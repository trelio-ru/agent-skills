import CoreGraphics
import Foundation
import ApplicationServices
import Darwin

// NSWorkspace.frontmostApplication обновляется только с оборотом main run loop.
// В синхронной HID-секции несколько его чтений могут повторить старый PID даже
// после переключения приложения пользователем. Process Manager читает текущий
// foreground синхронно и не зависит от run loop, включая поток watchdog-а.
// https://developer.apple.com/documentation/appkit/nsrunningapplication
// Эти опубликованные C API deprecated и не импортируются как вызовы Swift.
// Узкий compatibility shim использует документированные ABI и проверяет оба
// symbol-а при каждом чтении. На macOS без них ввод отменяется; fallback на
// закешированный AppKit или нестабильный AXFocusedApplication не разрешён.
// https://developer.apple.com/documentation/applicationservices/1501050-getfrontprocess
// https://developer.apple.com/documentation/applicationservices/1500992-getprocesspid
func freshFrontmostPID() -> pid_t? {
    guard let handle = dlopen(
        "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
        RTLD_LAZY | RTLD_LOCAL
    ) else { return nil }
    defer { dlclose(handle) }
    guard let frontSymbol = dlsym(handle, "GetFrontProcess"),
          let pidSymbol = dlsym(handle, "GetProcessPID") else { return nil }
    typealias FrontFunction = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>) -> Int16
    typealias PIDFunction = @convention(c) (UnsafePointer<ProcessSerialNumber>, UnsafeMutablePointer<pid_t>) -> Int32
    return readForegroundPID(
        getFrontProcess: unsafeBitCast(frontSymbol, to: FrontFunction.self),
        getProcessPID: unsafeBitCast(pidSymbol, to: PIDFunction.self)
    )
}

// Инъекция только native reads позволяет проверять ошибки и смену процесса
// без переключения пользовательского приложения в детерминированных тестах.
func readForegroundPID(
    getFrontProcess: (UnsafeMutablePointer<ProcessSerialNumber>) -> Int16,
    getProcessPID: (UnsafePointer<ProcessSerialNumber>, UnsafeMutablePointer<pid_t>) -> Int32
) -> pid_t? {
    var serial = ProcessSerialNumber(highLongOfPSN: 0, lowLongOfPSN: 0)
    var pid: pid_t = 0
    guard getFrontProcess(&serial) == 0,
          getProcessPID(&serial, &pid) == 0, pid > 0 else { return nil }
    return pid
}

// Общий оконный контракт CLI и supervisor принимает наблюдения снаружи:
// гонки фокуса и геометрии проверяются детерминированно, без отправки тестовых
// событий в приложения пользователя.
struct InputWindowIdentity: Equatable, Codable {
    let id: UInt32
    let pid: Int32
    let bounds: CGRect

    func matches(_ other: InputWindowIdentity) -> Bool {
        id == other.id && pid == other.pid && bounds == other.bounds
    }
}

// LaunchServices выбирает приложение по bundle/path и может активировать другой
// экземпляр Chrome. Здесь обе стороны handoff адресуют конкретный живой PID.
// ABI этих опубликованных, но deprecated C API проверяется до переключения.
func activateExactProcess(_ pid: pid_t) -> Bool {
    guard pid > 0, kill(pid, 0) == 0 || errno == EPERM,
          let handle = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY | RTLD_LOCAL) else { return false }
    defer { dlclose(handle) }
    guard let getSymbol = dlsym(handle, "GetProcessForPID"),
          let setSymbol = dlsym(handle, "SetFrontProcessWithOptions") else { return false }
    typealias GetFunction = @convention(c) (pid_t, UnsafeMutablePointer<ProcessSerialNumber>) -> Int32
    typealias SetFunction = @convention(c) (UnsafePointer<ProcessSerialNumber>, UInt32) -> Int32
    var serial = ProcessSerialNumber(highLongOfPSN: 0, lowLongOfPSN: 0)
    let getProcess = unsafeBitCast(getSymbol, to: GetFunction.self)
    let setProcess = unsafeBitCast(setSymbol, to: SetFunction.self)
    return getProcess(pid, &serial) == 0 && setProcess(&serial, 1) == 0
}

