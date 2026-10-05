import CoreGraphics
import Foundation
import ApplicationServices
import Darwin

private func window(_ id: UInt32 = 1, x: CGFloat = 1720, width: CGFloat = 318, pid: Int32 = 100) -> InputWindowIdentity {
    InputWindowIdentity(id: id, pid: pid, bounds: CGRect(x: x, y: 30, width: width, height: 701))
}

private func rejects(_ code: String, _ body: () throws -> Void) {
    do {
        try body()
        fatalError("Expected rejection: \(code)")
    } catch let error as InputSafetyError {
        precondition(error.code == code, "Unexpected error: \(error)")
    } catch { fatalError("Unexpected error: \(error)") }
}

@main
private enum InputSafetyTests {
    static func main() throws {
        // Два последовательных чтения без main run loop должны увидеть смену
        // PID, а не вернуть первый AppKit snapshot. Native reads подменены;
        // тест не запускает приложение и не отправляет пользовательский ввод.
        var focusedPID: pid_t = 100
        var nativeError: Int16 = 0
        var pidError: Int32 = 0
        var pidReads = 0
        let readFocus = {
            readForegroundPID(
                getFrontProcess: { serial in
                    serial.pointee.lowLongOfPSN = 42
                    return nativeError
                },
                getProcessPID: { serial, pid in
                    precondition(serial.pointee.lowLongOfPSN == 42)
                    pidReads += 1
                    pid.pointee = focusedPID
                    return pidError
                }
            )
        }
        precondition(readFocus() == 100)
        focusedPID = 200
        precondition(readFocus() == 200)
        nativeError = -1
        precondition(readFocus() == nil && pidReads == 2)
        nativeError = 0
        pidError = -1
        precondition(readFocus() == nil)
        pidError = 0
        for invalidPID: pid_t in [0, -1] {
            focusedPID = invalidPID
            precondition(readFocus() == nil)
        }

        var clock: TimeInterval = 0
        var activations = 0
        var raises = 0
        let alreadyReady = try prepareStableInputWindow(
            readReady: { window() },
            activate: { activations += 1 }, raise: { raises += 1 },
            now: { clock }, pause: { clock += $0 }
        )
        precondition(alreadyReady == window() && activations == 0 && raises == 0)

        // Отказ AXRaise не равен неготовности окна: проверяется его фактическое
        // состояние. Этот сценарий воспроизводит focus → click из инцидента.
        clock = 0
        var ready = false
        let afterUnsupportedRaise = try prepareStableInputWindow(
            readReady: { ready ? window() : nil },
            activate: {}, raise: { raises += 1; ready = true },
            now: { clock }, pause: { clock += $0 }
        )
        precondition(afterUnsupportedRaise == window() && raises == 1)

        // Во время активации окно перемещается и получает другой ID. Старый
        // прямоугольник никогда не используется для точки последующего клика.
        clock = 0
        var activated = false
        var observations = 0
        let moved = try prepareStableInputWindow(
            readReady: {
                guard activated else { return nil }
                observations += 1
                return observations == 1 ? window() : window(2, x: 1900)
            },
            activate: { activated = true }, raise: {},
            now: { clock }, pause: { clock += $0 }
        )
        precondition(observations == 4 && moved.id == 2)
        let point = try normalizedInputPoint(window: moved, x: 0.5, y: 0.5)
        precondition(point.x == 2059 && point.y == 380.5)

        clock = 0
        rejects("input_window_not_ready") {
            _ = try prepareStableInputWindow(timeout: 0.5, readReady: { nil }, activate: {}, raise: {}, now: { clock }, pause: { clock += $0 })
        }

        for changed in [nil, window(3, x: 1900), window(2, x: 1901), window(2, x: 1900, width: 319), window(2, x: 1900, pid: 200)] {
            var eventPosted = false
            rejects("input_target_changed") {
                try validateInputTarget(expected: moved, current: changed, point: point)
                eventPosted = true
            }
            precondition(!eventPosted)
        }
        try validateInputTarget(expected: moved, current: moved, point: point)
        let edge = try normalizedInputPoint(window: moved, x: 1, y: 1)
        precondition(moved.bounds.contains(edge))
        for invalid in [Double.nan, Double.infinity, -0.1, 1.1] {
            rejects("invalid_input_point") { _ = try normalizedInputPoint(window: moved, x: invalid, y: 0.5) }
        }

        rejects("hidden_session_required") { _ = try resolveInputMode(session: nil, activeSession: nil, visible: false) }
        rejects("hidden_session_required") { _ = try resolveInputMode(session: nil, activeSession: "live", visible: false) }
        rejects("session_not_active") { _ = try resolveInputMode(session: "ended", activeSession: nil, visible: false) }
        rejects("session_not_active") { _ = try resolveInputMode(session: "old", activeSession: "live", visible: false) }
        rejects("input_mode_conflict") { _ = try resolveInputMode(session: nil, activeSession: "live", visible: true) }
        rejects("input_mode_conflict") { _ = try resolveInputMode(session: "ended", activeSession: nil, visible: true) }
        let hiddenMode = try resolveInputMode(session: "live", activeSession: "live", visible: false)
        let visibleMode = try resolveInputMode(session: nil, activeSession: nil, visible: true)
        precondition(hiddenMode == .hidden && visibleMode == .visible)

        precondition(hasIdleInput(age: 3, heldKey: false, heldButton: false, modifiers: []))
        for age: TimeInterval in [0.5, 2.99] {
            precondition(!hasIdleInput(age: age, heldKey: false, heldButton: false, modifiers: []))
        }
        precondition(!hasIdleInput(age: 20, heldKey: true, heldButton: false, modifiers: []))
        precondition(!hasIdleInput(age: 20, heldKey: false, heldButton: true, modifiers: []))
        for flags: CGEventFlags in [.maskCommand, .maskShift, .maskAlternate, .maskControl, .maskSecondaryFn] {
            precondition(!hasIdleInput(age: 20, heldKey: false, heldButton: false, modifiers: flags))
        }
        precondition(hasIdleInput(age: 20, heldKey: false, heldButton: false, modifiers: .maskAlphaShift))
        for event: CGEventType in [.scrollWheel, .leftMouseDragged, .otherMouseUp, .flagsChanged, .keyUp] {
            precondition(physicalInputEventTypes.contains(event))
        }

        // Реальный цикл допуска: пользователь вводит каждые две секунды до
        // 46-й секунды. Старые 30/40-секундные лимиты не должны завершить запрос,
        // а паузы между вводом не дают права забрать фокус раньше трёх секунд.
        clock = 0
        var actions = 0
        var lastInput: TimeInterval = 0
        let completed = try performAfterInputIdle(isIdle: {
            if clock < 46 { lastInput = floor(clock / 2) * 2 }
            return hasIdleInput(age: clock - lastInput, heldKey: false, heldButton: false, modifiers: [])
        }, checkAllowed: {}, attempt: {
            actions += 1
            precondition(clock >= 47)
            return ["ok": true, "events_posted": true, "verification_required": true]
        }, now: { clock }, pause: { clock += $0 })
        precondition(actions == 1 && clock < 48 && completed["ok"] as? Bool == true)

        // Десять минут непрерывной работы моделируются clock-ом без sleep и
        // без ввода в macOS. Ошибка обязана доказать отсутствие отправки.
        clock = 0; actions = 0
        do {
            _ = try performAfterInputIdle(isIdle: { false }, checkAllowed: {}, attempt: {
                actions += 1; return ["ok": true]
            }, now: { clock }, pause: { clock += $0 })
            fatalError("Expected idle timeout")
        } catch let error as InputSafetyError {
            precondition(error.code == "input_idle_timeout")
            precondition(error.details["events_posted"] as? Bool == false)
        }
        precondition(clock == 600 && actions == 0)

        let retryable: [String: Any] = ["ok": false, "error_code": "input_user_active",
            "events_posted": false, "verification_required": false, "restored_front_app": true]
        clock = 0; actions = 0; lastInput = 0
        _ = try performAfterInputIdle(isIdle: { clock - lastInput >= 3 }, checkAllowed: {}, attempt: {
            actions += 1
            if actions < 3 { lastInput = clock; return retryable }
            return ["ok": true]
        }, now: { clock }, pause: { clock += $0 })
        precondition(actions == 3 && clock >= 9 && clock < 9.3)

        // Неотправленные попытки не продлевают общий deadline. Последняя
        // проверка покоя прямо на границе также не запускает поздний ввод.
        clock = 0; actions = 0
        rejects("input_idle_timeout") {
            _ = try performAfterInputIdle(isIdle: { true }, checkAllowed: {}, attempt: {
                actions += 1; return retryable
            }, now: { clock }, pause: { clock += $0 })
        }
        precondition(clock == 600 && actions > 1)
        clock = 0; actions = 0
        rejects("input_idle_timeout") {
            _ = try performAfterInputIdle(isIdle: { clock >= 600 }, checkAllowed: {}, attempt: {
                actions += 1; return ["ok": true]
            }, now: { clock }, pause: { clock += $0 })
        }
        precondition(actions == 0)
        clock = 0
        _ = try performAfterInputIdle(isIdle: { clock >= 599.5 }, checkAllowed: {}, attempt: {
            actions += 1; return ["ok": true]
        }, now: { clock }, pause: { clock += $0 })
        precondition(actions == 1 && clock < 600)

        clock = 0; actions = 0
        rejects("input_request_expired") {
            _ = try performAfterInputIdle(isIdle: { false }, checkAllowed: {
                if clock >= 4 { throw InputSafetyError(code: "input_request_expired", message: "cancelled") }
            }, attempt: { actions += 1; return ["ok": true] }, now: { clock }, pause: { clock += $0 })
        }
        precondition(actions == 0 && clock < 4.2)
        for replacement: [String: Any] in [
            ["events_posted": true], ["verification_required": true],
            ["restored_front_app": false], ["error_code": "input_guard_interrupted"],
        ] {
            let unsafe = retryable.merging(replacement) { _, value in value }
            clock = 0; actions = 0
            let result = try performAfterInputIdle(isIdle: { true }, checkAllowed: {}, attempt: {
                actions += 1; return unsafe
            }, now: { clock }, pause: { clock += $0 })
            precondition(actions == 1 && result["ok"] as? Bool == false)
        }
        precondition(!canRetryUnstartedInput(["ok": false, "error_code": "input_user_active"]))
        precondition(canRetryUnstartedInput(retryable.merging(["restored_front_app": false, "handoff_started": false]) { _, v in v }))
        precondition(inputRequestIsLive(clientPID: 100, expiresAt: 710, now: 100, processAlive: { $0 == 100 }))
        for expiry: TimeInterval in [100, 99, 716, .infinity, .nan] {
            precondition(!inputRequestIsLive(clientPID: 100, expiresAt: expiry, now: 100, processAlive: { _ in true }))
        }
        precondition(!inputRequestIsLive(clientPID: 100, expiresAt: 710, now: 100, processAlive: { _ in false }))
        precondition(sessionDefaultIdleTimeout == 1_800 && sessionDefaultHardTimeout == 7_200)
        for text in ["Камера Camera 123", "е\u{301} 🎉", String(repeating: "я", count: 128)] {
            let chunks = try inputTextChunks(text)
            precondition(String(utf16CodeUnits: chunks.flatMap { $0 }, count: chunks.flatMap { $0 }.count) == text)
            precondition(chunks.allSatisfy { $0.count <= 16 })
        }
        for invalid in ["", "a\nb", "a\rb", "a\tb", "a\u{0000}b", "a\u{2028}b", String(repeating: "я", count: 129)] {
            rejects("invalid_input_text") { _ = try inputTextChunks(invalid) }
        }
        var admission = InputEventAdmission()
        precondition(admission.accepts(owned: true, release: false))
        precondition(!admission.accepts(owned: false, release: false))
        precondition(admission.reason == "input_user_active")
        precondition(!admission.accepts(owned: true, release: false))
        precondition(admission.accepts(owned: true, release: true))
        admission.cancel("input_handoff_expired")
        precondition(admission.reason == "input_user_active")
        admission.active = false
        precondition(admission.accepts(owned: false, release: false))
        precondition(!admission.accepts(owned: true, release: false))
        var watchdogAdmission = InputEventAdmission()
        watchdogAdmission.cancel("input_handoff_expired")
        precondition(!watchdogAdmission.accepts(owned: true, release: false))
        precondition(watchdogAdmission.accepts(owned: true, release: true))

        for oldVersion: Int? in [nil, 1, 2, 999] {
            rejects("session_runtime_changed") { try requireGuardedInputProtocol(oldVersion) }
        }
        try requireGuardedInputProtocol(3)
        // Настоящий замороженный процесс, а не mock timer: production boundary
        // обязана убить и reap-нуть его до разрешения восстановления фокуса.
        let stopped = Process()
        stopped.executableURL = URL(fileURLWithPath: "/bin/sleep")
        stopped.arguments = ["30"]
        try stopped.run()
        kill(stopped.processIdentifier, SIGSTOP)
        let beforeWatchdog = ProcessInfo.processInfo.systemUptime
        precondition(waitForGuardedChild(stopped, timeout: 0.08))
        precondition(!stopped.isRunning && ProcessInfo.processInfo.systemUptime - beforeWatchdog < 1)
        let cancelled = Process()
        cancelled.executableURL = URL(fileURLWithPath: "/bin/sleep")
        cancelled.arguments = ["30"]
        try cancelled.run()
        precondition(waitForGuardedChild(cancelled, shouldContinue: { false }))
        precondition(!cancelled.isRunning)

        print("Input safety regressions passed: uncached focus, stable windows, routing, held input, Unicode, cancellation and late-event rejection.")
    }
}
