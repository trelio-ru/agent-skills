import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import Vision

private let bundleIdentifier = "com.apple.ScreenContinuity"
private let russianWindowTitle = "Видеоповтор iPhone"
private let englishWindowTitle = "iPhone Mirroring"
private let runtimeOutputOptions = RuntimeOutputOptions(arguments: Array(CommandLine.arguments.dropFirst()))
// Разрешаем read-back ошибки только после входа в действие, а не после
// неверного аргумента. Это не запускает новый ввод и не повторяет команду.
private var observationAfterAction = false

private enum MirrorError: LocalizedError {
    case usage(String)
    case unavailable(String)
    case permission(String)
    case unsafe(String)
    case timeout(String)

    var errorDescription: String? {
        switch self {
        case .usage(let message), .unavailable(let message), .permission(let message),
             .unsafe(let message), .timeout(let message):
            return message
        }
    }

    var exitCode: Int32 {
        switch self {
        case .usage: return 2
        case .unavailable: return 3
        case .permission: return 4
        case .unsafe: return 5
        case .timeout: return 6
        }
    }
}

private struct WindowRecord {
    let id: CGWindowID
    let pid: pid_t
    let ownerName: String
    let title: String
    let bounds: CGRect
    let layer: Int
    let alpha: Double
    let isOnscreen: Bool
    let onscreenRank: Int?

    var inputIdentity: InputWindowIdentity {
        InputWindowIdentity(id: id, pid: pid, bounds: bounds)
    }

    var json: [String: Any] {
        [
            "id": Int(id),
            "pid": Int(pid),
            "owner_name": ownerName,
            "title": title,
            "bounds": [
                "x": Double(bounds.origin.x),
                "y": Double(bounds.origin.y),
                "width": Double(bounds.width),
                "height": Double(bounds.height),
            ],
            "layer": layer,
            "alpha": alpha,
            "is_onscreen": isOnscreen,
            "onscreen_rank": onscreenRank as Any,
        ]
    }
}

private func normalized(_ value: String) -> String {
    let replaced = value
        .replacingOccurrences(of: "\u{00A0}", with: " ")
        .replacingOccurrences(of: "\u{202F}", with: " ")
        .lowercased()
    return replaced.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func number(_ value: Any?) -> NSNumber? {
    value as? NSNumber
}

private func rect(_ value: Any?) -> CGRect? {
    guard let dictionary = value as? [String: Any],
          let x = number(dictionary["X"])?.doubleValue,
          let y = number(dictionary["Y"])?.doubleValue,
          let width = number(dictionary["Width"])?.doubleValue,
          let height = number(dictionary["Height"])?.doubleValue else {
        return nil
    }
    return CGRect(x: x, y: y, width: width, height: height)
}

private func rawWindowDictionaries(_ option: CGWindowListOption) -> [[String: Any]] {
    CGWindowListCopyWindowInfo(option, kCGNullWindowID) as? [[String: Any]] ?? []
}

private func windows(for pid: pid_t) -> [WindowRecord] {
    // `kCGWindowIsOnscreen` is absent for windows on another Space. A separate
    // on-screen list gives an unambiguous membership test and z-order rank.
    let onscreen = rawWindowDictionaries([.optionOnScreenOnly, .excludeDesktopElements])
    var onscreenRanks: [CGWindowID: Int] = [:]
    for (index, dictionary) in onscreen.enumerated() {
        if let id = number(dictionary[kCGWindowNumber as String])?.uint32Value {
            onscreenRanks[id] = index
        }
    }

    return rawWindowDictionaries(.optionAll).compactMap { dictionary in
        guard number(dictionary[kCGWindowOwnerPID as String])?.int32Value == pid,
              let id = number(dictionary[kCGWindowNumber as String])?.uint32Value,
              let bounds = rect(dictionary[kCGWindowBounds as String]) else {
            return nil
        }

        return WindowRecord(
            id: id,
            pid: pid,
            ownerName: dictionary[kCGWindowOwnerName as String] as? String ?? "",
            title: dictionary[kCGWindowName as String] as? String ?? "",
            bounds: bounds,
            layer: number(dictionary[kCGWindowLayer as String])?.intValue ?? -1,
            alpha: number(dictionary[kCGWindowAlpha as String])?.doubleValue ?? 1,
            isOnscreen: onscreenRanks[id] != nil,
            onscreenRank: onscreenRanks[id]
        )
    }
}

private func runningApp() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
        .first(where: { !$0.isTerminated })
}

private func ensureRunningApp(timeout: TimeInterval = 12) throws -> NSRunningApplication {
    if let app = runningApp() {
        return app
    }

    // `open -b` uses the system LaunchServices registration and avoids any
    // hard-coded localized application path.
    let launcher = Process()
    launcher.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    launcher.arguments = ["-b", bundleIdentifier]
    try launcher.run()
    launcher.waitUntilExit()
    guard launcher.terminationStatus == 0 else {
        throw MirrorError.unavailable("Не удалось запустить \(bundleIdentifier).")
    }

    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if let app = runningApp() {
            return app
        }
        Thread.sleep(forTimeInterval: 0.2)
    }
    throw MirrorError.timeout("Приложение запущено, но процесс не появился за \(Int(timeout)) с.")
}

private func activateBundle(_ identifier: String) throws {
    let launcher = Process()
    launcher.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    launcher.arguments = ["-b", identifier]
    try launcher.run()
    launcher.waitUntilExit()
    guard launcher.terminationStatus == 0 else {
        throw MirrorError.unavailable("LaunchServices не смог активировать \(identifier).")
    }
}

private func isWelcomeWindow(_ record: WindowRecord) -> Bool {
    let title = normalized(record.title)
    return title.contains("добро пожаловать") || title.contains("welcome")
}

private func isWorkingWindow(_ record: WindowRecord, app: NSRunningApplication) -> Bool {
    guard record.layer == 0, !isWelcomeWindow(record) else { return false }
    let title = normalized(record.title)
    let accepted = [russianWindowTitle, englishWindowTitle, app.localizedName ?? ""]
        .map(normalized)
        .filter { !$0.isEmpty }
    return accepted.contains(title)
}

private func workingWindow(for app: NSRunningApplication) -> WindowRecord? {
    windows(for: app.processIdentifier)
        .filter { isWorkingWindow($0, app: app) }
        .sorted {
            if $0.isOnscreen != $1.isOnscreen { return $0.isOnscreen }
            if $0.onscreenRank != $1.onscreenRank {
                return ($0.onscreenRank ?? Int.max) < ($1.onscreenRank ?? Int.max)
            }
            return $0.bounds.width * $0.bounds.height > $1.bounds.width * $1.bounds.height
        }
        .first
}

