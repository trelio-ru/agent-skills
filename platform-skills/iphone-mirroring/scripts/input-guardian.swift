import AppKit
import ApplicationServices
import CoreGraphics
import Carbon
import Darwin
import Foundation

// Один процесс — одна операция. Он единственный отправитель её HID-событий;
// после его выхода ни зависший supervisor, ни поздний callback не могут
// продолжить ввод. JSON поступает только через stdin pipe, не через argv/файл.
private final class InputGuardian {
    private let operation: GuardedInputOperation
    private let source: CGEventSource
    private let marker = Int64.random(in: 1...Int64.max)
    private var admission = InputEventAdmission()
    private var tap: CFMachPort?
    private var timer: Timer?
    private var previousPID: pid_t = 0
    private var previousName: String?
    private var cursor = CGPoint.zero
    private var cursorHidden = false
    private var cursorDetached = false
    private var started: TimeInterval = 0
    private var recovering = false
    private var posted = false
    private var releaseEvents: [CGEvent] = []
    private var result: [String: Any] = [:]
    private var physicalDisplays = Set<UInt32>()

    init(_ operation: GuardedInputOperation) throws {
        guard let source = CGEventSource(stateID: .privateState) else {
            throw InputSafetyError(code: "input_event_failed", message: "Не удалось создать источник событий.")
        }
        self.source = source
        self.operation = operation
    }
    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    private func displayIDs() -> Set<UInt32> {
        var ids = [CGDirectDisplayID](repeating: 0, count: 32)
        var count: UInt32 = 0
        guard CGGetOnlineDisplayList(32, &ids, &count) == .success else { return [] }
        return Set(ids.prefix(Int(count)).filter { $0 != operation.displayID })
    }

    private func sessionHealthy() -> Bool {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        return getppid() == operation.parentPID
            && operation.callerPID > 0 && (kill(operation.callerPID, 0) == 0 || errno == EPERM)
            && !IsSecureEventInputEnabled()
            && session?["CGSSessionScreenIsLocked"] as? Bool != true
            && CGMainDisplayID() == operation.mainDisplayID
            && CGDisplayIsAsleep(operation.mainDisplayID) == 0
            && CGDisplayIsActive(operation.displayID) != 0
            && displayIDs() == physicalDisplays
    }

    private func currentWindow() -> InputWindowIdentity? {
        guard freshFrontmostPID() == operation.window.pid,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let top = windows.first(where: {
                  ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == operation.window.pid
                      && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
              }),
              let id = (top[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let values = top[kCGWindowBounds as String] as? [String: Any],
              let x = values["X"] as? Double, let y = values["Y"] as? Double,
              let width = values["Width"] as? Double, let height = values["Height"] as? Double else { return nil }
        let bounds = CGRect(x: x, y: y, width: width, height: height)
        guard operation.virtualBounds.contains(bounds) else { return nil }
        return InputWindowIdentity(id: id, pid: operation.window.pid, bounds: bounds)
    }

    private func check() throws {
        if now - started >= 1.6 { admission.cancel("input_handoff_expired") }
        if !sessionHealthy() { admission.cancel("input_session_interrupted") }
        if let tap, !CGEvent.tapIsEnabled(tap: tap) { admission.cancel("input_guard_disabled") }
        if let code = admission.reason {
            throw InputSafetyError(code: code, message: "Операция прервана; сначала проверьте фактический результат на iPhone.")
        }
    }

    // Pump main run loop вместо Thread.sleep: event tap продолжает принимать
    // физический ввод, а двухсекундный таймер работает во время любого ожидания.
    private func pause(_ seconds: TimeInterval, checking: Bool = true) throws {
        let until = now + seconds
        repeat {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: min(0.005, max(0, until - now))))
            if checking { try check() }
        } while now < until
    }

