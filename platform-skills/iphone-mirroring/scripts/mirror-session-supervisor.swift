import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

private let mirrorBundleIdentifier = "com.apple.ScreenContinuity"
private let russianWindowTitle = "Видеоповтор iPhone"
private let englishWindowTitle = "iPhone Mirroring"
private let virtualDisplayVendor: UInt32 = 0xEEEE
private let virtualDisplayProduct: UInt32 = 0xC0DE
private let virtualDisplaySerial: UInt32 = 0x1F0E

private struct CodablePoint: Codable {
    let x: Double
    let y: Double

    init(_ point: CGPoint) {
        x = Double(point.x)
        y = Double(point.y)
    }

    var cgPoint: CGPoint { CGPoint(x: x, y: y) }
}

private struct CodableRect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ rect: CGRect) {
        x = Double(rect.origin.x)
        y = Double(rect.origin.y)
        width = Double(rect.width)
        height = Double(rect.height)
    }
}

private struct SessionState: Codable {
    let protocolVersion: Int
    let inputProtocolVersion: Int
    let sessionID: String
    var status: String
    let supervisorPID: Int32
    let startedAt: Double
    var lastActivityAt: Double
    let idleTimeout: Double
    let hardTimeout: Double
    let refreshRate: Double
    let savedMainDisplayID: UInt32
    var virtualDisplayID: UInt32?
    var virtualBounds: CodableRect?
    let mirrorWasRunning: Bool
    var mirrorLaunchedBySupervisor: Bool
    var mirrorPID: Int32?
    var originalWindowPosition: CodablePoint?
    var exitReason: String?
    var endedAt: Double?
}

private struct SessionRequest: Codable {
    let id: String
    let sessionID: String
    let command: String
    let x: Double?
    let y: Double?
    let count: Int?
    let direction: String?
    let pixels: Int?
    let textLength: Int?
    let clientPID: Int32?
    let expiresAt: Double?
}

private struct WindowRecord {
    let id: CGWindowID
    let pid: pid_t
    let bounds: CGRect
    let isOnscreen: Bool

    var inputIdentity: InputWindowIdentity {
        InputWindowIdentity(id: id, pid: pid, bounds: bounds)
    }

    var json: [String: Any] {
        [
            "id": Int(id),
            "pid": Int(pid),
            "bounds": [
                "x": Double(bounds.origin.x),
                "y": Double(bounds.origin.y),
                "width": Double(bounds.width),
                "height": Double(bounds.height),
            ],
            "is_onscreen": isOnscreen,
        ]
    }
}

private struct FrontApplication {
    let pid: pid_t
    let bundleIdentifier: String?
    let path: String?
    let name: String?
}

private enum SupervisorError: LocalizedError {
    case failure(String)

    var errorDescription: String? {
        switch self {
        case .failure(let message): return message
        }
    }
}

private func normalized(_ value: String) -> String {
    value
        .replacingOccurrences(of: "\u{00A0}", with: " ")
        .replacingOccurrences(of: "\u{202F}", with: " ")
        .lowercased()
        .split(whereSeparator: { $0.isWhitespace })
        .joined(separator: " ")
}

private func number(_ value: Any?) -> NSNumber? { value as? NSNumber }

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

private func workingWindow(pid: pid_t) -> WindowRecord? {
    let onscreenIDs = Set(
        rawWindowDictionaries([.optionOnScreenOnly, .excludeDesktopElements]).compactMap {
            number($0[kCGWindowNumber as String])?.uint32Value
        }
    )

    return rawWindowDictionaries(.optionAll).compactMap { dictionary -> WindowRecord? in
        guard number(dictionary[kCGWindowOwnerPID as String])?.int32Value == pid,
              number(dictionary[kCGWindowLayer as String])?.intValue == 0,
              let id = number(dictionary[kCGWindowNumber as String])?.uint32Value,
              let bounds = rect(dictionary[kCGWindowBounds as String]) else {
            return nil
        }
        let title = normalized(dictionary[kCGWindowName as String] as? String ?? "")
        let accepted = [normalized(russianWindowTitle), normalized(englishWindowTitle)]
        guard accepted.contains(title),
              !title.contains("добро пожаловать"),
              !title.contains("welcome") else {
            return nil
        }
        return WindowRecord(
            id: id,
            pid: pid,
            bounds: bounds,
            isOnscreen: onscreenIDs.contains(id)
        )
    }.sorted {
        if $0.isOnscreen != $1.isOnscreen { return $0.isOnscreen }
        return $0.bounds.width * $0.bounds.height > $1.bounds.width * $1.bounds.height
    }.first
}

private func copyAXAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    return result == .success ? value : nil
}