private func waitForWorkingWindow(for app: NSRunningApplication, timeout: TimeInterval = 12) throws -> WindowRecord {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if let record = workingWindow(for: app) {
            return record
        }
        Thread.sleep(forTimeInterval: 0.2)
    }
    throw MirrorError.timeout("Не найдено точное рабочее окно «\(russianWindowTitle)» за \(Int(timeout)) с.")
}

private func capture(_ record: WindowRecord, to outputURL: URL) throws {
    try FileManager.default.createDirectory(
        at: outputURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try? FileManager.default.removeItem(at: outputURL)

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-o", "-l", String(record.id), outputURL.path]
    let errorPipe = Pipe()
    process.standardError = errorPipe
    try process.run()
    process.waitUntilExit()

    guard process.terminationStatus == 0, FileManager.default.fileExists(atPath: outputURL.path) else {
        let data = errorPipe.fileHandleForReading.readDataToEndOfFile()
        let detail = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        throw MirrorError.permission(
            detail.isEmpty
                ? "Не удалось снять окно. Проверьте разрешение «Запись экрана» у вызывающего процесса."
                : "Не удалось снять окно: \(detail)"
        )
    }
}

private func recognizeText(in imageURL: URL) throws -> [String] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["ru-RU", "en-US"]

    let handler = VNImageRequestHandler(url: imageURL, options: [:])
    try handler.perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
}

private func screenshotPayload(arguments: [String], outputURL: URL) throws -> [String: Any] {
    try refreshSessionActivityIfActive(arguments: arguments)
    guard let app = runningApp() else {
        throw MirrorError.unavailable("Видеоповтор не запущен. Для HID-серии сначала выполните session start.")
    }
    let record = try waitForWorkingWindow(for: app)
    try capture(record, to: outputURL)
    let lines = try recognizeText(in: outputURL)
    return runtimeScreenshotPayload(
        command: arguments.first ?? "screenshot", output: outputURL.path,
        capturedAt: Int(Date().timeIntervalSince1970 * 1_000),
        screenState: classifyScreen(lines), window: record.json, recognizedText: lines
    )
}

private func automaticScreenshot(arguments: [String]) throws -> [String: Any] {
    try withPrivateRuntimeObservation {
        try screenshotPayload(arguments: arguments, outputURL: $0)
    }
}

private func observedResult(_ result: [String: Any], arguments: [String]) -> [String: Any] {
    guard runtimeOutputOptions.observe else { return result }
    return addingRuntimeObservation(to: result) { try automaticScreenshot(arguments: arguments) }
}

private func emitActionResult(_ result: [String: Any], arguments: [String], legacyStatus: Bool = true) {
    if runtimeOutputOptions.observe {
        // Один захват даёт и сохранённый PNG, и классификацию. Старый путь
        // status снимал окно ради OCR и сразу удалял тот же нужный агенту кадр.
        emitJSON(observedResult(result, arguments: arguments))
    } else {
        var payload = result
        if legacyStatus { payload["status"] = status(includeOCR: true) }
        emitJSON(payload)
    }
}

private func classifyScreen(_ lines: [String]) -> String {
    let text = normalized(lines.joined(separator: " "))
    if text.contains("подключение прервано") || text.contains("connection interrupted") {
        return "interrupted"
    }
    if text.contains("iphone используется") || text.contains("iphone is in use") {
        return "iphone_in_use"
    }
    if text.contains("iphone не найден") || text.contains("iphone not found") {
        return "iphone_not_found"
    }
    if text.contains("время истекло") || text.contains("timed out") {
        return "timed_out"
    }
    if text.contains("введите код-парол")
        || text.contains("код-пароль на iphone")
        || text.contains("разблокируйте iphone")
        || text.contains("passcode required")
        || text.contains("enter your passcode")
        || text.contains("unlock your iphone") {
        return "physical_unlock_required"
    }
    if text.contains("не удалось подключ") || text.contains("unable to connect") || text.contains("could not connect") {
        return "error"
    }
    if text.contains("подключение:") || text.contains("connecting to") {
        return "connecting"
    }

    // В подключённом режиме на экране может не быть распознаваемого текста
    // (например, только обои). Поэтому отсутствие известных системных экранов
    // является кандидатом на подключение, а не доказанным состоянием.
    return "connected_or_unknown"
}

private func status(includeOCR: Bool) -> [String: Any] {
    guard let app = runningApp() else {
        return [
            "bundle_id": bundleIdentifier,
            "app_running": false,
            "screen_state": "app_not_running",
            "ax_trusted": AXIsProcessTrusted(),
        ]
    }

    let records = windows(for: app.processIdentifier)
    let welcome = records.filter(isWelcomeWindow)
    guard let working = workingWindow(for: app) else {
        return [
            "bundle_id": bundleIdentifier,
            "app_running": true,
            "pid": Int(app.processIdentifier),
            "frontmost": freshFrontmostPID() == app.processIdentifier,
            "screen_state": welcome.isEmpty ? "working_window_not_found" : "welcome_only",
            "ax_trusted": AXIsProcessTrusted(),
            "welcome_windows": welcome.map(\.json),
        ]
    }

    var result: [String: Any] = [
        "bundle_id": bundleIdentifier,
        "app_running": true,
        "pid": Int(app.processIdentifier),
        "frontmost": freshFrontmostPID() == app.processIdentifier,
        "ax_trusted": AXIsProcessTrusted(),
        "working_window": working.json,
        "welcome_windows": welcome.map(\.json),
        "screen_state": "unknown",
    ]

    let accessibilityLines = workingAXWindow(for: app).map { collectAXText($0) } ?? []
    result["ax_text"] = accessibilityLines

    guard includeOCR else {
        result["screen_state"] = "not_checked"
        return result
    }

    let temporaryURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("iphone-mirroring-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: temporaryURL) }

    do {
        try capture(working, to: temporaryURL)
        let lines = try recognizeText(in: temporaryURL)
        result["recognized_text"] = lines
        result["screen_state"] = classifyScreen(accessibilityLines + lines)
    } catch {
        result["screen_state"] = accessibilityLines.isEmpty
            ? "unknown"
            : classifyScreen(accessibilityLines)
        result["screen_state_error"] = error.localizedDescription
    }
    return result
}

private func copyAXAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    return result == .success ? value : nil
}

private func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    copyAXAttribute(element, attribute) as? String
}

private func axActionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return names as? [String] ?? []
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    copyAXAttribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

private func collectAXText(_ element: AXUIElement, depth: Int = 0) -> [String] {
    guard depth <= 8 else { return [] }
    let role = axString(element, kAXRoleAttribute) ?? ""
    var result: [String] = []
    if role == kAXStaticTextRole || role == kAXButtonRole || role == kAXImageRole {
        for attribute in [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute] {
            if let value = axString(element, attribute), !value.isEmpty, !result.contains(value) {
                result.append(value)
            }
        }
    }
    for child in axChildren(element) {
        result.append(contentsOf: collectAXText(child, depth: depth + 1))
    }
    return result
}

