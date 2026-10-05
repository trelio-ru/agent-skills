import Foundation

@main
enum RuntimeOutputTests {
    static func main() throws {
        // Новые режимы включаются только реальными флагами. Строка пользователя
        // и значение другого параметра не могут поменять поведение команды.
        let legacy = RuntimeOutputOptions(arguments: ["status"])
        assert(!legacy.compact && !legacy.observe && !legacy.includeOCR)
        let quoted = RuntimeOutputOptions(arguments: ["type-text", "--text", "--observe", "--compact"])
        assert(quoted.compact && !quoted.observe)
        let sessionValue = RuntimeOutputOptions(arguments: ["click", "--session", "--observe", "--x", "0.5"])
        assert(!sessionValue.observe)
        let enabled = RuntimeOutputOptions(arguments: ["scroll", "--direction", "down", "--compact", "--observe", "--ocr"])
        assert(enabled.compact && enabled.observe && enabled.includeOCR)

        let action: [String: Any] = [
            "action": "scroll", "ok": true, "events_posted": true,
            "verification_required": true, "restored_front_app": true,
            "handoff_started": true, "input_wait_seconds": 10.37356,
            "previous_pid": 42, "window": ["id": 9, "pid": 55],
        ]
        let original: [String: Any] = [
            "action_result": action,
            "status": ["app_running": true, "screen_state": "connected_or_unknown",
                       "frontmost": false, "ax_text": [], "recognized_text": ["Тестовый экран"],
                       "working_window": ["id": 9], "welcome_windows": [["id": 8]]],
        ]
        let compact = compactRuntimeOutput(original)
        let result = compact["action_result"] as! [String: Any]
        assert(result["events_posted"] as? Bool == true)
        assert(result["verification_required"] as? Bool == true)
        assert(result["restored_front_app"] as? Bool == true)
        assert(result["input_wait_seconds"] as? Double == 10.4)
        assert(result["window"] == nil && result["previous_pid"] == nil)
        let status = compact["status"] as! [String: Any]
        assert(status["frontmost"] as? Bool == false)
        assert(status["screen_state"] as? String == "connected_or_unknown")
        assert(status["recognized_text"] == nil && status["welcome_windows"] == nil)
        let withOCR = compactRuntimeOutput(original, includeOCR: true)["status"] as! [String: Any]
        assert(withOCR["recognized_text"] as? [String] == ["Тестовый экран"])

        // Compact не фабрикует отрицание отправки, когда старый/аварийный
        // исполнитель не оставил такого доказательства.
        let unknown = compactRuntimeOutput(["action": "scroll"])
        assert(unknown["events_posted"] == nil && unknown["verification_required"] == nil)
        let partial: [String: Any] = [
            "error_code": "input_user_active", "error": "Операция прервана",
            "events_posted": true, "verification_required": true, "restored_front_app": false,
            "new_diagnostic_field": ["phase": "return_focus"],
        ]
        assert(NSDictionary(dictionary: compactRuntimeOutput(partial)).isEqual(to: partial))
        let nested = compactRuntimeOutput(["action_result": partial])["action_result"] as! [String: Any]
        assert(NSDictionary(dictionary: nested).isEqual(to: partial))

        var captures = 0
        let observed = addingRuntimeObservation(to: ["action_result": action]) {
            captures += 1
            return ["output": "/tmp/example.png", "screen_state": "connected_or_unknown"]
        }
        assert(captures == 1 && observed["observation"] != nil)
        let failedCapture = addingRuntimeObservation(to: partial) {
            captures += 1
            throw NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "Capture failed"])
        }
        assert(captures == 2)
        assert(failedCapture["events_posted"] as? Bool == true)
        assert(failedCapture["restored_front_app"] as? Bool == false)
        assert(failedCapture["verification_required"] as? Bool == true)
        assert(failedCapture["observation"] == nil)
        assert((failedCapture["observation_error"] as? [String: Any])?["verification_required"] as? Bool == true)

        for command in ["type-text", "screenshot", "scroll"] {
            let screenshot = runtimeScreenshotPayload(
                command: command, output: "/tmp/example.png", capturedAt: 123,
                screenState: "connected_or_unknown", window: ["id": 9], recognizedText: ["PRIVATE TEST TEXT"]
            )
            for projected in [screenshot, compactRuntimeOutput(screenshot, includeOCR: true)] {
                assert(projected["output"] as? String == "/tmp/example.png")
                assert((projected["recognized_text"] != nil) == (command != "type-text"))
                if command == "type-text" {
                    let encoded = String(data: try JSONSerialization.data(withJSONObject: projected), encoding: .utf8)!
                    assert(!encoded.contains("PRIVATE TEST TEXT"))
                }
            }
        }

        let lease = compactRuntimeOutput([
            "action": "session_start", "sessionID": "lease", "mirrorWasRunning": false,
            "mirrorLaunchedBySupervisor": true, "idleTimeout": 1800, "hardTimeout": 7200,
            "idle_remaining": 1798.938, "hard_remaining": 7198.938, "virtualDisplayID": 14,
        ])
        assert(lease["mirrorWasRunning"] as? Bool == false)
        assert(lease["mirrorLaunchedBySupervisor"] as? Bool == true)
        assert(lease["idleTimeout"] as? Int == 1800 && lease["hardTimeout"] as? Int == 7200)
        assert(lease["idle_remaining"] as? Double == 1798)
        let stopped = compactRuntimeOutput(["active": false, "exitReason": "explicit_stop", "process_alive": false])
        assert(stopped["active"] as? Bool == false && stopped["exitReason"] as? String == "explicit_stop")

        // Проверяем реальные права/уникальность файлов, но capture подменён
        // безопасной записью: тест не читает экран и не запускает Видеоповтор.
        var directories: [URL] = []
        defer { for directory in directories { try? FileManager.default.removeItem(at: directory) } }
        for _ in 0..<2 {
            let artifact = try withPrivateRuntimeObservation { output in
                directories.append(output.deletingLastPathComponent())
                try Data([1, 2, 3]).write(to: output)
                return ["output": output.path]
            }
            let path = artifact["output"] as! String
            let file = try FileManager.default.attributesOfItem(atPath: path)
            let directory = try FileManager.default.attributesOfItem(atPath: directories.last!.path)
            assert((file[.posixPermissions] as! NSNumber).intValue == 0o600)
            assert((directory[.posixPermissions] as! NSNumber).intValue == 0o700)
        }
        assert(directories[0] != directories[1])
        var failedDirectory: URL?
        do {
            _ = try withPrivateRuntimeObservation { output in
                failedDirectory = output.deletingLastPathComponent()
                try Data([4]).write(to: output)
                throw NSError(domain: "test", code: 2)
            }
            assertionFailure("Capture failure must escape after removing its private artifact")
        } catch {
            assert(failedDirectory != nil && !FileManager.default.fileExists(atPath: failedDirectory!.path))
        }
        print("Runtime output regressions passed")
    }
}