// Учитываем не только начало жеста, но и scroll/drag/up/модификаторы. Возраст
// событий сам по себе не доказывает покой: зажатая клавиша или кнопка также
// запрещает handoff. Caps Lock как переключённый режим не считается зажатием.
let physicalInputEventTypes: [CGEventType] = [
    .mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
    .otherMouseDown, .otherMouseUp, .leftMouseDragged, .rightMouseDragged,
    .otherMouseDragged, .scrollWheel, .keyDown, .keyUp, .flagsChanged,
    .tabletPointer, .tabletProximity,
]

// Ожидание покоя и короткое владение вводом имеют разные бюджеты. Десять минут
// разрешают пользователю продолжать работу, но не увеличивают двухсекундный
// deadline guardian-а. Запрос оставляет запас на IPC и возврат управления.
let inputIdleRequiredSeconds: TimeInterval = 3
let inputIdleWaitTimeout: TimeInterval = 600
let inputRequestTimeout: TimeInterval = inputIdleWaitTimeout + 10
let sessionDefaultIdleTimeout: TimeInterval = 1_800
let sessionDefaultHardTimeout: TimeInterval = 7_200

func hasIdleInput(age: TimeInterval, heldKey: Bool, heldButton: Bool, modifiers: CGEventFlags) -> Bool {
    age >= inputIdleRequiredSeconds && !heldKey && !heldButton
        && modifiers.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift, .maskSecondaryFn]).isEmpty
}

func physicalInputIsIdle() -> Bool {
    let state = CGEventSourceStateID.hidSystemState
    let age = physicalInputEventTypes.map { CGEventSource.secondsSinceLastEventType(state, eventType: $0) }.min() ?? 0
    let keyHeld = (0..<128).contains { $0 != 57 && CGEventSource.keyState(state, key: CGKeyCode($0)) }
    let buttonHeld = (0..<32).contains { CGEventSource.buttonState(state, button: CGMouseButton(rawValue: UInt32($0))!) }
    return hasIdleInput(age: age, heldKey: keyHeld, heldButton: buttonHeld, modifiers: CGEventSource.flagsState(state))
}

// Возвращаться к ожиданию можно только при доказанно неотправленном вводе и
// завершённом handoff (либо до его начала). Отсутствующие поля, crash и даже
// одно отправленное mouseMoved не разрешают слепой повтор действия.
func canRetryUnstartedInput(_ result: [String: Any]) -> Bool {
    let code = result["error_code"] as? String
    return result["ok"] as? Bool == false
        && (code == "input_not_idle" || code == "input_user_active")
        && result["events_posted"] as? Bool == false
        && result["verification_required"] as? Bool == false
        && (result["restored_front_app"] as? Bool == true || result["handoff_started"] as? Bool == false)
}