private func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    copyAXAttribute(element, attribute) as? String
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    copyAXAttribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

private func axWindows(pid: pid_t) -> [AXUIElement] {
    let application = AXUIElementCreateApplication(pid)
    var windows = copyAXAttribute(application, kAXWindowsAttribute) as? [AXUIElement] ?? []
    let fallbacks = [kAXFocusedWindowAttribute, kAXMainWindowAttribute].compactMap { attribute -> AXUIElement? in
        guard let raw = copyAXAttribute(application, attribute) else { return nil }
        // ScreenContinuity on macOS 26 returns this CF object through an AX
        // bridge that a normal conditional cast can misidentify as the parent
        // AXApplication. The exact AXUIElement bitcast is the working system
        // representation and is verified again by its AXWindow role below.
        return unsafeBitCast(raw, to: AXUIElement.self)
    } + axChildren(application).filter {
        axString($0, kAXRoleAttribute) == kAXWindowRole
    }
    for candidate in fallbacks where !windows.contains(where: { CFEqual($0, candidate) }) {
        windows.append(candidate)
    }
    return windows
}

private func workingAXWindow(pid: pid_t) -> AXUIElement? {
    let accepted = Set([normalized(russianWindowTitle), normalized(englishWindowTitle)])
    return axWindows(pid: pid).first { window in
        guard axString(window, kAXRoleAttribute) == kAXWindowRole else { return false }
        guard let title = axString(window, kAXTitleAttribute) else { return false }
        let clean = normalized(title)
        return accepted.contains(clean)
            && !clean.contains("добро пожаловать")
            && !clean.contains("welcome")
    }
}

private func axPosition(_ window: AXUIElement) -> CGPoint? {
    guard let raw = copyAXAttribute(window, kAXPositionAttribute) else { return nil }
    let value = raw as! AXValue
    var point = CGPoint.zero
    return AXValueGetValue(value, .cgPoint, &point) ? point : nil
}

@discardableResult
private func moveAXWindow(_ window: AXUIElement, to point: CGPoint) -> Bool {
    var mutable = point
    guard let value = AXValueCreate(.cgPoint, &mutable) else { return false }
    let result = AXUIElementSetAttributeValue(
        window,
        kAXPositionAttribute as CFString,
        value
    )
    if result != .success {
        let role = axString(window, kAXRoleAttribute) ?? "?"
        let title = axString(window, kAXTitleAttribute) ?? "?"
        let identifier = axString(window, kAXIdentifierAttribute) ?? "?"
        fputs(
            "AX move failed error=\(result.rawValue) role=\(role) "
                + "title=\(title) id=\(identifier)\n",
            stderr
        )
    }
    return result == .success
}

private func prepareAXWindowForMove(_ window: AXUIElement) {
    for attribute in [kAXMainAttribute, kAXFocusedAttribute] {
        _ = AXUIElementSetAttributeValue(
            window,
            attribute as CFString,
            kCFBooleanTrue
        )
    }
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
}

private func runningMirrorPID() -> pid_t? {
    NSRunningApplication.runningApplications(withBundleIdentifier: mirrorBundleIdentifier)
        .first(where: { !$0.isTerminated })?
        .processIdentifier
}

private func activateMirrorApplication(pid: pid_t) -> Bool {
    let applicationPath: String? = {
        NSRunningApplication(processIdentifier: pid)?.bundleURL?.path
    }()
    if let applicationPath,
       runOpen(arguments: ["-a", applicationPath]),
       waitForFrontmost(pid, timeout: 1.2) {
        return true
    }

    // LaunchServices occasionally treats an already background-launched app
    // as unchanged. NSRunningApplication is a bounded fallback after the
    // previous app has already been copied to primitive snapshot values.
    _ = NSRunningApplication(processIdentifier: pid)?.activate(
        options: [.activateAllWindows]
    )
    return waitForFrontmost(pid, timeout: 1.5)
}

@discardableResult
private func runOpen(arguments: [String]) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = arguments
    do {
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus == 0
    } catch {
        return false
    }
}

private func waitForFrontmost(_ pid: pid_t, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if freshFrontmostPID() == pid {
            return true
        }
        Thread.sleep(forTimeInterval: 0.01)
    }
    return freshFrontmostPID() == pid
}

private func frontApplicationSnapshot() -> FrontApplication? {
    // Copy primitive values and release NSRunningApplication immediately. A
    // retained frontmostApplication object prevented reliable activation in
    // the real-device experiments that led to this supervisor.
    guard let pid = freshFrontmostPID(),
          let application = NSRunningApplication(processIdentifier: pid) else { return nil }
    return FrontApplication(
        pid: application.processIdentifier,
        bundleIdentifier: application.bundleIdentifier,
        path: application.bundleURL?.path,
        name: application.localizedName
    )
}

