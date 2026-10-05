import Foundation
import Darwin
import Security

// The helper is compiled from the signed package into a content-addressed,
// owner-only cache. All errors are categorical: never stringify Keychain data,
// input packets, browser output, or a provider/system password.
enum Failure: Error { case denied; case diagnostic(String) }
let maximumLease = 1_800_000.0
func checked(_ condition: Bool) throws { if !condition { throw Failure.denied } }
func output(_ value: String) { FileHandle.standardOutput.write(Data((value + "\n").utf8)) }
func checkedKeychain(_ status: OSStatus, fallback: String) throws {
    // Even an unlocked login Keychain can reject access with
    // errSecAuthFailed. Preserve that category without exposing OS error text,
    // key metadata, or values, and never reset a user's Keychain as recovery.
    if status == errSecSuccess { return }
    let code: String
    switch status {
    case errSecAuthFailed: code = "native_keychain_auth_failed"
    case errSecInteractionNotAllowed: code = "native_keychain_interaction_required"
    case errSecDuplicateItem: code = "native_keychain_key_exists"
    case errSecItemNotFound: code = "native_keychain_key_missing"
    case errSecNoSuchKeychain, errSecNotAvailable: code = "native_keychain_unavailable"
    case errSecMissingEntitlement: code = "native_keychain_entitlement_missing"
    default: code = fallback
    }
    throw Failure.diagnostic(code)
}
func keychainProbe() throws {
    // Reading settings does not read credential items or request an unlock.
    // GetStatus alone is insufficient: stale login authentication can report
    // unlocked/readable/writable while CopySettings and SecItemAdd both fail.
    try checkedKeychain(SecKeychainSetUserInteractionAllowed(false), fallback: "native_keychain_probe_failed")
    defer { SecKeychainSetUserInteractionAllowed(true) }
    var keychain: SecKeychain?
    try checkedKeychain(SecKeychainCopyDefault(&keychain), fallback: "native_keychain_probe_failed")
    guard let keychain else { throw Failure.diagnostic("native_keychain_unavailable") }
    var settings = SecKeychainSettings()
    settings.version = UInt32(SEC_KEYCHAIN_SETTINGS_VERS1)
    try checkedKeychain(SecKeychainCopySettings(keychain, &settings), fallback: "native_keychain_probe_failed")
}

func key(_ operation: String, _ account: String) throws {
    // The caller explicitly chose a non-interactive messenger session. A
    // locked/unavailable Keychain returns an error instead of opening any UI.
    try checkedKeychain(SecKeychainSetUserInteractionAllowed(false), fallback: "native_keychain_probe_failed")
    defer { SecKeychainSetUserInteractionAllowed(true) }
    try checked(account.count == 64 && account.allSatisfy { $0.isHexDigit })
    // File-based login Keychain works for an unsigned local CLI, unlike Data
    // Protection Keychain items that require an application entitlement.
    // WhatsApp is a non-financial communication skill. Use the current user's
    // Keychain protection without adding per-session LocalAuthentication.
    // System Keychain trust/locked-store prompts remain owned by macOS.
    var query: [CFString: Any] = [kSecClass: kSecClassGenericPassword,
        kSecAttrService: "trelio.whatsapp-web.session.v1", kSecAttrAccount: account]
    if operation == "key-create" {
        var value = Data(count: 32)
        try checked(value.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) } == errSecSuccess)
        defer { value.resetBytes(in: 0..<value.count) }
        var access: SecAccess?
        try checkedKeychain(SecAccessCreate("Trelio – WhatsApp" as CFString, nil, &access),
            fallback: "native_keychain_acl_failed")
        // This new messenger key has current-user protection, matching DPAPI
        // CurrentUser on Windows. Only the default restricted ACL gets a nil
        // app list (Apple's documented any-app form); the owner/change-ACL entry
        // remains intact. This configures our newly created item, never changes
        // an existing key's ACL or another application's Keychain entries.
        // Code-hash changes can then reuse it without an authorization dialog.
        guard let access else { throw Failure.denied }
        var aclList: CFArray?
        try checkedKeychain(SecAccessCopyACLList(access, &aclList), fallback: "native_keychain_acl_failed")
        guard let entries = aclList as? [SecACL] else { throw Failure.denied }
        for acl in entries {
            var apps: CFArray?, description: CFString?
            var selector = SecKeychainPromptSelector()
            try checkedKeychain(SecACLCopyContents(acl, &apps, &description, &selector), fallback: "native_keychain_acl_failed")
            if let apps, CFArrayGetCount(apps) > 0 {
                guard let description else { throw Failure.denied }
                try checkedKeychain(SecACLSetContents(acl, nil, description, selector), fallback: "native_keychain_acl_failed")
            }
        }
        query[kSecAttrAccess] = access
        query[kSecValueData] = value
        try checkedKeychain(SecItemAdd(query as CFDictionary, nil), fallback: "native_keychain_write_failed")
        output(value.base64EncodedString())
    } else if operation == "key-read" {
        query[kSecReturnData] = true; query[kSecMatchLimit] = kSecMatchLimitOne
        var item: CFTypeRef?
        try checkedKeychain(SecItemCopyMatching(query as CFDictionary, &item), fallback: "native_keychain_read_failed")
        guard var value = item as? Data, value.count == 32 else { throw Failure.denied }
        defer { value.resetBytes(in: 0..<value.count) }
        output(value.base64EncodedString())
    } else if operation == "key-delete" {
        let result = SecItemDelete(query as CFDictionary)
        if result != errSecItemNotFound { try checkedKeychain(result, fallback: "native_keychain_delete_failed") }
        output("ok")
    } else { throw Failure.denied }
}

