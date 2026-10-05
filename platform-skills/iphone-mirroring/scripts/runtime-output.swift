import Darwin
import Foundation

// Это opt-in контракт агентских ответов. Старый CLI без --compact сохраняет
// полный JSON: минорный релиз не удаляет поля у существующих потребителей.
struct RuntimeOutputOptions {
    let compact: Bool
    let observe: Bool
    let includeOCR: Bool

    init(arguments: [String]) {
        let valuedOptions: Set<String> = [
            "--session", "--text", "--output", "--x", "--y", "--count",
            "--direction", "--pixels", "--timeout", "--interval",
            "--idle-timeout", "--hard-timeout", "--refresh",
        ]
        var flags = Set<String>()
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            // Значение --text может буквально равняться --observe/--compact.
            // Оно остаётся данными и не включает снимок или другой формат.
            if valuedOptions.contains(argument) { index += 2; continue }
            flags.insert(argument)
            index += 1
        }
        compact = flags.contains("--compact")
        observe = flags.contains("--observe")
        includeOCR = flags.contains("--ocr")
    }
}

// Сокращается только служебная часть успешного ответа. Ошибки целиком проходят
// наружу: неизвестный новый diagnostic field нельзя потерять вместе с фактом
// частичного ввода или неудачного возврата фокуса. Отсутствующее доказательство
// никогда не превращается в false/успех при проекции.
func compactRuntimeOutput(_ source: [String: Any], includeOCR: Bool = false) -> [String: Any] {
    if source["error"] != nil || source["error_code"] != nil || source["ok"] as? Bool == false {
        return source
    }
    let fields: Set<String> = [
        "action", "ok", "action_result", "status", "observation", "observation_error",
        "output", "captured_at", "screen_state", "screen_state_error",
        "app_running", "ax_trusted", "frontmost", "connection_candidate",
        "sessionID", "active", "process_alive", "reused", "already_stopped", "exitReason",
        "idleTimeout", "hardTimeout", "idle_remaining", "hard_remaining", "inputProtocolVersion",
        "mirrorWasRunning", "mirrorLaunchedBySupervisor",
        "events_posted", "handoff_started", "restored_front_app", "verification_required",
        "input_guard", "input_wait_seconds", "idle_required_seconds", "input_attempts",
        "focus_ms", "text_echoed",
    ]
    var result = source.filter { fields.contains($0.key) }
    for key in ["action_result", "status", "observation"] {
        if let nested = result[key] as? [String: Any] {
            result[key] = compactRuntimeOutput(nested, includeOCR: includeOCR)
        }
    }
    if includeOCR {
        for key in ["recognized_text", "ax_text"] {
            if let value = source[key] { result[key] = value }
        }
    }
    // Субмиллисекундные timestamp/lease fractions бесполезны для следующего
    // решения агента. Округление меняет только представление, не сами таймеры.
    for key in ["idle_remaining", "hard_remaining"] {
        if let value = result[key] as? NSNumber { result[key] = floor(value.doubleValue) }
    }
    if let value = result["input_wait_seconds"] as? NSNumber {
        result["input_wait_seconds"] = (value.doubleValue * 10).rounded() / 10
    }
    return result
}

// Ошибка снимка после действия не заменяет результат действия общей ошибкой:
// отправленные события могли уже изменить iPhone. Агент получает оба факта,
// сохраняет verification_required и делает только read-back перед повтором.
func addingRuntimeObservation(
    to source: [String: Any],
    capture: () throws -> [String: Any]
) -> [String: Any] {
    var result = source
    do {
        result["observation"] = try capture()
    } catch {
        result["observation_error"] = [
            "error_code": "observation_failed",
            "error": error.localizedDescription,
            "verification_required": true,
        ]
    }
    return result
}

func runtimeScreenshotPayload(
    command: String, output: String, capturedAt: Int, screenState: String,
    window: [String: Any], recognizedText: [String]
) -> [String: Any] {
    var result: [String: Any] = [
        "action": "screenshot", "output": output, "captured_at": capturedAt,
        "screen_state": screenState, "window": window,
    ]
    // Согласие на ввод обычного текста не превращается в автоматический echo
    // поля в JSON. Правило действует до выбора compact/full и даже при --ocr.
    if command != "type-text" { result["recognized_text"] = recognizedText }
    return result
}

func withPrivateRuntimeObservation(capture: (URL) throws -> [String: Any]) throws -> [String: Any] {
    // Один OS-owned каталог на кадр не пересекается с чужими файлами и не
    // требует очищать предыдущие снимки, которые ещё может читать агент.
    var template = Array(FileManager.default.temporaryDirectory
        .appendingPathComponent("trelio-iphone-observation-XXXXXX").path.utf8CString)
    guard let created = mkdtemp(&template) else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    let directory = URL(fileURLWithPath: String(cString: created), isDirectory: true)
    let output = directory.appendingPathComponent("screen.png")
    do {
        let result = try capture(output)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
        return result
    } catch {
        try? FileManager.default.removeItem(at: directory)
        throw error
    }
}