private func restoreApplication(_ application: FrontApplication, excluding pid: pid_t) -> Bool {
    guard application.pid != pid else { return true }
    guard kill(application.pid, 0) == 0 || errno == EPERM else { return false }
    guard activateExactProcess(application.pid) else { return false }
    return waitForFrontmost(application.pid, timeout: 0.4)
}

private func physicalDisplayIDs(excluding virtualDisplayID: CGDirectDisplayID? = nil) -> Set<UInt32> {
    var displays = [CGDirectDisplayID](repeating: 0, count: 32)
    var count: UInt32 = 0
    guard CGGetOnlineDisplayList(UInt32(displays.count), &displays, &count) == .success else {
        return []
    }
    return Set(displays.prefix(Int(count)).filter {
        $0 != virtualDisplayID && CGDisplayVendorNumber($0) != virtualDisplayVendor
    })
}

private func screenIsLocked() -> Bool {
    if let session = CGSessionCopyCurrentDictionary() as? [String: Any],
       session["CGSSessionScreenIsLocked"] as? Bool == true {
        return true
    }
    // Keep a conservative fallback for macOS builds that omit the dictionary
    // key while loginwindow owns the foreground session.
    guard let pid = freshFrontmostPID() else { return false }
    return NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "com.apple.loginwindow"
}

private func atomicWriteJSON(_ object: Any, to url: URL) throws {
    let data = try JSONSerialization.data(
        withJSONObject: object,
        options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    )
    try data.write(to: url, options: .atomic)
}

private final class SessionSupervisor: @unchecked Sendable {
    private let sessionDirectory: URL
    private let requestsDirectory: URL
    private let stateURL: URL
    private let activityURL: URL
    private let sessionID: String
    private let idleTimeout: TimeInterval
    private let hardTimeout: TimeInterval
    private let refreshRate: Double
    private let startedAt = Date().timeIntervalSince1970
    private let savedMainDisplayID = CGMainDisplayID()
    private let initialPhysicalDisplays: Set<UInt32>
    private let mirrorWasRunning: Bool
    private let startupFrontApplication: FrontApplication?

    private var state: SessionState
    private var displayHandle: UnsafeMutableRawPointer?
    private var displayID: CGDirectDisplayID = kCGNullDirectDisplay
    private var virtualBounds = CGRect.zero
    private var mirrorPID: pid_t?
    private var originalWindowPosition: CGPoint?
    private var stopReason: String?
    private var cleanedUp = false
    private var lastHealthCheck = Date.distantPast
    private var signalSources: [DispatchSourceSignal] = []
    private let stopLock = NSLock()
    private var inputRequestInProgress = false

    init(
        sessionDirectory: URL,
        sessionID: String,
        idleTimeout: TimeInterval,
        hardTimeout: TimeInterval,
        refreshRate: Double
    ) {
        self.sessionDirectory = sessionDirectory
        requestsDirectory = sessionDirectory.appendingPathComponent("requests", isDirectory: true)
        stateURL = sessionDirectory.appendingPathComponent("state.json")
        activityURL = sessionDirectory.appendingPathComponent("activity")
        self.sessionID = sessionID
        self.idleTimeout = idleTimeout
        self.hardTimeout = hardTimeout
        self.refreshRate = refreshRate
        initialPhysicalDisplays = physicalDisplayIDs()
        mirrorWasRunning = runningMirrorPID() != nil
        startupFrontApplication = frontApplicationSnapshot()
        state = SessionState(
            protocolVersion: 1,
            inputProtocolVersion: guardedInputProtocolVersion,
            sessionID: sessionID,
            status: "starting",
            supervisorPID: getpid(),
            startedAt: startedAt,
            lastActivityAt: startedAt,
            idleTimeout: idleTimeout,
            hardTimeout: hardTimeout,
            refreshRate: refreshRate,
            savedMainDisplayID: savedMainDisplayID,
            virtualDisplayID: nil,
            virtualBounds: nil,
            mirrorWasRunning: mirrorWasRunning,
            mirrorLaunchedBySupervisor: false,
            mirrorPID: nil,
            originalWindowPosition: nil,
            exitReason: nil,
            endedAt: nil
        )
    }