    private func receive(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            admission.cancel("input_guard_disabled")
            return Unmanaged.passUnretained(event)
        }
        let own = event.getIntegerValueField(.eventSourceUnixProcessID) == Int64(getpid())
            && event.getIntegerValueField(.eventSourceUserData) == marker
        if !own && admission.reason == nil {
            // Только тип/источник события: ни клавиша, ни Unicode, ни координаты
            // физического ввода не читаются и не попадают в диагностику.
            result["interruption_event_type"] = Int(type.rawValue)
            result["interruption_source_pid"] = event.getIntegerValueField(.eventSourceUnixProcessID)
            result["interruption_own_marker"] = event.getIntegerValueField(.eventSourceUserData) == marker
        }
        let release = type == .leftMouseUp || type == .rightMouseUp || type == .otherMouseUp || type == .keyUp
        if own && freshFrontmostPID() != operation.window.pid {
            admission.cancel("input_target_changed")
            if release { event.postToPid(operation.window.pid) }
            return nil
        }
        return admission.accepts(owned: own, release: release) ? Unmanaged.passUnretained(event) : nil
    }

    private func post(_ event: CGEvent, release: Bool = false) throws {
        if !release {
            try check()
            let point = try normalizedInputPoint(window: operation.window, x: operation.x, y: operation.y)
            try validateInputTarget(expected: operation.window, current: currentWindow(), point: point)
        }
        event.setIntegerValueField(.eventSourceUserData, value: marker)
        if release && freshFrontmostPID() != operation.window.pid {
            event.postToPid(operation.window.pid)
        } else {
            event.post(tap: .cghidEventTap)
        }
        posted = true
    }

    private func pair(_ down: CGEvent, _ up: CGEvent, duration: TimeInterval) throws {
        // Сохраняем только созданный нами release, никогда не пользовательские
        // клавиши/символы. Отмена между down/up завершает пару перед возвратом.
        releaseEvents.append(up)
        try post(down)
        try pause(duration)
        try post(up, release: true)
        releaseEvents.removeLast()
    }

    private func click(_ count: Int, point: CGPoint) throws {
        for index in 1...count {
            guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
                throw InputSafetyError(code: "input_event_failed", message: "Не удалось создать клик.")
            }
            down.flags = []; up.flags = []
            down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            try pair(down, up, duration: 0.05)
            try pause(0.05)
        }
    }

    private func typeText(_ chunks: [[UniChar]]) throws {
        for chunk in chunks {
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                throw InputSafetyError(code: "input_event_failed", message: "Не удалось создать текстовое событие.")
            }
            down.flags = []; up.flags = []
            chunk.withUnsafeBufferPointer {
                down.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress)
                up.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress)
            }
            try pair(down, up, duration: 0.001)
            try pause(0.004)
        }
    }

    private func finish(code: String? = nil) -> Never {
        if recovering {
            // Вторая авария означает, что recovery сама не завершилась в срок.
            // Сначала прекращаем отправителя; supervisor имеет свой внешний
            // deadline и выполняет последнюю попытку восстановления по PID.
            CGAssociateMouseAndMouseCursorPosition(1)
            if cursorHidden { CGWarpMouseCursorPosition(cursor); CGDisplayShowCursor(operation.mainDisplayID) }
            emit(code: code ?? "input_recovery_timeout", restored: false)
        }
        recovering = true
        if let code { admission.cancel(code) }
        admission.cancelling = true
        // Release проходит тот же tap. Короткое обслуживание run loop даёт ему
        // покинуть очередь до переключения фокуса. Новых down уже не бывает.
        for event in releaseEvents { try? post(event, release: true) }
        releaseEvents.removeAll()
        try? pause(0.03, checking: false)
        if cursorDetached { CGAssociateMouseAndMouseCursorPosition(1) }
        if cursorHidden {
            CGWarpMouseCursorPosition(cursor)
            CGDisplayShowCursor(operation.mainDisplayID)
            cursorHidden = false
        }
        // Если пользователь/система уже выбрали другое приложение, не отбираем
        // его обратно. При обычном возврате активируем ровно сохранённый PID.
        if freshFrontmostPID() == operation.window.pid {
            _ = activateExactProcess(previousPID)
        }
        let restoreDeadline = min(started + 1.98, now + 0.30)
        while freshFrontmostPID() != previousPID && freshFrontmostPID() == operation.window.pid && now < restoreDeadline {
            try? pause(0.005, checking: false)
        }
        let restored = freshFrontmostPID() == previousPID
        if !restored && admission.reason == nil { admission.cancel("input_focus_restore_failed") }
        admission.active = false
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        timer?.invalidate()
        emit(code: admission.reason, restored: restored)
    }

    private func emit(code: String?, restored: Bool) -> Never {
        result["ok"] = code == nil
        result["action"] = operation.command
        result["events_posted"] = posted
        result["verification_required"] = posted
        result["restored_front_app"] = restored
        result["previous_pid"] = Int(previousPID)
        result["previous_app"] = previousName ?? NSNull()
        result["focus_ms"] = Int(max(0, now - started) * 1000)
        result["input_guard"] = "native_event_tap"
        result["handoff_started"] = true
        if let code {
            result["error_code"] = code
            result["error"] = "Операция прервана; проверьте результат перед повтором."
        }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data + Data([10]))
        }
        exit(0)
    }

    func run() throws -> Never {
        guard getppid() == operation.parentPID, operation.window.pid > 0,
              NSRunningApplication(processIdentifier: operation.window.pid)?.bundleIdentifier == "com.apple.ScreenContinuity",
              operation.displayID != operation.mainDisplayID,
              CGDisplayVendorNumber(operation.displayID) == 0xEEEE,
              CGDisplayBounds(operation.displayID) == operation.virtualBounds,
              operation.virtualBounds.contains(operation.window.bounds),
              operation.command == "tap" || operation.command == "scroll" || operation.command == "type-text" else {
            throw InputSafetyError(code: "invalid_input_operation", message: "Недопустимая операция ввода.")
        }
        let chunks = operation.command == "type-text" ? try inputTextChunks(operation.text ?? "") : []
        let point = try normalizedInputPoint(window: operation.window, x: operation.x, y: operation.y)
        guard (1...2).contains(operation.count), (20...2000).contains(operation.pixels),
              operation.direction == "up" || operation.direction == "down" else {
            throw InputSafetyError(code: "invalid_input_operation", message: "Недопустимые параметры ввода.")
        }
        guard AXIsProcessTrusted(), !IsSecureEventInputEnabled() else {
            throw InputSafetyError(code: "input_guard_unavailable", message: "Перехват клавиатуры недоступен либо macOS использует защищённый ввод; действие отменено.")
        }
        guard physicalInputIsIdle(), let front = freshFrontmostPID(), front != operation.window.pid else {
            throw InputSafetyError(code: "input_not_idle", message: "Нет безопасной паузы с известным исходным приложением; ввод не начат.")
        }
        previousPID = front
        previousName = NSRunningApplication(processIdentifier: front)?.localizedName
        cursor = CGEvent(source: nil)?.location ?? .zero
        physicalDisplays = displayIDs()
        guard sessionHealthy() else {
            throw InputSafetyError(code: "input_session_interrupted", message: "Состояние дисплеев изменилось до ввода.")
        }
        var mask: CGEventMask = physicalInputEventTypes.reduce(0) { $0 | (CGEventMask(1) << $1.rawValue) }
        mask |= CGEventMask(1) << 14 // systemDefined: мультимедийные клавиши.
        guard let port = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, context in
            guard let context else { return Unmanaged.passUnretained(event) }
            return Unmanaged<InputGuardian>.fromOpaque(context).takeUnretainedValue().receive(type, event)
        }, userInfo: Unmanaged.passUnretained(self).toOpaque()),
              let runSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else {
            throw InputSafetyError(code: "input_guard_unavailable", message: "macOS не разрешила перехват ввода; переключение фокуса отменено.")
        }
        tap = port
        CFRunLoopAddSource(CFRunLoopGetMain(), runSource, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        started = now
        timer = Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.now - self.started >= 2 { self.finish(code: "input_handoff_expired") }
            if !self.sessionHealthy() { self.admission.cancel("input_session_interrupted") }
        }
        do {
            // Проверяем гонку после установки фильтра, ДО активации приложения.
            guard physicalInputIsIdle() else { throw InputSafetyError(code: "input_user_active", message: "Пользователь возобновил ввод.") }
            try check()
            guard activateExactProcess(operation.window.pid) else {
                throw InputSafetyError(code: "input_focus_unavailable", message: "Не удалось активировать точный процесс Видеоповтора.")
            }
            var stable = 0
            while stable < 3 {
                try check()
                stable = currentWindow() == operation.window ? stable + 1 : 0
                try pause(0.04)
            }
            guard CGDisplayHideCursor(operation.mainDisplayID) == .success else {
                throw InputSafetyError(code: "input_cursor_failed", message: "Не удалось скрыть курсор.")
            }
            cursorHidden = true
            guard CGAssociateMouseAndMouseCursorPosition(0) == .success else {
                throw InputSafetyError(code: "input_cursor_failed", message: "Не удалось отсоединить курсор.")
            }
            cursorDetached = true
            guard CGWarpMouseCursorPosition(point) == .success else {
                throw InputSafetyError(code: "input_cursor_failed", message: "Не удалось установить точную позицию курсора.")
            }
            guard let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
                throw InputSafetyError(code: "input_event_failed", message: "Не удалось создать наведение.")
            }
            move.flags = []
            try post(move)
            try pause(0.05)
            switch operation.command {
            case "tap": try click(operation.count, point: point)
            case "type-text":
                try click(1, point: point)
                try pause(0.05)
                try typeText(chunks)
                result["text_utf16_units"] = operation.text?.utf16.count ?? 0
                result["text_echoed"] = false
            default:
                let total = operation.direction == "down" ? -operation.pixels : operation.pixels
                for index in 0..<6 {
                    let delta = index == 5 ? total - total / 6 * 5 : total / 6
                    guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(delta), wheel2: 0, wheel3: 0) else {
                        throw InputSafetyError(code: "input_event_failed", message: "Не удалось создать прокрутку.")
                    }
                    event.flags = []; event.location = point
                    try post(event)
                    try pause(0.035)
                }
            }
            try pause(0.08)
            finish()
        } catch let error as InputSafetyError { finish(code: error.code) }
        catch { finish(code: "input_operation_failed") }
    }
}

@main
private enum InputGuardianMain {
    static func main() {
        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard data.count <= 8192 else {
                throw InputSafetyError(code: "invalid_input_operation", message: "Слишком большой запрос ввода.")
            }
            let operation = try JSONDecoder().decode(GuardedInputOperation.self, from: data)
            try InputGuardian(operation).run()
        } catch {
            let code = (error as? InputSafetyError)?.code ?? "invalid_input_operation"
            // Все throwing preflight-проверки находятся до активации окна.
            // Supervisor может безопасно дождаться следующей паузы только при
            // явном доказательстве, что этот процесс ещё не забирал управление.
            let result: [String: Any] = ["ok": false, "error_code": code, "error": "Ввод не начат.", "events_posted": false, "verification_required": false, "handoff_started": false]
            if let data = try? JSONSerialization.data(withJSONObject: result) { FileHandle.standardOutput.write(data + Data([10])) }
            exit(0)
        }
    }
}