// Это production-цикл ожидания, а не агентские повторы tool call. Один deadline
// сохраняется при любой гонке до отправки событий. Проверка жизни caller-а,
// session stop и hard timeout выполняется и при занятом, и при свободном вводе.
// Инъекции clock/наблюдений позволяют проверить десять минут без реального HID.
func performAfterInputIdle(
    timeout: TimeInterval = inputIdleWaitTimeout,
    isIdle: () -> Bool = physicalInputIsIdle,
    checkAllowed: () throws -> Void,
    attempt: () throws -> [String: Any],
    now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    pause: (TimeInterval) -> Void = { RunLoop.current.run(until: Date(timeIntervalSinceNow: $0)) }
) throws -> [String: Any] {
    let started = now()
    let deadline = started + timeout
    var attempts = 0
    while now() < deadline {
        try checkAllowed()
        if isIdle() {
            // Проверка состояния сама может занять время; просроченная команда
            // не получает поздний handoff даже при появившемся покое.
            guard now() < deadline else { break }
            let waited = max(0, now() - started)
            attempts += 1
            var result = try attempt()
            if !canRetryUnstartedInput(result) {
                result["input_wait_seconds"] = waited
                result["idle_required_seconds"] = inputIdleRequiredSeconds
                result["input_attempts"] = attempts
                return result
            }
        }
        pause(min(0.1, max(0, deadline - now())))
    }
    throw InputSafetyError(
        code: "input_idle_timeout",
        message: "За десять минут не появилось безопасного окна из трёх секунд без ввода; действие не отправлено.",
        details: ["events_posted": false, "verification_required": false,
                  "input_wait_seconds": max(0, now() - started),
                  "idle_required_seconds": inputIdleRequiredSeconds, "input_attempts": attempts]
    )
}

func inputRequestIsLive(clientPID: pid_t?, expiresAt: TimeInterval?, now: TimeInterval, processAlive: (pid_t) -> Bool) -> Bool {
    guard let pid = clientPID, pid > 0, let deadline = expiresAt,
          deadline.isFinite, deadline > now, deadline <= now + inputRequestTimeout + 5 else { return false }
    return processAlive(pid)
}

// Только однострочный обычный текст. Enter/Tab и управляющие символы не могут
// незаметно превратить ввод в отправку формы. UTF-16 chunks не разрывают emoji,
// surrogate pair либо составной символ; никакой нормализации/усечения нет.
func inputTextChunks(_ text: String) throws -> [[UniChar]] {
    guard !text.isEmpty, text.utf8.count <= 1024, text.utf16.count <= 128,
          !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || $0.value == 0x2028 || $0.value == 0x2029 }) else {
        throw InputSafetyError(code: "invalid_input_text", message: "Нужен непустой однострочный текст до 128 UTF-16 единиц без управляющих символов.")
    }
    var chunks: [[UniChar]] = []
    for character in text {
        let units = Array(String(character).utf16)
        guard units.count <= 16 else {
            throw InputSafetyError(code: "invalid_input_text", message: "Составной символ слишком длинный для одного события; текст не отправлен.")
        }
        chunks.append(units)
    }
    return chunks
}

struct GuardedInputOperation: Codable {
    let command: String
    let parentPID: Int32
    let callerPID: Int32
    let window: InputWindowIdentity
    let virtualBounds: CGRect
    let displayID: UInt32
    let mainDisplayID: UInt32
    let x: Double
    let y: Double
    let count: Int
    let direction: String
    let pixels: Int
    let text: String?
}

// Чистое состояние admission используется настоящим event tap и тестами.
// События другого процесса (включая другой агент) прекращают операцию. Во время
// восстановления разрешены только наши отпускания уже созданных down-событий.
struct InputEventAdmission {
    var active = true
    var cancelling = false
    var reason: String?

    mutating func accepts(owned: Bool, release: Bool) -> Bool {
        guard active else { return !owned }
        if !owned {
            cancelling = true
            if reason == nil { reason = "input_user_active" }
            return false
        }
        return !cancelling || release
    }

    mutating func cancel(_ code: String) {
        cancelling = true
        if reason == nil { reason = code }
    }
}

struct InputSafetyError: LocalizedError {
    let code: String
    let message: String
    var details: [String: Any] = [:]
    var errorDescription: String? { message }
}

enum InputMode: Equatable {
    case hidden
    case visible
}