private func axWindows(for pid: pid_t) -> [AXUIElement] {
    let application = AXUIElementCreateApplication(pid)
    var result = copyAXAttribute(application, kAXWindowsAttribute) as? [AXUIElement] ?? []

    // ScreenContinuity на macOS 26 иногда возвращает пустой AXWindows, хотя
    // AXFocusedWindow/AXMainWindow содержат полноценное окно. Учитываем оба
    // атрибута и обычных AXWindow-детей, не полагаясь на один мост NSArray.
    let candidates = [kAXFocusedWindowAttribute, kAXMainWindowAttribute].compactMap { attribute -> AXUIElement? in
        guard let raw = copyAXAttribute(application, attribute) else { return nil }
        // ScreenContinuity на macOS 26 может ошибочно представить обычное
        // CF-приведение как AXApplication. Битовое представление остаётся тем
        // же AXUIElement и ниже обязательно проверяется по роли AXWindow.
        return unsafeBitCast(raw, to: AXUIElement.self)
    } + axChildren(application).filter { child in
        axString(child, kAXRoleAttribute) == kAXWindowRole
    }

    for candidate in candidates where !result.contains(where: { CFEqual($0, candidate) }) {
        result.append(candidate)
    }
    return result
}

private func workingAXWindow(for app: NSRunningApplication) -> AXUIElement? {
    let accepted = [russianWindowTitle, englishWindowTitle, app.localizedName ?? ""]
        .map(normalized)
        .filter { !$0.isEmpty }
    return axWindows(for: app.processIdentifier).first { window in
        guard axString(window, kAXRoleAttribute) == kAXWindowRole else { return false }
        guard let title = axString(window, kAXTitleAttribute) else { return false }
        let cleanTitle = normalized(title)
        return accepted.contains(cleanTitle)
            && !cleanTitle.contains("добро пожаловать")
            && !cleanTitle.contains("welcome")
    }
}

private func setAXBoolean(_ element: AXUIElement, attribute: String, value: Bool) {
    let boolean: CFBoolean = value ? kCFBooleanTrue : kCFBooleanFalse
    _ = AXUIElementSetAttributeValue(element, attribute as CFString, boolean)
}

private func safeWorkingWindow(for app: NSRunningApplication) -> WindowRecord? {
    guard freshFrontmostPID() == app.processIdentifier,
          let working = workingWindow(for: app),
          working.isOnscreen,
          let workingRank = working.onscreenRank else {
        return nil
    }

    // Если окно приветствия или другая панель приложения лежит выше рабочего
    // окна, глобальный CGEvent может попасть не туда. Такой клик запрещаем.
    let higherSibling = windows(for: app.processIdentifier).contains { candidate in
        candidate.id != working.id
            && candidate.layer == 0
            && candidate.isOnscreen
            && (candidate.onscreenRank ?? Int.max) < workingRank
    }
    return higherSibling ? nil : working
}

@discardableResult
private func focusWorkingWindow(_ app: NSRunningApplication) throws -> WindowRecord {
    guard AXIsProcessTrusted() else {
        throw MirrorError.permission("Нет разрешения «Универсальный доступ» для выбора рабочего окна.")
    }
    var lastRaiseResult: AXError?
    let identity: InputWindowIdentity
    do {
        identity = try prepareStableInputWindow(
            timeout: 6,
            readReady: { safeWorkingWindow(for: app)?.inputIdentity },
            activate: {
                _ = app.unhide()
                try activateBundle(bundleIdentifier)
            },
            raise: {
                guard let candidate = workingAXWindow(for: app) else { return }
                setAXBoolean(candidate, attribute: kAXMainAttribute, value: true)
                setAXBoolean(candidate, attribute: kAXFocusedAttribute, value: true)
                lastRaiseResult = AXUIElementPerformAction(candidate, kAXRaiseAction as CFString)
            }
        )
    } catch let error as InputSafetyError {
        // AttributeUnsupported / CannotComplete — ошибка взаимодействия с
        // конкретным окном. Запрашивать новые TCC-разрешения по ней неверно.
        let detail = lastRaiseResult.map { " Последний AXRaise: AXError \($0.rawValue)." } ?? ""
        throw InputSafetyError(code: error.code, message: error.message + detail)
    }
    guard let window = safeWorkingWindow(for: app), identity.matches(window.inputIdentity) else {
        throw InputSafetyError(code: "input_target_changed", message: "Окно изменилось после проверки готовности; действие отменено.")
    }
    return window
}

private func centerWorkingWindow(_ app: NSRunningApplication) throws -> WindowRecord {
    guard AXIsProcessTrusted() else {
        throw MirrorError.permission("Для фонового перемещения окна нужен «Универсальный доступ».")
    }
    let record = try waitForWorkingWindow(for: app)
    guard let axWindow = workingAXWindow(for: app) else {
        throw MirrorError.unavailable("Не найдено AX-окно для центрирования.")
    }

    // Центрируем на основном дисплее. Это намеренно переносит окно с дисплея с
    // отрицательным X, где старые координатные инструменты работали ненадёжно.
    let display = CGDisplayBounds(CGMainDisplayID())
    let menuBarAllowance: CGFloat = 34
    let bottomAllowance: CGFloat = 16
    let visibleTop = display.minY + menuBarAllowance
    let visibleHeight = max(0, display.height - menuBarAllowance - bottomAllowance)
    var target = CGPoint(
        x: display.minX + max(0, (display.width - record.bounds.width) / 2),
        y: visibleTop + max(0, (visibleHeight - record.bounds.height) / 2)
    )

    guard let position = AXValueCreate(.cgPoint, &target) else {
        throw MirrorError.unavailable("Не удалось создать AX-позицию окна.")
    }
    let setResult = AXUIElementSetAttributeValue(axWindow, kAXPositionAttribute as CFString, position)
    guard setResult == .success else {
        throw MirrorError.permission("Accessibility не смог переместить окно (AXError \(setResult.rawValue)).")
    }

    Thread.sleep(forTimeInterval: 0.3)
    guard let updated = workingWindow(for: app) else {
        throw MirrorError.unavailable("Окно исчезло после центрирования.")
    }
    return updated
}

private struct FrontAppSnapshot {
    let pid: pid_t?
    let bundleIdentifier: String?
    let name: String?
    let path: String?
}

