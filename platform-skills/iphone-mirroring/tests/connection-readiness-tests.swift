import Foundation

private enum TestFailure: Error { case cancelled, capture }

@main
enum ConnectionReadinessTests {
    static func main() throws {
        func frame(_ state: String = "connected_or_unknown", ready: Bool? = true, id: String = "42:7") -> MirrorConnectionSample {
            MirrorConnectionSample(screenState: state, controlsReady: ready, windowIdentity: id, observation: ["output": id])
        }
        // Однотонный тёмный экран реального приложения допустим. Его отличает
        // AX ready, а не яркость или обязательное наличие OCR/часов iPhone.
        assert(frame(ready: true).effectiveState == "connected_or_unknown")
        assert(frame(ready: false).effectiveState == "connecting")
        assert(frame(ready: nil).effectiveState == "readiness_unavailable")
        assert(frame("iphone_in_use", ready: true).effectiveState == "iphone_in_use")

        var clock = 0.0
        var samples = 0
        var sampleTimes: [Double] = []
        let result = try waitForMirrorConnection(
            now: { clock }, sleep: { clock += $0 }, check: {}, sample: {
                samples += 1; sampleTimes.append(clock)
                // Реальная последовательность retry: gray → connecting →
                // wallpaper без текста → рабочий экран. Текстовая эвристика
                // раньше завершалась уже на первых двух пустых кадрах.
                switch samples {
                case 1, 2: return frame(ready: false)
                case 3: return frame("connecting", ready: false)
                case 4: return frame(ready: false)
                default: return frame()
                }
            }
        )
        assert(result.outcome == "candidate" && samples == 6)
        assert(sampleTimes.first! >= 3 && result.elapsed >= 8)
        assert(result.sample?.observation["output"] as? String == "42:7")
        assert(result.json["connection_candidate"] as? Bool == true)
        assert(result.json["verification_required"] as? Bool == true)

        // Уже готовое окно всё равно проходит начальную паузу и два разных
        // захвата. Переход на другое окно сбрасывает первый кандидат.
        clock = 0; samples = 0
        let changed = try waitForMirrorConnection(
            now: { clock }, sleep: { clock += $0 }, check: {}, sample: {
                samples += 1
                return frame(id: samples == 1 ? "old-window" : "new-window")
            }
        )
        assert(changed.outcome == "candidate" && samples == 3 && changed.elapsed >= 5)

        // Disabled между двумя ready не сохраняет прежний кандидат.
        clock = 0; samples = 0
        let flapped = try waitForMirrorConnection(
            now: { clock }, sleep: { clock += $0 }, check: {}, sample: {
                samples += 1
                return frame(ready: samples != 2)
            }
        )
        assert(flapped.outcome == "candidate" && samples == 4)

        for ready: Bool? in [false, nil] {
            clock = 0; samples = 0
            let unavailable = try waitForMirrorConnection(
                timeout: 6, now: { clock }, sleep: { clock += $0 }, check: {}, sample: {
                    samples += 1; return frame(ready: ready)
                }
            )
            assert(unavailable.outcome == "timed_out" && samples == 3)
            assert(unavailable.elapsed == 6)
            assert(unavailable.json["connection_candidate"] as? Bool == false)
        }

        for state in ["iphone_in_use", "physical_unlock_required", "interrupted", "iphone_not_found", "timed_out", "error", "app_not_running", "welcome_only"] {
            clock = 0; samples = 0
            let blocked = try waitForMirrorConnection(
                now: { clock }, sleep: { clock += $0 }, check: {}, sample: {
                    samples += 1; return frame(state, ready: false)
                }
            )
            assert(blocked.outcome == "blocked" && samples == 1)
            assert(blocked.sample?.effectiveState == state)
        }

        clock = 0; samples = 0
        let short = try waitForMirrorConnection(
            timeout: 1, now: { clock }, sleep: { clock += $0 }, check: {}, sample: {
                samples += 1; return frame()
            }
        )
        assert(short.outcome == "timed_out" && samples == 0 && short.sample == nil)

        // Долгий захват не продлевает бюджет и не выдаёт late success.
        clock = 0; samples = 0
        let slow = try waitForMirrorConnection(
            timeout: 5, now: { clock }, sleep: { clock += $0 }, check: {}, sample: {
                samples += 1; clock += 3; return frame()
            }
        )
        assert(slow.outcome == "timed_out" && samples == 1)

        clock = 0; samples = 0
        do {
            _ = try waitForMirrorConnection(
                now: { clock }, sleep: { clock += $0 }, check: {
                    if clock >= 1 { throw TestFailure.cancelled }
                }, sample: { samples += 1; return frame() }
            )
            assertionFailure("Cancelled caller was allowed to capture")
        } catch TestFailure.cancelled { assert(samples == 0) }

        clock = 0; samples = 0
        do {
            _ = try waitForMirrorConnection(
                now: { clock }, sleep: { clock += $0 }, check: {}, sample: {
                    samples += 1; throw TestFailure.capture
                }
            )
            assertionFailure("Capture error became connection success")
        } catch TestFailure.capture { assert(samples == 1) }
        print("Connection readiness regressions passed")
    }
}
