import Foundation
import Darwin

// Derived from the reviewed non-financial provider guardian. The signed email
// package owns this standalone copy; no sibling installed skill is executed.
// Only permit packets and ordinary command results use these private pipes.
enum Failure: Error { case denied }
let maximumLease = 1_800_000.0
func checked(_ condition: Bool) throws { if !condition { throw Failure.denied } }
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
    var workerIdentity: proc_bsdinfo?
    let start = continuousMilliseconds(), wallStart = Date().timeIntervalSince1970 * 1000
    let duration: Double
    let parentCondition = NSCondition()
    var openerReply: Bool?
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
    func stop(_ code: Int32 = 2) -> Never {
        lock.lock()
        for original in [workerIdentity].compactMap({ $0 }) {
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
        // Only our owned worker group is terminated; the user browser opened
        // through LaunchServices is outside it and must remain untouched.
        _exit(code)
    }
    func run(_ node: String, _ script: String, _ config: String) throws {
        try checked(getpgrp() == getpid() && duration > 0 && duration <= maximumLease)
        worker.executableURL = URL(fileURLWithPath: node)
        // No user sitecustomize/PYTHONPATH code may run before our first permit.
        worker.arguments = ["-I", "-S", "-B", script]
        worker.standardInput = input; worker.standardOutput = replies; worker.standardError = errors
        // Drain, discard, never log child diagnostics. A filled stderr pipe
        // must not hang a worker or accidentally become a secret-bearing log.
        errors.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        try worker.run()
        guard let ownedWorker = processInfo(worker.processIdentifier) else { stop() }
        lock.lock(); workerIdentity = ownedWorker; lock.unlock()
        input.fileHandleForWriting.write(Data((config + "\n").utf8))
        // The public wrapper holds stdin open for our whole lifetime. EOF
        // means caller loss, independently of the Python event loop.
        DispatchQueue.global().async { [self] in
            while let line = readLine() {
                guard line.utf8.count < 128, let data = line.data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let ok = object["ok"] as? Bool else { stop() }
                parentCondition.lock()
                if openerReply != nil { parentCondition.unlock(); stop() }
                openerReply = ok; parentCondition.signal(); parentCondition.unlock()
            }
            stop()
        }
        DispatchQueue.global().async { [self] in
            while true {
                if !valid() { stop() }
                Thread.sleep(forTimeInterval: 0.1)
            }
        }
        // SIGTERM/interrupt must clean the worker before leaving the guardian.
        // SIGKILL cannot execute cleanup; a healthy worker detects pipe EOF.
        let signals = [SIGTERM, SIGINT].map { number -> DispatchSourceSignal in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { [self] in stop() }; source.resume(); return source
        }
        defer { for source in signals { source.cancel() } }
        var pending = Data()
        while true {
            let chunk = replies.fileHandleForReading.availableData
            if chunk.isEmpty { stop() }
            pending.append(chunk)
            if pending.count > 128 * 1024 * 1024 { stop() }
            while let end = pending.firstIndex(of: 10) {
                let packet = pending.prefix(upTo: end); pending.removeSubrange(...end)
                guard valid(), let object = try? JSONSerialization.jsonObject(with: packet) as? [String: Any],
                      let id = object["id"] as? Int, let op = object["op"] as? String else { stop() }
                if op == "result" {
                    guard let code = object["code"] as? Int32, [0, 2].contains(code),
                          object["value"] is String else { stop() }
                    // This stdout is a private pipe to the wrapper, which emits
                    // only result.value; setup URLs never reach agent output.
                    FileHandle.standardOutput.write(packet + Data([10])); stop(code)
                } else if op == "open" {
                    guard let url = object["url"] as? String, url.utf8.count < 256 else { stop() }
                    let message = try JSONSerialization.data(withJSONObject: ["op": "open", "url": url])
                    FileHandle.standardOutput.write(message + Data([10]))
                    parentCondition.lock()
                    while openerReply == nil { parentCondition.wait() }
                    let ok = openerReply!; openerReply = nil; parentCondition.unlock()
                    if !valid() { stop() }
                    input.fileHandleForWriting.write(Data(("{\"id\":\(id),\"ok\":\(ok)}\n").utf8))
                    continue
                } else if op != "permit" { stop() }
                // Every new action must pass this native deadline barrier.
                input.fileHandleForWriting.write(Data(("{\"id\":\(id),\"ok\":true}\n").utf8))
            }
        }
    }
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    if args == ["probe"] {
        try checked(continuousMilliseconds() >= 0)
        print("macos-email-continuous-v1")
    } else if args.count == 4 && args[0] == "guard", let duration = Double(args[3]),
              let config = readLine(), config.utf8.count < 65536 {
        try Guardian(duration, config).run(args[1], args[2], config)
    } else { throw Failure.denied }
} catch {
    FileHandle.standardError.write(Data("native_email_operation_failed\n".utf8)); _exit(2)
}