private func frontAppSnapshot() throws -> FrontAppSnapshot {
    // Возвращаем значения, а не NSRunningApplication: удержание объекта
    // frontmostApplication мешало ScreenContinuity стать активным на macOS 26.
    guard let pid = freshFrontmostPID(),
          let current = NSRunningApplication(processIdentifier: pid) else {
        throw InputSafetyError(code: "input_focus_unavailable", message: "Не удалось прочитать текущий фокус для безопасного возврата; ввод отменён.")
    }
    return FrontAppSnapshot(
        pid: current.processIdentifier,
        bundleIdentifier: current.bundleIdentifier,
        name: current.localizedName,
        path: current.bundleURL?.path
    )
}

private func restoreFrontApp(_ snapshot: FrontAppSnapshot, excluding pid: pid_t) {
    guard let previousPID = snapshot.pid, previousPID != pid else { return }
    guard let previous = NSRunningApplication(processIdentifier: previousPID), !previous.isTerminated else {
        return
    }
    _ = activateExactProcess(previousPID)
}

private func clickNormalized(app: NSRunningApplication, x: Double, y: Double, count: Int) throws -> [String: Any] {
    guard (0...1).contains(x), (0...1).contains(y) else {
        throw MirrorError.usage("--x и --y должны находиться в диапазоне 0...1.")
    }
    guard count == 1 || count == 2 else {
        throw MirrorError.usage("--count поддерживает только 1 или 2.")
    }

    let previous = try frontAppSnapshot()
    defer {
        // Внутренний поток iPhone не принимает адресные фоновые mouse events:
        // это проверено отдельно через CGEventPostToPid. Поэтому на время тапа
        // окно становится активным, после чего прежнее приложение возвращается
        // без закрытия/скрытия и без изменения его данных.
        restoreFrontApp(previous, excluding: app.processIdentifier)
    }

    let record = try focusWorkingWindow(app)
    let point = try normalizedInputPoint(window: record.inputIdentity, x: x, y: y)
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        throw MirrorError.unavailable("Не удалось создать источник событий CoreGraphics.")
    }

    // Перемещение курсора перед нажатием важно для iPhone Mirroring: приложение
    // применяет hover/targeting к фактической глобальной позиции указателя.
    let originalLocation = CGEvent(source: nil)?.location
    defer {
        if let originalLocation {
            CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: originalLocation, mouseButton: .left)?
                .post(tap: .cghidEventTap)
        }
    }
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?
        .post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.05)

    for index in 1...count {
        // Hover и активация могут изменить геометрию окна. Прямо перед down
        // проверяем тот же window ID, PID, bounds и foreground, без автоповтора.
        try validateInputTarget(expected: record.inputIdentity, current: safeWorkingWindow(for: app)?.inputIdentity, point: point)
        guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
            throw MirrorError.unavailable("Не удалось создать событие мыши CoreGraphics.")
        }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        down.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.06)
        up.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.08)
    }

    return [
        "action": "click",
        "normalized": ["x": x, "y": y],
        "global_point": ["x": Double(point.x), "y": Double(point.y)],
        "window": record.json,
        "restored_front_app": previous.name ?? NSNull(),
        "events_posted": true,
        "verification_required": true,
    ]
}

private func scrollContent(app: NSRunningApplication, direction: String, pixels: Int) throws -> [String: Any] {
    guard direction == "up" || direction == "down" else {
        throw MirrorError.usage("--direction должен быть up или down.")
    }
    guard (20...2000).contains(pixels) else {
        throw MirrorError.usage("--pixels должен находиться в диапазоне 20...2000.")
    }

    let previous = try frontAppSnapshot()
    defer { restoreFrontApp(previous, excluding: app.processIdentifier) }

    let record = try focusWorkingWindow(app)
    let point = CGPoint(x: record.bounds.midX, y: record.bounds.midY)
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        throw MirrorError.unavailable("Не удалось создать источник событий CoreGraphics.")
    }

    let originalLocation = CGEvent(source: nil)?.location
    defer {
        if let originalLocation {
            CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: originalLocation, mouseButton: .left)?
                .post(tap: .cghidEventTap)
        }
    }
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?
        .post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.05)

    // Несколько меньших событий ближе к физическому wheel/trackpad input и
    // надёжнее одного большого скачка для SwiftUI-списков внутри iPhone.
    let signedPixels = direction == "down" ? -pixels : pixels
    let steps = 6
    for index in 0..<steps {
        try validateInputTarget(expected: record.inputIdentity, current: safeWorkingWindow(for: app)?.inputIdentity, point: point)
        let remaining = signedPixels - (signedPixels / steps) * index
        let delta = index == steps - 1 ? remaining : signedPixels / steps
        guard let event = CGEvent(
            scrollWheelEvent2Source: source,
            units: .pixel,
            wheelCount: 1,
            wheel1: Int32(delta),
            wheel2: 0,
            wheel3: 0
        ) else {
            throw MirrorError.unavailable("Не удалось создать событие прокрутки CoreGraphics.")
        }
        event.location = point
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.035)
    }

    return [
        "action": "scroll",
        "direction": direction,
        "pixels": pixels,
        "window": record.json,
        "restored_front_app": previous.name ?? NSNull(),
        "events_posted": true,
        "verification_required": true,
    ]
}

private func findMenuItem(in element: AXUIElement, titles: Set<String>, depth: Int = 0) -> AXUIElement? {
    guard depth <= 8 else { return nil }
    if let title = axString(element, kAXTitleAttribute), titles.contains(normalized(title)) {
        return element
    }
    for child in axChildren(element) {
        if let match = findMenuItem(in: child, titles: titles, depth: depth + 1) {
            return match
        }
    }
    return nil
}

private func pressNavigationMenu(_ command: String, app: NSRunningApplication) throws {
    guard AXIsProcessTrusted() else {
        throw MirrorError.permission("Для фоновой команды меню нужен «Универсальный доступ».")
    }
    let titles: Set<String>
    switch command {
    case "home":
        titles = [normalized("Экран «Домой»"), normalized("Home Screen")]
    case "app-switcher":
        titles = [normalized("Переключатель приложений"), normalized("App Switcher")]
    default:
        titles = [normalized("Spotlight")]
    }

    let application = AXUIElementCreateApplication(app.processIdentifier)
    guard let item = findMenuItem(in: application, titles: titles) else {
        throw MirrorError.unavailable("Не найден фоновый пункт меню для команды \(command).")
    }
    let result = AXUIElementPerformAction(item, kAXPressAction as CFString)
    guard result == .success else {
        throw MirrorError.permission("Не удалось выполнить фоновую команду \(command) (AXError \(result.rawValue)).")
    }
}