    func run() throws {
        try FileManager.default.createDirectory(
            at: requestsDirectory,
            withIntermediateDirectories: true
        )
        try touchActivity()
        try persistState()
        installSignalHandlers()

        do {
            try setUpVirtualDisplayAndWindow()
            state.status = "active"
            try persistState()
            log("session active display=\(displayID) mirror_pid=\(mirrorPID ?? 0)")

            while currentStopReason() == nil {
                try autoreleasepool {
                    try processRequests()
                }
                checkTimersAndHealth()
                RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.10))
            }
        } catch {
            requestStop("error: \(error.localizedDescription)")
            throw error
        }
    }

    func cleanup() {
        guard !cleanedUp else { return }
        cleanedUp = true
        let reason = currentStopReason() ?? "normal_exit"
        log("cleanup started reason=\(reason)")

        CGAssociateMouseAndMouseCursorPosition(1)
        CGDisplayShowCursor(CGMainDisplayID())

        if let mirrorPID,
           kill(mirrorPID, 0) == 0,
           let originalWindowPosition,
           let window = workingAXWindow(pid: mirrorPID) {
            _ = moveAXWindow(window, to: originalWindowPosition)
            Thread.sleep(forTimeInterval: 0.25)
        }

        if state.mirrorLaunchedBySupervisor,
           let application = NSRunningApplication.runningApplications(
               withBundleIdentifier: mirrorBundleIdentifier
           ).first(where: { !$0.isTerminated }) {
            _ = application.terminate()
            let deadline = Date().addingTimeInterval(2)
            while !application.isTerminated, Date() < deadline {
                Thread.sleep(forTimeInterval: 0.05)
            }
            if !application.isTerminated {
                _ = application.forceTerminate()
            }
        }

        if displayID != kCGNullDirectDisplay {
            _ = VDFixupDisplayArrangement(displayID, savedMainDisplayID)
        }
        if let displayHandle {
            VDReleaseDisplay(displayHandle)
            self.displayHandle = nil
        }
        displayID = kCGNullDirectDisplay

        state.status = "ended"
        state.exitReason = reason
        state.endedAt = Date().timeIntervalSince1970
        state.lastActivityAt = activityTimestamp()
        try? persistState()
        log("cleanup completed active_displays=\(activeDisplayCount()) main=\(CGMainDisplayID())")
    }

    private func setUpVirtualDisplayAndWindow() throws {
        guard AXIsProcessTrusted() else {
            throw SupervisorError.failure("Нет разрешения «Универсальный доступ».")
        }
        guard !screenIsLocked() else {
            throw SupervisorError.failure(
                "Экран Mac заблокирован; скрытая сессия не создаётся."
            )
        }
        guard initialPhysicalDisplays.contains(savedMainDisplayID) else {
            throw SupervisorError.failure("Основной дисплей не распознан как физический.")
        }
        guard CGDisplayIsActive(savedMainDisplayID) != 0 else {
            // Creating a virtual display while the real panel sleeps can make
            // WindowServer activate only the invisible display. Abort before
            // allocating CGVirtualDisplay; the next call may retry after wake.
            throw SupervisorError.failure(
                "Физический основной дисплей спит; скрытая сессия не создаётся."
            )
        }

        displayHandle = VDCreateDisplay(
            "Codex iPhone Session",
            600,
            900,
            refreshRate,
            virtualDisplayVendor,
            virtualDisplayProduct,
            virtualDisplaySerial
        )
        guard let displayHandle else {
            throw SupervisorError.failure("CGVirtualDisplay недоступен или не применил настройки.")
        }
        displayID = VDDisplayID(displayHandle)
        guard displayID != kCGNullDirectDisplay else {
            throw SupervisorError.failure("Виртуальный дисплей не получил display ID.")
        }

        let activationDeadline = Date().addingTimeInterval(4)
        while Date() < activationDeadline {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.15))
            if CGDisplayIsActive(displayID) != 0,
               CGDisplayBounds(displayID).width > 1 {
                break
            }
        }
        guard CGDisplayIsActive(displayID) != 0 else {
            throw SupervisorError.failure("Виртуальный дисплей не стал активным.")
        }
        guard VDFixupDisplayArrangement(displayID, savedMainDisplayID) else {
            throw SupervisorError.failure("Не удалось безопасно расположить виртуальный дисплей.")
        }

        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.4))
        virtualBounds = CGDisplayBounds(displayID)
        guard CGMainDisplayID() == savedMainDisplayID,
              virtualBounds.width >= 600,
              virtualBounds.height >= 900 else {
            throw SupervisorError.failure(
                "Нарушен physical-main guard: main=\(CGMainDisplayID()), bounds=\(virtualBounds)."
            )
        }

        if runningMirrorPID() == nil {
            guard runOpen(arguments: ["-g", "-b", mirrorBundleIdentifier]) else {
                throw SupervisorError.failure("Не удалось фоново запустить Видеоповтор iPhone.")
            }
            state.mirrorLaunchedBySupervisor = true
        }

        let processDeadline = Date().addingTimeInterval(12)
        while Date() < processDeadline, runningMirrorPID() == nil {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.15))
        }
        guard let resolvedPID = runningMirrorPID() else {
            throw SupervisorError.failure("Процесс Видеоповтора не появился.")
        }
        mirrorPID = resolvedPID
        state.mirrorPID = resolvedPID

        var activatedForSetup = false
        func activateForSetupIfNeeded() -> Bool {
            if activatedForSetup { return true }
            guard activateMirrorApplication(pid: resolvedPID) else { return false }
            activatedForSetup = true
            return true
        }
        func restoreSetupApplicationIfNeeded() {
            guard activatedForSetup else { return }
            if let startupFrontApplication {
                _ = restoreApplication(startupFrontApplication, excluding: resolvedPID)
            }
            activatedForSetup = false
        }

        // A running background instance often publishes its real AXWindow
        // immediately. If it exposes only the AXApplication placeholder,
        // perform one bounded activation and retry instead of weakening the
        // role/title checks.
        let windowDeadline = Date().addingTimeInterval(1.5)
        var axWindow: AXUIElement?
        while Date() < windowDeadline {
            axWindow = workingAXWindow(pid: resolvedPID)
            if axWindow != nil, workingWindow(pid: resolvedPID) != nil { break }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.15))
        }
        if axWindow == nil {
            guard activateForSetupIfNeeded() else {
                throw SupervisorError.failure("Не удалось подготовить окно к переносу.")
            }
            let foregroundWindowDeadline = Date().addingTimeInterval(3)
            while Date() < foregroundWindowDeadline {
                axWindow = workingAXWindow(pid: resolvedPID)
                if axWindow != nil, workingWindow(pid: resolvedPID) != nil { break }
                RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.10))
            }
        }
        guard let axWindow else {
            restoreSetupApplicationIfNeeded()
            throw SupervisorError.failure("Не найдено точное AX-окно Видеоповтора.")
        }
        originalWindowPosition = axPosition(axWindow)
        state.originalWindowPosition = originalWindowPosition.map(CodablePoint.init)

        let target = CGPoint(x: virtualBounds.minX + 10, y: virtualBounds.minY + 10)
        var moved = false
        for _ in 0..<12 where !moved {
            let candidate = workingAXWindow(pid: resolvedPID) ?? axWindow
            prepareAXWindowForMove(candidate)
            moved = moveAXWindow(candidate, to: target)
            if !moved {
                RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.10))
            }
        }

        if !moved {
            // A freshly background-launched ScreenContinuity window may reject
            // AXPosition until its process has been activated once. Use the
            // same bounded handoff as an input action, then return the exact
            // startup application and its existing Space.
            guard activateForSetupIfNeeded() else {
                throw SupervisorError.failure("Не удалось подготовить окно к переносу.")
            }
            for _ in 0..<12 where !moved {
                let candidate = workingAXWindow(pid: resolvedPID) ?? axWindow
                prepareAXWindowForMove(candidate)
                moved = moveAXWindow(candidate, to: target)
                if !moved { Thread.sleep(forTimeInterval: 0.10) }
            }
        }
        guard moved else {
            restoreSetupApplicationIfNeeded()
            throw SupervisorError.failure("Не удалось перенести окно на виртуальный дисплей.")
        }
        restoreSetupApplicationIfNeeded()

        let moveDeadline = Date().addingTimeInterval(3)
        var movedWindow: WindowRecord?
        while Date() < moveDeadline {
            movedWindow = workingWindow(pid: resolvedPID)
            if let movedWindow, virtualBounds.contains(
                CGPoint(x: movedWindow.bounds.midX, y: movedWindow.bounds.midY)
            ) {
                break
            }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.10))
        }
        guard let movedWindow,
              movedWindow.isOnscreen,
              virtualBounds.contains(CGPoint(x: movedWindow.bounds.midX, y: movedWindow.bounds.midY)) else {
            throw SupervisorError.failure("Окно не закрепилось на виртуальном дисплее.")
        }

        state.virtualDisplayID = displayID
        state.virtualBounds = CodableRect(virtualBounds)
    }

    private func processRequests() throws {
        let urls = try FileManager.default.contentsOfDirectory(
            at: requestsDirectory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ).filter { $0.lastPathComponent.hasPrefix("request-") && $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }

        for url in urls {
            // Отдельный stop мог быть обработан во время ожидания предыдущего
            // ввода. Не перечитываем уже удалённый запрос из старого snapshot-а.
            if currentStopReason() != nil { return }
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            let data = try Data(contentsOf: url)
            let request = try JSONDecoder().decode(SessionRequest.self, from: data)
            let responseURL = requestsDirectory.appendingPathComponent("response-\(request.id).json")
            let response: [String: Any]

            if request.sessionID != sessionID {
                response = ["ok": false, "error": "session_id не совпадает с активной сессией."]
            } else {
                try touchActivity()
                do {
                    response = try handle(request)
                } catch let error as InputSafetyError {
                    response = error.details.merging(["ok": false, "error": error.message, "error_code": error.code]) { _, value in value }
                } catch {
                    response = ["ok": false, "error": error.localizedDescription]
                }
            }

            try atomicWriteJSON(response, to: responseURL)
            try? FileManager.default.removeItem(at: url)
            if request.command == "stop" { return }
        }
    }

    private func requestAlive(_ request: SessionRequest) -> Bool {
        inputRequestIsLive(clientPID: request.clientPID, expiresAt: request.expiresAt, now: Date().timeIntervalSince1970) {
            kill($0, 0) == 0 || errno == EPERM
        }
    }

    // Очередь HID последовательна, но stop не должен ждать десяти минут за
    // занятым вводом. Здесь обрабатывается только stop exact активной сессии;
    // никакая следующая команда не запускается рекурсивно либо параллельно.
    private func processPendingStop() throws {
        guard currentStopReason() == nil else { return }
        let urls = try FileManager.default.contentsOfDirectory(at: requestsDirectory, includingPropertiesForKeys: nil)
        for url in urls where url.lastPathComponent.hasPrefix("request-") && url.pathExtension == "json" {
            guard let data = try? Data(contentsOf: url),
                  let request = try? JSONDecoder().decode(SessionRequest.self, from: data),
                  request.command == "stop", request.sessionID == sessionID,
                  UUID(uuidString: request.id) != nil, requestAlive(request) else { continue }
            requestStop("explicit_stop")
            try atomicWriteJSON(["ok": true, "action": "session_stop", "session_id": sessionID],
                                to: requestsDirectory.appendingPathComponent("response-\(request.id).json"))
            try? FileManager.default.removeItem(at: url)
            return
        }
    }

    private func handle(_ request: SessionRequest) throws -> [String: Any] {
        guard request.command == "stop" || requestAlive(request) else {
            throw InputSafetyError(code: "input_request_expired", message: "Вызывающий процесс завершился или запрос истёк; ввод отменён.")
        }
        switch request.command {
        case "tap":
            guard let x = request.x, let y = request.y else {
                throw SupervisorError.failure("Для tap нужны x и y.")
            }
            return try performGuardedInput(request: request, command: "tap", x: x, y: y, count: request.count ?? 1)
        case "scroll":
            return try performGuardedInput(request: request, command: "scroll", direction: request.direction ?? "", pixels: request.pixels ?? 480)
        case "type-text":
            guard let x = request.x, let y = request.y else {
                throw InputSafetyError(code: "invalid_input_point", message: "Для текста нужны координаты поля.")
            }
            let text = try readInputText(request)
            return try performGuardedInput(request: request, command: "type-text", x: x, y: y, text: text)
        case "stop":
            requestStop("explicit_stop")
            return ["ok": true, "action": "session_stop", "session_id": sessionID]
        default:
            throw SupervisorError.failure("Неизвестная команда supervisor: \(request.command)")
        }
    }

    // Текст никогда не попадает в request-*.json или supervisor.log. FIFO
    // содержит байты только в kernel pipe; имя выводится из проверенного UUID.
    private func readInputText(_ request: SessionRequest) throws -> String {
        guard UUID(uuidString: request.id) != nil, let length = request.textLength,
              (1...1024).contains(length) else {
            throw InputSafetyError(code: "invalid_input_text", message: "Недопустимый размер текстового запроса.")
        }
        let path = requestsDirectory.appendingPathComponent("input-\(request.id).fifo").path
        let descriptor = Darwin.open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
        guard descriptor >= 0 else { throw InputSafetyError(code: "input_text_unavailable", message: "Канал текста уже закрыт; ввод отменён.") }
        defer { Darwin.close(descriptor); unlink(path) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_uid == getuid(),
              info.st_mode & S_IFMT == S_IFIFO, info.st_mode & 0o077 == 0 else {
            throw InputSafetyError(code: "input_text_unavailable", message: "Неподходящий канал текста.")
        }
        var bytes = [UInt8](repeating: 0, count: length + 1)
        let count = Darwin.read(descriptor, &bytes, bytes.count)
        guard count == length, let text = String(bytes: bytes.prefix(count), encoding: .utf8) else {
            throw InputSafetyError(code: "invalid_input_text", message: "Текст поступил не полностью; ввод отменён.")
        }
        _ = try inputTextChunks(text)
        return text
    }

    private func performGuardedInput(
        request: SessionRequest, command: String, x: Double = 0.5, y: Double = 0.5, count: Int = 1,
        direction: String = "down", pixels: Int = 480, text: String? = nil
    ) throws -> [String: Any] {
        guard x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y),
              (1...2).contains(count), (20...2000).contains(pixels),
              direction == "up" || direction == "down" else {
            throw InputSafetyError(code: "invalid_input_operation", message: "Недопустимые параметры ввода.")
        }
        // Активная команда считается работой session, даже когда пользователь
        // продолжает печатать. Её собственный бюджет остаётся десять минут, hard
        // deadline сессии не продлевается, а после ответа idle отсчитывается заново.
        inputRequestInProgress = true
        defer { inputRequestInProgress = false; try? touchActivity() }
        return try performAfterInputIdle(checkAllowed: {
            try processPendingStop()
            checkTimersAndHealth()
            guard currentStopReason() == nil, requestAlive(request) else {
                throw InputSafetyError(code: "input_request_expired", message: "Сессия или вызывающий процесс завершились до ввода.")
            }
        }, attempt: {
            try performInputAttempt(request: request, command: command, x: x, y: y, count: count,
                                    direction: direction, pixels: pixels, text: text)
        })
    }

    private func performInputAttempt(
        request: SessionRequest, command: String, x: Double, y: Double, count: Int,
        direction: String, pixels: Int, text: String?
    ) throws -> [String: Any] {
        guard requestAlive(request), currentStopReason() == nil, !screenIsLocked(),
              let mirrorPID, let window = workingWindow(pid: mirrorPID),
              window.isOnscreen, virtualBounds.contains(window.bounds),
              let previous = frontApplicationSnapshot() else {
            throw InputSafetyError(code: "input_target_changed", message: "Сессия, окно или исходное приложение изменились перед вводом; нужен свежий снимок.")
        }
        guard let path = ProcessInfo.processInfo.environment["IPHONE_MIRRORING_INPUT_GUARDIAN_PATH"],
              FileManager.default.isExecutableFile(atPath: path) else {
            throw InputSafetyError(code: "input_guard_unavailable", message: "Не найден собранный защитный исполнитель.")
        }
        let savedCursor = CGEvent(source: nil)?.location ?? .zero
        let operation = GuardedInputOperation(
            command: command, parentPID: getpid(), callerPID: request.clientPID!, window: window.inputIdentity,
            virtualBounds: virtualBounds, displayID: displayID, mainDisplayID: savedMainDisplayID,
            x: x, y: y, count: count, direction: direction, pixels: pixels, text: text
        )
        let child = Process()
        child.executableURL = URL(fileURLWithPath: path)
        let input = Pipe(), output = Pipe()
        child.standardInput = input; child.standardOutput = output
        child.standardError = FileHandle.nullDevice
        try child.run()
        defer {
            // Закрываем ещё не начавшего ввод ребёнка и при ошибке записи pipe.
            if child.isRunning { kill(child.processIdentifier, SIGKILL); child.waitUntilExit() }
        }
        try input.fileHandleForWriting.write(contentsOf: JSONEncoder().encode(operation))
        try input.fileHandleForWriting.close()
        let forced = waitForGuardedChild(child) {
            do { try processPendingStop() } catch { requestStop("stop_request_failed") }
            checkTimersAndHealth()
            return currentStopReason() == nil && requestAlive(request)
        }
        if forced || child.terminationStatus != 0 {
            // Crash/SIGSTOP могут произойти между down/up. Разрешены только
            // завершающие события, адресованные прежнему приложению; новой
            // буквы у аварийного keyUp нет. После этого sender уже мёртв.
            if let source = CGEventSource(stateID: .privateState),
               let point = try? normalizedInputPoint(window: window.inputIdentity, x: x, y: y) {
                var releases: [CGEvent] = []
                if let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) {
                    up.flags = []; releases.append(up)
                }
                if command == "type-text", let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) {
                    up.flags = []
                    up.keyboardSetUnicodeString(stringLength: 0, unicodeString: nil)
                    releases.append(up)
                }
                for event in releases { event.postToPid(mirrorPID) }
                RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.03))
            }
            CGAssociateMouseAndMouseCursorPosition(1)
            if virtualBounds.contains(CGEvent(source: nil)?.location ?? .zero) { CGWarpMouseCursorPosition(savedCursor) }
            CGDisplayShowCursor(savedMainDisplayID)
        }
        if freshFrontmostPID() == mirrorPID { _ = restoreApplication(previous, excluding: mirrorPID) }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        guard !forced, child.terminationStatus == 0,
              var result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ["ok": false, "error_code": "input_guard_interrupted", "error": "Исполнитель аварийно остановлен. Проверьте результат на iPhone перед повтором.", "verification_required": true]
        }
        result["window"] = window.json
        return result
    }

    private func checkTimersAndHealth() {
        let now = Date()
        let epoch = now.timeIntervalSince1970
        let lastActivity = activityTimestamp()
        if abs(state.lastActivityAt - lastActivity) > 0.01 {
            state.lastActivityAt = lastActivity
            try? persistState()
        }

        if !inputRequestInProgress && epoch - lastActivity >= idleTimeout {
            requestStop("idle_timeout")
            return
        }
        if epoch - startedAt >= hardTimeout {
            requestStop("hard_timeout")
            return
        }
        guard now.timeIntervalSince(lastHealthCheck) >= 1 else { return }
        lastHealthCheck = now

        if ProcessInfo.processInfo.thermalState == .serious
            || ProcessInfo.processInfo.thermalState == .critical {
            requestStop("thermal_pressure")
            return
        }
        if screenIsLocked() {
            requestStop("screen_locked")
            return
        }
        if CGMainDisplayID() != savedMainDisplayID {
            _ = VDFixupDisplayArrangement(displayID, savedMainDisplayID)
            requestStop("main_display_changed")
            return
        }
        if physicalDisplayIDs(excluding: displayID) != initialPhysicalDisplays {
            requestStop("physical_topology_changed")
            return
        }
        if let mirrorPID, kill(mirrorPID, 0) != 0 && errno != EPERM {
            requestStop("mirroring_process_exited")
        }
    }

    private func touchActivity() throws {
        let text = "\(Date().timeIntervalSince1970)\n"
        try Data(text.utf8).write(to: activityURL, options: .atomic)
        state.lastActivityAt = Date().timeIntervalSince1970
    }

    private func activityTimestamp() -> Double {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: activityURL.path),
              let date = attributes[.modificationDate] as? Date else {
            return state.lastActivityAt
        }
        return date.timeIntervalSince1970
    }

    private func persistState() throws {
        let data = try JSONEncoder().encode(state)
        try data.write(to: stateURL, options: .atomic)
    }

    private func requestStop(_ reason: String) {
        stopLock.lock()
        if stopReason == nil { stopReason = reason }
        stopLock.unlock()
    }

    private func currentStopReason() -> String? {
        stopLock.lock()
        defer { stopLock.unlock() }
        return stopReason
    }

    private func installSignalHandlers() {
        for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
            Darwin.signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(
                signal: signalNumber,
                queue: DispatchQueue.global(qos: .userInitiated)
            )
            source.setEventHandler { [weak self] in
                self?.requestStop("signal_\(signalNumber)")
            }
            source.resume()
            signalSources.append(source)
        }
    }

    private func activeDisplayCount() -> UInt32 {
        var count: UInt32 = 0
        _ = CGGetActiveDisplayList(0, nil, &count)
        return count
    }

    private func log(_ message: String) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        FileHandle.standardOutput.write(Data("\(timestamp) \(message)\n".utf8))
    }
}

