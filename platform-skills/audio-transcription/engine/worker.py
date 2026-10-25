"""Bounded, resumable local ASR; no network transport and no transcript stdout.

Node owns setup/consent. This worker only reads hash-pinned installed artifacts
and writes the exact user-selected job directory. An OS lock prevents two
workers from advancing the same durable transcript concurrently.
"""
from __future__ import annotations

import argparse
import array
import contextlib
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import uuid

RATE = 16000
ENGINE = Path(__file__).resolve().parent
ARTIFACTS = json.loads((ENGINE.parent / "scripts" / "artifacts.json").read_text(encoding="utf-8"))


class Cancelled(Exception):
    pass


def atomic_json(path, value):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextlib.contextmanager
def job_lock(directory):
    fd = os.open(directory / ".worker.lock", os.O_RDWR | os.O_CREAT, 0o600)
    stream = os.fdopen(fd, "r+b")
    try:
        if os.name == "nt":
            import msvcrt
            stream.write(b"0")
            stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        stream.close()


def clock(samples, subtitles=False):
    milliseconds = round(samples * 1000 / RATE)
    hours, milliseconds = divmod(milliseconds, 3600000)
    minutes, milliseconds = divmod(milliseconds, 60000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02}" + (f",{milliseconds:03}" if subtitles else "")