private func findReconnectButton(in element: AXUIElement, depth: Int = 0) -> AXUIElement? {
    guard depth <= 8 else { return nil }
    let labels = [
        axString(element, kAXTitleAttribute),
        axString(element, kAXDescriptionAttribute),
        axString(element, kAXValueAttribute),
    ].compactMap { $0 }.map(normalized)
    // После физической разблокировки или блокировки Apple не обновляет
    // terminal overlay автоматически. На нём остаётся «Подключиться» / Connect,
    // и это то же явное действие восстановления, что «Повторить попытку».
    if labels.contains(where: {
        $0.contains("повторить попытку")
            || $0.contains("try again")
            || $0 == "retry"
            || $0 == "подключиться"
            || $0 == "connect"
    }) {
        return element
    }
    for child in axChildren(element) {
        if let match = findReconnectButton(in: child, depth: depth + 1) {
            return match
        }
    }
    return nil
}

private func pressRetry(_ app: NSRunningApplication) throws {
    guard AXIsProcessTrusted() else {
        throw MirrorError.permission("Для фонового повтора подключения нужен «Универсальный доступ».")
    }
    guard let window = workingAXWindow(for: app),
          let button = findReconnectButton(in: window) else {
        throw MirrorError.unavailable("На текущем экране не найдена AX-кнопка «Повторить попытку» или «Подключиться».")
    }
    let result = AXUIElementPerformAction(button, kAXPressAction as CFString)
    guard result == .success else {
        throw MirrorError.permission("Не удалось нажать кнопку повторного подключения (AXError \(result.rawValue)).")
    }
}

private func absoluteURL(for path: String) -> URL {
    if path.hasPrefix("/") {
        return URL(fileURLWithPath: path)
    }
    return URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        .appendingPathComponent(path)
        .standardizedFileURL
}

private func option(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
        return nil
    }
    return arguments[index + 1]
}

// MARK: - Hidden session lease

private let sessionDirectoryURL: URL = {
    if let configured = ProcessInfo.processInfo.environment["IPHONE_MIRRORING_SESSION_DIR"],
       !configured.isEmpty {
        return URL(fileURLWithPath: configured, isDirectory: true)
    }
    return FileManager.default.temporaryDirectory
        .appendingPathComponent("codex-iphone-mirroring/session-v1", isDirectory: true)
}()

private var sessionStateURL: URL {
    sessionDirectoryURL.appendingPathComponent("state.json")
}

private var sessionActivityURL: URL {
    sessionDirectoryURL.appendingPathComponent("activity")
}

private var sessionRequestsURL: URL {
    sessionDirectoryURL.appendingPathComponent("requests", isDirectory: true)
}

private func readJSONObject(at url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url),
          let object = try? JSONSerialization.jsonObject(with: data),
          let dictionary = object as? [String: Any] else {
        return nil
    }
    return dictionary
}

private func processIsAlive(_ pid: pid_t) -> Bool {
    guard pid > 0 else { return false }
    if kill(pid, 0) == 0 { return true }
    return errno == EPERM
}

private func supervisorPID(in state: [String: Any]) -> pid_t? {
    number(state["supervisorPID"])?.int32Value
}

private func sessionID(in state: [String: Any]) -> String? {
    state["sessionID"] as? String
}

private func activeSessionState() -> [String: Any]? {
    guard let state = readJSONObject(at: sessionStateURL),
          state["status"] as? String == "active",
          let pid = supervisorPID(in: state),
          processIsAlive(pid) else {
        return nil
    }
    return state
}

private func validatedActiveSession(arguments: [String]) throws -> [String: Any]? {
    guard let state = activeSessionState() else {
        if option("--session", in: arguments) != nil {
            throw InputSafetyError(code: "session_not_active", message: "Указанная сессия завершена или недоступна; действие отменено без видимого fallback.")
        }
        return nil
    }
    if let requested = option("--session", in: arguments),
       requested != sessionID(in: state) {
        throw MirrorError.unsafe(
            "--session не совпадает с активной lease-сессией; действие отменено."
        )
    }
    return state
}

private func inputMode(arguments: [String]) throws -> InputMode {
    let active = activeSessionState()
    let mode = try resolveInputMode(
        session: option("--session", in: arguments),
        activeSession: active.flatMap(sessionID),
        visible: arguments.contains("--visible")
    )
    if mode == .hidden { try requireGuardedInputProtocol(number(active?["inputProtocolVersion"])?.intValue) }
    return mode
}

private func touchSessionActivity() throws {
    let payload = "\(Date().timeIntervalSince1970)\n"
    try Data(payload.utf8).write(to: sessionActivityURL, options: .atomic)
}

private func refreshSessionActivityIfActive(arguments: [String]) throws {
    guard try validatedActiveSession(arguments: arguments) != nil else { return }
    try touchSessionActivity()
}

private func sessionStateWithRuntimeFields(_ state: [String: Any]) -> [String: Any] {
    var result = state
    let now = Date().timeIntervalSince1970
    let activityDate = (try? FileManager.default.attributesOfItem(
        atPath: sessionActivityURL.path
    )[.modificationDate] as? Date) ?? nil
    let lastActivity = activityDate?.timeIntervalSince1970
        ?? number(state["lastActivityAt"])?.doubleValue
        ?? now
    let startedAt = number(state["startedAt"])?.doubleValue ?? now
    let idleTimeout = number(state["idleTimeout"])?.doubleValue ?? 0
    let hardTimeout = number(state["hardTimeout"])?.doubleValue ?? 0
    let pid = supervisorPID(in: state) ?? 0
    let isActive = state["status"] as? String == "active" && processIsAlive(pid)

    // Activity file is the lease authority and may be newer than the state
    // snapshot until the supervisor's next 100 ms loop persists it.
    result["lastActivityAt"] = lastActivity
    result["process_alive"] = processIsAlive(pid)
    result["idle_remaining"] = isActive ? max(0, idleTimeout - (now - lastActivity)) : 0
    result["hard_remaining"] = isActive ? max(0, hardTimeout - (now - startedAt)) : 0
    result["session_dir"] = sessionDirectoryURL.path
    return result
}

private func staleSessionLogTail() -> String {
    let logURL = sessionDirectoryURL.appendingPathComponent("supervisor.log")
    guard let data = try? Data(contentsOf: logURL),
          let text = String(data: data, encoding: .utf8) else {
        return ""
    }
    return String(text.suffix(2_000)).trimmingCharacters(in: .whitespacesAndNewlines)
}

private func waitForSessionState(
    supervisorPID: pid_t,
    timeout: TimeInterval
) -> [String: Any]? {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if let state = readJSONObject(at: sessionStateURL) {
            let status = state["status"] as? String
            if status == "active" || status == "ended" {
                return state
            }
        }
        if !processIsAlive(supervisorPID) { break }
        Thread.sleep(forTimeInterval: 0.10)
    }
    return readJSONObject(at: sessionStateURL)
}

