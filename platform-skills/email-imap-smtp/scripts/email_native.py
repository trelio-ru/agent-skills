"""Native process ownership and encrypted Windows password storage.

Only code from the signed package is compiled. Compiler output and private
password pipes never become agent-visible diagnostics. The current OS user is
the trust boundary; this does not sandbox other software running as that user.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid


MAXIMUM_LEASE_MS = 1_800_000
SOURCE = Path(__file__).resolve().parent


class NativeError(RuntimeError):
    pass


def child_environment() -> dict[str, str]:
    # Do not propagate legacy TRELIO_EMAIL_PASSWORD_* or Python injection vars
    # into compiler, guardian or worker. These processes need only OS runtime
    # paths, locale and desktop integration, never ambient provider credentials.
    names = {
        "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG",
        "LC_ALL", "LC_CTYPE", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
        "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
        "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "TERM",
        # Value-free, host-selected account metadata survives the owned worker.
        # Provider credentials and arbitrary TRELIO_SKILL_* remain excluded.
        "TRELIO_SKILL_ACCOUNT_JSON",
    }
    return {name: value for name, value in os.environ.items() if name.upper() in names}


def run_private(executable: Path | str, arguments: list[str], *, value: bytes | None = None,
                timeout: float = 120) -> bytes:
    try:
        result = subprocess.run(
            [str(executable), *arguments], input=value, capture_output=True,
            env=child_environment(), timeout=timeout, check=False,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise NativeError("native_email_operation_failed") from None
    if result.returncode != 0 or len(result.stdout) > 16_384:
        # Never include CalledProcessError, compiler text or native stderr:
        # they may contain a path, private input or unexpected OS diagnostics.
        raise NativeError("native_email_operation_failed")
    return result.stdout


def verify_path(path: Path, *, directory: bool) -> None:
    for component in (path, *path.parents):
        if component.is_symlink():
            raise NativeError("native_email_unsafe_storage")
    info = path.lstat()
    if directory != stat.S_ISDIR(info.st_mode) or not directory and not stat.S_ISREG(info.st_mode):
        raise NativeError("native_email_unsafe_storage")
    if os.name == "posix" and (info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise NativeError("native_email_unsafe_storage")


def native_helper(config_directory: Path) -> Path:
    if sys.platform not in {"darwin", "win32"}:
        raise NativeError("encrypted_email_storage_unsupported_os")
    source = SOURCE / ("native-macos.swift" if sys.platform == "darwin" else "native-windows.cs")
    identity = hashlib.sha256(source.read_bytes() + sys.executable.encode()).hexdigest()
    # Stable device-wide email namespace, outside the materialized package and
    # any company/Workspace. A changed native source gets a separate build.
    parent = config_directory / "native"
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    for component in (parent, *parent.parents):
        if component.is_symlink():
            raise NativeError("native_email_unsafe_storage")
    cache = parent / identity
    windows = Path(os.environ.get("SystemRoot", os.environ.get("SYSTEMROOT", "")))
    if sys.platform == "win32" and not windows.is_absolute():
        raise NativeError("native_email_system_root_required")
    if not cache.exists():
        if sys.platform == "win32":
            run_private(windows / "System32/WindowsPowerShell/v1.0/powershell.exe",
                        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                         "-File", str(SOURCE / "private-directory.ps1"), str(cache)])
        else:
            cache.mkdir(mode=0o700)
    verify_path(cache, directory=True)
    executable = cache / ("native.exe" if sys.platform == "win32" else "Trelio")
    if not executable.exists():
        candidate = cache / ("build-" + uuid.uuid4().hex + (".exe" if sys.platform == "win32" else ""))
        try:
            if sys.platform == "darwin":
                run_private("/usr/bin/swiftc", ["-O", "-o", str(candidate), str(source)])
            else:
                run_private(windows / "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
                            ["/nologo", "/target:exe", "/optimize+", "/platform:anycpu", "/codepage:65001",
                             "/r:System.Security.dll", "/r:System.Web.Extensions.dll", "/out:" + str(candidate), str(source)])
            if sys.platform == "win32":
                # An elevated Windows token can give compiler output the
                # Administrators group as owner even inside a private folder.
                # Let the exact freshly-built helper replace that descriptor
                # before it becomes the cached executable.
                run_private(candidate, ["secure-file", str(candidate)])
            else:
                candidate.chmod(0o700)
            candidate.replace(executable)
        finally:
            candidate.unlink(missing_ok=True)
    verify_path(executable, directory=False)
    if sys.platform == "win32":
        run_private(executable, ["verify-directory", str(cache)])
        run_private(executable, ["verify-file", str(executable)])
    run_private(executable, ["probe"])
    return executable


def windows_password(config_directory: Path, account_name: str, username: str,
                     value: bytes | None = None) -> bytes:
    helper = native_helper(config_directory)
    identity = hashlib.sha256(json.dumps([account_name, username], ensure_ascii=False,
                                        separators=(",", ":")).encode()).hexdigest()
    directory = config_directory / "secrets" / "encrypted"
    run_private(helper, ["private-directory", str(directory)])
    return run_private(helper, ["password-read" if value is None else "password-write",
                                str(directory / (identity + ".dpapi")), identity], value=value)


def windows_config_backup(config_directory: Path, filename: str, value: bytes) -> Path:
    helper = native_helper(config_directory)
    directory = config_directory / "previous"
    run_private(helper, ["private-directory", str(directory)])
    destination = directory / filename
    run_private(helper, ["write-private", str(destination)], value=value)
    return destination


def supervise(config_directory: Path, arguments: list[str], *, terminal: bool,
              started_at: int, opener) -> int:
    helper = native_helper(config_directory)
    config = json.dumps({"arguments": arguments, "terminal": terminal,
                         "terminalDevice": os.ttyname(sys.stdin.fileno()) if terminal and os.name == "posix" else None,
                         "consoleOwner": os.getpid() if terminal and os.name == "nt" else None,
                         "startedAt": started_at, "expiresAt": started_at + MAXIMUM_LEASE_MS}, ensure_ascii=False)
    if len(config.encode()) >= 65536:
        raise NativeError("native_email_arguments_too_large")
    process = subprocess.Popen(
        [str(helper), "guard", sys.executable, str(SOURCE / "email_worker.py"), str(MAXIMUM_LEASE_MS)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env=child_environment(), start_new_session=sys.platform == "darwin",
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    try:
        process.stdin.write((config + "\n").encode())
        process.stdin.flush()
        opened = False
        while True:
            line = process.stdout.readline(128 * 1024 * 1024)
            if not line or not line.endswith(b"\n"):
                raise NativeError("native_email_session_ended; operation outcome may be unknown")
            try:
                packet = json.loads(line)
            except (ValueError, UnicodeError):
                raise NativeError("native_email_protocol_invalid") from None
            if packet.get("op") == "open" and not opened:
                url = packet.get("url", "")
                if not isinstance(url, str) or not re.fullmatch(r"http://127\.0\.0\.1:[0-9]{1,5}/[A-Za-z0-9_/-]{32,128}", url):
                    raise NativeError("native_email_opener_invalid")
                opened = True
                try:
                    # Run the system opener outside the worker's Windows Job.
                    # Otherwise cleanup could kill a newly started user browser.
                    # The nonce crosses only this private pipe, never CLI output.
                    opener(url)
                    ok = True
                except Exception:
                    ok = False
                process.stdin.write((json.dumps({"ok": ok}) + "\n").encode())
                process.stdin.flush()
            elif packet.get("op") == "result" and packet.get("code") in {0, 2} and isinstance(packet.get("value"), str):
                # Only a completed ordinary command result reaches the agent.
                # Print it before waiting: a later cleanup failure cannot undo
                # confirmed SMTP acceptance or justify another send.
                print(packet["value"], file=sys.stdout if packet["code"] == 0 else sys.stderr, flush=True)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass  # Preserve the received result; finally owns cleanup.
                return packet["code"]
            else:
                raise NativeError("native_email_protocol_invalid")
    finally:
        if process.poll() is None:
            # SIGTERM is handled by the macOS guardian; closing the Windows Job
            # handle kills its complete owned tree, even if the worker is hung.
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        process.stdin.close()
        process.stdout.close()