def segment_pcm(stream, cancelled=lambda: False):
    """Keep every sample exactly once, cutting in the quietest 200 ms window.

    GigaAM's ordinary inference is bounded to 25 seconds. At most 23 seconds
    of PCM are retained, even for multi-hour input. Continuous speech still
    needs a hard boundary; we never silently omit samples to make a pause.
    """
    pending = bytearray()
    end = False
    while pending or not end:
        if cancelled():
            raise Cancelled()
        while len(pending) < 23 * RATE * 2 and not end:
            chunk = stream.read(min(65536, 23 * RATE * 2 - len(pending)))
            if not chunk:
                end = True
            else:
                pending.extend(chunk)
        if not pending:
            return
        if len(pending) % 2:
            raise RuntimeError("AUDIO_DECODE_FAILED")
        samples = len(pending) // 2
        stop = samples
        if not end and samples == 23 * RATE:
            audio = array.array("h", pending)
            if sys.byteorder != "little":
                audio.byteswap()
            choices = ((sum(value * value for value in audio[at:at + RATE // 5]), at + RATE // 10)
                       for at in range(16 * RATE, 23 * RATE - RATE // 5, RATE // 20))
            stop = min(choices)[1]
        yield bytes(pending[:stop * 2])
        del pending[:stop * 2]


def ffmpeg_executable():
    # Select only the hash-locked wheel's bundled executable. get_ffmpeg_exe()
    # would also accept an ambient override or an unrelated PATH executable.
    import imageio_ffmpeg
    folder = Path(imageio_ffmpeg.__file__).parent / "binaries"
    files = [p for p in folder.iterdir() if p.is_file() and p.name.startswith("ffmpeg-") and not p.is_symlink()]
    if len(files) != 1:
        raise RuntimeError("AUDIO_DECODER_MISSING")
    return str(files[0])


def ffmpeg_arguments(executable, input_path):
    return [executable, "-nostdin", "-hide_banner", "-loglevel", "error",
            "-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,mp3,mov,matroska,webm,ogg,flac,aac,aiff",
            "-i", str(input_path), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(RATE),
            "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"]


def load_model(state_root, cancelled):
    # A PyTorch checkpoint contains pickle. Check the exact published bytes
    # before torch.load; never accept a user-selected checkpoint or remote code.
    for item in ARTIFACTS["models"]:
        file = state_root / "models" / item["name"]
        if file.is_symlink() or not file.is_file() or file.stat().st_size != item["bytes"]:
            raise RuntimeError("AUDIO_MODEL_INTEGRITY_FAILED")
        digest = hashlib.sha256()
        with file.open("rb") as stream:
            while chunk := stream.read(4 * 1024 * 1024):
                if cancelled():
                    raise Cancelled()
                digest.update(chunk)
        if digest.hexdigest() != item["sha256"]:
            raise RuntimeError("AUDIO_MODEL_INTEGRITY_FAILED")
    sys.path.insert(0, str(ENGINE / "vendor"))
    import torch
    from gigaam.model import GigaAMASR
    torch.set_num_threads(4)
    checkpoint = torch.load(state_root / "models" / "v3_rnnt.ckpt", map_location="cpu", weights_only=False)
    config = checkpoint["cfg"]
    config.encoder.flash_attn = False
    # Plain RNNT decodes the alphabet embedded in its official configuration.
    # It has no separate SentencePiece artifact; carrying over the E2E tokenizer
    # would change the decoder rather than merely format the recognized words.
    model = GigaAMASR(config)
    model.load_state_dict(checkpoint["state_dict"])
    return model.float().eval(), torch


def transcribe_pcm(model, torch, pcm):
    if not any(pcm):
        return ""
    # Pad only a final fragment shorter than the 20 ms analysis window. The
    # stored timestamps still describe its original, unpadded source samples.
    pcm = pcm + b"\0" * max(0, 320 * 2 - len(pcm))
    with torch.inference_mode():
        audio = torch.frombuffer(bytearray(pcm), dtype=torch.int16).float().div_(32768).unsqueeze(0)
        lengths = torch.tensor([audio.shape[-1]], dtype=torch.long)
        encoded, encoded_lengths = model.forward(audio, lengths)
        result = model._decode(encoded, encoded_lengths, lengths)
    return result[0][0]


def write_outputs(directory, state):
    # These are raw ASR segments, not diarization or precise word alignment.
    # Empty results stay in JSON; omitting them from TXT/SRT changes no audio.
    segments = state["segments"]
    text = "\n\n".join(f"[{clock(s['startSample'])} – {clock(s['endSample'])}]\n{s['text']}" for s in segments if s["text"])
    subtitles = []
    for segment in segments:
        if segment["text"]:
            subtitles.append(f"{len(subtitles) + 1}\n{clock(segment['startSample'], True)} --> {clock(segment['endSample'], True)}\n{segment['text']}\n")
    for name, body in [("transcript.txt", text + "\n"), ("transcript.srt", "\n".join(subtitles))]:
        temporary = directory / (name + ".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(body)
        os.replace(temporary, directory / name)
    atomic_json(directory / "transcript.json", {"model": state["model"], "complete": state["state"] == "completed",
                "sampleRate": RATE, "durationSeconds": state["processedSamples"] / RATE, "segments": segments})


def process_job(directory, state_root, run_id, resume=False, model_loader=load_model, infer=transcribe_pcm):
    with job_lock(directory):
        job_file = directory / "job.json"
        state = json.loads(job_file.read_text(encoding="utf-8"))
        if state["state"] == "completed":
            return
        # A runtime upgrade must never append RNNT words to durable E2E
        # segments. Check before changing job state, opening the source or
        # loading weights, and preserve the old job for its original runtime.
        if state.get("model") != ARTIFACTS["model"]:
            raise RuntimeError("AUDIO_JOB_MODEL_MISMATCH")
        if state["segments"] and not resume:
            return
        # Cancellation is fenced by run identity. Ignore an older request on
        # resume without deleting the file: a newly requested cancellation may
        # already be waiting while this interpreter acquires its OS lock.
        state.update(state="validating", pid=os.getpid(), runId=run_id, errorCode=None)
        atomic_json(job_file, state)

        def cancelled():
            file = directory / "cancel.json"
            try:
                return json.loads(file.read_text(encoding="utf-8")).get("runId") == run_id
            except FileNotFoundError:
                return False

        def save():
            state["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            atomic_json(job_file, state)

        decoder = None
        stderr_thread = None
        monitor_stop = threading.Event()
        monitor = None
        started = time.monotonic()
        try:
            source = Path(state["input"])
            stat = source.stat()
            if source.is_symlink() or stat.st_size != state["originalSize"] or abs(stat.st_mtime * 1000 - state["originalMtimeMs"]) > 1:
                raise RuntimeError("AUDIO_SOURCE_CHANGED")
            source_hash = hashlib.sha256()
            with source.open("rb") as stream:
                while chunk := stream.read(4 * 1024 * 1024):
                    if cancelled():
                        raise Cancelled()
                    source_hash.update(chunk)
            fingerprint = source_hash.hexdigest()
            if state.get("sourceSha256") and state["sourceSha256"] != fingerprint:
                raise RuntimeError("AUDIO_SOURCE_CHANGED")
            state.update(sourceSha256=fingerprint, state="loading")
            save()
            model, torch = model_loader(state_root, cancelled)
            state["state"] = "transcribing"
            save()
            decoder = subprocess.Popen(ffmpeg_arguments(ffmpeg_executable(), source), shell=False,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            # Drain stderr without retaining source metadata or unbounded input
            # errors. No decoder exception, source text or transcript is logged.
            stderr_thread = threading.Thread(target=lambda: drain(decoder.stderr), daemon=True)
            stderr_thread.start()
            def cancel_decoder():
                while not monitor_stop.wait(0.2):
                    if cancelled() and decoder.poll() is None:
                        try:
                            decoder.kill()
                        except ProcessLookupError:
                            pass
                        return
            monitor = threading.Thread(target=cancel_decoder, daemon=True)
            monitor.start()
            offset = 0
            completed = state["processedSamples"]
            for pcm in segment_pcm(decoder.stdout, cancelled):
                end = offset + len(pcm) // 2
                if end <= completed:
                    offset = end
                    continue
                if offset != state["processedSamples"]:
                    raise RuntimeError("AUDIO_RESUME_BOUNDARY_MISMATCH")
                before = source.stat()
                if before.st_size != stat.st_size or before.st_mtime_ns != stat.st_mtime_ns:
                    raise RuntimeError("AUDIO_SOURCE_CHANGED")
                if cancelled():
                    raise Cancelled()
                text = infer(model, torch, pcm)
                state["segments"].append({"index": len(state["segments"]), "startSample": offset, "endSample": end, "text": text})
                state["processedSamples"] = end
                state["processingSeconds"] = state.get("processingSeconds", 0) + time.monotonic() - started
                started = time.monotonic()
                save()
                write_outputs(directory, state)
                offset = end
            if cancelled():
                raise Cancelled()
            if decoder.wait(timeout=30) != 0:
                raise RuntimeError("AUDIO_DECODE_FAILED")
            after = source.stat()
            if after.st_size != stat.st_size or after.st_mtime_ns != stat.st_mtime_ns:
                raise RuntimeError("AUDIO_SOURCE_CHANGED")
            if cancelled():
                raise Cancelled()
            state.update(state="completed", totalSeconds=state["processedSamples"] / RATE)
        except Cancelled:
            state["state"] = "cancelled"
        except Exception as error:
            state["state"] = "failed"
            state["errorCode"] = str(error) if re.fullmatch(r"AUDIO_[A-Z_]+", str(error)) else "AUDIO_TRANSCRIPTION_FAILED"
        finally:
            monitor_stop.set()
            if decoder and decoder.poll() is None:
                decoder.kill()
                decoder.wait(timeout=15)
            if stderr_thread:
                stderr_thread.join(timeout=5)
            if monitor:
                monitor.join(timeout=1)
            # Publish the terminal job state only after every deliverable is
            # durable. Otherwise status could expose completed while JSON
            # still says complete=false or Windows still has a file open.
            write_outputs(directory, state)
            save()


def drain(stream):
    while stream.read(8192):
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    try:
        process_job(args.job_dir, args.state_dir, args.run_id, args.resume)
    except Exception:
        # An occupied OS lock or invalid private job cannot overwrite another
        # worker's state. The caller observes the original durable status.
        sys.exit(1)