private func startHiddenSession(arguments: [String]) throws -> [String: Any] {
    let idleTimeout = option("--idle-timeout", in: arguments).flatMap(Double.init) ?? sessionDefaultIdleTimeout
    let hardTimeout = option("--hard-timeout", in: arguments).flatMap(Double.init) ?? sessionDefaultHardTimeout
    let refreshRate = option("--refresh", in: arguments).flatMap(Double.init) ?? 30
    guard (30...3_600).contains(idleTimeout) else {
        throw MirrorError.usage("--idle-timeout должен быть в диапазоне 30...3600 секунд.")
    }
    guard hardTimeout > idleTimeout, hardTimeout <= 86_400 else {
        throw MirrorError.usage("--hard-timeout должен быть больше idle и не превышать 86400 секунд.")
    }
    guard refreshRate == 30 || refreshRate == 60 else {
        throw MirrorError.usage("--refresh поддерживает 30 или 60 Гц.")
    }

    if let active = activeSessionState() {
        try requireGuardedInputProtocol(number(active["inputProtocolVersion"])?.intValue)
        try touchSessionActivity()
        var result = sessionStateWithRuntimeFields(active)
        result["action"] = "session_start"
        result["reused"] = true
        return result
    }

    // An ended session keeps its final state for diagnostics. Remove only an
    // explicitly scoped temporary directory after proving its supervisor dead.
    if FileManager.default.fileExists(atPath: sessionDirectoryURL.path) {
        if let stale = readJSONObject(at: sessionStateURL),
           let pid = supervisorPID(in: stale),
           processIsAlive(pid) {
            let status = stale["status"] as? String ?? "unknown"
            throw MirrorError.unsafe(
                "Supervisor PID \(pid) ещё жив (status=\(status)); новая сессия не создана."
            )
        }
        try FileManager.default.removeItem(at: sessionDirectoryURL)
    }

    try FileManager.default.createDirectory(
        at: sessionRequestsURL,
        withIntermediateDirectories: true
    )
    let newSessionID = UUID().uuidString.lowercased()
    try Data("\(Date().timeIntervalSince1970)\n".utf8).write(
        to: sessionActivityURL,
        options: .atomic
    )

    guard let supervisorPath = ProcessInfo.processInfo.environment[
        "IPHONE_MIRRORING_SUPERVISOR_PATH"
    ], FileManager.default.isExecutableFile(atPath: supervisorPath) else {
        throw MirrorError.unavailable("Не найден собранный mirror-session-supervisor.")
    }

    let logURL = sessionDirectoryURL.appendingPathComponent("supervisor.log")
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    guard let logHandle = FileHandle(forWritingAtPath: logURL.path) else {
        throw MirrorError.unavailable("Не удалось открыть журнал supervisor.")
    }
    defer { try? logHandle.close() }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: supervisorPath)
    process.arguments = [
        "--session-dir", sessionDirectoryURL.path,
        "--session-id", newSessionID,
        "--idle-timeout", String(idleTimeout),
        "--hard-timeout", String(hardTimeout),
        "--refresh", String(refreshRate),
    ]
    process.standardOutput = logHandle
    process.standardError = logHandle
    try process.run()

    try Data("\(process.processIdentifier)\n".utf8).write(
        to: sessionDirectoryURL.appendingPathComponent("launch.pid"),
        options: .atomic
    )

    guard let state = waitForSessionState(
        supervisorPID: process.processIdentifier,
        timeout: 18
    ), state["status"] as? String == "active" else {
        if process.isRunning { process.terminate() }
        let state = readJSONObject(at: sessionStateURL)
        let reason = state?["exitReason"] as? String ?? staleSessionLogTail()
        throw MirrorError.unavailable(
            reason.isEmpty
                ? "Supervisor не запустил скрытую сессию за 18 секунд."
                : "Supervisor не запустил сессию: \(reason)"
        )
    }

    var result = sessionStateWithRuntimeFields(state)
    result["action"] = "session_start"
    result["reused"] = false
    return result
}

private func sendSupervisorRequest(
    command: String,
    arguments: [String],
    fields: [String: Any] = [:],
    inputText: String? = nil,
    timeout: TimeInterval = inputRequestTimeout
) throws -> [String: Any] {
    guard let state = try validatedActiveSession(arguments: arguments),
          let currentSessionID = sessionID(in: state),
          let pid = supervisorPID(in: state) else {
        throw MirrorError.unavailable("Нет активной скрытой session lease.")
    }

    // Даже SIGKILL Node wrapper-а не должен оставить CLI ждать покоя и позже
    // отправить ввод. Обычные сигналы wrapper пересылает; исчезновение родителя
    // дополнительно обнаруживается здесь без продления запроса.
    let callerParentPID = getppid()
    guard callerParentPID > 1 else {
        throw InputSafetyError(code: "input_request_expired", message: "Вызывающий процесс завершился до запроса.")
    }
    let requestID = UUID().uuidString.lowercased()
    var request: [String: Any] = [
        "id": requestID,
        "sessionID": currentSessionID,
        "command": command,
        "clientPID": getpid(),
        "expiresAt": Date().timeIntervalSince1970 + timeout,
    ]
    for (key, value) in fields { request[key] = value }

    let requestURL = sessionRequestsURL.appendingPathComponent("request-\(requestID).json")
    let responseURL = sessionRequestsURL.appendingPathComponent("response-\(requestID).json")
    let textPath = sessionRequestsURL.appendingPathComponent("input-\(requestID).fifo").path
    var textDescriptor: Int32 = -1
    defer {
        if textDescriptor >= 0 { Darwin.close(textDescriptor); unlink(textPath) }
        // Таймаут не оставляет отложенную команду, которую supervisor мог бы
        // выполнить позже после завершения вызывающего CLI.
        try? FileManager.default.removeItem(at: requestURL)
    }
    if let inputText {
        _ = try inputTextChunks(inputText)
        let bytes = Array(inputText.utf8)
        guard mkfifo(textPath, 0o600) == 0 else {
            throw InputSafetyError(code: "input_text_unavailable", message: "Не удалось открыть канал текста.")
        }
        textDescriptor = Darwin.open(textPath, O_RDWR | O_NONBLOCK | O_NOFOLLOW)
        guard textDescriptor >= 0 else {
            unlink(textPath)
            throw InputSafetyError(code: "input_text_unavailable", message: "Не удалось открыть канал текста.")
        }
        let written = bytes.withUnsafeBytes { Darwin.write(textDescriptor, $0.baseAddress, $0.count) }
        guard written == bytes.count else {
            throw InputSafetyError(code: "input_text_unavailable", message: "Текст не помещён в канал; действие отменено.")
        }
        request["textLength"] = bytes.count
    }
    let data = try JSONSerialization.data(withJSONObject: request, options: [.sortedKeys])
    try data.write(to: requestURL, options: .atomic)
    try touchSessionActivity()

    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    while ProcessInfo.processInfo.systemUptime < deadline {
        guard getppid() == callerParentPID else {
            throw InputSafetyError(code: "input_request_expired", message: "Вызывающий процесс завершился; отложенный ввод отменён.")
        }
        if let response = readJSONObject(at: responseURL) {
            try? FileManager.default.removeItem(at: responseURL)
            if response["ok"] as? Bool == false {
                if let code = response["error_code"] as? String {
                    let safeFields = ["events_posted", "verification_required", "restored_front_app", "previous_pid", "focus_ms", "input_guard", "interruption_event_type", "interruption_source_pid", "interruption_own_marker", "handoff_started", "input_wait_seconds", "idle_required_seconds", "input_attempts"]
                    let details = response.filter { safeFields.contains($0.key) }
                    throw InputSafetyError(code: code, message: response["error"] as? String ?? "Supervisor отменил ввод.", details: details)
                }
                throw MirrorError.unavailable(
                    response["error"] as? String ?? "Supervisor отклонил запрос."
                )
            }
            return response
        }
        if !processIsAlive(pid) {
            throw MirrorError.unavailable(
                "Supervisor завершился до ответа: \(staleSessionLogTail())"
            )
        }
        Thread.sleep(forTimeInterval: 0.05)
    }
    throw MirrorError.timeout("Supervisor не ответил на \(command) за \(timeout) с.")
}