// mach_continuous_time includes suspend and is independent of wall-clock
// adjustments. A JS setTimeout/hrtime in the worker is not the security timer.
func continuousMilliseconds() -> Double {
    var scale = mach_timebase_info_data_t()
    mach_timebase_info(&scale)
    return Double(mach_continuous_time()) * Double(scale.numer) / Double(scale.denom) / 1_000_000
}
func processInfo(_ pid: Int32) -> proc_bsdinfo? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size ? info : nil
}

final class Guardian {
    let worker = Process()
    let input = Pipe(), replies = Pipe(), errors = Pipe()
    let lock = NSLock()
    var browser: proc_bsdinfo?
    var workerIdentity: proc_bsdinfo?
    let start = continuousMilliseconds(), wallStart = Date().timeIntervalSince1970 * 1000
    let duration: Double
    init(_ duration: Double, _ config: String) throws {
        try checked(duration > 0 && duration <= maximumLease)
        guard let data = config.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.denied }
        if let expiry = object["expiresAt"] as? Double, let started = object["startedAt"] as? Double {
            try checked(expiry - started == maximumLease && expiry <= wallStart + maximumLease)
            // Native startup and a slow filesystem must not restart the lease.
            // Anchor the continuous timer to the CLI's original wall deadline.
            self.duration = min(duration, expiry - wallStart)
        } else {
            try checked(object["expiresAt"] == nil && object["startedAt"] == nil)
            self.duration = duration // Bounded synthetic native fixtures only.
        }
        try checked(self.duration > 0)
    }
    func valid() -> Bool {
        let elapsed = continuousMilliseconds() - start
        let wall = Date().timeIntervalSince1970 * 1000
        return elapsed >= 0 && elapsed < duration && wall >= wallStart - 2000 && wall < wallStart + duration
    }
    func stop() -> Never {
        lock.lock()
        for original in [browser, workerIdentity].compactMap({ $0 }) {
            if let current = processInfo(Int32(original.pbi_pid)) {
                if current.pbi_start_tvsec != original.pbi_start_tvsec ||
                   current.pbi_start_tvusec != original.pbi_start_tvusec { continue }
            }
            // A group ID remains reserved while any member lives. If its leader
            // has exited, this also reaps orphaned native unlock helpers. If the
            // PID was recycled into a different leader, the start-time check
            // above prevents touching the replacement process.
            if original.pbi_pgid == original.pbi_pid { kill(-Int32(original.pbi_pid), SIGKILL) }
        }
        // Guardian was spawned with detached:true. Its own group never contains
        // the agent; Foundation's separate worker group was handled above.
        kill(-getpid(), SIGKILL)
        _exit(1)
    }
    func run(_ node: String, _ script: String, _ config: String) throws {
        try checked(getpgrp() == getpid() && duration > 0 && duration <= maximumLease)
        worker.executableURL = URL(fileURLWithPath: node)
        worker.arguments = [script]
        worker.standardInput = input; worker.standardOutput = replies; worker.standardError = errors
        worker.terminationHandler = { [weak self] _ in self?.stop() }
        // Drain, discard, never log child diagnostics. A filled stderr pipe
        // must not hang a worker or accidentally become a secret-bearing log.
        errors.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        try worker.run()
        guard let ownedWorker = processInfo(worker.processIdentifier) else { stop() }
        lock.lock(); workerIdentity = ownedWorker; lock.unlock()
        input.fileHandleForWriting.write(Data((config + "\n").utf8))
        DispatchQueue.global().async { [self] in
            while true {
                if !valid() { stop() }
                Thread.sleep(forTimeInterval: 0.1)
            }
        }
        var pending = Data()
        while true {
            let chunk = replies.fileHandleForReading.availableData
            if chunk.isEmpty { stop() }
            pending.append(chunk)
            if pending.count > 8192 { stop() }
            while let end = pending.firstIndex(of: 10) {
                let packet = pending.prefix(upTo: end); pending.removeSubrange(...end)
                guard valid(), let object = try? JSONSerialization.jsonObject(with: packet) as? [String: Any],
                      let id = object["id"] as? Int, let op = object["op"] as? String else { stop() }
                if op == "own" {
                    guard let pid = object["pid"] as? Int32, let info = processInfo(pid),
                          info.pbi_ppid == UInt32(worker.processIdentifier) && info.pbi_pgid == info.pbi_pid else { stop() }
                    lock.lock()
                    if browser != nil { lock.unlock(); stop() }
                    browser = info; lock.unlock()
                } else if op != "permit" { stop() }
                // Every new action must pass this native deadline barrier.
                input.fileHandleForWriting.write(Data(("{\"id\":\(id),\"ok\":true}\n").utf8))
            }
        }
    }
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    if args == ["probe"] { output("macos-keychain-continuous-guard-v1") }
    else if args == ["keychain-probe"] { try keychainProbe(); output("ready") }
    else if args.count == 2 && args[0].hasPrefix("key-") { try key(args[0], args[1]) }
    else if args.count == 4 && args[0] == "guard", let duration = Double(args[3]),
            let config = readLine(), config.utf8.count < 16384 {
        try Guardian(duration, config).run(args[1], args[2], config)
    } else { throw Failure.denied }
} catch Failure.diagnostic(let code) {
    FileHandle.standardError.write(Data((code + "\n").utf8)); _exit(2)
} catch { _exit(2) }
