import Foundation
import Security
import LocalAuthentication

// This key-only helper has its own frozen, content-addressed executable identity.
// The legacy guardian/key helper must remain byte-for-byte stable because the
// file-based login Keychain records its trusted application. A new key service
// lets the title-aware UI evolve once, then stay stable across later runtimes.
enum Failure: Error { case denied; case diagnostic(String) }
func checked(_ condition: Bool) throws { if !condition { throw Failure.denied } }
func output(_ value: String) { FileHandle.standardOutput.write(Data((value + "\n").utf8)) }
func checkedKeychain(_ status: OSStatus, fallback: String) throws {
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

let serviceV2 = "trelio.t-bank.vault.v2"
let serviceV1 = "trelio.t-bank.vault.v1"

func accountQuery(_ service: String, _ account: String) throws -> [CFString: Any] {
    try checked(account.count == 64 && account.allSatisfy { $0.isHexDigit })
    return [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account]
}

func requestPacket() throws -> [String: Any]? {
    // The task title and migration key stay off argv/env. One bounded packet is
    // consumed from the private parent pipe and is never persisted or logged.
    let input = try FileHandle.standardInput.read(upToCount: 1025) ?? Data()
    try checked(input.count <= 1024)
    if input.isEmpty { return nil }
    guard let object = try JSONSerialization.jsonObject(with: input) as? [String: Any],
          object["schema"] as? Int == 1 else { throw Failure.denied }
    return object
}

func requestTitle(_ packet: [String: Any]?) throws -> String? {
    guard let packet else { return nil }
    try checked(packet.keys.allSatisfy { ["schema", "requestTitle"].contains($0) })
    guard let title = packet["requestTitle"] as? String else { throw Failure.denied }
    let bytes = title.utf8.count
    try checked(bytes > 0 && bytes <= 160 && title == title.trimmingCharacters(in: .whitespacesAndNewlines))
    let unsafe = title.unicodeScalars.contains { scalar in
        let value = scalar.value
        return value <= 0x1f || (0x7f...0x9f).contains(value)
            || (0x202a...0x202e).contains(value) || (0x2066...0x2069).contains(value)
    }
    try checked(!unsafe)
    return title
}

func importedKey(_ packet: [String: Any]?) throws -> Data {
    guard let packet, packet.keys.sorted() == ["key", "schema"],
          let encoded = packet["key"] as? String,
          var value = Data(base64Encoded: encoded), value.count == 32 else { throw Failure.denied }
    // Return a copy so the temporary decoder storage can be zeroed immediately.
    defer { value.resetBytes(in: 0..<value.count) }
    return Data(value)
}

func ownerConfirmation(_ title: String?) throws {
    let context = LAContext()
    defer { context.invalidate() }
    context.touchIDAuthenticationAllowableReuseDuration = 0
    context.localizedCancelTitle = "Отмена"
    var availability: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &availability) else {
        throw Failure.diagnostic("native_unlock_unavailable")
    }
    let complete = DispatchSemaphore(value: 0)
    var accepted = false
    var failure = "native_unlock_failed"
    let reason = title.map {
        "Чат «\($0)» запрашивает защищённую сессию Т‑Банка максимум на 30 минут"
    } ?? "Открыть защищённую сессию Т‑Банка максимум на 30 минут"
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { result, error in
        if let error = error as? LAError {
            switch error.code {
            case .userCancel, .systemCancel, .appCancel: failure = "native_unlock_cancelled"
            case .authenticationFailed: failure = "native_unlock_rejected"
            case .notInteractive: failure = "native_unlock_interaction_required"
            default: break
            }
        }
        accepted = result
        complete.signal()
    }
    guard complete.wait(timeout: .now() + 115) == .success else {
        throw Failure.diagnostic("native_unlock_timeout")
    }
    if !accepted { throw Failure.diagnostic(failure) }
}

func keyStatus(_ service: String, _ account: String) throws {
    var query = try accountQuery(service, account)
    query[kSecReturnAttributes] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    // Status is value-free and must never open Keychain UI. It decides whether
    // to use v2 directly or invoke the already-trusted v1 helper for migration.
    try checkedKeychain(SecKeychainSetUserInteractionAllowed(false), fallback: "native_keychain_probe_failed")
    defer { SecKeychainSetUserInteractionAllowed(true) }
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecSuccess { output("present") }
    else if status == errSecItemNotFound { output("missing") }
    else { try checkedKeychain(status, fallback: "native_keychain_probe_failed") }
}

func addKey(_ account: String, _ value: inout Data) throws {
    var query = try accountQuery(serviceV2, account)
    var access: SecAccess?
    try checkedKeychain(SecAccessCreate("Trelio – Т‑Банк" as CFString, nil, &access),
        fallback: "native_keychain_acl_failed")
    query[kSecAttrAccess] = access
    query[kSecValueData] = value
    try checkedKeychain(SecItemAdd(query as CFDictionary, nil), fallback: "native_keychain_write_failed")
}

func key(_ operation: String, _ account: String) throws {
    if operation == "key-status" { try keyStatus(serviceV2, account); return }
    if operation == "legacy-status" { try keyStatus(serviceV1, account); return }

    let packet = try requestPacket()
    if operation == "key-import" {
        // Reading the legacy key already required a fresh owner confirmation in
        // the trusted v1 helper. Import only creates a missing v2 item; it never
        // reads credentials or bypasses a later title-aware confirmation.
        var value = try importedKey(packet)
        defer { value.resetBytes(in: 0..<value.count) }
        try addKey(account, &value)
        output("ok")
        return
    }

    try ownerConfirmation(try requestTitle(packet))
    var query = try accountQuery(serviceV2, account)
    if operation == "key-create" {
        var value = Data(count: 32)
        try checked(value.withUnsafeMutableBytes {
            SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!)
        } == errSecSuccess)
        defer { value.resetBytes(in: 0..<value.count) }
        try addKey(account, &value)
        output(value.base64EncodedString())
    } else if operation == "key-read" {
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
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

do {
    let args = Array(CommandLine.arguments.dropFirst())
    if args == ["probe"] { output("macos-keychain-la-title-key-v2") }
    else if args.count == 2 && ["key-status", "legacy-status", "key-create", "key-read", "key-import", "key-delete"].contains(args[0]) {
        try key(args[0], args[1])
    } else { throw Failure.denied }
} catch Failure.diagnostic(let code) {
    FileHandle.standardError.write(Data((code + "\n").utf8))
    _exit(2)
} catch { _exit(2) }