private func hiddenSessionStatus() -> [String: Any] {
    guard let state = readJSONObject(at: sessionStateURL) else {
        return ["action": "session_status", "active": false]
    }
    var result = sessionStateWithRuntimeFields(state)
    result["action"] = "session_status"
    result["active"] = state["status"] as? String == "active"
        && (supervisorPID(in: state).map(processIsAlive) ?? false)
    return result
}

private func keepHiddenSessionAlive(arguments: [String]) throws -> [String: Any] {
    guard let state = try validatedActiveSession(arguments: arguments) else {
        throw MirrorError.unavailable("Нет активной скрытой session lease.")
    }
    try touchSessionActivity()
    var result = sessionStateWithRuntimeFields(state)
    result["action"] = "session_keepalive"
    return result
}

private func stopHiddenSession(arguments: [String]) throws -> [String: Any] {
    guard let state = activeSessionState() else {
        var result = hiddenSessionStatus()
        result["action"] = "session_stop"
        result["already_stopped"] = true
        return result
    }
    if let requested = option("--session", in: arguments),
       requested != sessionID(in: state) {
        throw MirrorError.unsafe("--session не совпадает с активной lease-сессией.")
    }
    let response = try sendSupervisorRequest(
        command: "stop",
        arguments: arguments,
        timeout: 8
    )
    if let pid = supervisorPID(in: state) {
        let deadline = Date().addingTimeInterval(6)
        while processIsAlive(pid), Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
    }
    var result = hiddenSessionStatus()
    result["action"] = "session_stop"
    result["supervisor_response"] = response
    return result
}

private func emitJSON(_ object: [String: Any], to handle: FileHandle = .standardOutput) {
    let payload = runtimeOutputOptions.compact
        ? compactRuntimeOutput(object, includeOCR: runtimeOutputOptions.includeOCR) : object
    var options: JSONSerialization.WritingOptions = [.sortedKeys, .withoutEscapingSlashes]
    if !runtimeOutputOptions.compact { options.insert(.prettyPrinted) }
    guard JSONSerialization.isValidJSONObject(payload),
          let data = try? JSONSerialization.data(
            withJSONObject: payload,
            options: options
          ) else {
        let fallback = "{\"error\":\"Не удалось сериализовать результат.\"}\n"
        handle.write(Data(fallback.utf8))
        return
    }
    handle.write(data)
    handle.write(Data("\n".utf8))
}

private let usage = """
Использование:
  mirrorctl session start [--idle-timeout 1800] [--hard-timeout 7200] [--refresh 30|60]
  mirrorctl session status
  mirrorctl session keepalive [--session ID]
  mirrorctl session stop [--session ID]
  mirrorctl status [--no-ocr]
  mirrorctl focus --visible
  mirrorctl center --visible
  mirrorctl screenshot --output PATH [--session ID]
  mirrorctl click --x 0...1 --y 0...1 [--count 1|2] (--session ID | --visible)
  mirrorctl scroll --direction up|down [--pixels 480] (--session ID | --visible)
  mirrorctl type-text --x 0...1 --y 0...1 --text TEXT --session ID
  mirrorctl home | app-switcher | spotlight (--session ID | --visible)
  mirrorctl retry (--session ID | --visible)
  mirrorctl wait-connected [--timeout SECONDS] [--interval SECONDS]

Агентский режим (совместимые дополнительные флаги):
  --compact  Короткий JSON без служебных полей и полного OCR.
  --ocr      Добавить OCR в компактный status/screenshot/observation.
  --observe  Сохранить снимок после session start или одного действия;
             путь возвращается в observation.output, ввод не повторяется.
  mirrorctl screenshot --compact [--output PATH] [--session ID]
  mirrorctl session start --compact --observe
  mirrorctl scroll --direction down --session ID --compact --observe
Без --output компактный screenshot создаёт приватный временный PNG.
"""