func resolveInputMode(session: String?, activeSession: String?, visible: Bool) throws -> InputMode {
    // Завершившаяся lease никогда не означает разрешение отправить тот же клик
    // на физический экран. Видимый ввод выбирается отдельным явным аргументом.
    if visible {
        guard session == nil, activeSession == nil else {
            throw InputSafetyError(code: "input_mode_conflict", message: "--visible нельзя совмещать со скрытой сессией.")
        }
        return .visible
    }
    guard let session, !session.isEmpty else {
        throw InputSafetyError(code: "hidden_session_required", message: "Для управления нужен --session ID после session start. Видимый режим выбирается только явным --visible.")
    }
    guard session == activeSession else {
        throw InputSafetyError(code: "session_not_active", message: "Указанная сессия не активна; действие отменено без перехода на обычный экран.")
    }
    return .hidden
}

func prepareStableInputWindow(
    timeout: TimeInterval = 3,
    readReady: () -> InputWindowIdentity?,
    activate: () throws -> Void,
    raise: () -> Void,
    now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    pause: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }
) throws -> InputWindowIdentity {
    let deadline = now() + timeout
    var previous: InputWindowIdentity?
    var stableSamples = 0
    var activated = false

    while now() < deadline {
        if let current = readReady() {
            stableSamples = previous?.matches(current) == true ? stableSamples + 1 : 1
            previous = current
            if stableSamples >= 3 { return current }
        } else {
            previous = nil
            stableSamples = 0
            if !activated {
                try activate()
                activated = true
            } else {
                // AXRaise может вернуть AttributeUnsupported даже для рабочего
                // AXWindow. Доказательство готовности — свежие наблюдения окна,
                // а не успех вспомогательного AX-вызова.
                raise()
            }
        }
        pause(0.08)
    }
    throw InputSafetyError(code: "input_window_not_ready", message: "Точное рабочее окно не получило стабильный фокус и геометрию; события не отправлены.")
}

func normalizedInputPoint(window: InputWindowIdentity, x: Double, y: Double) throws -> CGPoint {
    let bounds = window.bounds
    guard x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y),
          bounds.minX.isFinite, bounds.minY.isFinite,
          bounds.width.isFinite, bounds.height.isFinite,
          bounds.width > 1, bounds.height > 1 else {
        throw InputSafetyError(code: "invalid_input_point", message: "Для ввода нужны конечные координаты 0...1 и непустое окно.")
    }
    // CGRect не включает правую/нижнюю границу: значение 1 остаётся внутри
    // последней половины point, вместо попадания в соседнее окно/рабочий стол.
    return CGPoint(
        x: min(bounds.maxX - 0.5, bounds.minX + CGFloat(x) * bounds.width),
        y: min(bounds.maxY - 0.5, bounds.minY + CGFloat(y) * bounds.height)
    )
}

func validateInputTarget(
    expected: InputWindowIdentity,
    current: InputWindowIdentity?,
    point: CGPoint
) throws {
    guard let current, expected.matches(current), current.bounds.contains(point) else {
        throw InputSafetyError(code: "input_target_changed", message: "Фокус, окно или его границы изменились перед вводом. Снимите свежий экран перед новым действием.")
    }
}

let guardedInputProtocolVersion = 3

func requireGuardedInputProtocol(_ version: Int?) throws {
    guard version == guardedInputProtocolVersion else {
        throw InputSafetyError(code: "session_runtime_changed", message: "Сессия создана старым исполнителем. Завершите её через session stop с точным ID и создайте новую session start.")
    }
}

// Supervisor имеет внешний deadline: SIGSTOP либо зависание main run loop
// ребёнка не выключают эту страховку. Возврат означает, что остановленный
// отправитель уже reap-нут; восстановление фокуса выполняется только после.
@discardableResult
func waitForGuardedChild(_ child: Process, timeout: TimeInterval = 2.4, shouldContinue: () -> Bool = { true }) -> Bool {
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    while child.isRunning, ProcessInfo.processInfo.systemUptime < deadline, shouldContinue() {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.01))
    }
    let forced = child.isRunning
    if forced {
        kill(child.processIdentifier, SIGKILL)
        child.waitUntilExit()
    }
    return forced
}
