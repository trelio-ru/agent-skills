import Foundation

// OCR не отличает серый кадр и фон Apple без текста от приложения iPhone.
// Поэтому кандидат требует независимого положительного AX-сигнала: системные
// пункты навигации включены до и после захвата exact рабочего окна.
struct MirrorConnectionSample {
    let screenState: String
    let controlsReady: Bool?
    let windowIdentity: String
    let observation: [String: Any]

    var effectiveState: String {
        guard screenState == "connected_or_unknown" else { return screenState }
        if controlsReady == nil { return "readiness_unavailable" }
        return controlsReady == true ? screenState : "connecting"
    }
}

struct MirrorConnectionWaitResult {
    let outcome: String
    let elapsed: TimeInterval
    let sample: MirrorConnectionSample?

    var json: [String: Any] {
        [
            "connection_outcome": outcome,
            "connection_candidate": outcome == "candidate",
            "connection_wait_seconds": (elapsed * 10).rounded() / 10,
            "screen_state": sample?.effectiveState ?? "not_checked",
            // Даже доступные команды Apple доказывают только transport-ready,
            // а не исполнение бизнес-действия или смысл содержимого экрана.
            "verification_required": true,
        ]
    }
}

// Одно ожидание принадлежит уже выполненному start/retry. Оно никогда не
// нажимает кнопку, не перезапускает приложение и не продлевает свой deadline.
// Clock, sleep и sample внедряются для проверки настоящего алгоритма без
// телефона/TCC; production использует только монотонные systemUptime-часы.
func waitForMirrorConnection(
    timeout: TimeInterval = 30,
    interval: TimeInterval = 1,
    minimumDelay: TimeInterval = 3,
    now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    sleep: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
    check: () throws -> Void,
    sample: () throws -> MirrorConnectionSample
) throws -> MirrorConnectionWaitResult {
    let started = now()
    let deadline = started + timeout
    let terminalStates: Set<String> = [
        "interrupted", "iphone_in_use", "iphone_not_found", "timed_out", "error",
        "physical_unlock_required", "app_not_running", "welcome_only",
    ]
    var last: MirrorConnectionSample?
    var candidateIdentity: String?
    var nextSampleAt = started + minimumDelay

    while now() < deadline {
        // Проверка caller/lease выполняется и во время начальной паузы.
        // Stop другой команды не оставляет CLI ждать и затем читать новую lease.
        try check()
        if now() < nextSampleAt {
            sleep(max(0, min(0.1, min(nextSampleAt, deadline) - now())))
            continue
        }
        let current = try sample()
        last = current
        try check()
        // Время OCR входит в тот же бюджет; кадр, завершившийся после deadline,
        // нельзя объявлять успешным на основании старого начала проверки.
        guard now() < deadline else { break }
        if terminalStates.contains(current.effectiveState) {
            return MirrorConnectionWaitResult(outcome: "blocked", elapsed: now() - started, sample: current)
        }
        if current.effectiveState == "connected_or_unknown", current.controlsReady == true,
           !current.windowIdentity.isEmpty {
            if candidateIdentity == current.windowIdentity {
                return MirrorConnectionWaitResult(outcome: "candidate", elapsed: now() - started, sample: current)
            }
            candidateIdentity = current.windowIdentity
        } else {
            candidateIdentity = nil
        }
        nextSampleAt = now() + interval
    }
    return MirrorConnectionWaitResult(outcome: "timed_out", elapsed: now() - started, sample: last)
}