private func run() throws {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else {
        throw MirrorError.usage(usage)
    }

    if runtimeOutputOptions.observe {
        let observableCommands: Set<String> = ["click", "scroll", "type-text", "home", "app-switcher", "spotlight", "retry"]
        let startsSession = command == "session" && arguments.dropFirst().first == "start"
        guard startsSession || observableCommands.contains(command) else {
            throw MirrorError.usage("--observe доступен для session start, click, scroll, type-text, home, app-switcher, spotlight и retry.")
        }
    }

    switch command {
    case "help", "--help", "-h":
        print(usage)

    case "session":
        guard arguments.indices.contains(1) else {
            throw MirrorError.usage("Для session нужна команда start|status|keepalive|stop.")
        }
        switch arguments[1] {
        case "start":
            let session = try startHiddenSession(arguments: arguments)
            observationAfterAction = true
            emitActionResult(session, arguments: arguments, legacyStatus: false)
        case "status":
            emitJSON(hiddenSessionStatus())
        case "keepalive":
            emitJSON(try keepHiddenSessionAlive(arguments: arguments))
        case "stop":
            emitJSON(try stopHiddenSession(arguments: arguments))
        default:
            throw MirrorError.usage("Неизвестная session-команда: \(arguments[1]).")
        }

    case "status":
        try refreshSessionActivityIfActive(arguments: arguments)
        emitJSON(status(includeOCR: !arguments.contains("--no-ocr")))

    case "focus":
        guard try inputMode(arguments: arguments) == .visible else {
            throw MirrorError.unsafe("focus предназначен для явно выбранного видимого режима. Не завершайте скрытую сессию ради фокуса.")
        }
        let app = try ensureRunningApp()
        let record = try focusWorkingWindow(app)
        emitJSON(["action": "focus", "window": record.json, "status": status(includeOCR: true)])

    case "center":
        guard try inputMode(arguments: arguments) == .visible else {
            throw MirrorError.unsafe("center предназначен для явно выбранного видимого режима. Скрытое окно удерживает supervisor.")
        }
        let app = try ensureRunningApp()
        let record = try centerWorkingWindow(app)
        emitJSON(["action": "center", "window": record.json, "status": status(includeOCR: true)])

    case "screenshot":
        if let path = option("--output", in: arguments) {
            emitJSON(try screenshotPayload(arguments: arguments, outputURL: absoluteURL(for: path)))
        } else if runtimeOutputOptions.compact {
            emitJSON(try automaticScreenshot(arguments: arguments))
        } else {
            throw MirrorError.usage("Для screenshot обязателен --output PATH.")
        }

    case "click":
        guard let xText = option("--x", in: arguments), let x = Double(xText),
              let yText = option("--y", in: arguments), let y = Double(yText) else {
            throw MirrorError.usage("Для click обязательны числовые --x и --y в диапазоне 0...1.")
        }
        let count = option("--count", in: arguments).flatMap(Int.init) ?? 1
        if try inputMode(arguments: arguments) == .hidden {
            observationAfterAction = true
            let action = try sendSupervisorRequest(
                command: "tap",
                arguments: arguments,
                fields: ["x": x, "y": y, "count": count]
            )
            Thread.sleep(forTimeInterval: 0.5)
            emitActionResult(["action_result": action], arguments: arguments)
            return
        }
        let app = try ensureRunningApp()
        observationAfterAction = true
        let action = try clickNormalized(app: app, x: x, y: y, count: count)
        Thread.sleep(forTimeInterval: 0.5)
        emitActionResult(["action_result": action], arguments: arguments)

    case "scroll":
        guard let direction = option("--direction", in: arguments) else {
            throw MirrorError.usage("Для scroll обязателен --direction up|down.")
        }
        let pixels = option("--pixels", in: arguments).flatMap(Int.init) ?? 480
        if try inputMode(arguments: arguments) == .hidden {
            observationAfterAction = true
            let action = try sendSupervisorRequest(
                command: "scroll",
                arguments: arguments,
                fields: ["direction": direction, "pixels": pixels]
            )
            Thread.sleep(forTimeInterval: 0.5)
            emitActionResult(["action_result": action], arguments: arguments)
            return
        }
        let app = try ensureRunningApp()
        observationAfterAction = true
        let action = try scrollContent(app: app, direction: direction, pixels: pixels)
        Thread.sleep(forTimeInterval: 0.5)
        emitActionResult(["action_result": action], arguments: arguments)

    case "type-text":
        guard try inputMode(arguments: arguments) == .hidden else {
            throw InputSafetyError(code: "hidden_session_required", message: "Текст вводится только внутри скрытой сессии.")
        }
        guard let xText = option("--x", in: arguments), let x = Double(xText),
              let yText = option("--y", in: arguments), let y = Double(yText),
              let text = option("--text", in: arguments) else {
            throw MirrorError.usage("Для type-text нужны --x, --y и --text. Команда не нажимает Enter.")
        }
        guard !arguments.contains("--replace") else {
            throw InputSafetyError(code: "unsupported_input_option", message: "Для замены сначала очистите поле его видимой кнопкой и проверьте результат.")
        }
        _ = try inputTextChunks(text)
        observationAfterAction = true
        let action = try sendSupervisorRequest(
            command: "type-text", arguments: arguments,
            fields: ["x": x, "y": y], inputText: text
        )
        // Снимок запрашивается явно; JSON не содержит OCR введённого текста.
        if runtimeOutputOptions.observe { Thread.sleep(forTimeInterval: 0.5) }
        emitActionResult(["action_result": action], arguments: arguments, legacyStatus: false)

    case "home", "app-switcher", "spotlight":
        _ = try inputMode(arguments: arguments)
        try refreshSessionActivityIfActive(arguments: arguments)
        let app = try ensureRunningApp()
        observationAfterAction = true
        try pressNavigationMenu(command, app: app)
        Thread.sleep(forTimeInterval: 0.5)
        emitActionResult(["action": command], arguments: arguments)

    case "retry":
        _ = try inputMode(arguments: arguments)
        try refreshSessionActivityIfActive(arguments: arguments)
        let app = try ensureRunningApp()
        observationAfterAction = true
        try pressRetry(app)
        Thread.sleep(forTimeInterval: 0.8)
        emitActionResult(["action": "retry"], arguments: arguments)

    case "wait-connected":
        let timeout = option("--timeout", in: arguments).flatMap(Double.init) ?? 30
        let interval = option("--interval", in: arguments).flatMap(Double.init) ?? 1.5
        guard timeout > 0, interval >= 0.25 else {
            throw MirrorError.usage("--timeout должен быть > 0, --interval — не меньше 0.25 с.")
        }

        let deadline = Date().addingTimeInterval(timeout)
        var consecutiveCandidates = 0
        var lastState = "unknown"
        while Date() < deadline {
            try refreshSessionActivityIfActive(arguments: arguments)
            let current = status(includeOCR: true)
            lastState = current["screen_state"] as? String ?? "unknown"
            if lastState == "connected_or_unknown" {
                consecutiveCandidates += 1
                if consecutiveCandidates >= 2 {
                    emitJSON([
                        "action": "wait-connected",
                        "connection_candidate": true,
                        "status": current,
                        "verification_required": true,
                    ])
                    return
                }
            } else {
                consecutiveCandidates = 0
            }
            Thread.sleep(forTimeInterval: interval)
        }
        throw MirrorError.timeout("Подключение не стало готовым за \(timeout) с; последнее состояние: \(lastState).")

    default:
        throw MirrorError.usage("Неизвестная команда: \(command)\n\n\(usage)")
    }
}

@main
private enum MirrorControl {
    private static func emitError(_ payload: [String: Any]) {
        let result = observationAfterAction
            ? observedResult(payload, arguments: Array(CommandLine.arguments.dropFirst())) : payload
        emitJSON(result, to: .standardError)
    }

    static func main() {
        do {
            try run()
        } catch let error as InputSafetyError {
            var payload = error.details
            payload["error"] = error.message
            payload["error_code"] = error.code
            payload["error_type"] = "unsafe"
            payload["exit_code"] = 5
            emitError(payload)
            exit(5)
        } catch let error as MirrorError {
            emitError([
                "error": error.localizedDescription,
                "error_type": String(describing: error),
                "exit_code": Int(error.exitCode),
            ])
            exit(error.exitCode)
        } catch {
            emitError([
                "error": error.localizedDescription,
                "error_type": String(describing: type(of: error)),
                "exit_code": 1,
            ])
            exit(1)
        }
    }
}
