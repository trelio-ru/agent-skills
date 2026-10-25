"""Real subprocess/decoder tests with synthetic PCM, never personal recordings."""
from pathlib import Path
import array
import importlib.util
import io
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
import wave

ENGINE = Path(__file__).resolve().parents[1] / "engine"
spec = importlib.util.spec_from_file_location("audio_worker", ENGINE / "worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.job = self.root / "результат"
        self.job.mkdir()
        self.source = self.root / "Длинная запись.wav"
        self.pcm = array.array("h", (int(math.sin(i / 27) * 1000) for i in range(65 * worker.RATE))).tobytes()
        with wave.open(str(self.source), "wb") as stream:
            stream.setparams((1, 2, worker.RATE, 0, "NONE", "not compressed"))
            stream.writeframes(self.pcm)
        stat = self.source.stat()
        worker.atomic_json(self.job / "job.json", {"schemaVersion": 1, "model": "v3_rnnt", "state": "queued", "runId": "first",
            "input": str(self.source), "originalSize": stat.st_size, "originalMtimeMs": stat.st_mtime * 1000,
            "segments": [], "processedSamples": 0})

    def tearDown(self):
        self.temporary.cleanup()

    def state(self):
        return json.loads((self.job / "job.json").read_text(encoding="utf-8"))

    def test_segmenter_preserves_every_sample_and_is_bounded(self):
        pieces = list(worker.segment_pcm(io.BytesIO(self.pcm)))
        self.assertEqual(b"".join(pieces), self.pcm)
        self.assertGreater(len(pieces), 2)
        self.assertTrue(all(len(p) <= 23 * worker.RATE * 2 for p in pieces))

    def test_cancel_resume_keeps_exact_cursor_and_unicode_files(self):
        calls = []
        def infer(model, torch, pcm):
            calls.append(pcm)
            if len(calls) == 1:
                worker.atomic_json(self.job / "cancel.json", {"runId": "first"})
            return "Русский текст № 1"
        worker.process_job(self.job, self.root, "first", model_loader=lambda *_: (None, None), infer=infer)
        self.assertEqual(self.state()["state"], "cancelled")
        self.assertEqual(len(self.state()["segments"]), 1)
        self.assertFalse(json.loads((self.job / "transcript.json").read_text(encoding="utf-8"))["complete"])
        worker.process_job(self.job, self.root, "second", resume=True, model_loader=lambda *_: (None, None), infer=infer)
        state = self.state()
        self.assertEqual(state["state"], "completed")
        self.assertEqual(state["processedSamples"], len(self.pcm) // 2)
        self.assertEqual(b"".join(calls), self.pcm)
        self.assertTrue((self.job / "transcript.txt").read_text(encoding="utf-8").startswith("[00:00:00"))
        self.assertIn("Русский текст № 1", (self.job / "transcript.srt").read_text(encoding="utf-8"))
        self.assertTrue(json.loads((self.job / "transcript.json").read_text(encoding="utf-8"))["complete"])

    def test_queued_cancellation_is_not_lost_on_startup(self):
        worker.atomic_json(self.job / "cancel.json", {"runId": "first"})
        called = []
        def load(root, cancelled):
            if cancelled():
                raise worker.Cancelled()
            called.append(True)
            return None, None
        worker.process_job(self.job, self.root, "first", model_loader=load, infer=lambda *_: "unexpected")
        self.assertEqual(self.state()["state"], "cancelled")
        self.assertFalse(called)
        self.assertFalse(self.state()["segments"])

    def test_new_resume_cancellation_survives_startup(self):
        state = self.state()
        state["state"] = "cancelled"
        worker.atomic_json(self.job / "job.json", state)
        worker.atomic_json(self.job / "cancel.json", {"runId": "resumed"})
        called = []
        worker.process_job(self.job, self.root, "resumed", resume=True,
            model_loader=lambda *_: called.append(True), infer=lambda *_: "unexpected")
        self.assertEqual(self.state()["state"], "cancelled")
        self.assertFalse(called)

    def test_changed_source_cannot_resume_or_complete(self):
        state = self.state()
        state.update(state="cancelled", originalSize=0)
        worker.atomic_json(self.job / "job.json", state)
        worker.process_job(self.job, self.root, "next", resume=True, model_loader=lambda *_: (None, None), infer=lambda *_: "unexpected")
        self.assertEqual(self.state()["errorCode"], "AUDIO_SOURCE_CHANGED")
        self.assertEqual(self.state()["state"], "failed")

    def test_corrupt_audio_never_becomes_a_completed_empty_transcript(self):
        self.source.write_bytes(b"not an audio file")
        state = self.state()
        stat = self.source.stat()
        state.update(originalSize=stat.st_size, originalMtimeMs=stat.st_mtime * 1000)
        worker.atomic_json(self.job / "job.json", state)
        worker.process_job(self.job, self.root, "first", model_loader=lambda *_: (None, None), infer=lambda *_: "unexpected")
        self.assertEqual(self.state()["errorCode"], "AUDIO_DECODE_FAILED")
        self.assertEqual(self.state()["state"], "failed")

    def test_model_integrity_is_checked_before_loading_pickle(self):
        with self.assertRaisesRegex(RuntimeError, "AUDIO_MODEL_INTEGRITY_FAILED"):
            worker.load_model(self.root, lambda: False)

    def test_output_files_preserve_raw_words_numbers_and_missing_punctuation(self):
        state = self.state()
        raw = "он не вернул 3 000 рублей и не ответил"
        state.update(state="completed", processedSamples=16000,
            segments=[{"index": 0, "startSample": 0, "endSample": 16000, "text": raw}])
        worker.write_outputs(self.job, state)
        output = json.loads((self.job / "transcript.json").read_text(encoding="utf-8"))
        self.assertEqual(output["segments"][0]["text"], raw)
        self.assertEqual((self.job / "transcript.txt").read_text(encoding="utf-8").split("\n", 1)[1].strip(), raw)
        self.assertEqual((self.job / "transcript.srt").read_text(encoding="utf-8").splitlines()[2], raw)

    def test_resume_cannot_mix_old_e2e_segments_with_rnnt_or_mutate_the_job(self):
        state = self.state()
        state.update(model="v3_e2e_rnnt", state="cancelled", processedSamples=16000,
            segments=[{"index": 0, "startSample": 0, "endSample": 16000, "text": "Сохранённые слова"}])
        worker.atomic_json(self.job / "job.json", state)
        worker.write_outputs(self.job, state)
        originals = {name: (self.job / name).read_bytes()
            for name in ["job.json", "transcript.json", "transcript.txt", "transcript.srt"]}
        calls = []
        with self.assertRaisesRegex(RuntimeError, "AUDIO_JOB_MODEL_MISMATCH"):
            worker.process_job(self.job, self.root, "new-runtime", resume=True,
                model_loader=lambda *_: calls.append(True), infer=lambda *_: "unexpected")
        self.assertFalse(calls)
        for name, content in originals.items():
            self.assertEqual((self.job / name).read_bytes(), content)

    def test_completed_old_model_is_not_reopened_or_rewritten_by_worker(self):
        state = self.state()
        state.update(model="v3_e2e_rnnt", state="completed")
        worker.atomic_json(self.job / "job.json", state)
        before = (self.job / "job.json").read_bytes()
        calls = []
        worker.process_job(self.job, self.root, "new-runtime", resume=True,
            model_loader=lambda *_: calls.append(True))
        self.assertFalse(calls)
        self.assertEqual((self.job / "job.json").read_bytes(), before)

    def test_same_job_os_lock_is_exclusive_in_a_real_child(self):
        source = "import importlib.util,sys; from pathlib import Path; s=importlib.util.spec_from_file_location('w',sys.argv[1]);w=importlib.util.module_from_spec(s);s.loader.exec_module(w);\nwith w.job_lock(Path(sys.argv[2])): print('unexpected')"
        with worker.job_lock(self.job):
            result = subprocess.run([sys.executable, "-I", "-c", source, str(ENGINE / "worker.py"), str(self.job)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(b"unexpected", result.stdout)


if __name__ == "__main__":
    unittest.main()