private func argument(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
        return nil
    }
    return arguments[index + 1]
}

@main
private enum MirrorSessionMain {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard let directoryText = argument("--session-dir", in: arguments),
              let sessionID = argument("--session-id", in: arguments),
              let idleTimeout = argument("--idle-timeout", in: arguments).flatMap(Double.init),
              let hardTimeout = argument("--hard-timeout", in: arguments).flatMap(Double.init),
              let refreshRate = argument("--refresh", in: arguments).flatMap(Double.init) else {
            fputs("Missing required supervisor arguments.\n", stderr)
            exit(2)
        }

        let supervisor = SessionSupervisor(
            sessionDirectory: URL(fileURLWithPath: directoryText, isDirectory: true),
            sessionID: sessionID,
            idleTimeout: idleTimeout,
            hardTimeout: hardTimeout,
            refreshRate: refreshRate
        )

        var supervisorExitCode: Int32 = 0
        do {
            try supervisor.run()
        } catch {
            fputs("Supervisor error: \(error.localizedDescription)\n", stderr)
            supervisorExitCode = 1
        }
        // Do not call exit() from the catch above: Darwin.exit bypasses Swift defer
        // scopes. Cleanup must run explicitly before the process terminates so a
        // startup error cannot strand the private display object.
        supervisor.cleanup()
        exit(supervisorExitCode)
    }
}
