#!/usr/bin/env python3
"""Private local Telegram MTProto runtime for the Trelio skill catalog.

The installation-wide Telegram app credential is part of the immutable signed
runtime package. It is distributable application identity, while the personal
MTProto session, login factors and read-only restriction stay local in the stable
skill/company/member/connection namespace.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import getpass
import hashlib
import http.server
import io
import json
import math
import os
import re
import secrets
import stat
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse
import venv
import webbrowser
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


SKILL_ID = "telegram-mtproto"
APP_CREDENTIAL_FILE = Path(__file__).resolve().with_name("telegram-app-credentials.json")
MAX_APP_CREDENTIAL_FILE_BYTES = 4_096
HOST_COMPANY_ID_ENV = "TRELIO_SKILL_COMPANY_ID"
HOST_MEMBER_ID_ENV = "TRELIO_SKILL_MEMBER_ID"
HOST_CONNECTION_ID_ENV = "TRELIO_SKILL_CONNECTION_ID"
HOST_CONNECTION_CONFIG_ENV = "TRELIO_SKILL_CONNECTION_CONFIG_JSON"
LEGACY_API_HASH_FILE_NAME = "api_hash"
RUNTIME_VERSION = "1"
POLICY_MODES = ("confirm", "read-only")
# Windows Python does not ship the IANA timezone database used by export.
# Pinning tzdata beside the other bootstrap dependencies keeps the same named
# timezone contract on every supported OS without falling back to guessed UTC
# offsets or platform-specific timezone names.
RUNTIME_PYTHON_PACKAGES = (
    "telethon>=1.44,<2",
    "qrcode[pil]>=8,<9",
    "tzdata>=2025.2,<2027",
)
MAX_MESSAGE_CHARS = 4096
# Telethon's client default is Markdown today, but relying on that implicit
# default makes formatted output changeable by a dependency update or caller
# configuration. Keep the provider contract explicit for both new messages
# and edits. In particular, Telegram HTML such as ``<a href=...>`` is literal
# text in this mode; a rendered link is written as ``[label](https://...)``.
TELEGRAM_TEXT_PARSE_MODE = "md"
TELEGRAM_TEXT_PARSE_MODE_NAME = "telegram-markdown"
# Telegram captions have a lower provider limit than ordinary text messages.
# The edit command validates that distinction after loading the exact target.
MAX_CAPTION_CHARS = 1024
# Telegram already bounds ordinary messages, but keeping explicit output caps
# makes the JSON contract safe even when a future MTProto object or test double
# contains unexpectedly large values.
MAX_READ_TEXT_CHARS = 16_384
MAX_REPLY_TEXT_CHARS = 4_096
MAX_ENTITY_TITLE_CHARS = 256
MAX_ENTITY_USERNAME_CHARS = 64
MAX_CHAT_REFERENCE_CHARS = 256
MAX_FILE_NAME_CHARS = 512
MAX_MEMBER_QUERY_CHARS = 128
MAX_SEARCH_QUERY_CHARS = 256
# Context expansion intentionally has a tighter result ceiling than snippet-only
# search. Ten matches with ten messages on either side already produce up to 210
# normalized messages, which is enough to reconstruct several discussions while
# keeping provider calls and JSON output predictably bounded.
MAX_SEARCH_CONTEXT_RADIUS = 10
MAX_SEARCH_CONTEXT_RESULTS = 10
# Telegram turns a schedule date less than ten seconds in the future into an
# immediate send. Requiring a full minute at the last pre-mutation check leaves
# room for peer resolution and ordinary network latency without silently
# changing the user's requested future delivery into a live message.
MIN_SCHEDULE_LEAD_SECONDS = 60
MAX_SCHEDULE_AT_CHARS = 64
DEFAULT_SCHEDULED_LIMIT = 20
MAX_SCHEDULED_LIMIT = 100
MESSAGE_WORKFLOW_VERSION = "2.3.1"
MAX_FILTERED_SEARCH_SCAN = 1_000
MAX_FILTERED_SEARCH_PAGES = 10
MAX_TRANSCRIPT_CHARS = 65_536
MESSAGE_APPROVAL_TTL_SECONDS = 300
SEARCH_MEDIA_FILTERS = {
    "any": "InputMessagesFilterEmpty",
    "photo": "InputMessagesFilterPhotos",
    "video": "InputMessagesFilterVideo",
    "document": "InputMessagesFilterDocument",
    "voice": "InputMessagesFilterVoice",
    "round-video": "InputMessagesFilterRoundVideo",
    "audio": "InputMessagesFilterMusic",
    "url": "InputMessagesFilterUrl",
}
RFC3339_SCHEDULE_PATTERN = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})"
)
# Global Telegram search uses a provider cursor made from offset rate, peer and
# message id. The public token carries only bounded numeric offsets plus a query
# digest; the peer access hash is resolved again from Telethon's private session
# cache and never leaves the runtime.
GLOBAL_SEARCH_BATCH_LIMIT = 100
MAX_GLOBAL_SEARCH_CURSOR_RESULTS = 10_000
MAX_GLOBAL_SEARCH_CURSOR_CHARS = 1_024
DEFAULT_MEMBER_LIMIT = 100
MAX_MEMBER_LIMIT = 200
MAX_LINK_ENTITIES = 32
MAX_LINK_TEXT_CHARS = 512
MAX_LINK_URL_CHARS = 2_048
MAX_REPLY_RESOLUTION_CONCURRENCY = 8
# Telegram explicitly requires client-side throttling for contacts.resolvePhone.
# Persisting the timestamp below the exact connection identity keeps separate
# runtime processes from accidentally exceeding the provider's one-call-per-
# three-seconds contract without storing the searched phone number itself.
RESOLVE_PHONE_MIN_INTERVAL_SECONDS = 3.0
RESOLVE_PHONE_RATE_STATE_VERSION = 1
MAX_RESOLVE_PHONE_RATE_STATE_BYTES = 256
MIN_INTERNATIONAL_PHONE_DIGITS = 5
MAX_INTERNATIONAL_PHONE_DIGITS = 15
# Period exports can cover many dialogs, so they need an aggregate ceiling in
# addition to the per-dialog history limits. The reserved metadata allowance
# keeps the final JSON wrapper, chat summaries and truncation warnings inside
# the advertised byte budget without retaining an unbounded message array.
DEFAULT_EXPORT_TIMEZONE = "Europe/Moscow"
DEFAULT_EXPORT_DIALOG_LIMIT = 500
DEFAULT_EXPORT_PER_CHAT_LIMIT = 2_000
DEFAULT_EXPORT_SCAN_LIMIT = 10_000
DEFAULT_EXPORT_TOTAL_MESSAGE_LIMIT = 10_000
DEFAULT_EXPORT_MAX_OUTPUT_BYTES = 8 * 1_024 * 1_024
MAX_EXPORT_OUTPUT_BYTES = 16 * 1_024 * 1_024
EXPORT_METADATA_RESERVE_BYTES = 1 * 1_024 * 1_024
DEFAULT_QR_LOGIN_TIMEOUT_SECONDS = 300
DEFAULT_QR_REFRESH_SECONDS = 25
MAX_PROMPT_BODY_BYTES = 4_096
MAX_PASSWORD_HINT_CHARS = 256
LOGIN_METHOD_CODE = "code"
LOGIN_METHOD_QR = "qr"
BROWSER_PROMPT_SESSION: "BrowserPromptSession | None" = None


class TelegramRuntimeError(RuntimeError):
    """Expected, user-safe configuration or protocol error.

    Most runtime failures need only a concise message. A few recovery paths are
    agent-facing protocols in their own right, so they may additionally expose
    a stable code, bounded public details and one explicit next action. Keeping
    that structure on the expected exception prevents raw Telethon diagnostics
    from leaking while still giving the caller enough information to recover.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        details: dict[str, Any] | None = None,
        next_action: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = dict(details) if details else None
        self.next_action = dict(next_action) if next_action else None

    def public_payload(self) -> dict[str, Any]:
        """Serialize only the explicitly allowlisted agent-visible fields."""

        payload: dict[str, Any] = {"ok": False, "error": str(self)}
        if self.code:
            payload["code"] = self.code
        if self.details:
            payload["details"] = self.details
        if self.next_action:
            payload["nextAction"] = self.next_action
        return payload


class PromptCancelled(TelegramRuntimeError):
    """Raised when the user intentionally cancels a local login prompt."""


class BrowserPromptUnavailable(TelegramRuntimeError):
    """Raised when a protected local browser prompt cannot be delivered."""


@dataclass(frozen=True)
class Identity:
    company_id: str
    member_id: str
    connection_id: str


@dataclass(frozen=True)
class GlobalSearchCursor:
    seen: int = 0
    offset_rate: int = 0
    offset_peer_id: int | None = None
    offset_id: int = 0


def default_config_home() -> Path:
    override = os.environ.get("TRELIO_CONFIG_HOME")
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Trelio"
    return Path.home() / ".config" / "trelio"


def default_cache_home() -> Path:
    override = os.environ.get("TRELIO_CACHE_HOME")
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Trelio" / "cache"
    return Path.home() / ".cache" / "trelio"


def normalize_identity_part(value: str | None, label: str) -> str:
    normalized = str(value or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", normalized):
        raise TelegramRuntimeError(f"{label} must contain only lowercase letters, digits and hyphens.")
    return normalized


def positive_message_id(value: str) -> int:
    """Reject zero/negative message ids before opening the MTProto session."""

    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError("message id must be a positive integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("message id must be a positive integer")
    return parsed


def utc_now() -> datetime:
    """Return an aware clock value through one patchable test seam."""

    return datetime.now(timezone.utc)


def normalize_schedule_datetime(value: datetime) -> datetime:
    """Normalize a provider or user timestamp to whole UTC seconds."""

    if value.tzinfo is None or value.utcoffset() is None:
        raise TelegramRuntimeError("Scheduled message time must include an explicit UTC offset or Z.")
    return value.astimezone(timezone.utc).replace(microsecond=0)


def format_utc_datetime(value: datetime) -> str:
    """Serialize an aware timestamp in a stable RFC 3339 UTC form."""

    return normalize_schedule_datetime(value).isoformat().replace("+00:00", "Z")


def assert_schedule_lead_time(
    scheduled_at: datetime,
    *,
    now: datetime | None = None,
) -> None:
    """Prevent Telegram from converting a near-term schedule into an immediate send."""

    reference = normalize_schedule_datetime(now or utc_now())
    if scheduled_at < reference + timedelta(seconds=MIN_SCHEDULE_LEAD_SECONDS):
        raise TelegramRuntimeError(
            f"--schedule-at must be at least {MIN_SCHEDULE_LEAD_SECONDS} seconds in the future "
            "so Telegram cannot turn it into an immediate send."
        )


def parse_schedule_at(
    value: str,
    *,
    now: datetime | None = None,
) -> datetime:
    """Parse one unambiguous RFC 3339 delivery time without guessing a timezone."""

    normalized = unicodedata.normalize("NFKC", str(value or "")).strip()
    if len(normalized) > MAX_SCHEDULE_AT_CHARS or not RFC3339_SCHEDULE_PATTERN.fullmatch(
        normalized
    ):
        raise TelegramRuntimeError(
            "--schedule-at must be RFC 3339 with seconds and an explicit UTC offset or Z."
        )
    try:
        parsed = datetime.fromisoformat(
            normalized[:-1] + "+00:00" if normalized.endswith("Z") else normalized
        )
    except ValueError as error:
        raise TelegramRuntimeError("--schedule-at is not a valid calendar timestamp.") from error
    scheduled_at = normalize_schedule_datetime(parsed)
    assert_schedule_lead_time(scheduled_at, now=now)
    return scheduled_at


def normalize_phone_lookup(value: Any) -> str:
    """Normalize one explicit international number without echoing it.

    ``contacts.resolvePhone`` expects an international number. The runtime
    accepts common human formatting but never guesses a country code or turns a
    domestic leading digit into another country. Returning digits only matches
    Telegram's canonical phone representation and keeps the provider request
    deterministic.
    """

    if not isinstance(value, str):
        raise TelegramRuntimeError(
            "Phone lookup requires one international number beginning with +."
        )
    normalized = unicodedata.normalize("NFKC", value).strip()
    if not re.fullmatch(r"\+[0-9 ().-]+", normalized):
        raise TelegramRuntimeError(
            "Phone lookup requires one international number beginning with + and containing no extension."
        )
    digits = re.sub(r"[^0-9]", "", normalized)
    if not re.fullmatch(
        rf"[1-9][0-9]{{{MIN_INTERNATIONAL_PHONE_DIGITS - 1},{MAX_INTERNATIONAL_PHONE_DIGITS - 1}}}",
        digits,
    ):
        raise TelegramRuntimeError(
            f"Phone lookup requires from {MIN_INTERNATIONAL_PHONE_DIGITS} to "
            f"{MAX_INTERNATIONAL_PHONE_DIGITS} international digits after +."
        )
    return digits


def resolve_host_identity_part(
    cli_value: str | None,
    *,
    environment_name: str,
    label: str,
) -> str:
    """Prefer the live host identity and reject an attempted CLI override.

    Older instructions supplied these values as explicit arguments. Keeping
    matching arguments compatible avoids breaking an in-flight agent turn,
    while the signed host environment becomes authoritative for every current
    direct invocation and cannot be redirected to another local namespace.
    """

    host_value = os.environ.get(environment_name)
    normalized_host = (
        normalize_identity_part(host_value, environment_name)
        if host_value is not None
        else None
    )
    normalized_cli = (
        normalize_identity_part(cli_value, label)
        if cli_value is not None
        else None
    )
    if normalized_host is not None and normalized_cli not in (None, normalized_host):
        raise TelegramRuntimeError(f"{label} does not match the signed runtime host identity.")
    if normalized_host is not None:
        return normalized_host
    if normalized_cli is not None:
        return normalized_cli
    raise TelegramRuntimeError(f"{label} is missing from the signed runtime host identity.")


def identity_from_args(args: argparse.Namespace) -> Identity:
    return Identity(
        company_id=resolve_host_identity_part(
            args.company_id,
            environment_name=HOST_COMPANY_ID_ENV,
            label="company-id",
        ),
        member_id=resolve_host_identity_part(
            args.member_id,
            environment_name=HOST_MEMBER_ID_ENV,
            label="member-id",
        ),
        connection_id=resolve_host_identity_part(
            args.connection_id,
            environment_name=HOST_CONNECTION_ID_ENV,
            label="connection-id",
        ),
    )


def connection_root(identity: Identity) -> Path:
    return (
        default_config_home()
        / "integrations"
        / SKILL_ID
        / identity.company_id
        / identity.member_id
        / identity.connection_id
    )


def runtime_root() -> Path:
    return default_cache_home() / "runtimes" / SKILL_ID / RUNTIME_VERSION


def runtime_python() -> Path:
    if os.name == "nt":
        return runtime_root() / "Scripts" / "python.exe"
    return runtime_root() / "bin" / "python"


def ensure_private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    file_stat = path.lstat()
    if not stat.S_ISDIR(file_stat.st_mode):
        raise TelegramRuntimeError(f"Unsafe local directory {path}: expected a real directory.")
    if os.name == "posix":
        if file_stat.st_uid != os.getuid():
            raise TelegramRuntimeError(f"Unsafe owner for local directory {path}.")
        path.chmod(0o700)


def ensure_private_file(path: Path) -> None:
    if not path.exists():
        return
    file_stat = path.lstat()
    if not stat.S_ISREG(file_stat.st_mode):
        raise TelegramRuntimeError(f"Unsafe local file {path}: expected a regular file.")
    if os.name != "posix":
        return
    if file_stat.st_uid != os.getuid():
        raise TelegramRuntimeError(f"Unsafe owner for local file {path}.")
    mode = file_stat.st_mode & 0o777
    if mode & 0o077:
        raise TelegramRuntimeError(f"Unsafe permissions on {path}: expected 600, got {mode:o}.")


def write_private_text(path: Path, value: str) -> None:
    """Atomically write one local credential or config without following links.

    The MTProto session already makes this per-user directory a machine trust
    root. The extra regular-file, owner and mode checks still prevent an
    accidental group/world-readable copy or a pre-created symlink from turning
    a local credential write into disclosure outside that namespace.
    """

    ensure_private_directory(path.parent)
    ensure_private_file(path)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor: int | None = None
    try:
        descriptor = os.open(temporary, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            descriptor = None
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name == "posix":
            path.chmod(0o600)
        ensure_private_file(path)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


def write_private_json(path: Path, value: dict[str, Any]) -> None:
    write_private_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def policy_path(identity: Identity) -> Path:
    return connection_root(identity) / "config" / "policy.json"


def resolve_phone_rate_state_path(identity: Identity) -> Path:
    return connection_root(identity) / "state" / "resolve-phone-rate-limit.json"


def load_resolve_phone_last_attempt(identity: Identity) -> float | None:
    """Read only the bounded timestamp used for cross-process throttling."""

    path = resolve_phone_rate_state_path(identity)
    if not path.exists():
        return None
    ensure_private_file(path)
    if path.stat().st_size > MAX_RESOLVE_PHONE_RATE_STATE_BYTES:
        raise TelegramRuntimeError("Local Telegram phone lookup rate state is invalid.")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise TelegramRuntimeError(
            "Cannot read the local Telegram phone lookup rate state."
        ) from error
    timestamp = data.get("lastAttemptAt") if isinstance(data, dict) else None
    if (
        not isinstance(data, dict)
        or data.get("schemaVersion") != RESOLVE_PHONE_RATE_STATE_VERSION
        or isinstance(timestamp, bool)
        or not isinstance(timestamp, (int, float))
        or not math.isfinite(timestamp)
        or timestamp < 0
    ):
        raise TelegramRuntimeError("Local Telegram phone lookup rate state is invalid.")
    return float(timestamp)


def reserve_resolve_phone_slot(identity: Identity) -> float:
    """Reserve one provider lookup no sooner than three seconds after the last.

    The surrounding session lock serializes all processes for this exact local
    Telegram identity. The timestamp is written *before* the network request,
    so a failed or interrupted request still consumes its provider rate slot.
    No searched number or returned identity is ever persisted here.
    """

    last_attempt = load_resolve_phone_last_attempt(identity)
    now = time.time()
    waited = 0.0
    if last_attempt is not None:
        elapsed = max(0.0, now - last_attempt)
        waited = max(0.0, RESOLVE_PHONE_MIN_INTERVAL_SECONDS - elapsed)
        if waited > 0:
            time.sleep(waited)
            now = time.time()
    # If the wall clock moved backwards, retaining the later timestamp keeps
    # subsequent invocations conservative instead of accidentally bursting.
    attempted_at = max(now, last_attempt or 0.0)
    write_private_json(
        resolve_phone_rate_state_path(identity),
        {
            "schemaVersion": RESOLVE_PHONE_RATE_STATE_VERSION,
            "lastAttemptAt": attempted_at,
        },
    )
    return waited


def load_policy(identity: Identity) -> dict[str, Any]:
    path = policy_path(identity)
    if not path.exists():
        return {"sendMode": "confirm"}
    ensure_private_file(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise TelegramRuntimeError(f"Cannot read local policy {path}: {error}") from error
    mode = data.get("sendMode")
    # Old installations may retain a device-wide authorization. Reading it
    # must never authorize a new conversation; preserve the file for rollback
    # while reducing its effective behavior to per-invocation confirmation.
    if mode == "autonomous":
        mode = "confirm"
    if mode not in POLICY_MODES:
        raise TelegramRuntimeError(f"Local policy {path} has an unsupported sendMode.")
    return {"sendMode": mode}


def assert_send_allowed(
    identity: Identity,
    *,
    confirmed: bool,
) -> str:
    mode = str(load_policy(identity)["sendMode"])
    if mode == "read-only":
        raise TelegramRuntimeError("Local Telegram policy is read-only; sending and edits are disabled.")
    # The agent attests authorization for this invocation only: either the
    # exact message was approved or the operator explicitly authorized sending
    # within the current conversation's scope. Nothing is persisted here.
    if not confirmed:
        raise TelegramRuntimeError("Telegram send requires --confirm for this invocation.")
    return mode


@contextlib.contextmanager
def session_lock(identity: Identity) -> Iterator[None]:
    """Serialize one local MTProto session without storing lock data in a Run."""

    lock_dir = connection_root(identity) / "locks"
    ensure_private_directory(lock_dir)
    lock_path = lock_dir / "session.lock"
    lock_file = lock_path.open("a+b")
    try:
        if os.name == "nt":
            import msvcrt

            try:
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise TelegramRuntimeError("This Telegram session is already used by another process.") from error
        else:
            import fcntl

            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise TelegramRuntimeError("This Telegram session is already used by another process.") from error
        yield
    finally:
        if os.name == "nt":
            with contextlib.suppress(OSError):
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            with contextlib.suppress(OSError):
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        lock_file.close()


def browser_prompt_app_page() -> bytes:
    """Render the self-contained local login page without external assets."""

    return """<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trelio Telegram</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: #eef0f2;
    color: #202124;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  main {
    width: min(620px, calc(100vw - 32px));
    box-sizing: border-box;
    background: #fff;
    border: 1px solid #d9dce1;
    border-radius: 12px;
    box-shadow: 0 18px 48px rgba(0,0,0,.18);
    padding: 24px;
  }
  h1 { margin: 0 0 16px; font-size: 20px; line-height: 1.35; font-weight: 650; }
  form { display: grid; gap: 14px; }
  input {
    box-sizing: border-box;
    width: 100%;
    min-height: 44px;
    border: 2px solid #1a73e8;
    border-radius: 8px;
    padding: 8px 10px;
    color: #202124;
    background: #fff;
    font-size: 18px;
  }
  input:focus { outline: 3px solid rgba(26,115,232,.2); }
  .actions { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
  button {
    min-width: 120px;
    min-height: 40px;
    border: 1px solid #c9cdd3;
    border-radius: 8px;
    background: #eef0f2;
    color: #202124;
    font-size: 16px;
    cursor: pointer;
  }
  button.primary { border-color: #1a73e8; background: #1a73e8; color: #fff; }
  .error { margin: 0 0 12px; color: #b00020; font-size: 14px; }
  .prompt-hint { margin: 0 0 12px; color: #5f6368; font-size: 14px; line-height: 1.45; }
  .password-manager-warning {
    margin: 0;
    padding: 10px 12px;
    border-radius: 8px;
    background: #fff8e1;
    color: #5f4200;
    font-size: 14px;
    line-height: 1.4;
  }
  .muted { margin: 0; color: #5f6368; line-height: 1.45; }
  .small { margin: 10px 0 0; color: #5f6368; font-size: 14px; line-height: 1.4; }
  .qr-wrap { display: grid; place-items: center; margin: 4px 0 16px; }
  .qr {
    width: min(72vw, 440px);
    height: auto;
    image-rendering: pixelated;
    background: #fff;
    padding: 18px;
    border: 1px solid #d9dce1;
    border-radius: 8px;
  }
</style>
<main id="app">
  <h1>Trelio Telegram</h1>
  <p class="muted">Жду следующий шаг входа…</p>
</main>
<script>
const app = document.getElementById("app");
let currentPromptId = null;
let polling = true;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderWaiting() {
  currentPromptId = null;
  app.innerHTML = `<h1>Trelio Telegram</h1><p class="muted">Жду следующий шаг входа…</p>`;
}

function renderFinished(data) {
  currentPromptId = null;
  polling = false;
  app.innerHTML = `<h1>${escapeHtml(data.title || "Готово")}</h1>
    <p class="muted">${escapeHtml(data.message || "Можно закрыть вкладку и вернуться в Codex.")}</p>`;
}

function renderQr(data) {
  currentPromptId = "qr";
  const seconds = data.expires_in
    ? `<p class="small">QR обновится автоматически. Осталось примерно ${escapeHtml(data.expires_in)} сек.</p>`
    : "";
  app.innerHTML = `<h1>${escapeHtml(data.title || "Вход по QR-коду Telegram")}</h1>
    <div class="qr-wrap"><img class="qr" alt="Telegram QR" src="${escapeHtml(data.image_data_url)}"></div>
    <p class="muted">Telegram: Настройки → Устройства → Подключить устройство</p>
    <p class="small">Сканируйте QR только из приложения Telegram. Не пересылайте и не фотографируйте эту страницу.</p>
    ${seconds}`;
}

function renderPrompt(data) {
  currentPromptId = data.id;
  const error = data.error ? `<p class="error">${escapeHtml(data.error)}</p>` : "";
  const hint = data.hint
    ? `<p class="prompt-hint"><strong>Подсказка Telegram:</strong> ${escapeHtml(data.hint)}</p>`
    : "";
  const cancelLabel = escapeHtml(data.cancel_label || "Отмена");
  let controls = "";
  if (data.choices && data.choices.length) {
    controls = `<div class="actions">
      <button type="button" data-cancel="1">${cancelLabel}</button>
      ${data.choices.map(([value, label]) =>
        `<button class="primary" type="submit" name="choice" value="${escapeHtml(value)}">${escapeHtml(label)}</button>`
      ).join("")}
    </div>`;
  } else {
    const inputType = data.hidden ? "password" : "text";
    const required = data.allow_empty ? "" : "required";
    const passwordManagerWarning = data.hidden
      ? `<p class="password-manager-warning">Сохранять данные в браузере не нужно – подключение будет сохранено отдельно на этом устройстве. Если браузер предложит сохранить данные, выберите «Нет, спасибо».</p>`
      : "";
    controls = `<input autofocus name="value" type="${inputType}" autocomplete="off" ${required}>
      ${passwordManagerWarning}
      <div class="actions">
        <button type="button" data-cancel="1">${cancelLabel}</button>
        <button class="primary" type="submit">Продолжить</button>
      </div>`;
  }
  app.innerHTML = `<h1>${escapeHtml(data.prompt)}</h1>${hint}${error}<form id="prompt-form" autocomplete="off">${controls}</form>`;
  const form = document.getElementById("prompt-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = event.submitter;
    const formData = new FormData(form);
    if (submitter && submitter.name) formData.set(submitter.name, submitter.value);
    formData.set("id", String(data.id));
    await submitPrompt(data, formData);
  });
  const cancelButton = form.querySelector("[data-cancel]");
  if (cancelButton) {
    cancelButton.addEventListener("click", async () => {
      const formData = new FormData();
      formData.set("id", String(data.id));
      formData.set("cancel", "1");
      await submitPrompt(data, formData);
    });
  }
  const input = form.querySelector("input");
  if (input) input.focus();
}

async function submitPrompt(data, formData) {
  const response = await fetch("submit", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
    body: new URLSearchParams(formData),
    cache: "no-store",
  });
  const payload = await response.json();
  if (!payload.ok && payload.error) {
    data.error = payload.error;
    renderPrompt(data);
    return;
  }
  renderWaiting();
}

async function poll() {
  try {
    const response = await fetch("state?t=" + Date.now(), {cache: "no-store"});
    const data = await response.json();
    if (data.status === "prompt") {
      if (data.id !== currentPromptId) renderPrompt(data);
    } else if (data.status === "qr") {
      renderQr(data);
    } else if (data.status === "finished") {
      renderFinished(data);
      return;
    } else if (currentPromptId !== null) {
      renderWaiting();
    }
  } catch (_error) {
    polling = false;
    app.innerHTML = `<h1>Локальная страница закрыта</h1>
      <p class="muted">Вернитесь в Codex и при необходимости запустите вход заново.</p>`;
  } finally {
    if (polling) setTimeout(poll, 350);
  }
}

poll();
</script>
""".encode("utf-8")


def open_browser_url(url: str) -> None:
    """Open one loopback URL without leaking it into process output."""

    if sys.platform == "darwin":
        try:
            completed = subprocess.run(
                ["/usr/bin/open", url],
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise BrowserPromptUnavailable("Cannot open the protected local Telegram login page.") from error
        if completed.returncode != 0:
            raise BrowserPromptUnavailable("Cannot open the protected local Telegram login page.")
        return

    if sys.platform.startswith("win"):
        try:
            startfile = getattr(os, "startfile", None)
            if startfile is None:
                raise OSError("Windows shell opener is unavailable")
            startfile(url)
            return
        except OSError as error:
            raise BrowserPromptUnavailable(
                "Cannot open the protected local Telegram login page."
            ) from error

    try:
        if not webbrowser.open(url, new=2):
            raise BrowserPromptUnavailable("Cannot open the protected local Telegram login page.")
    except webbrowser.Error as error:
        raise BrowserPromptUnavailable("Cannot open the protected local Telegram login page.") from error


class BrowserPromptSession:
    """Serve one tokenized loopback page for a single login process."""

    def __init__(self) -> None:
        self.token = secrets.token_urlsafe(32)
        self.condition = threading.Condition()
        self.page_loaded = threading.Event()
        self.current_prompt: dict[str, Any] | None = None
        self.current_qr: dict[str, Any] | None = None
        self.response: dict[str, Any] | None = None
        self.finished: dict[str, str] | None = None
        self.next_prompt_id = 0
        self.opened = False
        try:
            self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), self._handler_class())
        except OSError as error:
            raise BrowserPromptUnavailable(
                "The protected Telegram login page cannot bind to 127.0.0.1."
            ) from error
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def port(self) -> int:
        return int(self.server.server_address[1])

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def base_path(self) -> str:
        return f"/{self.token}"

    @property
    def url(self) -> str:
        return f"{self.origin}{self.base_path}/"

    def _handler_class(self) -> Any:
        session = self

        class PromptHandler(http.server.BaseHTTPRequestHandler):
            server_version = "TrelioLoopback/1"
            sys_version = ""

            def log_message(self, _format: str, *_args: Any) -> None:
                return

            def end_headers(self) -> None:
                self.send_header("Cache-Control", "no-store")
                self.send_header("Pragma", "no-cache")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("X-Frame-Options", "DENY")
                self.send_header("Cross-Origin-Resource-Policy", "same-origin")
                self.send_header(
                    "Content-Security-Policy",
                    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
                    "img-src data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
                )
                super().end_headers()

            def send_bytes(self, body: bytes, content_type: str, status: int = 200) -> None:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)
                self.close_connection = True

            def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
                self.send_bytes(
                    json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8",
                    status,
                )

            def request_is_local(self) -> bool:
                return (
                    self.client_address[0] == "127.0.0.1"
                    and self.headers.get("Host") == f"127.0.0.1:{session.port}"
                )

            def prompt_subpath(self) -> str | None:
                path = urllib.parse.urlparse(self.path).path
                if path == session.base_path:
                    return "/"
                prefix = session.base_path + "/"
                if not path.startswith(prefix):
                    return None
                return "/" + path[len(prefix):]

            def do_GET(self) -> None:  # noqa: N802 - stdlib callback name.
                if not self.request_is_local():
                    self.send_json({"ok": False, "error": "Forbidden."}, status=403)
                    return
                subpath = self.prompt_subpath()
                if subpath == "/":
                    session.page_loaded.set()
                    self.send_bytes(browser_prompt_app_page(), "text/html; charset=utf-8")
                    return
                if subpath == "/state":
                    with session.condition:
                        finished = dict(session.finished) if session.finished else None
                        qr = dict(session.current_qr) if session.current_qr else None
                        prompt = dict(session.current_prompt) if session.current_prompt else None
                    if finished:
                        self.send_json({"status": "finished", **finished})
                    elif qr:
                        self.send_json({"status": "qr", **qr})
                    elif prompt:
                        self.send_json({"status": "prompt", **prompt})
                    else:
                        self.send_json({"status": "waiting"})
                    return
                self.send_json({"ok": False, "error": "Not found."}, status=404)

            def do_POST(self) -> None:  # noqa: N802 - stdlib callback name.
                if not self.request_is_local() or self.prompt_subpath() != "/submit":
                    self.send_json({"ok": False, "error": "Forbidden."}, status=403)
                    return
                if self.headers.get("Origin") != session.origin:
                    self.send_json({"ok": False, "error": "Forbidden."}, status=403)
                    return
                content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                if content_type != "application/x-www-form-urlencoded":
                    self.send_json({"ok": False, "error": "Unsupported request."}, status=415)
                    return
                try:
                    length = int(self.headers.get("Content-Length", ""))
                except ValueError:
                    length = -1
                if length < 0 or length > MAX_PROMPT_BODY_BYTES:
                    self.send_json({"ok": False, "error": "Invalid request size."}, status=413)
                    return

                try:
                    raw_body = self.rfile.read(length).decode("utf-8", errors="strict")
                    fields = urllib.parse.parse_qs(
                        raw_body,
                        keep_blank_values=True,
                        max_num_fields=4,
                    )
                except (UnicodeError, ValueError):
                    self.send_json({"ok": False, "error": "Invalid request body."}, status=400)
                    return
                try:
                    prompt_id = int((fields.get("id") or [""])[0])
                except ValueError:
                    self.send_json({"ok": False, "error": "Этот шаг уже не актуален."}, status=409)
                    return

                with session.condition:
                    prompt = session.current_prompt
                    if not prompt or prompt["id"] != prompt_id:
                        self.send_json({"ok": False, "error": "Этот шаг уже не актуален."}, status=409)
                        return
                    if fields.get("cancel"):
                        session.response = {"cancelled": True}
                    else:
                        choices = prompt.get("choices") or []
                        if choices:
                            value = (fields.get("choice") or [""])[0]
                            allowed_values = {choice_value for choice_value, _label in choices}
                            if value not in allowed_values:
                                self.send_json(
                                    {"ok": False, "error": "Выберите один из вариантов."},
                                    status=400,
                                )
                                return
                        else:
                            value = (fields.get("value") or [""])[0].strip()
                            if not value and not prompt.get("allow_empty"):
                                self.send_json(
                                    {"ok": False, "error": "Нужно заполнить поле."},
                                    status=400,
                                )
                                return
                        session.response = {"cancelled": False, "value": value}
                    session.current_prompt = None
                    session.condition.notify_all()
                self.send_json({"ok": True})

        return PromptHandler

    def open(self) -> None:
        """Open the protected page and require the browser to fetch its exact URL."""

        if self.opened:
            return
        self.page_loaded.clear()
        open_browser_url(self.url)
        if not self.page_loaded.wait(timeout=8):
            raise BrowserPromptUnavailable(
                "The default browser did not load the protected local Telegram login page."
            )
        self.opened = True

    def ask(
        self,
        prompt: str,
        *,
        hidden: bool,
        allow_empty: bool = False,
        choices: Sequence[tuple[str, str]] | None = None,
        cancel_label: str = "Отмена",
        hint: str = "",
    ) -> str:
        with self.condition:
            self.next_prompt_id += 1
            self.response = None
            self.finished = None
            self.current_qr = None
            self.current_prompt = {
                "id": self.next_prompt_id,
                "prompt": prompt,
                "hidden": hidden,
                "allow_empty": allow_empty,
                "choices": list(choices or []),
                "cancel_label": cancel_label,
                "hint": hint,
                "error": "",
            }
            self.condition.notify_all()
        try:
            self.open()
        except BrowserPromptUnavailable:
            with self.condition:
                self.current_prompt = None
            raise

        with self.condition:
            while self.response is None:
                self.condition.wait()
            response = self.response
            self.response = None
        if response.get("cancelled"):
            raise PromptCancelled(f"Ввод отменён: {prompt}")
        return str(response.get("value") or "")

    def show_qr(self, *, image_data_url: str, expires_in: int) -> None:
        with self.condition:
            self.current_prompt = None
            self.finished = None
            self.current_qr = {
                "title": "Вход по QR-коду Telegram",
                "image_data_url": image_data_url,
                "expires_in": expires_in,
            }
            self.condition.notify_all()
        self.open()

    def clear_qr(self) -> None:
        with self.condition:
            self.current_qr = None
            self.condition.notify_all()

    def finish(self, *, title: str, message: str) -> None:
        with self.condition:
            self.current_prompt = None
            self.current_qr = None
            self.response = None
            self.finished = {"title": title, "message": message}
            self.condition.notify_all()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def ensure_browser_prompt_session() -> BrowserPromptSession:
    global BROWSER_PROMPT_SESSION
    if BROWSER_PROMPT_SESSION is None:
        BROWSER_PROMPT_SESSION = BrowserPromptSession()
    return BROWSER_PROMPT_SESSION


def shutdown_browser_prompt_session() -> None:
    global BROWSER_PROMPT_SESSION
    if BROWSER_PROMPT_SESSION is None:
        return
    BROWSER_PROMPT_SESSION.close()
    BROWSER_PROMPT_SESSION = None


def prompt_value_terminal(
    prompt: str,
    *,
    hidden: bool,
    allow_empty: bool = False,
    cancel_label: str = "Отмена",
) -> str:
    if not sys.stdin.isatty():
        raise BrowserPromptUnavailable(
            "The local browser login page is unavailable and no visible terminal is attached."
        )
    label = f"{prompt} (или {cancel_label}): "
    value = getpass.getpass(label) if hidden else input(label)
    value = value.strip()
    if value.casefold() == cancel_label.casefold():
        raise PromptCancelled(f"Ввод отменён: {prompt}")
    if not value and not allow_empty:
        raise TelegramRuntimeError(f"Нужно заполнить поле: {prompt}")
    return value


def prompt_choice_terminal(
    prompt: str,
    choices: Sequence[tuple[str, str]],
    *,
    cancel_label: str = "Отмена",
) -> str:
    if not sys.stdin.isatty():
        raise BrowserPromptUnavailable(
            "The local browser login page is unavailable and no visible terminal is attached."
        )
    print(prompt)
    for index, (_value, label) in enumerate(choices, start=1):
        print(f"  {index}. {label}")
    print(f"  0. {cancel_label}")
    while True:
        answer = input("Выбор: ").strip().casefold()
        if answer in {"0", "q", "quit", "cancel", "отмена", "назад"}:
            raise PromptCancelled(f"Ввод отменён: {prompt}")
        if answer.isdigit() and 1 <= int(answer) <= len(choices):
            return choices[int(answer) - 1][0]
        for value, label in choices:
            if answer in {value.casefold(), label.casefold()}:
                return value
        print("Введите номер варианта.")


def prompt_value(
    prompt: str,
    *,
    hidden: bool = False,
    allow_empty: bool = False,
    terminal_prompts: bool = False,
    cancel_label: str = "Отмена",
    browser_hint: str = "",
) -> str:
    if not terminal_prompts:
        try:
            return ensure_browser_prompt_session().ask(
                prompt,
                hidden=hidden,
                allow_empty=allow_empty,
                cancel_label=cancel_label,
                hint=browser_hint,
            )
        except BrowserPromptUnavailable:
            pass
    return prompt_value_terminal(
        prompt,
        hidden=hidden,
        allow_empty=allow_empty,
        cancel_label=cancel_label,
    )


def prompt_choice(
    prompt: str,
    choices: Sequence[tuple[str, str]],
    *,
    terminal_prompts: bool = False,
    cancel_label: str = "Отмена",
) -> str:
    if not terminal_prompts:
        try:
            return ensure_browser_prompt_session().ask(
                prompt,
                hidden=False,
                choices=choices,
                cancel_label=cancel_label,
            )
        except BrowserPromptUnavailable:
            pass
    return prompt_choice_terminal(prompt, choices, cancel_label=cancel_label)


def command_bootstrap(_args: argparse.Namespace) -> dict[str, Any]:
    root = runtime_root()
    python = runtime_python()
    ensure_private_directory(root.parent)
    if not python.exists():
        venv.EnvBuilder(with_pip=True, clear=False).create(root)
    completed = subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            *RUNTIME_PYTHON_PACKAGES,
        ],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "pip failed"
        raise TelegramRuntimeError(f"Cannot install Telegram runtime: {detail}")
    return {"runtimeReady": True, "runtimePython": str(python)}


def reexec_in_runtime_if_needed(command: str) -> None:
    if command in {"bootstrap", "doctor", "policy"}:
        return
    python = runtime_python()
    current_prefix = Path(sys.prefix).resolve()
    expected_prefix = runtime_root().resolve()
    if current_prefix == expected_prefix:
        return
    if not python.exists():
        raise TelegramRuntimeError("Telegram runtime is not installed. Run bootstrap first.")
    os.execve(str(python), [str(python), str(Path(__file__).resolve()), *sys.argv[1:]], dict(os.environ))


def import_telethon():
    try:
        from telethon import TelegramClient
        from telethon.errors import SessionPasswordNeededError
        from telethon.tl.functions.account import GetPasswordRequest
    except ImportError as error:
        raise TelegramRuntimeError("Telethon is unavailable. Run bootstrap first.") from error
    return TelegramClient, SessionPasswordNeededError, GetPasswordRequest


def import_telethon_phone_resolver():
    """Load only the fixed MTProto request and its conclusive miss error."""

    try:
        from telethon.errors import PhoneNotOccupiedError
        from telethon.tl.functions.contacts import ResolvePhoneRequest
    except ImportError as error:
        raise TelegramRuntimeError(
            "Telegram phone lookup is unavailable. Run bootstrap to repair the local runtime."
        ) from error
    return ResolvePhoneRequest, PhoneNotOccupiedError


def import_telethon_global_search():
    """Load the fixed TL request and helpers used by resumable global search."""

    try:
        from telethon import utils
        from telethon.tl.functions.messages import SearchGlobalRequest
        from telethon.tl.types import (
            InputMessagesFilterEmpty,
            InputPeerEmpty,
            MessageEmpty,
        )
    except ImportError as error:
        raise TelegramRuntimeError(
            "Telegram global search is unavailable. Run bootstrap to repair the local runtime."
        ) from error
    return (
        SearchGlobalRequest,
        InputMessagesFilterEmpty,
        InputPeerEmpty,
        MessageEmpty,
        utils,
    )


def import_qrcode():
    """Load QR rendering only for QR login after bootstrap installed it."""

    try:
        import qrcode
        import PIL.Image  # noqa: F401 - validates the qrcode[pil] extra.
    except ImportError as error:
        raise TelegramRuntimeError(
            "Telegram QR dependencies are unavailable. Run bootstrap first."
        ) from error
    return qrcode


def import_telethon_workflows():
    """Require the TL layer that can prove scheduled delivery IDs after a send.

    An old local venv may survive many signed releases. Check its actual library
    before any new provider request instead of discovering a missing TL field
    after an irreversible send-now operation.
    """

    try:
        import telethon
        from telethon import events, functions, types, utils
        from telethon.extensions import markdown
        version = tuple(int(part) for part in telethon.__version__.split(".")[:2])
        if version < (1, 44):
            raise ImportError
    except (ImportError, ValueError) as error:
        raise TelegramRuntimeError(
            "Telegram message workflows require Telethon >=1.44. Run bootstrap once."
        ) from error
    return functions.messages, types, utils, events, markdown


def session_path(identity: Identity) -> Path:
    state_dir = connection_root(identity) / "state"
    ensure_private_directory(state_dir)
    return state_dir / "telegram"


def legacy_api_hash_path(identity: Identity) -> Path:
    """Return the pre-managed-credential cache path without creating it."""

    return connection_root(identity) / "credentials" / LEGACY_API_HASH_FILE_NAME


def remove_legacy_api_hash_cache(identity: Identity) -> bool:
    """Delete the retired per-connection hash cache without reading its value.

    The parent must still be a real owner-only directory and the target a
    private regular file. This prevents migration cleanup from following a
    substituted symlink outside the stable integration namespace.
    """

    path = legacy_api_hash_path(identity)
    credentials_dir = path.parent
    if not credentials_dir.exists() and not credentials_dir.is_symlink():
        return False
    ensure_private_directory(credentials_dir)
    if not path.exists() and not path.is_symlink():
        return False
    ensure_private_file(path)
    path.unlink()
    with contextlib.suppress(OSError):
        credentials_dir.rmdir()
    return True


def normalize_api_id(value: str, *, source: str) -> int:
    normalized = value.strip()
    if not re.fullmatch(r"[1-9][0-9]{0,9}", normalized):
        raise TelegramRuntimeError(f"Telegram api_id from {source} is invalid.")
    api_id = int(normalized)
    if api_id > 2_147_483_647:
        raise TelegramRuntimeError(f"Telegram api_id from {source} is invalid.")
    return api_id


def normalize_api_hash(value: str, *, source: str) -> str:
    normalized = value.strip().lower()
    if not re.fullmatch(r"[a-f0-9]{32}", normalized):
        raise TelegramRuntimeError(f"Telegram api_hash from {source} is invalid.")
    return normalized


def require_app_credentials(identity: Identity) -> tuple[int, str, bool]:
    """Load the exact app identity bundled into this signed runtime release.

    The package is already content-addressed and signature-verified by the
    generic host. Rechecking file type and size here keeps direct or damaged
    invocations fail-closed without introducing a config, argv or environment
    fallback. The values are deliberately never returned by public commands.
    """

    try:
        file_stat = APP_CREDENTIAL_FILE.lstat()
        if APP_CREDENTIAL_FILE.is_symlink() or not stat.S_ISREG(file_stat.st_mode):
            raise TelegramRuntimeError(
                "Telegram app credential file in the signed runtime package is invalid."
            )
        if file_stat.st_size < 1 or file_stat.st_size > MAX_APP_CREDENTIAL_FILE_BYTES:
            raise TelegramRuntimeError(
                "Telegram app credential file in the signed runtime package is invalid."
            )
        delivered = APP_CREDENTIAL_FILE.read_text(encoding="utf-8")
        envelope = json.loads(delivered)
    except TelegramRuntimeError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError) as error:
        raise TelegramRuntimeError(
            "Telegram app credentials are missing or invalid in the signed runtime package."
        ) from error
    if (
        not isinstance(envelope, dict)
        or set(envelope) != {"api_id", "api_hash"}
        or not isinstance(envelope.get("api_id"), str)
        or not isinstance(envelope.get("api_hash"), str)
    ):
        raise TelegramRuntimeError(
            "Telegram app credential file in the signed runtime package is invalid."
        )

    api_id = normalize_api_id(envelope["api_id"], source="the signed runtime package")
    api_hash = normalize_api_hash(envelope["api_hash"], source="the signed runtime package")
    legacy_cache_removed = remove_legacy_api_hash_cache(identity)
    return api_id, api_hash, legacy_cache_removed


def build_client(args: argparse.Namespace, identity: Identity):
    api_id, api_hash, _legacy_cache_removed = require_app_credentials(identity)
    TelegramClient, _, _ = import_telethon()
    # Telethon otherwise resubmits RPCs on selected server/flood errors. A
    # mutation or quota-consuming transcription must expose an uncertain
    # outcome to the caller instead of silently submitting it a second time.
    # Ordinary reads retain the library's safe retry behavior.
    request_policy = {}
    if getattr(args, "command", None) in {
        "send", "edit", "reply", "transcribe", "scheduled-edit",
        "scheduled-cancel", "scheduled-send-now",
    }:
        request_policy = {"request_retries": 0, "flood_sleep_threshold": 0,
                          "raise_last_call_error": True}
    return TelegramClient(
        str(session_path(identity)),
        api_id,
        api_hash,
        device_model="Trelio Agent",
        system_version=sys.platform,
        app_version="1.0",
        **request_policy,
    )


async def ensure_authorized(client: Any) -> None:
    await client.connect()
    if not await client.is_user_authorized():
        raise TelegramRuntimeError("Local Telegram session is not authorized. Run login first.")


def normalize_telegram_password_hint(value: Any) -> str:
    """Keep Telegram's display-only 2FA hint bounded and on one safe UI line."""

    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:MAX_PASSWORD_HINT_CHARS]


async def telegram_password_hint(client: Any, GetPasswordRequest: Any) -> str:
    """Read the optional hint without making login depend on hint availability."""

    try:
        password_state = await client(GetPasswordRequest())
    except Exception:
        return ""
    return normalize_telegram_password_hint(getattr(password_state, "hint", ""))


def login_method_for_args(args: argparse.Namespace) -> str:
    """Choose code or QR before Telegram sends any one-time credential."""

    if args.qr:
        return LOGIN_METHOD_QR
    if args.code:
        return LOGIN_METHOD_CODE
    return prompt_choice(
        "Как войти в Telegram на этом компьютере?",
        (
            (LOGIN_METHOD_CODE, "Код Telegram"),
            (LOGIN_METHOD_QR, "QR-код"),
        ),
        terminal_prompts=args.terminal_prompts,
    )


async def authorize_with_code_login(
    client: Any,
    args: argparse.Namespace,
    SessionPasswordNeededError: Any,
    GetPasswordRequest: Any,
) -> None:
    phone = prompt_value(
        "Телефон Telegram с кодом страны",
        terminal_prompts=args.terminal_prompts,
        cancel_label="Назад",
    )
    sent = await client.send_code_request(phone)
    code = prompt_value(
        "Код входа Telegram",
        hidden=True,
        terminal_prompts=args.terminal_prompts,
        cancel_label="Назад",
    ).replace(" ", "")
    try:
        await client.sign_in(
            phone=phone,
            code=code,
            phone_code_hash=sent.phone_code_hash,
        )
    except SessionPasswordNeededError:
        password_hint = await telegram_password_hint(client, GetPasswordRequest)
        password = prompt_value(
            "Пароль 2FA Telegram",
            hidden=True,
            terminal_prompts=args.terminal_prompts,
            cancel_label="Назад",
            browser_hint=password_hint,
        )
        await client.sign_in(password=password)


def qr_image_data_url(qrcode_module: Any, url: str) -> str:
    """Render the short-lived Telegram login URL without writing it to disk."""

    qr_image = qrcode_module.QRCode(border=3, box_size=14)
    qr_image.add_data(url)
    qr_image.make(fit=True)
    rendered = qr_image.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    rendered.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def terminal_qr_ascii(qrcode_module: Any, url: str) -> str:
    qr_image = qrcode_module.QRCode(border=2)
    qr_image.add_data(url)
    qr_image.make(fit=True)
    output = io.StringIO()
    qr_image.print_ascii(out=output, invert=True)
    return output.getvalue()


async def authorize_with_qr_login(
    client: Any,
    args: argparse.Namespace,
    SessionPasswordNeededError: Any,
    GetPasswordRequest: Any,
) -> None:
    qrcode_module = import_qrcode()
    use_browser = not args.terminal_prompts
    loop = asyncio.get_running_loop()
    deadline = loop.time() + args.qr_timeout
    qr_login = await client.qr_login()

    while loop.time() < deadline:
        expires_in = max(
            1,
            int(qr_login.expires.timestamp() - time.time()),
        )
        if use_browser:
            try:
                ensure_browser_prompt_session().show_qr(
                    image_data_url=qr_image_data_url(qrcode_module, qr_login.url),
                    expires_in=expires_in,
                )
            except BrowserPromptUnavailable:
                use_browser = False
        if not use_browser:
            if not sys.stdin.isatty():
                raise BrowserPromptUnavailable(
                    "The local browser login page is unavailable and no visible terminal is attached."
                )
            print(terminal_qr_ascii(qrcode_module, qr_login.url))
            print("Telegram: Настройки → Устройства → Подключить устройство")

        wait_for = min(
            max(1, expires_in - 2),
            max(1, args.qr_refresh_seconds),
            max(1, int(deadline - loop.time())),
        )
        try:
            await asyncio.wait_for(qr_login.wait(), timeout=wait_for)
            if BROWSER_PROMPT_SESSION is not None:
                BROWSER_PROMPT_SESSION.clear_qr()
            return
        except SessionPasswordNeededError:
            if BROWSER_PROMPT_SESSION is not None:
                BROWSER_PROMPT_SESSION.clear_qr()
            password_hint = await telegram_password_hint(client, GetPasswordRequest)
            password = prompt_value(
                "Пароль 2FA Telegram",
                hidden=True,
                terminal_prompts=args.terminal_prompts,
                cancel_label="Назад" if not args.qr else "Отмена",
                browser_hint=password_hint,
            )
            await client.sign_in(password=password)
            return
        except asyncio.TimeoutError:
            if loop.time() >= deadline:
                break
            await qr_login.recreate()

    raise TelegramRuntimeError(
        "Время входа по QR истекло. Запустите login ещё раз и отсканируйте новый код."
    )


async def command_login_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    _, SessionPasswordNeededError, GetPasswordRequest = import_telethon()
    client = build_client(args, identity)
    await client.connect()
    try:
        if not await client.is_user_authorized():
            while True:
                method = login_method_for_args(args)
                try:
                    if method == LOGIN_METHOD_QR:
                        await authorize_with_qr_login(
                            client,
                            args,
                            SessionPasswordNeededError,
                            GetPasswordRequest,
                        )
                    else:
                        await authorize_with_code_login(
                            client,
                            args,
                            SessionPasswordNeededError,
                            GetPasswordRequest,
                        )
                    break
                except PromptCancelled:
                    if args.qr or args.code:
                        raise
                    continue
        me = await client.get_me()
        session_file = session_path(identity).with_suffix(".session")
        if session_file.exists() and os.name == "posix":
            session_file.chmod(0o600)
        if BROWSER_PROMPT_SESSION is not None:
            BROWSER_PROMPT_SESSION.finish(
                title="Telegram подключён",
                message="Личная авторизация сохранена. Можно закрыть вкладку и вернуться в Codex.",
            )
            await asyncio.sleep(0.7)
        return {"authorized": True, "userId": me.id, "username": me.username}
    except TelegramRuntimeError:
        raise
    except Exception as error:
        # Telethon exceptions may contain transport or RPC details that are not
        # part of the agent-visible contract. Keep the local UI actionable while
        # returning only a stable, secret-free category to Codex.
        raise TelegramRuntimeError(
            "Telegram не завершил вход. Проверьте данные или соединение и запустите login заново."
        ) from error
    finally:
        await client.disconnect()


def bounded_string(value: Any, limit: int) -> tuple[str, bool]:
    """Return a JSON-safe bounded string without leaking object structure."""

    if value is None:
        text = ""
    elif isinstance(value, str):
        text = value
    else:
        text = str(value)
    return text[:limit], len(text) > limit


def optional_bounded_string(value: Any, limit: int) -> str | None:
    if value is None:
        return None
    text, _ = bounded_string(value, limit)
    return text or None


def public_entity(entity: Any) -> dict[str, Any]:
    """Allowlist the public identity fields used by the CLI JSON contract.

    Telethon entities also contain phone numbers, access hashes and raw peer
    structures. Reading individual known scalar attributes instead of dumping
    the MTProto object keeps all of that state outside agent-visible output.
    """

    raw_id = getattr(entity, "id", None)
    entity_id = raw_id if isinstance(raw_id, int) and not isinstance(raw_id, bool) else None
    title = (
        optional_bounded_string(getattr(entity, "title", None), MAX_ENTITY_TITLE_CHARS)
        or optional_bounded_string(
            " ".join(
                filter(
                    None,
                    [
                        optional_bounded_string(
                            getattr(entity, "first_name", None),
                            MAX_ENTITY_TITLE_CHARS,
                        ),
                        optional_bounded_string(
                            getattr(entity, "last_name", None),
                            MAX_ENTITY_TITLE_CHARS,
                        ),
                    ],
                )
            ),
            MAX_ENTITY_TITLE_CHARS,
        )
        or optional_bounded_string(
            getattr(entity, "username", None),
            MAX_ENTITY_TITLE_CHARS,
        )
    )
    result = {
        "id": entity_id,
        "title": title,
        "username": optional_bounded_string(
            getattr(entity, "username", None),
            MAX_ENTITY_USERNAME_CHARS,
        ),
    }
    last_activity = public_last_activity(getattr(entity, "status", None))
    if last_activity is not None:
        result["lastActivity"] = last_activity
    return result


def normalize_member_query(value: Any) -> str:
    """Normalize one optional Telegram-side member search without echoing it.

    Telegram accepts a free-text name or username query. Bounding the normalized
    value before the provider call keeps both the request and the returned JSON
    predictable while still allowing ordinary human names and ``@username``.
    """

    if value is None:
        return ""
    if not isinstance(value, str):
        raise TelegramRuntimeError("Member search query must be text.")
    normalized = unicodedata.normalize("NFKC", value).strip()
    if not normalized:
        raise TelegramRuntimeError("Member search query cannot be empty.")
    if len(normalized) > MAX_MEMBER_QUERY_CHARS:
        raise TelegramRuntimeError(
            f"Member search query exceeds {MAX_MEMBER_QUERY_CHARS} characters."
        )
    return normalized


def normalize_message_search_query(value: Any) -> str:
    """Normalize one bounded server-side message search query.

    Global search reaches every cloud chat visible to the personal Telegram
    session, so an accidental empty or unbounded query would have a much wider
    scope than exact-chat search. Reusing this guard for both modes keeps their
    semantics aligned while preserving ordinary spaces and human text.
    """

    if not isinstance(value, str):
        raise TelegramRuntimeError("Message search query must be text.")
    normalized = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value)).strip()
    if not normalized:
        raise TelegramRuntimeError("Message search query cannot be empty.")
    if len(normalized) > MAX_SEARCH_QUERY_CHARS:
        raise TelegramRuntimeError(
            f"Message search query exceeds {MAX_SEARCH_QUERY_CHARS} characters."
        )
    return normalized


def global_search_query_digest(query: str) -> str:
    """Bind an opaque continuation token to one normalized search query."""

    return hashlib.sha256(query.encode("utf-8")).hexdigest()


def encode_global_search_cursor(query: str, cursor: GlobalSearchCursor) -> str:
    """Encode safe provider offsets without exposing an MTProto input peer."""

    if (
        cursor.seen < 1
        or cursor.seen > MAX_GLOBAL_SEARCH_CURSOR_RESULTS
        or cursor.offset_peer_id is None
        or cursor.offset_peer_id == 0
        or cursor.offset_id < 1
    ):
        raise TelegramRuntimeError("Telegram global search cursor state is invalid.")
    payload = {
        "offsetId": cursor.offset_id,
        "offsetPeerId": cursor.offset_peer_id,
        "offsetRate": cursor.offset_rate,
        "queryDigest": global_search_query_digest(query),
        "seen": cursor.seen,
        "v": 1,
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(
            payload,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("ascii")
    ).decode("ascii").rstrip("=")
    if len(encoded) > MAX_GLOBAL_SEARCH_CURSOR_CHARS:
        raise TelegramRuntimeError("Telegram global search cursor is too large.")
    return encoded


def decode_global_search_cursor(query: str, value: Any) -> GlobalSearchCursor:
    """Validate a continuation token before it reaches Telegram or the cache."""

    if value in (None, ""):
        return GlobalSearchCursor()
    if (
        not isinstance(value, str)
        or len(value) > MAX_GLOBAL_SEARCH_CURSOR_CHARS
        or not re.fullmatch(r"[A-Za-z0-9_-]+", value)
    ):
        raise TelegramRuntimeError("Telegram global search cursor is invalid.")
    try:
        padding = "=" * (-len(value) % 4)
        payload = json.loads(
            base64.b64decode(
                value + padding,
                altchars=b"-_",
                validate=True,
            ).decode("ascii")
        )
    except (UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise TelegramRuntimeError("Telegram global search cursor is invalid.") from error
    if not isinstance(payload, dict) or set(payload) != {
        "offsetId",
        "offsetPeerId",
        "offsetRate",
        "queryDigest",
        "seen",
        "v",
    }:
        raise TelegramRuntimeError("Telegram global search cursor is invalid.")

    def bounded_integer(key: str, minimum: int, maximum: int) -> int:
        item = payload.get(key)
        if (
            not isinstance(item, int)
            or isinstance(item, bool)
            or item < minimum
            or item > maximum
        ):
            raise TelegramRuntimeError("Telegram global search cursor is invalid.")
        return item

    if (
        not isinstance(payload.get("v"), int)
        or isinstance(payload.get("v"), bool)
        or payload.get("v") != 1
        or not secrets.compare_digest(
            str(payload.get("queryDigest") or ""),
            global_search_query_digest(query),
        )
    ):
        raise TelegramRuntimeError(
            "Telegram global search cursor does not belong to this query. Start from the first page."
        )
    offset_peer_id = bounded_integer(
        "offsetPeerId",
        -(1 << 63) + 1,
        (1 << 63) - 1,
    )
    if offset_peer_id == 0:
        raise TelegramRuntimeError("Telegram global search cursor is invalid.")
    return GlobalSearchCursor(
        seen=bounded_integer("seen", 1, MAX_GLOBAL_SEARCH_CURSOR_RESULTS),
        offset_rate=bounded_integer("offsetRate", 0, (1 << 63) - 1),
        offset_peer_id=offset_peer_id,
        offset_id=bounded_integer("offsetId", 1, (1 << 63) - 1),
    )


def search_context_radius(args: argparse.Namespace) -> int:
    """Validate optional bounded context expansion for a message search.

    ``argparse`` enforces this for ordinary CLI calls, but tests and future
    in-process callers may construct a namespace directly. Keeping the same
    checks beside the provider operation prevents those paths from silently
    creating a much larger account-wide history read.
    """

    value = getattr(args, "context", 0)
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 0
        or value > MAX_SEARCH_CONTEXT_RADIUS
    ):
        raise TelegramRuntimeError(
            f"Search context must be an integer from 0 to {MAX_SEARCH_CONTEXT_RADIUS}."
        )
    if value and args.limit > MAX_SEARCH_CONTEXT_RESULTS:
        raise TelegramRuntimeError(
            f"Search with context supports --limit 1..{MAX_SEARCH_CONTEXT_RESULTS}."
        )
    return value


def public_participant(user: Any, audience: str) -> dict[str, Any]:
    """Serialize one group member or channel subscriber through an allowlist.

    ``get_participants`` attaches a raw participant object to every Telethon
    ``User``. That object can contain inviter ids, rights and other MTProto
    details, so only a coarse role is derived from its constructor name. Phone,
    access hash and the raw participant object never enter agent-visible JSON.
    """

    participant = getattr(user, "participant", None)
    participant_type = type(participant).__name__ if participant is not None else ""
    if participant_type in {"ChannelParticipantCreator", "ChatParticipantCreator"}:
        role = "owner"
    elif participant_type in {"ChannelParticipantAdmin", "ChatParticipantAdmin"}:
        role = "admin"
    else:
        role = "subscriber" if audience == "subscribers" else "member"
    return {
        **public_entity(user),
        "role": role,
        "isBot": bool(getattr(user, "bot", False)),
    }


def nonnegative_integer(value: Any) -> int | None:
    """Return a safe provider count without accepting booleans or sentinels."""

    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def participant_access_reason(error: Exception) -> str | None:
    """Map known Telegram access failures without exposing raw RPC details."""

    reasons = {
        "ChatAdminRequiredError": "hidden_or_admin_required",
        "ChannelPrivateError": "not_joined_or_private",
        "UserNotParticipantError": "not_joined_or_private",
        "ChannelInvalidError": "chat_unavailable",
        "ChannelMonoforumUnsupportedError": "unsupported_chat",
    }
    return reasons.get(type(error).__name__)


def telegram_status_timestamp(value: Any) -> str | None:
    """Serialize only a real Telegram timestamp as normalized UTC ISO 8601."""

    if isinstance(value, datetime):
        timestamp = value
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
    elif isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        try:
            timestamp = datetime.fromtimestamp(value, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    else:
        return None
    return timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def public_last_activity(status: Any) -> dict[str, Any] | None:
    """Map Telegram's privacy-aware status union to a small safe contract.

    Telegram itself decides whether a precise timestamp is visible. Exact
    online/offline values are preserved only when present; privacy-obscured
    variants remain coarse categories and are never converted into guessed
    dates. Unknown future constructors fail closed by returning no field.
    """

    if status is None:
        return None
    status_type = status.__class__.__name__
    if status_type == "UserStatusOnline":
        result: dict[str, Any] = {"kind": "online", "exact": True}
        expires_at = telegram_status_timestamp(getattr(status, "expires", None))
        if expires_at is not None:
            result["expiresAt"] = expires_at
        return result
    if status_type == "UserStatusOffline":
        last_seen_at = telegram_status_timestamp(getattr(status, "was_online", None))
        if last_seen_at is None:
            return {"kind": "unknown", "exact": False}
        return {"kind": "offline", "exact": True, "lastSeenAt": last_seen_at}
    coarse_statuses = {
        "UserStatusRecently": "recently",
        "UserStatusLastWeek": "last_week",
        "UserStatusLastMonth": "last_month",
    }
    if status_type in coarse_statuses:
        return {"kind": coarse_statuses[status_type], "exact": False}
    if status_type == "UserStatusEmpty":
        return {"kind": "unknown", "exact": False}
    return None


def utf16_slice(text: str, offset: int, length: int) -> str:
    """Slice Telegram entity offsets, which are measured in UTF-16 units."""

    encoded = text.encode("utf-16-le", errors="surrogatepass")
    start = min(offset * 2, len(encoded))
    end = min((offset + length) * 2, len(encoded))
    return encoded[start:end].decode("utf-16-le", errors="replace")


def public_link_entities(
    text: str,
    entities: Any,
) -> tuple[list[dict[str, Any]], bool]:
    """Normalize only URL-bearing Telegram entities.

    The class-name allowlist is intentionally narrow. Other MTProto entity
    variants may carry mentions, custom emoji document ids or future fields
    that are not part of this read-only contract.
    """

    if not isinstance(entities, (list, tuple)):
        return [], False

    result: list[dict[str, Any]] = []
    supported_seen = 0
    for entity in entities:
        class_name = type(entity).__name__
        if class_name not in {"MessageEntityUrl", "MessageEntityTextUrl"}:
            continue
        supported_seen += 1
        if len(result) >= MAX_LINK_ENTITIES:
            continue

        offset = getattr(entity, "offset", None)
        length = getattr(entity, "length", None)
        if (
            not isinstance(offset, int)
            or isinstance(offset, bool)
            or not isinstance(length, int)
            or isinstance(length, bool)
            or offset < 0
            or length <= 0
        ):
            continue

        entity_text, text_truncated = bounded_string(
            utf16_slice(text, offset, length),
            MAX_LINK_TEXT_CHARS,
        )
        raw_url = (
            entity_text
            if class_name == "MessageEntityUrl"
            else getattr(entity, "url", None)
        )
        if not isinstance(raw_url, str) or not raw_url:
            continue
        url, url_truncated = bounded_string(raw_url, MAX_LINK_URL_CHARS)
        result.append({
            "type": "url" if class_name == "MessageEntityUrl" else "text_url",
            "offset": offset,
            "length": length,
            "text": entity_text,
            "url": url,
            "textTruncated": text_truncated,
            "urlTruncated": url_truncated,
        })

    return result, supported_seen > len(result)


async def optional_message_entity(message: Any, attribute: str, getter_name: str) -> Any | None:
    """Resolve sender/chat best-effort without exposing Telegram diagnostics."""

    entity = getattr(message, attribute, None)
    if entity is not None:
        return entity
    getter = getattr(message, getter_name, None)
    if not callable(getter):
        return None
    try:
        return await getter()
    except Exception:
        # Missing/deleted peers must not make an otherwise readable message
        # fail, and raw RPC diagnostics do not belong in normalized output.
        return None


async def public_reply_context(
    message: Any,
    current_chat: Any | None,
) -> dict[str, Any] | None:
    """Resolve one direct reply only; never recurse into the quoted message."""

    reply_header = getattr(message, "reply_to", None)
    reply_message_id = getattr(message, "reply_to_msg_id", None)
    if reply_message_id is None and reply_header is not None:
        reply_message_id = getattr(reply_header, "reply_to_msg_id", None)
    if (
        not isinstance(reply_message_id, int)
        or isinstance(reply_message_id, bool)
        or reply_message_id <= 0
    ):
        return None

    quote_text, quote_text_truncated = bounded_string(
        getattr(reply_header, "quote_text", None),
        MAX_REPLY_TEXT_CHARS,
    )
    quote_entities, quote_entities_truncated = public_link_entities(
        quote_text,
        getattr(reply_header, "quote_entities", None),
    )

    reply_message = None
    get_reply_message = getattr(message, "get_reply_message", None)
    if callable(get_reply_message):
        try:
            reply_message = await get_reply_message()
        except Exception:
            # A deleted message, an inaccessible cross-chat reply and a
            # transient MTProto lookup failure intentionally collapse to the
            # same non-sensitive unavailable state.
            reply_message = None

    if reply_message is None:
        return {
            "messageId": reply_message_id,
            "unavailable": True,
            "author": None,
            "chat": (
                None
                if getattr(reply_header, "reply_to_peer_id", None) is not None
                else (
                    public_entity(current_chat)
                    if current_chat is not None
                    else None
                )
            ),
            "text": quote_text,
            "textTruncated": quote_text_truncated,
            "linkEntities": quote_entities,
            "linkEntitiesTruncated": quote_entities_truncated,
            "quoteText": quote_text or None,
            "quoteTextTruncated": quote_text_truncated,
            "quoteLinkEntities": quote_entities,
            "quoteLinkEntitiesTruncated": quote_entities_truncated,
        }

    sender = await optional_message_entity(reply_message, "sender", "get_sender")
    reply_chat = await optional_message_entity(reply_message, "chat", "get_chat")
    if reply_chat is None and getattr(reply_header, "reply_to_peer_id", None) is None:
        reply_chat = current_chat

    reply_text, reply_text_truncated = bounded_string(
        getattr(reply_message, "message", None),
        MAX_REPLY_TEXT_CHARS,
    )
    reply_entities, reply_entities_truncated = public_link_entities(
        reply_text,
        getattr(reply_message, "entities", None),
    )
    return {
        "messageId": reply_message_id,
        "unavailable": False,
        "author": public_entity(sender) if sender is not None else None,
        "chat": public_entity(reply_chat) if reply_chat is not None else None,
        "text": reply_text,
        "textTruncated": reply_text_truncated,
        "linkEntities": reply_entities,
        "linkEntitiesTruncated": reply_entities_truncated,
        "quoteText": quote_text or None,
        "quoteTextTruncated": quote_text_truncated,
        "quoteLinkEntities": quote_entities,
        "quoteLinkEntitiesTruncated": quote_entities_truncated,
    }


def public_message(
    message: Any,
    *,
    reply_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    sender = getattr(message, "sender", None)
    text, text_truncated = bounded_string(
        getattr(message, "message", None),
        MAX_READ_TEXT_CHARS,
    )
    link_entities, link_entities_truncated = public_link_entities(
        text,
        getattr(message, "entities", None),
    )
    raw_file_size = getattr(getattr(message, "file", None), "size", None)
    file_size = (
        raw_file_size
        if isinstance(raw_file_size, int)
        and not isinstance(raw_file_size, bool)
        and raw_file_size >= 0
        else None
    )
    return {
        "id": message.id,
        "date": message.date.isoformat() if message.date else None,
        "outgoing": bool(message.out),
        "sender": public_entity(sender) if sender else None,
        "text": text,
        "textTruncated": text_truncated,
        "hasMedia": message.media is not None,
        "mediaType": message_media_type(message),
        "threadId": message_thread_id(message),
        "fileName": optional_bounded_string(
            getattr(getattr(message, "file", None), "name", None),
            MAX_FILE_NAME_CHARS,
        ),
        "fileSize": file_size,
        "linkEntities": link_entities,
        "linkEntitiesTruncated": link_entities_truncated,
        "replyContext": reply_context,
    }


async def public_messages(
    messages: list[Any],
    current_chat: Any | None,
    *,
    include_chat: bool = False,
) -> list[dict[str, Any]]:
    """Serialize a bounded page while limiting peer and reply lookups.

    Exact-chat reads already know their chat once. A global Telegram search
    returns messages from different peers, so that mode resolves and emits an
    allowlisted chat independently for every result. Raw peers and access
    hashes remain outside the public payload in both modes.
    """

    semaphore = asyncio.Semaphore(MAX_REPLY_RESOLUTION_CONCURRENCY)

    async def serialize(message: Any) -> dict[str, Any]:
        async with semaphore:
            message_chat = current_chat
            if include_chat or message_chat is None:
                resolved_chat = await optional_message_entity(
                    message,
                    "chat",
                    "get_chat",
                )
                if resolved_chat is not None:
                    message_chat = resolved_chat
            reply_context = await public_reply_context(message, message_chat)
        result = public_message(message, reply_context=reply_context)
        result["link"] = message_link(message_chat, message.id) if message_chat is not None else None
        if include_chat:
            result["chat"] = (
                public_entity(message_chat) if message_chat is not None else None
            )
        return result

    return list(await asyncio.gather(*(serialize(message) for message in messages)))


async def public_search_context(
    client: Any,
    match: Any,
    radius: int,
    *,
    chat: Any | None = None,
) -> dict[str, Any]:
    """Read one chronological, bounded window around an exact search hit.

    Message ids are scoped to a Telegram peer. The chat attached to the search
    result is therefore resolved before history calls, and raw peer/access-hash
    data never enters the result. ``offset_id`` and reverse ``min_id`` are both
    exclusive, so the match can be inserted exactly once between the two pages.

    A provider failure on one side does not discard the successful search hit or
    the other side of its context. Instead the per-hit coverage remains explicit
    and contains only stable safe reasons, never raw RPC diagnostics.
    """

    if chat is None:
        chat = await optional_message_entity(match, "chat", "get_chat")
    requested = radius
    if chat is None:
        return {
            "available": False,
            "messages": [],
            "matchIndex": None,
            "coverage": {
                "requestedBefore": requested,
                "returnedBefore": 0,
                "requestedAfter": requested,
                "returnedAfter": 0,
                "historyStartReached": None,
                "historyEndReached": None,
                "complete": False,
                "incompleteReasons": ["chat_unavailable"],
            },
        }

    before: list[Any] = []
    after: list[Any] = []
    before_complete = True
    after_complete = True
    try:
        # Default history order is newest-to-oldest. Reverse the bounded page
        # locally so the final context reads naturally from oldest to newest.
        before = [
            item
            async for item in client.iter_messages(
                chat,
                limit=requested,
                offset_id=match.id,
            )
        ]
        before.reverse()
    except Exception:
        before_complete = False

    try:
        # In reverse mode ``min_id`` is the exclusive lower boundary, so this
        # yields the first newer messages in chronological order.
        after = [
            item
            async for item in client.iter_messages(
                chat,
                limit=requested,
                min_id=match.id,
                reverse=True,
            )
        ]
    except Exception:
        after_complete = False

    chronological = [*before, match, *after]
    messages = await public_messages(chronological, chat)
    match_index = len(before)
    for index, message in enumerate(messages):
        message["isMatch"] = index == match_index

    incomplete_reasons = []
    if not before_complete:
        incomplete_reasons.append("before_unavailable")
    if not after_complete:
        incomplete_reasons.append("after_unavailable")
    return {
        "available": True,
        "messages": messages,
        "matchIndex": match_index,
        "coverage": {
            "requestedBefore": requested,
            "returnedBefore": len(before),
            "requestedAfter": requested,
            "returnedAfter": len(after),
            "historyStartReached": before_complete and len(before) < requested,
            "historyEndReached": after_complete and len(after) < requested,
            "complete": before_complete and after_complete,
            "incompleteReasons": incomplete_reasons,
        },
    }


async def attach_search_contexts(
    client: Any,
    raw_messages: list[Any],
    messages: list[dict[str, Any]],
    radius: int,
) -> dict[str, Any] | None:
    """Attach a context window to every returned hit without parallel floods."""

    if radius == 0:
        return None
    complete = True
    available = 0
    # Sequential history calls are deliberate. One global search may span many
    # peers, and a burst of concurrent GetHistory requests is more likely to hit
    # Telegram flood controls while providing no useful latency guarantee.
    for raw_message, message in zip(raw_messages, messages, strict=True):
        context = await public_search_context(client, raw_message, radius)
        message["context"] = context
        if context["available"]:
            available += 1
        if not context["coverage"]["complete"]:
            complete = False
    return {
        "radius": radius,
        "attempted": len(messages),
        "available": available,
        "complete": complete,
    }


async def fetch_global_search_page(
    client: Any,
    query: str,
    limit: int,
    cursor_token: str | None,
    filters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fetch one resumable provider page without replaying earlier results.

    Telegram's ``messages.searchGlobal`` continuation consists of an offset
    rate, input peer and message id. Only the marked safe peer id is serialized
    into our opaque token; Telethon resolves its private access hash from the
    existing local session on the next invocation.
    """

    (
        SearchGlobalRequest,
        InputMessagesFilterEmpty,
        InputPeerEmpty,
        MessageEmpty,
        telethon_utils,
    ) = import_telethon_global_search()
    cursor_key = query
    if filters is not None:
        cursor_key = json.dumps({"query": query, **filters["public"]}, sort_keys=True, separators=(",", ":"))
    cursor = decode_global_search_cursor(cursor_key, cursor_token)
    cursor_budget = MAX_GLOBAL_SEARCH_CURSOR_RESULTS - cursor.seen
    if cursor_budget <= 0:
        raise TelegramRuntimeError(
            "Telegram global search cursor reached its bounded result ceiling. Narrow the query."
        )
    effective_limit = min(limit, cursor_budget)
    if cursor.offset_peer_id is None:
        offset_peer = InputPeerEmpty()
    else:
        try:
            offset_peer = await client.get_input_entity(cursor.offset_peer_id)
        except Exception as error:
            raise TelegramRuntimeError(
                "Telegram global search cursor can no longer resolve its chat. Start from the first page."
            ) from error

    offset_rate = cursor.offset_rate
    offset_id = cursor.offset_id
    consumed = 0
    messages: list[Any] = []
    identities: set[tuple[int, int]] = set()
    reported_total: int | None = None
    provider_exhausted = False
    cursor_available = True
    last_cursor: GlobalSearchCursor | None = None
    previous_provider_offset = (
        (cursor.offset_rate, cursor.offset_peer_id, cursor.offset_id)
        if cursor.offset_peer_id is not None
        else None
    )
    # Ordinary pages need at most two provider batches at the public 200-row
    # ceiling. Three extra iterations tolerate duplicate/empty normalized rows
    # without ever allowing a malformed provider response to loop forever.
    request_budget = math.ceil(effective_limit / GLOBAL_SEARCH_BATCH_LIMIT) + 3

    for _request_index in range(request_budget):
        if len(messages) >= effective_limit:
            break
        request_limit = min(GLOBAL_SEARCH_BATCH_LIMIT, effective_limit - len(messages))
        request = SearchGlobalRequest(
            q=query,
            filter=filters["mediaFilter"] if filters else InputMessagesFilterEmpty(),
            min_date=filters["minDate"] if filters else None,
            max_date=filters["maxDate"] if filters else None,
            offset_rate=offset_rate,
            offset_peer=offset_peer,
            offset_id=offset_id,
            limit=request_limit,
        )
        response = await client(request)
        if reported_total is None:
            reported_total = nonnegative_integer(getattr(response, "count", None))

        entities = {
            telethon_utils.get_peer_id(entity): entity
            for entity in [
                *list(getattr(response, "users", None) or []),
                *list(getattr(response, "chats", None) or []),
            ]
        }
        batch = []
        for message in list(getattr(response, "messages", None) or []):
            if isinstance(message, MessageEmpty):
                continue
            finish = getattr(message, "_finish_init", None)
            if callable(finish):
                finish(client, entities, None)
            batch.append(message)
        if not batch:
            provider_exhausted = True
            break

        consumed += len(batch)
        last_message = batch[-1]
        try:
            marked_peer_id = telethon_utils.get_peer_id(last_message.peer_id)
            input_peer = last_message.input_chat
        except Exception:
            marked_peer_id = None
            input_peer = None
        next_rate = nonnegative_integer(getattr(response, "next_rate", None)) or 0
        if (
            not isinstance(marked_peer_id, int)
            or isinstance(marked_peer_id, bool)
            or marked_peer_id == 0
            or input_peer is None
        ):
            cursor_available = False
        else:
            next_cursor = GlobalSearchCursor(
                seen=cursor.seen + consumed,
                offset_rate=next_rate,
                offset_peer_id=marked_peer_id,
                offset_id=last_message.id,
            )
            provider_offset = (
                next_cursor.offset_rate,
                next_cursor.offset_peer_id,
                next_cursor.offset_id,
            )
            if provider_offset == previous_provider_offset:
                # A repeated provider offset cannot safely advance the next
                # invocation. Keep the allowlisted rows from this response but
                # expose the page as uncontinuable instead of looping or
                # claiming that Telegram history was exhausted.
                cursor_available = False
            previous_provider_offset = provider_offset
            last_cursor = next_cursor
            offset_rate = next_cursor.offset_rate
            offset_peer = input_peer
            offset_id = next_cursor.offset_id

        for message in batch:
            try:
                identity = (
                    telethon_utils.get_peer_id(message.peer_id),
                    int(message.id),
                )
            except Exception:
                continue
            if identity in identities:
                continue
            identities.add(identity)
            messages.append(message)
            if len(messages) >= effective_limit:
                break
        if not cursor_available:
            break

    seen_through = cursor.seen + consumed
    has_more = (
        not provider_exhausted
        and cursor_available
        and bool(messages)
        and (
            reported_total is None
            or seen_through < reported_total
        )
    )
    cursor_limit_reached = has_more and seen_through >= MAX_GLOBAL_SEARCH_CURSOR_RESULTS
    next_cursor_token = None
    if has_more and not cursor_limit_reached and last_cursor is not None:
        next_cursor_token = encode_global_search_cursor(cursor_key, last_cursor)
    return {
        "messages": messages,
        "reportedTotal": reported_total,
        "seenBefore": cursor.seen,
        "seenThrough": seen_through,
        "hasMore": has_more,
        "nextCursor": next_cursor_token,
        "cursorAvailable": cursor_available,
        "cursorLimitReached": cursor_limit_reached,
        "providerExhausted": provider_exhausted,
    }


TELEGRAM_ENTITY_RESOLUTION_ERROR_NAMES = frozenset(
    {
        "ChannelInvalidError",
        "ChannelPrivateError",
        "ChatIdInvalidError",
        "PeerIdInvalidError",
        "UserIdInvalidError",
        "UsernameInvalidError",
        "UsernameNotOccupiedError",
    }
)


def is_telegram_entity_resolution_error(error: Exception) -> bool:
    """Recognize only provider errors that mean this peer was not resolved.

    Network, timeout and flood-control failures deliberately remain outside this
    set. Folding them into a reference error would misdiagnose a transient
    provider failure and could make an agent rewrite a valid chat target.
    """

    if isinstance(error, (ValueError, TypeError)):
        return True
    error_type = type(error)
    return (
        error_type.__module__.startswith("telethon.errors")
        and error_type.__name__ in TELEGRAM_ENTITY_RESOLUTION_ERROR_NAMES
    )


def unresolved_chat_error(reference: str) -> TelegramRuntimeError:
    """Build the stable, non-speculative recovery contract for one chat ref."""

    public_reference, reference_truncated = bounded_string(
        reference.strip(),
        MAX_CHAT_REFERENCE_CHARS,
    )
    return TelegramRuntimeError(
        f"Telegram could not resolve chat reference {public_reference!r} for the current session.",
        code="TELEGRAM_CHAT_RESOLUTION_FAILED",
        details={
            "reference": public_reference,
            "referenceTruncated": reference_truncated,
            "acceptedReferenceFormats": ["exact dialogs[].id", "@username"],
            "notProven": ["chat_absent", "access_denied"],
            "doNotGuessPeerPrefix": True,
        },
        next_action={
            "operation": "dialogs",
            "arguments": ["--query", "<chat title or username>", "--limit", "10"],
            "instruction": (
                "Find the chat by visible title or username, then retry with its exact "
                "dialogs[].id or @username. Do not add or remove '-' or '-100' to guess "
                "the Telegram peer type. An empty dialog search does not prove that the "
                "chat is absent."
            ),
        },
    )


async def resolve_entity(client: Any, reference: str):
    value = reference.strip()
    if not value:
        raise TelegramRuntimeError("Chat reference is required.")
    try:
        return await client.get_entity(int(value) if re.fullmatch(r"-?\d+", value) else value)
    except Exception as error:
        if not is_telegram_entity_resolution_error(error):
            raise
        # Never include the provider exception: it may carry RPC diagnostics,
        # access hashes or other session-specific data. The structured error is
        # sufficient for the agent to recover without guessing peer prefixes.
        raise unresolved_chat_error(value) from error


def parse_export_boundary(value: str, zone: ZoneInfo, label: str) -> datetime:
    """Parse one CLI boundary and normalize a naive value in the chosen zone."""

    normalized = value.strip()
    if normalized.endswith(("Z", "z")):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise TelegramRuntimeError(
            f"{label} must be an ISO 8601 date or datetime."
        ) from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=zone)
    return parsed.astimezone(timezone.utc)


def export_period(args: argparse.Namespace) -> tuple[ZoneInfo, datetime, datetime]:
    """Resolve a strict half-open export interval with an explicit IANA zone."""

    try:
        zone = ZoneInfo(args.timezone)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise TelegramRuntimeError(
            f"Unknown IANA timezone {args.timezone!r}."
        ) from error
    since = parse_export_boundary(args.since, zone, "--since")
    until = parse_export_boundary(args.until, zone, "--until")
    if since >= until:
        raise TelegramRuntimeError("--since must be earlier than --until.")
    return zone, since, until


def telegram_entity_type(entity: Any) -> str:
    """Classify only the broad chat kind needed by the export filter."""

    if bool(getattr(entity, "bot", False)):
        return "bot"
    class_name = type(entity).__name__
    if class_name == "User" or hasattr(entity, "first_name"):
        return "user"
    if class_name == "Chat" or bool(getattr(entity, "megagroup", False)):
        return "group"
    if class_name == "Channel" or bool(getattr(entity, "broadcast", False)):
        return "channel"
    # Telegram dialog entities are normally one of the classes above. An
    # unknown future peer is excluded from typed exports instead of being
    # guessed from its raw MTProto structure.
    return "unknown"


def export_message_without_links(message: dict[str, Any]) -> dict[str, Any]:
    """Remove normalized link metadata while retaining safe message text."""

    for key in ("linkEntities", "linkEntitiesTruncated"):
        message.pop(key, None)
    reply = message.get("replyContext")
    if isinstance(reply, dict):
        for key in (
            "linkEntities",
            "linkEntitiesTruncated",
            "quoteLinkEntities",
            "quoteLinkEntitiesTruncated",
        ):
            reply.pop(key, None)
    return message


def compact_json_bytes(value: Any) -> int:
    """Measure the UTF-8 bytes used by the compact machine-readable output."""

    return len(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )


def mark_export_chat_incomplete(chat: dict[str, Any], reason: str) -> None:
    """Add one stable incompleteness reason without duplicating warnings."""

    reasons = chat["incomplete_reasons"]
    if reason not in reasons:
        reasons.append(reason)
    chat["incomplete"] = True


def rebuild_export_summary(result: dict[str, Any]) -> None:
    """Recompute duplicated aggregate counters after any output truncation."""

    chats = result["chats"]
    message_count = sum(len(chat["messages"]) for chat in chats)
    scanned_count = sum(chat["scanned_count"] for chat in chats)
    incomplete = [
        {"chat": chat["chat"], "reasons": list(chat["incomplete_reasons"])}
        for chat in chats
        if chat["incomplete"]
    ]
    result["message_count"] = message_count
    result["scanned_count"] = scanned_count
    result["hit_per_chat_limit"] = any(chat["hit_per_chat_limit"] for chat in chats)
    result["hit_scan_limit"] = any(chat["hit_scan_limit"] for chat in chats)
    result["incomplete_chats"] = incomplete
    result["totals"].update({
        "chats_selected": len(chats),
        "chats_completed": len(chats) - len(incomplete),
        "messages": message_count,
        "scanned_messages": scanned_count,
    })


def enforce_export_output_limit(result: dict[str, Any], max_output_bytes: int) -> None:
    """Keep even unusually large chat metadata inside the promised byte cap.

    The streaming budget already reserves space for metadata, so this is a
    final fail-safe. It trims only the newest retained suffix of later chat
    result arrays and records that loss explicitly.
    """

    wrapped = {"ok": True, **result}
    if compact_json_bytes(wrapped) <= max_output_bytes:
        return

    result["hit_output_byte_limit"] = True
    warning = "output_byte_limit_reached"
    if warning not in result["warnings"]:
        result["warnings"].append(warning)

    for chat in reversed(result["chats"]):
        messages = chat["messages"]
        while messages and compact_json_bytes({"ok": True, **result}) > max_output_bytes:
            # Removing in moderate chunks avoids repeatedly serializing a
            # multi-megabyte object while still preserving most of the page.
            remove_count = max(1, min(len(messages), len(messages) // 8))
            del messages[-remove_count:]
            mark_export_chat_incomplete(chat, "output_byte_limit")
            chat["message_count"] = len(messages)
            rebuild_export_summary(result)
        if compact_json_bytes({"ok": True, **result}) <= max_output_bytes:
            return

    raise TelegramRuntimeError(
        "Export metadata exceeds --max-output-bytes; narrow the dialog selection."
    )


async def export_targets(
    client: Any,
    args: argparse.Namespace,
) -> tuple[list[tuple[Any, str | None]], int, bool, list[str]]:
    """Resolve exact chats or a bounded dialog page without raw peer dumps."""

    targets: list[tuple[Any, str | None]] = []
    warnings: list[str] = []
    seen: set[tuple[str, int | str | None]] = set()
    dialogs_scanned = 0
    hit_dialog_limit = False

    if args.chat:
        for reference in args.chat:
            entity = await resolve_entity(client, reference)
            entity_type = telegram_entity_type(entity)
            if args.chat_type != "any" and entity_type != args.chat_type:
                warnings.append(f"chat_type_mismatch:{reference}")
                continue
            public = public_entity(entity)
            identity = (entity_type, public["id"] or public["username"] or public["title"])
            if identity in seen:
                continue
            seen.add(identity)
            targets.append((entity, reference))
        return targets, dialogs_scanned, hit_dialog_limit, warnings

    async for dialog in client.iter_dialogs(limit=args.dialog_limit + 1):
        dialogs_scanned += 1
        if dialogs_scanned > args.dialog_limit:
            hit_dialog_limit = True
            dialogs_scanned = args.dialog_limit
            break
        entity = dialog.entity
        entity_type = telegram_entity_type(entity)
        if args.chat_type != "any" and entity_type != args.chat_type:
            continue
        public = public_entity(entity)
        identity = (entity_type, public["id"] or public["username"] or public["title"])
        if identity in seen:
            continue
        seen.add(identity)
        targets.append((entity, None))

    if hit_dialog_limit:
        warnings.append("dialog_limit_reached")
    return targets, dialogs_scanned, hit_dialog_limit, warnings


async def command_export_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    """Export a bounded, explicit half-open period from selected Telegram chats."""

    zone, since, until = export_period(args)
    client = build_client(args, identity)
    await ensure_authorized(client)
    try:
        targets, dialogs_scanned, hit_dialog_limit, warnings = await export_targets(
            client,
            args,
        )
        message_budget = max(
            0,
            args.max_output_bytes
            - min(EXPORT_METADATA_RESERVE_BYTES, args.max_output_bytes // 2),
        )
        message_bytes = 0
        retained_total = 0
        hit_total_message_limit = False
        hit_output_byte_limit = False
        chats: list[dict[str, Any]] = []

        for entity, reference in targets:
            chat_result: dict[str, Any] = {
                "chat": public_entity(entity),
                "chat_type": telegram_entity_type(entity),
                "reference": reference,
                "message_count": 0,
                "scanned_count": 0,
                "hit_per_chat_limit": False,
                "hit_scan_limit": False,
                "stopped_older_than_since": False,
                "history_exhausted": False,
                "incomplete": False,
                "incomplete_reasons": [],
                "warnings": [],
                "messages": [],
            }
            chats.append(chat_result)

            if retained_total >= args.total_message_limit:
                hit_total_message_limit = True
                mark_export_chat_incomplete(chat_result, "total_message_limit")
                continue
            if message_bytes >= message_budget:
                hit_output_byte_limit = True
                mark_export_chat_incomplete(chat_result, "output_byte_limit")
                continue

            raw_messages: list[Any] = []
            try:
                async for message in client.iter_messages(
                    entity,
                    limit=None,
                    offset_date=until,
                ):
                    if chat_result["scanned_count"] >= args.scan_limit:
                        chat_result["hit_scan_limit"] = True
                        mark_export_chat_incomplete(chat_result, "scan_limit")
                        break
                    chat_result["scanned_count"] += 1

                    message_date = getattr(message, "date", None)
                    if not isinstance(message_date, datetime):
                        if "message_without_date" not in chat_result["warnings"]:
                            chat_result["warnings"].append("message_without_date")
                        mark_export_chat_incomplete(chat_result, "message_without_date")
                        continue
                    if message_date.tzinfo is None:
                        message_date = message_date.replace(tzinfo=timezone.utc)
                    message_date = message_date.astimezone(timezone.utc)
                    if message_date >= until:
                        continue
                    if message_date < since:
                        chat_result["stopped_older_than_since"] = True
                        break
                    if len(raw_messages) >= args.per_chat_limit:
                        chat_result["hit_per_chat_limit"] = True
                        mark_export_chat_incomplete(chat_result, "per_chat_limit")
                        break
                    if retained_total + len(raw_messages) >= args.total_message_limit:
                        hit_total_message_limit = True
                        mark_export_chat_incomplete(chat_result, "total_message_limit")
                        break
                    raw_messages.append(message)
                else:
                    chat_result["history_exhausted"] = True
            except Exception:
                # A single inaccessible or transiently failing dialog should
                # not discard the other bounded results or expose raw RPC
                # diagnostics in the export artifact.
                chat_result["warnings"].append("chat_read_failed")
                mark_export_chat_incomplete(chat_result, "chat_read_failed")

            safe_messages = await public_messages(raw_messages, entity)
            if not args.include_links:
                safe_messages = [
                    export_message_without_links(message) for message in safe_messages
                ]
            if args.chronological:
                safe_messages.reverse()

            for safe_message in safe_messages:
                candidate_bytes = compact_json_bytes(safe_message) + 1
                if message_bytes + candidate_bytes > message_budget:
                    hit_output_byte_limit = True
                    mark_export_chat_incomplete(chat_result, "output_byte_limit")
                    break
                chat_result["messages"].append(safe_message)
                message_bytes += candidate_bytes
                retained_total += 1
            if len(chat_result["messages"]) < len(safe_messages):
                hit_output_byte_limit = True
                mark_export_chat_incomplete(chat_result, "output_byte_limit")
            chat_result["message_count"] = len(chat_result["messages"])

        result: dict[str, Any] = {
            "period": {
                "since": since.astimezone(zone).isoformat(),
                "until": until.astimezone(zone).isoformat(),
                "since_utc": since.isoformat(),
                "until_utc": until.isoformat(),
                "timezone": args.timezone,
                "semantics": "since <= message.date < until",
            },
            "read_at": datetime.now(timezone.utc).isoformat(),
            "parameters": {
                "selection": "exact_chats" if args.chat else "all_dialogs",
                "chat_type": args.chat_type,
                "dialog_limit": args.dialog_limit,
                "per_chat_limit": args.per_chat_limit,
                "scan_limit": args.scan_limit,
                "total_message_limit": args.total_message_limit,
                "max_output_bytes": args.max_output_bytes,
                "chronological": args.chronological,
                "include_links": args.include_links,
            },
            "totals": {
                "dialogs_scanned": dialogs_scanned,
                "chats_selected": len(chats),
                "chats_completed": 0,
                "messages": 0,
                "scanned_messages": 0,
            },
            "chats": chats,
            "message_count": 0,
            "scanned_count": 0,
            "hit_dialog_limit": hit_dialog_limit,
            "hit_per_chat_limit": False,
            "hit_scan_limit": False,
            "hit_total_message_limit": hit_total_message_limit,
            "hit_output_byte_limit": hit_output_byte_limit,
            "incomplete_chats": [],
            "warnings": warnings,
        }
        if hit_total_message_limit:
            result["warnings"].append("total_message_limit_reached")
        if hit_output_byte_limit:
            result["warnings"].append("output_byte_limit_reached")
        rebuild_export_summary(result)
        enforce_export_output_limit(result, args.max_output_bytes)
        return result
    finally:
        await client.disconnect()


async def command_dialogs_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    if args.query is not None:
        return await command_dialog_search_async(args, identity)
    client = build_client(args, identity)
    await ensure_authorized(client)
    try:
        query = (args.query or "").casefold()
        dialogs = []
        async for dialog in client.iter_dialogs(limit=min(args.limit * 5, 500)):
            title = str(dialog.name or "")
            if query and query not in title.casefold():
                continue
            dialogs.append({
                "id": dialog.id,
                "title": title,
                "unreadCount": dialog.unread_count,
                "entity": public_entity(dialog.entity),
            })
            if len(dialogs) >= args.limit:
                break
        return {"dialogs": dialogs}
    finally:
        await client.disconnect()


def import_telethon_dialog_search():
    try:
        from telethon import utils
        from telethon.tl.functions.contacts import SearchRequest
        from telethon.tl.functions.messages import GetPeerDialogsRequest
        from telethon.tl.types import InputDialogPeer
    except ImportError as error:
        raise TelegramRuntimeError("Telegram dialog search is unavailable. Run bootstrap.") from error
    return SearchRequest, GetPeerDialogsRequest, InputDialogPeer, utils


async def command_dialog_search_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    """Search the server's own-chat index, independently of dialog recency.

    contacts.search separates my_results from public results. Only the former
    determines membership; response.users/chats are entity dictionaries, not
    additional hits. In particular, never scan a recent dialog page to decide
    whether an old group is one of the user's chats.
    """

    query = normalize_message_search_query(args.query)
    SearchRequest, GetPeerDialogsRequest, InputDialogPeer, utils = import_telethon_dialog_search()
    client = build_client(args, identity)
    try:
        await ensure_authorized(client)
        response = await client(SearchRequest(q=query, limit=args.limit))
        entities = {utils.get_peer_id(e): e for e in [*response.users, *response.chats]}
        own_peers = list(response.my_results)
        selected = []
        seen = set()
        unresolved = 0
        for peer in own_peers:
            peer_id = utils.get_peer_id(peer)
            if peer_id in seen:
                continue
            seen.add(peer_id)
            entity = entities.get(peer_id)
            if entity is None:
                unresolved += 1
                continue
            if len(selected) < args.limit:
                selected.append((peer_id, entity))

        unread = {}
        unread_available = True
        if selected:
            try:
                # Preserve unreadCount via one exact metadata read for selected
                # hits. This is not a search or a scan of the first N dialogs.
                peers = [InputDialogPeer(await client.get_input_entity(e)) for _id, e in selected]
                metadata = await client(GetPeerDialogsRequest(peers=peers))
                unread = {utils.get_peer_id(d.peer): d.unread_count for d in metadata.dialogs}
            except Exception:
                unread_available = False
        dialogs = [{"id": peer_id, "title": public_entity(entity)["title"],
                    "unreadCount": unread.get(peer_id), "entity": public_entity(entity)}
                   for peer_id, entity in selected]
        reasons = ["provider_search_not_exhaustive"]
        limit_reached = len(own_peers) >= args.limit
        if limit_reached:
            reasons.append("result_limit_reached")
        if unresolved:
            reasons.append("own_result_entity_unavailable")
        return {"dialogs": dialogs, "query": query,
                "coverage": {"source": "contacts.search", "scope": "my_results",
                             "returned": len(dialogs), "limit": args.limit,
                             "limitReached": limit_reached, "complete": False,
                             "hasMore": None, "publicResultsIncluded": False,
                             "incompleteReasons": reasons,
                             "unreadCountsComplete": unread_available and all(i in unread for i, _e in selected)}}
    except TelegramRuntimeError:
        raise
    except Exception as error:
        raise TelegramRuntimeError("Telegram server dialog search failed; this is not an empty search result.") from error
    finally:
        await client.disconnect()


def resolved_phone_user(result: Any) -> Any:
    """Select the exact resolved user without exposing raw peer structures."""

    peer = getattr(result, "peer", None)
    user_id = getattr(peer, "user_id", None)
    users = getattr(result, "users", None)
    if (
        isinstance(user_id, bool)
        or not isinstance(user_id, int)
        or not isinstance(users, (list, tuple))
    ):
        raise TelegramRuntimeError(
            "Telegram returned an unsupported phone lookup result."
        )
    matches = [
        user
        for user in users
        if not isinstance(getattr(user, "id", None), bool)
        and getattr(user, "id", None) == user_id
    ]
    if len(matches) != 1:
        raise TelegramRuntimeError(
            "Telegram returned an ambiguous phone lookup result."
        )
    return matches[0]


async def command_resolve_phone_async(
    args: argparse.Namespace,
    identity: Identity,
) -> dict[str, Any]:
    """Resolve one phone without importing it or returning private MTProto data."""

    normalized_phone = normalize_phone_lookup(args.phone)
    ResolvePhoneRequest, PhoneNotOccupiedError = import_telethon_phone_resolver()
    client = build_client(args, identity)
    try:
        await ensure_authorized(client)
        # Reserve before the request so provider failures and process
        # interruptions cannot be retried immediately through a fresh process.
        reserve_resolve_phone_slot(identity)
        try:
            resolved = await client(ResolvePhoneRequest(phone=normalized_phone))
        except PhoneNotOccupiedError:
            # Telegram applies the target user's phone-discovery privacy before
            # returning a peer. Do not claim whether the number is unregistered
            # or simply unavailable to this account.
            return {
                "found": False,
                "reason": "not_found_or_private",
                "securityBoundary": "chat-only",
            }
        except Exception as error:
            raise TelegramRuntimeError(
                "Telegram phone lookup failed without a conclusive result. "
                "Do not retry automatically; the local rate limit still applies."
            ) from error

        user = resolved_phone_user(resolved)
        return {
            "found": True,
            "user": public_entity(user),
            "securityBoundary": "chat-only",
        }
    finally:
        await client.disconnect()


async def command_members_async(
    args: argparse.Namespace,
    identity: Identity,
) -> dict[str, Any]:
    """Return a bounded, privacy-safe participant page for one exact chat."""

    client = build_client(args, identity)
    await ensure_authorized(client)
    try:
        entity = await resolve_entity(client, args.chat)
        chat_type = telegram_entity_type(entity)
        if chat_type not in {"group", "channel"}:
            raise TelegramRuntimeError(
                "members requires an exact Telegram group, supergroup or channel."
            )

        query = normalize_member_query(args.query)
        audience = "subscribers" if chat_type == "channel" else "members"
        # Telegram represents broadcast channels and supergroups with the same
        # Channel entity. That type alone says only that Telegram *can* hide a
        # participant list; it does not prove that this particular response was
        # truncated. Keep the capability for unresolved/error paths, then
        # replace it below with evidence from the successful page.
        provider_can_hide_results = type(entity).__name__ != "Chat"
        reported_total = (
            nonnegative_integer(getattr(entity, "participants_count", None))
            if not query
            else None
        )
        try:
            participant_page = await client.get_participants(
                entity,
                limit=args.limit,
                search=query,
            )
        except Exception as error:
            reason = participant_access_reason(error)
            if reason is None:
                raise TelegramRuntimeError(
                    "Telegram participant lookup failed without a conclusive result."
                ) from error
            return {
                "available": False,
                "reason": reason,
                "chat": public_entity(entity),
                "chatType": chat_type,
                "audience": audience,
                "query": query or None,
                "participants": [],
                "coverage": {
                    "returned": 0,
                    "reportedTotal": reported_total,
                    "limit": args.limit,
                    "hasMore": None,
                    "limitReached": False,
                    "providerMayLimitResults": provider_can_hide_results,
                },
                "securityBoundary": "chat-only",
            }

        provider_total = nonnegative_integer(
            getattr(participant_page, "total", None)
        )
        if not query and provider_total is not None:
            reported_total = provider_total
        participants = [
            public_participant(user, audience) for user in participant_page
        ]
        returned = len(participants)

        # Telethon's TotalList.total for ChannelParticipantsSearch may contain
        # the whole chat size rather than the number of matching rows. Exposing
        # that value as a match total produced impossible coverage such as
        # "9 of 162 name matches". A filtered Channel result therefore keeps
        # total/continuation unknown; callers must not use it to prove absence.
        if query:
            reported_total = None

        if reported_total is None:
            limit_reached = returned >= args.limit
            coverage_unresolved = provider_can_hide_results or limit_reached
            has_more = None if coverage_unresolved else False
            provider_may_limit_results = coverage_unresolved
        elif returned > reported_total:
            # A participant change during pagination can make the two snapshots
            # disagree. Do not turn that race into a false exhaustive result.
            has_more = None
            limit_reached = returned >= args.limit
            provider_may_limit_results = True
        else:
            has_more = reported_total > returned
            limit_reached = returned >= args.limit and has_more
            # Equality is positive evidence for the unfiltered snapshot: the
            # provider returned every participant it reported, below the local
            # bound. A partial count remains explicitly non-exhaustive.
            provider_may_limit_results = has_more
        return {
            "available": True,
            "chat": public_entity(entity),
            "chatType": chat_type,
            "audience": audience,
            "query": query or None,
            "participants": participants,
            "coverage": {
                "returned": returned,
                "reportedTotal": reported_total,
                "limit": args.limit,
                "hasMore": has_more,
                "limitReached": limit_reached,
                "providerMayLimitResults": provider_may_limit_results,
            },
            "securityBoundary": "chat-only",
        }
    finally:
        await client.disconnect()


@dataclass(frozen=True)
class MessageReference:
    chat: str
    message_id: int
    thread_id: int | None = None
    comment_id: int | None = None


def message_reference(args: argparse.Namespace) -> MessageReference:
    """Parse only message links; never navigate a supplied URL or join a chat.

    A channel comment belongs to the linked discussion group, not to the
    channel's ID namespace. Preserve that distinction until the provider has
    resolved the discussion root. Reject conflicting selectors before login.
    """

    link = getattr(args, "link", None)
    if not link:
        chat = getattr(args, "chat", None)
        message_id = getattr(args, "message_id", None)
        if not chat or not isinstance(message_id, int) or not 0 < message_id < 2**31:
            raise TelegramRuntimeError("Select --link or both --chat and --message-id.")
        return MessageReference(chat, message_id)
    if getattr(args, "chat", None) or getattr(args, "message_id", None):
        raise TelegramRuntimeError("--link cannot be combined with --chat or --message-id.")
    if len(link) > MAX_LINK_URL_CHARS or any(unicodedata.category(c).startswith("C") for c in link):
        raise TelegramRuntimeError("Invalid Telegram message link.")
    if link.startswith(("t.me/", "telegram.me/")):
        link = "https://" + link
    try:
        parsed = urllib.parse.urlsplit(link)
        if parsed.username or parsed.password or parsed.port:
            raise ValueError
        pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True, max_num_fields=10)
        params = dict(pairs)
        if len(params) != len(pairs):
            raise ValueError
        parts = parsed.path.strip("/").split("/")
        path_thread = None
        if parsed.scheme in {"http", "https"} and parsed.hostname in {"t.me", "telegram.me"}:
            if parts[0] == "s":
                parts = parts[1:]
            if parts[0] == "c" and len(parts) in {3, 4}:
                if not re.fullmatch(r"[1-9][0-9]{0,12}", parts[1]):
                    raise ValueError
                chat = str(-(1_000_000_000_000 + int(parts[1])))
                ids = parts[2:]
            elif len(parts) in {2, 3} and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{3,31}", parts[0]):
                chat = "@" + parts[0]
                ids = parts[1:]
            else:
                raise ValueError
            if len(ids) == 2:
                path_thread = ids[0]
            raw_id = ids[-1]
        elif parsed.scheme == "tg" and parsed.netloc in {"resolve", "privatepost"} and not parsed.path:
            raw_id = params.pop("post")
            if parsed.netloc == "resolve":
                username = params.pop("domain")
                if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{3,31}", username):
                    raise ValueError
                chat = "@" + username
            else:
                channel = params.pop("channel")
                if not re.fullmatch(r"[1-9][0-9]{0,12}", channel):
                    raise ValueError
                chat = str(-(1_000_000_000_000 + int(channel)))
        else:
            raise ValueError
        if set(params) - {"thread", "comment", "single", "t"}:
            raise ValueError

        def parse_id(value):
            if value is None:
                return None
            if not re.fullmatch(r"[1-9][0-9]{0,9}", value) or int(value) >= 2**31:
                raise ValueError
            return int(value)

        thread_id = parse_id(params.get("thread", path_thread))
        if path_thread is not None and thread_id != parse_id(path_thread):
            raise ValueError
        return MessageReference(chat, parse_id(raw_id), thread_id, parse_id(params.get("comment")))
    except (ValueError, KeyError, IndexError) as error:
        raise TelegramRuntimeError("Unsupported or ambiguous Telegram message link.") from error


def message_media_type(message: Any) -> str:
    """Project semantic media kinds without returning document IDs/file refs."""

    for attr, kind in (("voice", "voice"), ("video_note", "round-video"),
                       ("photo", "photo"), ("video", "video"), ("audio", "audio"),
                       ("document", "document"), ("web_preview", "url")):
        if getattr(message, attr, None):
            return kind
    return "other" if getattr(message, "media", None) is not None else "text"


def message_thread_id(message: Any) -> int | None:
    header = getattr(message, "reply_to", None)
    top = getattr(header, "reply_to_top_id", None)
    if top is None and getattr(header, "forum_topic", False):
        top = getattr(header, "reply_to_msg_id", None)
    return top if isinstance(top, int) and not isinstance(top, bool) and top > 0 else None


def message_link(entity: Any, message_id: int) -> str | None:
    # A username/message link is valid for a channel/supergroup, not for a
    # user's private dialog, even when that user happens to have a username.
    if type(entity).__name__ not in {"Channel", "ChannelForbidden"}:
        return None
    username = getattr(entity, "username", None)
    if username and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{3,31}", username):
        return f"https://t.me/{username}/{message_id}"
    return f"https://t.me/c/{entity.id}/{message_id}"


def exact_provider_message(message: Any, entity: Any, message_id: int, utils: Any) -> Any:
    if (not message or type(message).__name__ == "MessageEmpty"
            or getattr(message, "id", None) != message_id
            or utils.get_peer_id(message.peer_id) != utils.get_peer_id(entity)):
        raise TelegramRuntimeError("The exact Telegram message is unavailable or belongs to another chat.")
    return message


def hydrate_messages(client: Any, response: Any, utils: Any) -> list[Any]:
    entities = {utils.get_peer_id(e): e for e in [
        *list(getattr(response, "users", None) or []),
        *list(getattr(response, "chats", None) or []),
    ]}
    messages = list(getattr(response, "messages", None) or [])
    for message in messages:
        finish = getattr(message, "_finish_init", None)
        if callable(finish):
            finish(client, entities, None)
    return messages


async def discussion_root(client: Any, entity: Any, post_id: int) -> tuple[Any, Any]:
    functions, _types, utils, _events, _markdown = import_telethon_workflows()
    response = await client(functions.GetDiscussionMessageRequest(peer=entity, msg_id=post_id))
    messages = hydrate_messages(client, response, utils)
    # Do not choose a row by numerical ID: different peers have independent ID
    # sequences. Prove the forwarded channel post in the returned group instead.
    candidates = []
    for message in messages:
        forward = getattr(message, "fwd_from", None)
        source_peer = getattr(forward, "from_id", None)
        if (source_peer is not None and utils.get_peer_id(source_peer) == utils.get_peer_id(entity)
                and getattr(forward, "channel_post", None) == post_id
                and utils.get_peer_id(message.peer_id) != utils.get_peer_id(entity)):
            candidates.append(message)
    if len(candidates) != 1:
        raise TelegramRuntimeError("Telegram could not prove one linked discussion root.")
    root = candidates[0]
    group = next((e for e in response.chats if utils.get_peer_id(e) == utils.get_peer_id(root.peer_id)), None)
    if group is None:
        raise TelegramRuntimeError("The linked Telegram discussion group is unavailable.")
    return group, root


async def resolve_message_target(client: Any, reference: MessageReference) -> tuple[Any, Any]:
    _functions, _types, utils, _events, _markdown = import_telethon_workflows()
    entity = await resolve_entity(client, reference.chat)
    message = exact_provider_message(
        await client.get_messages(entity, ids=reference.message_id), entity, reference.message_id, utils,
    )
    if reference.comment_id is not None:
        entity, root = await discussion_root(client, entity, reference.message_id)
        message = exact_provider_message(
            await client.get_messages(entity, ids=reference.comment_id), entity, reference.comment_id, utils,
        )
        header = getattr(message, "reply_to", None)
        if (message.id != root.id and getattr(header, "reply_to_top_id", None) != root.id
                and getattr(header, "reply_to_msg_id", None) != root.id):
            raise TelegramRuntimeError("The comment does not belong to the linked channel discussion.")
    if reference.thread_id is not None:
        if message.id != reference.thread_id and message_thread_id(message) != reference.thread_id:
            raise TelegramRuntimeError("The message does not belong to the selected Telegram thread.")
    return entity, message


async def command_message_read_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    reference = message_reference(args)
    client = build_client(args, identity)
    try:
        await ensure_authorized(client)
        entity, message = await resolve_message_target(client, reference)
        normalized = (await public_messages([message], entity))[0]
        result = {"chat": public_entity(entity), "message": normalized,
                  "readState": {"mode": "history-only", "marksRead": False}}
        if getattr(args, "context", 0):
            # get_messages already knows the exact peer. Pass it explicitly for
            # context even when Telethon has not populated the message cache.
            result["context"] = await public_search_context(client, message, args.context, chat=entity)
        return result
    except TelegramRuntimeError:
        raise
    except Exception as error:
        raise TelegramRuntimeError("Cannot read the selected Telegram message; no action was taken.") from error
    finally:
        await client.disconnect()


async def command_thread_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    reference = message_reference(args)
    functions, _types, utils, _events, _markdown = import_telethon_workflows()
    client = build_client(args, identity)
    try:
        await ensure_authorized(client)
        entity, selected = await resolve_message_target(client, reference)
        if getattr(entity, "broadcast", False):
            entity, selected = await discussion_root(client, entity, selected.id)
        if type(entity).__name__ != "Channel":
            raise TelegramRuntimeError("Telegram threads require a supergroup; use read --context for a private dialog.")
        root_id = (message_thread_id(selected)
                   or getattr(getattr(selected, "reply_to", None), "reply_to_msg_id", None) or selected.id)
        root = exact_provider_message(await client.get_messages(entity, ids=root_id), entity, root_id, utils)
        request_limit = min(args.limit + 1, 100)
        response = await client(functions.GetRepliesRequest(
            peer=entity, msg_id=root_id, offset_id=args.before_id or 0,
            offset_date=None, add_offset=0, limit=request_limit, max_id=0, min_id=0, hash=0,
        ))
        raw = hydrate_messages(client, response, utils)
        for message in raw:
            exact_provider_message(message, entity, message.id, utils)
            header = getattr(message, "reply_to", None)
            if (message.id != root_id and message_thread_id(message) != root_id
                    and getattr(header, "reply_to_msg_id", None) != root_id):
                raise TelegramRuntimeError("Telegram returned a message outside the selected thread.")
        # The extra row proves whether another bounded page exists. Return a
        # chronological page, but continue from its oldest exclusive ID.
        unique = {m.id: m for m in raw if m.id != root_id}
        descending = sorted(unique.values(), key=lambda m: m.id, reverse=True)
        # Telegram caps one getReplies response at 100. A full provider page
        # without a look-ahead row is not evidence that the thread ended.
        has_more = len(descending) > args.limit or len(raw) >= request_limit
        chosen = descending[:args.limit]
        return {
            "chat": public_entity(entity), "root": (await public_messages([root], entity))[0],
            "messages": await public_messages(list(reversed(chosen)), entity),
            "coverage": {"returned": len(chosen), "limit": args.limit, "hasMore": has_more,
                         "nextBeforeId": chosen[-1].id if has_more else None,
                         "complete": not has_more and args.before_id is None,
                         "pageComplete": True, "snapshotStable": False},
            "readState": {"mode": "history-only", "marksRead": False},
        }
    except TelegramRuntimeError:
        raise
    except Exception as error:
        raise TelegramRuntimeError("Cannot read the Telegram thread; access or provider response is unavailable.") from error
    finally:
        await client.disconnect()


async def command_reply_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    reference = message_reference(args)
    text = outgoing_text(args)
    _functions, _types, utils, _events, markdown = import_telethon_workflows()
    expected_text, _entities = markdown.parse(text)
    mode = assert_send_allowed(identity, confirmed=args.confirm)
    schedule_at = parse_schedule_at(args.schedule_at) if args.schedule_at else None
    client = build_client(args, identity)
    started = False
    try:
        await ensure_authorized(client)
        entity, target = await resolve_message_target(client, reference)
        # A reply to a channel post is a comment in its discussion group.
        # Sending to the broadcast peer would publish an unrelated channel post.
        if getattr(entity, "broadcast", False):
            entity, target = await discussion_root(client, entity, target.id)
        options = {"reply_to": target.id, "file": args.file, "parse_mode": TELEGRAM_TEXT_PARSE_MODE}
        if schedule_at is not None:
            assert_schedule_lead_time(schedule_at)
            options["schedule"] = schedule_at
        started = True
        sent = await client.send_message(entity, text or None, **options)
        exact_provider_message(sent, entity, sent.id, utils)
        if not sent.out or getattr(sent, "reply_to_msg_id", None) != target.id or sent.message != expected_text:
            raise TelegramRuntimeError("The provider did not prove the exact reply target.")
        top = message_thread_id(target)
        if top is not None and message_thread_id(sent) != top:
            raise TelegramRuntimeError("The provider did not prove the exact reply thread.")
        if schedule_at is not None and normalize_schedule_datetime(sent.date) != schedule_at:
            raise TelegramRuntimeError("The provider did not prove the requested reply delivery time.")
        return {"sent": schedule_at is None, "scheduled": schedule_at is not None,
                "scheduledAt": format_utc_datetime(schedule_at) if schedule_at else None,
                "chat": public_entity(entity), "replyToMessageId": target.id,
                "message": (await public_messages([sent], entity))[0], "policyMode": mode,
                "retryPolicy": "Do not retry automatically after an ambiguous failure."}
    except Exception as error:
        if started:
            raise TelegramRuntimeError("Telegram reply result is ambiguous. Read the exact chat/queue; do not retry or change transport.") from error
        if isinstance(error, TelegramRuntimeError):
            raise
        raise TelegramRuntimeError("Cannot validate the Telegram reply target; nothing was sent.") from error
    finally:
        await client.disconnect()


async def command_read_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    if getattr(args, "link", None) or getattr(args, "message_id", None):
        return await command_message_read_async(args, identity)
    if not getattr(args, "chat", None) or getattr(args, "context", 0):
        raise TelegramRuntimeError("Recent read needs --chat; --context needs an exact --message-id or --link.")
    client = build_client(args, identity)
    await ensure_authorized(client)
    try:
        entity = await resolve_entity(client, args.chat)
        raw_messages = [item async for item in client.iter_messages(entity, limit=args.limit)]
        messages = await public_messages(raw_messages, entity)
        return {"chat": public_entity(entity), "messages": messages}
    finally:
        await client.disconnect()


async def command_scheduled_async(
    args: argparse.Namespace,
    identity: Identity,
) -> dict[str, Any]:
    """Read one exact chat's server-side scheduled queue without opening history."""

    client = build_client(args, identity)
    await ensure_authorized(client)
    try:
        entity = await resolve_entity(client, args.chat)
        # GetScheduledHistory has no pagination parameters and Telegram returns
        # the queue as one provider response. ``limit=None`` lets Telethon keep
        # its reported total intact; the runtime sorts and caps agent-visible
        # JSON only after that bounded provider queue has been materialized.
        provider_page = await client.get_messages(
            entity,
            limit=None,
            scheduled=True,
        )
        raw_messages = list(provider_page)
        scheduled_rows: list[tuple[datetime, Any]] = []
        for message in raw_messages:
            message_id = nonnegative_integer(getattr(message, "id", None))
            if message_id is None or message_id == 0:
                raise TelegramRuntimeError(
                    "Telegram returned a scheduled message without a stable queue id."
                )
            raw_scheduled_at = getattr(message, "date", None)
            if not isinstance(raw_scheduled_at, datetime):
                raise TelegramRuntimeError(
                    "Telegram returned a scheduled message without a valid delivery time."
                )
            scheduled_rows.append(
                (normalize_schedule_datetime(raw_scheduled_at), message)
            )

        # Telegram's raw ordering is provider-defined. Showing the next due
        # message first makes a capped response useful and deterministic.
        scheduled_rows.sort(
            key=lambda row: (row[0], int(getattr(row[1], "id")))
        )
        selected_rows = scheduled_rows[: args.limit]
        selected_messages = [message for _scheduled_at, message in selected_rows]
        messages = await public_messages(selected_messages, entity)
        for message, (scheduled_at, raw_message) in zip(messages, selected_rows):
            repeat_period = nonnegative_integer(
                getattr(raw_message, "schedule_repeat_period", None)
            )
            message["scheduled"] = True
            message["scheduledAt"] = format_utc_datetime(scheduled_at)
            # Telegram may return recurring queue entries created by another
            # client even though this runtime intentionally creates only
            # one-shot schedules. Exposing the interval prevents an agent from
            # presenting a recurring delivery as a one-time message.
            message["repeatPeriodSeconds"] = repeat_period or None

        provider_total = nonnegative_integer(getattr(provider_page, "total", None))
        reported_total = max(provider_total or 0, len(raw_messages))
        provider_complete = provider_total is None or provider_total <= len(raw_messages)
        has_more = reported_total > len(messages)
        limit_reached = len(raw_messages) > args.limit
        complete = provider_complete and not has_more
        incomplete_reason = None
        if not provider_complete:
            incomplete_reason = "provider_result_incomplete"
        elif has_more:
            incomplete_reason = "result_limit_reached"
        return {
            "scope": "exact_chat_scheduled_queue",
            "chat": public_entity(entity),
            "messages": messages,
            "coverage": {
                "returned": len(messages),
                "reportedTotal": reported_total,
                "limit": args.limit,
                "hasMore": has_more,
                "limitReached": limit_reached,
                "complete": complete,
                "incompleteReason": incomplete_reason,
            },
            "readState": {
                "mode": "scheduled-queue-only",
                "marksIncomingRead": False,
            },
            "securityBoundary": "chat-only",
        }
    finally:
        await client.disconnect()


def search_filter_spec(args: argparse.Namespace) -> dict[str, Any] | None:
    media = getattr(args, "media_type", "any")
    sender = getattr(args, "from_user", None)
    since_value, until_value = getattr(args, "since", None), getattr(args, "until", None)
    if media == "any" and not sender and not since_value and not until_value and not getattr(args, "before_id", None):
        return None
    if sender and getattr(args, "global_search", False):
        # searchGlobal has no from_id parameter. Searching InputPeerEmpty would
        # silently drop supergroups/channels, so never substitute that API.
        raise TelegramRuntimeError("--from requires search --chat; Telegram global search has no sender filter.")
    if (getattr(args, "global_search", False) and media == "any"
            and not getattr(args, "query", None)):
        raise TelegramRuntimeError("Global search needs text or a media filter; dates alone require --chat.")
    if getattr(args, "before_id", None) and getattr(args, "global_search", False):
        raise TelegramRuntimeError("Global search continues only with --cursor, not --before-id.")
    try:
        zone = ZoneInfo(getattr(args, "timezone", DEFAULT_EXPORT_TIMEZONE))
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise TelegramRuntimeError("Unknown search timezone.") from error
    since = parse_export_boundary(since_value, zone, "--since") if since_value else None
    until = parse_export_boundary(until_value, zone, "--until") if until_value else None
    if since is not None and until is not None and since >= until:
        raise TelegramRuntimeError("Search --since must be earlier than --until.")

    def provider_boundary(value, *, minimum):
        if value is None:
            return None
        # Telegram stores dates in whole seconds and both native bounds are
        # strict. Round the public half-open boundaries upward before making
        # min_date exclusive; truncating a fractional datetime would admit an
        # older hit at since and lose a valid hit immediately before until.
        seconds = math.ceil(value.timestamp()) - (1 if minimum else 0)
        if not (0 if minimum else 1) <= seconds < 2**31:
            # Telethon wraps out-of-range dates into a signed 32-bit value.
            # Reject them instead of searching a different historical period.
            raise TelegramRuntimeError("Search date is outside Telegram's supported timestamp range.")
        return datetime.fromtimestamp(seconds, tz=timezone.utc)

    _functions, types, _utils, _events, _markdown = import_telethon_workflows()
    return {"since": since, "until": until,
            "minDate": provider_boundary(since, minimum=True),
            "maxDate": provider_boundary(until, minimum=False),
            "mediaFilter": getattr(types, SEARCH_MEDIA_FILTERS[media])(),
            "public": {"from": sender, "mediaType": media,
                       "since": format_utc_datetime(since) if since else None,
                       "until": format_utc_datetime(until) if until else None,
                       "timezone": str(zone)}}


async def filtered_chat_search(client: Any, args: argparse.Namespace, query: str,
                               filters: dict[str, Any], radius: int) -> dict[str, Any]:
    functions, _types, utils, _events, _markdown = import_telethon_workflows()
    entity = await resolve_entity(client, args.chat)
    sender = None
    sender_id = None
    if getattr(args, "from_user", None):
        # A bare numeric string is a phone/username lookup to Telethon. Use
        # the same exact-ID conversion as --chat before resolving InputPeer.
        author = await resolve_entity(client, args.from_user)
        sender_id = utils.get_peer_id(author)
        sender = await client.get_input_entity(author)
    private_chat = type(entity).__name__ == "User"
    # Telegram ignores from_id in private dialogs and can fail an RPC when
    # from_id is combined with a media filter, including in Saved Messages.
    # Keep the native media/text/date search and check the exact author over
    # its bounded result stream instead of retrying that unsupported request
    # or silently dropping the author's condition.
    local_author = sender is not None and (private_chat or filters["public"]["mediaType"] != "any")
    own_id = None
    if local_author and private_chat:
        me = await client.get_me()
        own_id = getattr(me, "id", None)
    raw = []
    seen = set()
    offset_id = getattr(args, "before_id", None) or 0
    provider_inexact = False
    provider_exhausted = False
    uncertain_row = False
    scanned = 0
    last_scanned_id = offset_id
    verify_locally = local_author or filters["since"] is not None or filters["until"] is not None
    for _page in range(MAX_FILTERED_SEARCH_PAGES):
        # Limit bounds matching results, not the number of native hits examined
        # by the local author/date check. A separate explicit ceiling bounds
        # work, and even an empty partial page has a resumable native offset.
        request_limit = min(100, MAX_FILTERED_SEARCH_SCAN - scanned,
                            100 if verify_locally else args.limit + 1 - len(raw))
        if request_limit <= 0:
            break
        response = await client(functions.SearchRequest(
            peer=entity, q=query, filter=filters["mediaFilter"], min_date=filters["minDate"],
            max_date=filters["maxDate"], from_id=None if local_author else sender, offset_id=offset_id,
            add_offset=0, limit=request_limit, max_id=0, min_id=0, hash=0,
        ))
        batch = hydrate_messages(client, response, utils)
        provider_inexact = provider_inexact or bool(getattr(response, "inexact", False))
        if len(batch) > request_limit:
            raise TelegramRuntimeError("Telegram filtered search exceeded its bounded provider page.")
        for message in batch:
            exact_provider_message(message, entity, message.id, utils)
            if message.id in seen or (last_scanned_id and message.id >= last_scanned_id):
                raise TelegramRuntimeError("Telegram filtered search did not advance its result cursor.")
            seen.add(message.id)
            last_scanned_id = message.id
            scanned += 1
            if filters["since"] is not None or filters["until"] is not None:
                if not isinstance(getattr(message, "date", None), datetime):
                    uncertain_row = True
                    continue
                date = normalize_schedule_datetime(message.date)
                # Telegram may ignore max_date on media-only searches. Verify
                # both public half-open boundaries even when sent natively.
                if (filters["since"] is not None and date < filters["since"]
                        or filters["until"] is not None and date >= filters["until"]):
                    continue
            if local_author:
                actual_sender = getattr(message, "sender_id", None)
                if actual_sender is None and getattr(message, "from_id", None) is not None:
                    actual_sender = utils.get_peer_id(message.from_id)
                if actual_sender is None and private_chat:
                    actual_sender = own_id if getattr(message, "out", False) else utils.get_peer_id(entity)
                if actual_sender is None:
                    uncertain_row = True
                    continue
                if actual_sender != sender_id:
                    continue
            raw.append(message)
        provider_exhausted = len(batch) < request_limit
        if provider_exhausted or len(raw) > args.limit:
            break
        offset_id = last_scanned_id
    has_more = len(raw) > args.limit or not provider_exhausted
    selected = raw[:args.limit]
    messages = await public_messages(selected, entity)
    scan_limited = not provider_exhausted and len(raw) <= args.limit
    reasons = []
    if len(raw) > args.limit:
        reasons.append("result_limit_reached")
    if scan_limited:
        reasons.append("provider_scan_limit_reached")
    if provider_inexact:
        reasons.append("provider_result_inexact")
    if uncertain_row:
        reasons.append("result_author_or_date_unavailable")
    if getattr(args, "before_id", None):
        reasons.append("paginated_window")
    result = {"chat": public_entity(entity), "query": query, "messages": messages,
              "filters": filters["public"],
              "coverage": {"source": "messages.search", "returned": len(messages),
                           "limit": args.limit, "hasMore": has_more, "limitReached": len(raw) > args.limit,
                           "nextBeforeId": (selected[-1].id if selected else last_scanned_id) if has_more else None,
                           "complete": not has_more and not reasons,
                           "scanned": scanned, "scanLimit": MAX_FILTERED_SEARCH_SCAN,
                           "scanLimitReached": scan_limited,
                           "authorFilter": "bounded_local" if local_author else "server" if sender is not None else "none",
                           "incompleteReasons": reasons,
                           "providerMayLimitResults": provider_inexact,
                           "snapshotStable": False}}
    context = await attach_search_contexts(client, selected, messages, radius)
    if context is not None:
        result["contextCoverage"] = context
    return result


async def command_search_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    filters = search_filter_spec(args)
    if (args.query in (None, "") and filters is not None
            and not any((getattr(args, "from_user", None), getattr(args, "since", None),
                         getattr(args, "until", None), getattr(args, "media_type", "any") != "any"))):
        raise TelegramRuntimeError("Search requires text or an explicit sender/date/media filter.")
    query = "" if filters is not None and args.query in (None, "") else normalize_message_search_query(args.query)
    client = build_client(args, identity)
    await ensure_authorized(client)
    try:
        context_radius = search_context_radius(args)
        if getattr(args, "global_search", False):
            page = await fetch_global_search_page(
                client,
                query,
                args.limit,
                getattr(args, "cursor", None),
                **({"filters": filters} if filters is not None else {}),
            )
            selected_messages = page["messages"]
            messages = await public_messages(
                selected_messages,
                None,
                include_chat=True,
            )
            context_coverage = await attach_search_contexts(
                client,
                selected_messages,
                messages,
                context_radius,
            )
            complete = (
                page["seenBefore"] == 0
                and not page["hasMore"]
                and page["cursorAvailable"]
            )
            incomplete_reason = None
            if not complete:
                if page["cursorLimitReached"]:
                    incomplete_reason = "cursor_limit_reached"
                elif not page["cursorAvailable"]:
                    incomplete_reason = "provider_cursor_unavailable"
                elif page["hasMore"]:
                    incomplete_reason = "result_limit_reached"
                else:
                    incomplete_reason = "paginated_window"
            result = {
                "scope": "global",
                "query": query,
                "messages": messages,
                "coverage": {
                    "scope": "all_accessible_cloud_chats",
                    "returned": len(messages),
                    "reportedTotal": page["reportedTotal"],
                    "limit": args.limit,
                    "seenBefore": page["seenBefore"],
                    "seenThrough": page["seenThrough"],
                    "hasMore": page["hasMore"],
                    "nextCursor": page["nextCursor"],
                    "limitReached": page["hasMore"],
                    "cursorLimitReached": page["cursorLimitReached"],
                    "pageComplete": page["cursorAvailable"],
                    "complete": complete,
                    "incompleteReason": incomplete_reason,
                    "snapshotStable": False,
                    "excludedChatTypes": ["secret"],
                },
                "securityBoundary": "chat-only",
            }
            if context_coverage is not None:
                result["contextCoverage"] = context_coverage
            if filters is not None:
                result["filters"] = filters["public"]
            return result

        if getattr(args, "cursor", None):
            raise TelegramRuntimeError("--cursor is supported only with search --global.")
        if filters is not None:
            return await filtered_chat_search(client, args, query, filters, context_radius)
        entity = await resolve_entity(client, args.chat)
        raw_messages = [
            item async for item in client.iter_messages(entity, search=query, limit=args.limit)
        ]
        messages = await public_messages(raw_messages, entity)
        context_coverage = await attach_search_contexts(
            client,
            raw_messages,
            messages,
            context_radius,
        )
        result = {"chat": public_entity(entity), "query": query, "messages": messages}
        if context_coverage is not None:
            result["contextCoverage"] = context_coverage
        return result
    except TelegramRuntimeError:
        raise
    except Exception as error:
        raise TelegramRuntimeError("Telegram message search failed; this is not an empty search result.") from error
    finally:
        await client.disconnect()


async def command_download_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    client = build_client(args, identity)
    await ensure_authorized(client)
    try:
        entity = await resolve_entity(client, args.chat)
        message = await client.get_messages(entity, ids=args.message_id)
        if not message or not message.media:
            raise TelegramRuntimeError("The selected Telegram message has no downloadable media.")
        output = Path(args.output).expanduser().resolve()
        ensure_private_directory(output)
        downloaded = await client.download_media(message, file=str(output))
        if not downloaded:
            raise TelegramRuntimeError("Telegram did not return a downloaded file.")
        return {"chat": public_entity(entity), "messageId": message.id, "path": str(Path(downloaded).resolve())}
    finally:
        await client.disconnect()


def outgoing_text(args: argparse.Namespace) -> str:
    if args.message_file:
        path = Path(args.message_file).expanduser().resolve()
        ensure_private_file(path)
        text = path.read_text(encoding="utf-8")
    else:
        text = args.message or ""
    if len(text) > MAX_MESSAGE_CHARS:
        raise TelegramRuntimeError(f"Telegram text exceeds {MAX_MESSAGE_CHARS} characters.")
    if not text and not args.file:
        raise TelegramRuntimeError("send requires --message, --message-file or --file.")
    return text


async def command_send_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    mode = assert_send_allowed(
        identity,
        confirmed=args.confirm,
    )
    text = outgoing_text(args)
    schedule_at = (
        parse_schedule_at(args.schedule_at)
        if getattr(args, "schedule_at", None)
        else None
    )
    client = build_client(args, identity)
    await ensure_authorized(client)
    try:
        entity = await resolve_entity(client, args.chat)
        send_options: dict[str, Any] = {
            "file": args.file,
            "parse_mode": TELEGRAM_TEXT_PARSE_MODE,
        }
        if schedule_at is not None:
            # Re-check immediately before the decisive RPC. A timestamp that
            # was safe before login/peer resolution may now be close enough
            # for Telegram to convert it into an immediate message.
            assert_schedule_lead_time(schedule_at)
            send_options["schedule"] = schedule_at
        sent = await client.send_message(entity, text or None, **send_options)
        result = {
            "sent": schedule_at is None,
            "scheduled": schedule_at is not None,
            "chat": public_entity(entity),
            "messageId": sent.id,
            "parseMode": TELEGRAM_TEXT_PARSE_MODE_NAME,
            "policyMode": mode,
            "retryPolicy": "Do not retry automatically after an ambiguous failure.",
        }
        if schedule_at is not None:
            returned_at = getattr(sent, "date", None)
            if (
                not isinstance(returned_at, datetime)
                or normalize_schedule_datetime(returned_at) != schedule_at
            ):
                raise TelegramRuntimeError(
                    "Telegram scheduled-message result is ambiguous: the provider did not return "
                    "the exact requested delivery time. Do not retry automatically."
                )
            result["scheduledAt"] = format_utc_datetime(schedule_at)
            result["message"] = public_message(sent)
        return result
    except TelegramRuntimeError:
        raise
    except Exception as error:
        raise TelegramRuntimeError(
            f"Telegram send failed or its result is ambiguous: {error}. Do not retry automatically."
        ) from error
    finally:
        await client.disconnect()


def edit_text(args: argparse.Namespace) -> str:
    """Read one exact replacement body without accepting attachment changes."""

    if args.message_file:
        path = Path(args.message_file).expanduser().resolve()
        ensure_private_file(path)
        text = path.read_text(encoding="utf-8")
    else:
        text = args.message or ""
    if not text:
        raise TelegramRuntimeError("edit requires a non-empty --message or --message-file.")
    if len(text) > MAX_MESSAGE_CHARS:
        raise TelegramRuntimeError(f"Telegram text exceeds {MAX_MESSAGE_CHARS} characters.")
    return text


def edit_approval_hash(operation: dict[str, Any]) -> str:
    """Bind approval to one canonical target snapshot and replacement body."""

    encoded = json.dumps(
        operation,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def edit_operation(
    args: argparse.Namespace,
    entity: Any,
    message: Any,
    replacement_text: str,
) -> dict[str, Any]:
    """Build the stable, public operation that an edit approval authorizes.

    The snapshot deliberately excludes mutable presence metadata and raw
    MTProto peers/access hashes. It includes the current body, supported link
    entities and edit timestamp so a concurrent change invalidates the prior
    approval before the decisive provider call.
    """

    raw_message_id = getattr(message, "id", None)
    if (
        not isinstance(raw_message_id, int)
        or isinstance(raw_message_id, bool)
        or raw_message_id <= 0
        or raw_message_id != args.message_id
    ):
        raise TelegramRuntimeError("Telegram did not return the exact message selected for editing.")
    if not bool(getattr(message, "out", False)):
        raise TelegramRuntimeError("Telegram edit is limited to the current account's own outgoing messages.")
    if getattr(message, "action", None) is not None:
        raise TelegramRuntimeError("Telegram service messages cannot be edited.")

    current_text, current_text_truncated = bounded_string(
        getattr(message, "message", None),
        MAX_READ_TEXT_CHARS,
    )
    if current_text_truncated:
        raise TelegramRuntimeError("The selected Telegram message is too large for a safe edit preview.")

    has_media = getattr(message, "media", None) is not None
    if has_media and len(replacement_text) > MAX_CAPTION_CHARS:
        raise TelegramRuntimeError(
            f"Telegram media captions cannot exceed {MAX_CAPTION_CHARS} characters."
        )
    link_entities, link_entities_truncated = public_link_entities(
        current_text,
        getattr(message, "entities", None),
    )
    if link_entities_truncated:
        raise TelegramRuntimeError(
            "The selected Telegram message has too many link entities for a safe edit preview."
        )

    chat = public_entity(entity)
    if chat["id"] is None:
        raise TelegramRuntimeError("Telegram did not return a stable chat id for the edit target.")
    edit_date = getattr(message, "edit_date", None)
    return {
        "approvalSchemaVersion": 1,
        "command": "edit",
        "chatReference": args.chat,
        "chatId": chat["id"],
        "chatType": telegram_entity_type(entity),
        "messageId": raw_message_id,
        "currentText": current_text,
        "currentLinkEntities": link_entities,
        "currentEditDate": edit_date.isoformat() if isinstance(edit_date, datetime) else None,
        "hasMedia": has_media,
        "newText": replacement_text,
        "parseMode": TELEGRAM_TEXT_PARSE_MODE_NAME,
    }


async def load_edit_preview(
    client: Any,
    args: argparse.Namespace,
    replacement_text: str,
) -> tuple[Any, Any, dict[str, Any]]:
    """Resolve and snapshot one exact editable message without marking it read."""

    entity = await resolve_entity(client, args.chat)
    message = await client.get_messages(entity, ids=args.message_id)
    if not message:
        raise TelegramRuntimeError("The selected Telegram message does not exist or is unavailable.")
    return entity, message, edit_operation(args, entity, message, replacement_text)


async def command_edit_preview_async(
    args: argparse.Namespace,
    identity: Identity,
) -> dict[str, Any]:
    """Read the live target and return the exact operation requiring approval."""

    if args.approval_hash:
        raise TelegramRuntimeError("--approval-hash is accepted only with edit --confirm.")
    replacement_text = edit_text(args)
    client = build_client(args, identity)
    await ensure_authorized(client)
    try:
        entity, _message, operation = await load_edit_preview(
            client,
            args,
            replacement_text,
        )
        return {
            "dryRun": True,
            "chat": public_entity(entity),
            "operation": operation,
            "approvalHash": edit_approval_hash(operation),
            "confirmationRequired": True,
            "policyMode": load_policy(identity)["sendMode"],
        }
    except TelegramRuntimeError:
        raise
    except Exception as error:
        raise TelegramRuntimeError(f"Cannot prepare Telegram edit preview: {error}") from error
    finally:
        await client.disconnect()


async def command_edit_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    """Edit one own message after an unchanged live preview was confirmed."""

    if not args.confirm:
        raise TelegramRuntimeError(
            "Telegram edit always requires --confirm."
        )
    if not isinstance(args.approval_hash, str) or not re.fullmatch(
        r"[0-9a-f]{64}", args.approval_hash
    ):
        raise TelegramRuntimeError(
            "Telegram edit requires the exact --approval-hash returned by --dry-run."
        )
    mode = assert_send_allowed(
        identity,
        confirmed=True,
    )
    replacement_text = edit_text(args)
    client = build_client(args, identity)
    await ensure_authorized(client)
    mutation_started = False
    try:
        entity, target, operation = await load_edit_preview(
            client,
            args,
            replacement_text,
        )
        expected_hash = edit_approval_hash(operation)
        if not secrets.compare_digest(args.approval_hash, expected_hash):
            raise TelegramRuntimeError(
                "Telegram edit target or replacement changed after --dry-run; prepare a new preview."
            )

        # From this point a transport error is ambiguous: Telegram may have
        # committed the edit before the response was lost. Never retry this
        # call automatically with a fresh approval or another transport.
        mutation_started = True
        edited = await client.edit_message(
            entity,
            target,
            replacement_text,
            parse_mode=TELEGRAM_TEXT_PARSE_MODE,
        )
        if (
            not edited
            or getattr(edited, "id", None) != args.message_id
            or not bool(getattr(edited, "out", False))
        ):
            raise TelegramRuntimeError(
                "Telegram edit result is ambiguous: the provider did not return the exact outgoing message. "
                "Do not retry automatically."
            )
        return {
            "edited": True,
            "chat": public_entity(entity),
            "message": public_message(edited),
            "parseMode": TELEGRAM_TEXT_PARSE_MODE_NAME,
            "policyMode": mode,
            "retryPolicy": "Do not retry automatically after an ambiguous failure.",
        }
    except TelegramRuntimeError:
        raise
    except Exception as error:
        if mutation_started:
            raise TelegramRuntimeError(
                f"Telegram edit failed or its result is ambiguous: {error}. "
                "Read the exact message before deciding whether another edit is needed."
            ) from error
        raise TelegramRuntimeError(f"Cannot validate Telegram edit target: {error}") from error
    finally:
        await client.disconnect()


def provider_content_digest(value: Any) -> str:
    """Hash provider content in memory; never expose raw TL objects or file refs.

    A refreshed file_reference is a transport credential, not a change to the
    attachment the user approved. Exclude only that field; retain document IDs,
    media attributes, formatting, buttons and other content in the digest.
    """

    def normalize(item):
        if hasattr(item, "to_dict"):
            item = item.to_dict()
        if isinstance(item, dict):
            return {key: normalize(val) for key, val in item.items() if key != "file_reference"}
        if isinstance(item, (list, tuple)):
            return [normalize(val) for val in item]
        if isinstance(item, bytes):
            return base64.b64encode(item).decode("ascii")
        if isinstance(item, datetime):
            return item.isoformat()
        if item is None or isinstance(item, (str, bool, int, float)):
            return item
        raise TelegramRuntimeError("Unsupported Telegram content in an approval snapshot.")
    return edit_approval_hash({"content": normalize(value)})


def scheduled_content(message: Any) -> dict[str, Any]:
    text, truncated = bounded_string(getattr(message, "message", None), MAX_READ_TEXT_CHARS)
    if truncated or getattr(message, "action", None) or not getattr(message, "out", False):
        raise TelegramRuntimeError("Only an exact own scheduled message with a complete preview can be changed.")
    if getattr(message, "rich_message", None) is not None:
        raise TelegramRuntimeError("This Telegram rich-message format cannot be safely changed.")
    return {"text": text,
            "formattingDigest": provider_content_digest(getattr(message, "entities", None) or []),
            "mediaDigest": provider_content_digest(getattr(message, "media", None)),
            "replyMarkupDigest": provider_content_digest(getattr(message, "reply_markup", None)),
            "replyDigest": provider_content_digest(getattr(message, "reply_to", None)),
            "repeatPeriodSeconds": getattr(message, "schedule_repeat_period", None)}


async def get_scheduled_target(client: Any, entity: Any, message_id: int, *, required=True) -> Any:
    functions, _types, utils, _events, _markdown = import_telethon_workflows()
    response = await client(functions.GetScheduledMessagesRequest(peer=entity, id=[message_id]))
    rows = [m for m in hydrate_messages(client, response, utils) if type(m).__name__ != "MessageEmpty"]
    if not rows and not required:
        return None
    if len(rows) != 1:
        raise TelegramRuntimeError("The exact scheduled message is unavailable; it may already have been sent.")
    return exact_provider_message(rows[0], entity, message_id, utils)


def scheduled_approval(identity: Identity, account_id: int, operation: dict[str, Any], token: str | None = None) -> str:
    """Issue/consume a short-lived, single-use local approval under session lock.

    Only opaque hashes and a deadline are stored, never message text. The live
    account, connection namespace, runtime version and current queue snapshot
    must still match. Consume before the mutation, including failed sends.
    """

    path = connection_root(identity) / "config" / "message-operation-approval.json"
    account_digest = hashlib.sha256(str(account_id).encode("ascii")).hexdigest()
    digest = edit_approval_hash(operation)
    now = time.time()
    if token is None:
        token = secrets.token_hex(32)
        write_private_json(path, {"token": token, "operationDigest": digest,
                                  "accountDigest": account_digest, "expiresAt": now + MESSAGE_APPROVAL_TTL_SECONDS})
        return token
    try:
        ensure_private_file(path)
        if path.stat().st_size > 2048:
            raise ValueError
        record = json.loads(path.read_text(encoding="utf-8"))
        expiry = record["expiresAt"]
        if (not isinstance(expiry, (int, float)) or isinstance(expiry, bool) or not math.isfinite(expiry)
                or not now < expiry <= now + MESSAGE_APPROVAL_TTL_SECONDS
                or not secrets.compare_digest(record["token"], token)
                or not secrets.compare_digest(record["operationDigest"], digest)
                or not secrets.compare_digest(record["accountDigest"], account_digest)):
            raise ValueError
    except (OSError, ValueError, KeyError, TypeError, TelegramRuntimeError) as error:
        raise TelegramRuntimeError("Scheduled-message approval is missing, expired, used or changed; prepare a new --dry-run.") from error
    path.unlink()
    return token


async def command_scheduled_mutation_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    if args.dry_run and args.approval_hash:
        raise TelegramRuntimeError("--approval-hash belongs only to --confirm.")
    if not args.dry_run and (not args.confirm or not re.fullmatch(r"[0-9a-f]{64}", args.approval_hash or "")):
        raise TelegramRuntimeError("Scheduled-message changes require --dry-run then --confirm --approval-hash.")
    replacement = None
    requested_at = None
    if args.command == "scheduled-edit":
        if args.message is not None or args.message_file:
            replacement = edit_text(args)
        if args.schedule_at:
            requested_at = parse_schedule_at(args.schedule_at)
        if replacement is None and requested_at is None:
            raise TelegramRuntimeError("scheduled-edit needs a new --message/--message-file or --schedule-at.")
    mode = load_policy(identity)["sendMode"]
    if not args.dry_run:
        mode = assert_send_allowed(identity, confirmed=True)
    functions, _types, utils, _events, markdown = import_telethon_workflows()
    client = build_client(args, identity)
    started = False
    try:
        await ensure_authorized(client)
        entity = await resolve_entity(client, args.chat)
        target = await get_scheduled_target(client, entity, args.message_id)
        before = scheduled_content(target)
        old_at = normalize_schedule_datetime(target.date)
        new_at = requested_at or old_at
        new_text, new_entities = markdown.parse(replacement) if replacement is not None else (None, None)
        if replacement is not None and not new_text:
            raise TelegramRuntimeError("The replacement Telegram message cannot be empty after Markdown parsing.")
        if getattr(target, "media", None) is not None and new_text is not None and len(new_text) > MAX_CAPTION_CHARS:
            raise TelegramRuntimeError("The scheduled media caption exceeds the supported limit.")
        operation = {"runtimeVersion": MESSAGE_WORKFLOW_VERSION, "command": args.command,
                     "chatId": utils.get_peer_id(entity), "messageId": target.id,
                     "current": before, "currentScheduledAt": format_utc_datetime(old_at),
                     "newText": new_text, "newFormattingDigest": provider_content_digest(new_entities) if new_entities is not None else None,
                     "newScheduledAt": format_utc_datetime(new_at) if args.command == "scheduled-edit" else None}
        me = await client.get_me()
        if not me or not isinstance(me.id, int) or me.id <= 0:
            raise TelegramRuntimeError("Cannot bind approval to the current Telegram account.")
        if args.command == "scheduled-edit":
            # schedule_date is mandatory even for a body-only edit: normal
            # history and the queue may contain unrelated messages with the
            # same numeric ID. Never issue an ordinary history edit here.
            assert_schedule_lead_time(new_at)
        if args.dry_run:
            return {"dryRun": True, "chat": public_entity(entity), "operation": operation,
                    "approvalHash": scheduled_approval(identity, me.id, operation),
                    "approvalExpiresInSeconds": MESSAGE_APPROVAL_TTL_SECONDS,
                    "confirmationRequired": True, "policyMode": mode}
        scheduled_approval(identity, me.id, operation, args.approval_hash)
        if args.command == "scheduled-edit":
            assert_schedule_lead_time(new_at)
            request = functions.EditMessageRequest(peer=entity, id=target.id,
                                                   message=new_text, entities=new_entities, schedule_date=new_at,
                                                   schedule_repeat_period=before["repeatPeriodSeconds"])
        elif args.command == "scheduled-cancel":
            request = functions.DeleteScheduledMessagesRequest(peer=entity, id=[target.id])
        else:
            request = functions.SendScheduledMessagesRequest(peer=entity, id=[target.id])
        started = True
        response = await client(request)
        after = await get_scheduled_target(client, entity, target.id, required=False)
        result = {"chat": public_entity(entity), "scheduledMessageId": target.id,
                  "policyMode": mode, "retryPolicy": "Do not retry automatically after an ambiguous failure."}
        if args.command == "scheduled-edit":
            if after is None:
                raise TelegramRuntimeError("The edited message is no longer in the queue.")
            expected = {**before}
            if new_text is not None:
                expected["text"] = new_text
                expected["formattingDigest"] = provider_content_digest(new_entities)
            if scheduled_content(after) != expected or normalize_schedule_datetime(after.date) != new_at:
                raise TelegramRuntimeError("The scheduled message does not match the confirmed edit.")
            return {**result, "edited": True, "scheduledAt": format_utc_datetime(new_at),
                    "message": (await public_messages([after], entity))[0]}
        if after is not None:
            raise TelegramRuntimeError("The original message is still in the scheduled queue.")
        deletion = [u for u in getattr(response, "updates", [])
                    if type(u).__name__ == "UpdateDeleteScheduledMessages"
                    and utils.get_peer_id(u.peer) == utils.get_peer_id(entity) and target.id in u.messages]
        if len(deletion) != 1:
            raise TelegramRuntimeError("The provider did not prove removal of the exact queue entry.")
        sent_ids = getattr(deletion[0], "sent_messages", None) or []
        if args.command == "scheduled-cancel":
            if sent_ids:
                raise TelegramRuntimeError("The message was delivered while cancellation was in progress.")
            return {**result, "cancelled": True}
        index = deletion[0].messages.index(target.id)
        if len(sent_ids) != len(deletion[0].messages):
            raise TelegramRuntimeError("The provider did not map the queue ID to a delivered message ID.")
        delivered_id = sent_ids[index]
        delivered = exact_provider_message(await client.get_messages(entity, ids=delivered_id), entity, delivered_id, utils)
        delivered_content = scheduled_content(delivered)
        # Repetition belongs to the schedule, not to its delivered occurrence.
        delivered_content["repeatPeriodSeconds"] = before["repeatPeriodSeconds"]
        if delivered_content != before or not getattr(delivered, "from_scheduled", False):
            raise TelegramRuntimeError("The delivered message does not match the approved queue entry.")
        return {**result, "sent": True, "messageId": delivered_id,
                "message": (await public_messages([delivered], entity))[0]}
    except Exception as error:
        if started:
            raise TelegramRuntimeError("Scheduled-message result is ambiguous. Read the exact queue and chat; do not retry or switch transport.") from error
        if isinstance(error, TelegramRuntimeError):
            raise
        raise TelegramRuntimeError("Cannot prepare the exact scheduled-message operation; nothing was changed.") from error
    finally:
        await client.disconnect()


async def command_transcribe_async(args: argparse.Namespace, identity: Identity) -> dict[str, Any]:
    """Start exactly one native transcription and await only its own updates.

    Telegram may consume a non-Premium quota when this request is submitted.
    Never turn a pending result into a polling loop of new transcribe requests,
    and never upload media to a second transcription provider automatically.
    """

    reference = message_reference(args)
    functions, types, utils, events, _markdown = import_telethon_workflows()
    client = build_client(args, identity)
    handler = None
    try:
        await ensure_authorized(client)
        entity, message = await resolve_message_target(client, reference)
        if message_media_type(message) not in {"voice", "round-video"}:
            raise TelegramRuntimeError("Select a Telegram voice message or round video for transcription.")
        updates: dict[int, Any] = {}
        changed = asyncio.Event()

        async def on_update(update):
            if (not isinstance(update, types.UpdateTranscribedAudio)
                    or update.msg_id != message.id
                    or utils.get_peer_id(update.peer) != utils.get_peer_id(entity)):
                return
            # A very early update may arrive before the RPC response; retain
            # only a small set for this exact peer/message, then select the
            # transcription ID returned by the authoritative initial request.
            if len(updates) < 4 or update.transcription_id in updates:
                updates[update.transcription_id] = update
                changed.set()

        handler = on_update
        client.add_event_handler(handler, events.Raw(types.UpdateTranscribedAudio))
        try:
            initial = await client(functions.TranscribeAudioRequest(peer=entity, msg_id=message.id))
        except Exception as error:
            code = getattr(error, "message", "")
            known = {"PREMIUM_ACCOUNT_REQUIRED": "premium_or_quota_required",
                     "MSG_VOICE_TOO_LONG": "voice_too_long", "TRANSCRIPTION_FAILED": "transcription_failed",
                     "MSG_VOICE_MISSING": "voice_unavailable"}
            if code in known or type(error).__name__ == "FloodWaitError":
                return {"available": False, "reason": known.get(code, "provider_rate_limit"),
                        "chat": public_entity(entity), "messageId": message.id,
                        "retryAfterSeconds": getattr(error, "seconds", None),
                        "automaticRetry": False}
            raise TelegramRuntimeError("Telegram transcription result is unknown; do not submit a duplicate request.") from error
        transcription_id = getattr(initial, "transcription_id", None)
        if (not isinstance(transcription_id, int) or isinstance(transcription_id, bool)
                or transcription_id == 0 or not -(1 << 63) <= transcription_id < (1 << 63)):
            raise TelegramRuntimeError("Telegram returned an invalid transcription result; do not repeat automatically.")
        current = initial
        deadline = asyncio.get_running_loop().time() + args.wait_seconds
        while bool(getattr(current, "pending", False)):
            current = updates.get(transcription_id, current)
            if not getattr(current, "pending", False):
                break
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                break
            changed.clear()
            try:
                await asyncio.wait_for(changed.wait(), timeout=remaining)
            except asyncio.TimeoutError:
                break
        transcript, truncated = bounded_string(getattr(current, "text", None), MAX_TRANSCRIPT_CHARS)
        return {"available": True, "source": "telegram", "chat": public_entity(entity),
                "messageId": message.id, "link": message_link(entity, message.id),
                "transcriptionId": transcription_id, "text": transcript, "textTruncated": truncated,
                "pending": bool(getattr(current, "pending", False)),
                "complete": not bool(getattr(current, "pending", False)) and not truncated,
                "remainingTrialCount": nonnegative_integer(getattr(initial, "trial_remains_num", None)),
                "trialResetsAt": telegram_status_timestamp(getattr(initial, "trial_remains_until_date", None)),
                "readState": {"mode": "transcription-only", "marksRead": False},
                "automaticRetry": False}
    except TelegramRuntimeError:
        raise
    except Exception as error:
        raise TelegramRuntimeError("Telegram transcription is unavailable; no external transcription provider was used.") from error
    finally:
        if handler is not None:
            client.remove_event_handler(handler)
        await client.disconnect()


def command_doctor(args: argparse.Namespace) -> dict[str, Any]:
    identity = identity_from_args(args)
    root = connection_root(identity)
    session_file = session_path(identity).with_suffix(".session")
    if session_file.exists():
        ensure_private_file(session_file)
    _api_id, _api_hash, legacy_cache_removed = require_app_credentials(identity)
    return {
        "runtimeReady": runtime_python().exists(),
        "appCredentialsBundled": True,
        "appCredentialBoundary": "signed-runtime-package",
        "appCredentialsUserConfigRequired": False,
        "legacyApiHashCacheRemoved": legacy_cache_removed,
        "sessionPresent": session_file.exists(),
        "policy": load_policy(identity),
        "localRoot": str(root),
        "securityBoundary": "chat-only",
    }


def command_policy(args: argparse.Namespace) -> dict[str, Any]:
    identity = identity_from_args(args)
    if args.policy_command == "set":
        if args.send_mode not in POLICY_MODES:
            raise TelegramRuntimeError("Persistent policy supports only confirm or read-only.")
        write_private_json(policy_path(identity), {"sendMode": args.send_mode})
    return {
        "policy": load_policy(identity),
        "path": str(policy_path(identity)),
    }


def run_async_command(args: argparse.Namespace) -> dict[str, Any]:
    identity = identity_from_args(args)
    with session_lock(identity):
        if args.command == "login":
            return asyncio.run(command_login_async(args, identity))
        if args.command == "dialogs":
            return asyncio.run(command_dialogs_async(args, identity))
        if args.command == "resolve-phone":
            return asyncio.run(command_resolve_phone_async(args, identity))
        if args.command == "members":
            return asyncio.run(command_members_async(args, identity))
        if args.command == "read":
            return asyncio.run(command_read_async(args, identity))
        if args.command == "thread":
            return asyncio.run(command_thread_async(args, identity))
        if args.command == "reply":
            return asyncio.run(command_reply_async(args, identity))
        if args.command == "transcribe":
            return asyncio.run(command_transcribe_async(args, identity))
        if args.command in {"scheduled-edit", "scheduled-cancel", "scheduled-send-now"}:
            return asyncio.run(command_scheduled_mutation_async(args, identity))
        if args.command == "scheduled":
            return asyncio.run(command_scheduled_async(args, identity))
        if args.command == "search":
            return asyncio.run(command_search_async(args, identity))
        if args.command in {"export", "daily-export"}:
            return asyncio.run(command_export_async(args, identity))
        if args.command == "download":
            return asyncio.run(command_download_async(args, identity))
        if args.command == "send":
            return asyncio.run(command_send_async(args, identity))
        if args.command == "edit":
            if args.dry_run:
                return asyncio.run(command_edit_preview_async(args, identity))
            return asyncio.run(command_edit_async(args, identity))
    raise TelegramRuntimeError(f"Unsupported Telegram command: {args.command}")


def add_connection_arguments(parser: argparse.ArgumentParser) -> None:
    # The generic signed-runtime host supplies these through protected
    # TRELIO_SKILL_* environment fields. Optional flags keep exact legacy
    # invocations working only when they match the host-owned values.
    parser.add_argument("--company-id")
    parser.add_argument("--member-id")
    parser.add_argument("--connection-id")


def add_export_arguments(parser: argparse.ArgumentParser) -> None:
    """Declare the shared bounded contract for export and daily-export."""

    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument(
        "--chat",
        action="append",
        help="Exact chat id or username; repeat to export several chats",
    )
    selection.add_argument(
        "--all-dialogs",
        action="store_true",
        help="Export a bounded page of dialogs",
    )
    parser.add_argument("--since", required=True, help="Inclusive ISO 8601 boundary")
    parser.add_argument("--until", required=True, help="Exclusive ISO 8601 boundary")
    parser.add_argument("--timezone", default=DEFAULT_EXPORT_TIMEZONE)
    parser.add_argument(
        "--chat-type",
        choices=("any", "group", "channel", "user", "bot"),
        default="any",
    )
    parser.add_argument(
        "--dialog-limit",
        type=int,
        choices=range(1, 1_001),
        default=DEFAULT_EXPORT_DIALOG_LIMIT,
        metavar="1..1000",
    )
    parser.add_argument(
        "--per-chat-limit",
        type=int,
        choices=range(1, 5_001),
        default=DEFAULT_EXPORT_PER_CHAT_LIMIT,
        metavar="1..5000",
    )
    parser.add_argument(
        "--scan-limit",
        type=int,
        choices=range(1, 50_001),
        default=DEFAULT_EXPORT_SCAN_LIMIT,
        metavar="1..50000",
    )
    parser.add_argument(
        "--total-message-limit",
        type=int,
        choices=range(1, 50_001),
        default=DEFAULT_EXPORT_TOTAL_MESSAGE_LIMIT,
        metavar="1..50000",
    )
    parser.add_argument(
        "--max-output-bytes",
        type=int,
        choices=range(1_048_576, MAX_EXPORT_OUTPUT_BYTES + 1),
        default=DEFAULT_EXPORT_MAX_OUTPUT_BYTES,
        metavar="1048576..16777216",
    )
    parser.add_argument(
        "--chronological",
        action="store_true",
        help="Return oldest retained message first inside each chat",
    )
    parser.add_argument(
        "--include-links",
        action="store_true",
        help="Include normalized URL entities in addition to message text",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Compatibility flag; runtime output is always JSON",
    )


def add_message_target_arguments(parser: argparse.ArgumentParser) -> None:
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--chat", help="Exact peer, together with --message-id")
    target.add_argument("--link", help="Telegram message, forum-topic or channel-comment link")
    parser.add_argument("--message-id", type=positive_message_id)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Trelio Telegram MTProto runtime")
    add_connection_arguments(parser)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("bootstrap", help="Install the pinned local Telethon runtime")
    commands.add_parser("doctor", help="Check local runtime, policy and session without revealing secrets")
    policy = commands.add_parser("policy", help="Read or update local sending policy")
    policy_commands = policy.add_subparsers(dest="policy_command", required=True)
    policy_commands.add_parser("show")
    policy_set = policy_commands.add_parser("set")
    policy_set.add_argument("--send-mode", choices=POLICY_MODES, required=True)
    login = commands.add_parser(
        "login",
        help="Authorize the personal session through a protected local browser page",
    )
    login_method = login.add_mutually_exclusive_group()
    login_method.add_argument("--qr", action="store_true", help="Open QR login immediately")
    login_method.add_argument("--code", action="store_true", help="Open phone and code login immediately")
    login.add_argument(
        "--terminal-prompts",
        action="store_true",
        help="Use the current visible terminal instead of the protected local browser page",
    )
    login.add_argument(
        "--qr-timeout",
        type=int,
        choices=range(30, 601),
        default=DEFAULT_QR_LOGIN_TIMEOUT_SECONDS,
        metavar="30..600",
    )
    login.add_argument(
        "--qr-refresh-seconds",
        type=int,
        choices=range(5, 61),
        default=DEFAULT_QR_REFRESH_SECONDS,
        metavar="5..60",
    )
    dialogs = commands.add_parser("dialogs", help="List or narrowly search dialogs")
    dialogs.add_argument("--query")
    dialogs.add_argument("--limit", type=int, choices=range(1, 101), default=20, metavar="1..100")
    resolve_phone = commands.add_parser(
        "resolve-phone",
        help="Resolve one international phone number when Telegram privacy allows it",
    )
    resolve_phone.add_argument(
        "--phone",
        required=True,
        help="One international number beginning with +; never returned in JSON",
    )
    members = commands.add_parser(
        "members",
        help="List a bounded page of visible group members or channel subscribers",
    )
    members.add_argument("--chat", required=True)
    members.add_argument(
        "--query",
        help="Optional Telegram-side search by visible name or username",
    )
    members.add_argument(
        "--limit",
        type=int,
        choices=range(1, MAX_MEMBER_LIMIT + 1),
        default=DEFAULT_MEMBER_LIMIT,
        metavar=f"1..{MAX_MEMBER_LIMIT}",
    )
    read = commands.add_parser("read", help="Read recent messages in one exact chat")
    add_message_target_arguments(read)
    read.add_argument("--context", type=int, choices=range(0, 11), default=0, metavar="0..10")
    read.add_argument("--limit", type=int, choices=range(1, 201), default=20, metavar="1..200")
    thread = commands.add_parser("thread", help="Read a bounded page of a message thread or channel comments")
    add_message_target_arguments(thread)
    thread.add_argument("--limit", type=int, choices=range(1, 101), default=50, metavar="1..100")
    thread.add_argument("--before-id", type=positive_message_id)
    reply = commands.add_parser("reply", help="Reply to one exact message, preserving its thread")
    add_message_target_arguments(reply)
    reply_body = reply.add_mutually_exclusive_group()
    reply_body.add_argument("--message")
    reply_body.add_argument("--message-file")
    reply.add_argument("--file")
    reply.add_argument("--schedule-at")
    reply.add_argument("--confirm", action="store_true")
    transcribe = commands.add_parser("transcribe", help="Transcribe one voice/round video through Telegram")
    add_message_target_arguments(transcribe)
    transcribe.add_argument("--wait-seconds", type=int, choices=range(0, 31), default=20, metavar="0..30")
    scheduled = commands.add_parser(
        "scheduled",
        help="Read the bounded scheduled-message queue of one exact chat",
    )
    scheduled.add_argument("--chat", required=True)
    scheduled.add_argument(
        "--limit",
        type=int,
        choices=range(1, MAX_SCHEDULED_LIMIT + 1),
        default=DEFAULT_SCHEDULED_LIMIT,
        metavar=f"1..{MAX_SCHEDULED_LIMIT}",
    )
    for name in ("scheduled-edit", "scheduled-cancel", "scheduled-send-now"):
        mutation = commands.add_parser(name, help="Change one exact queue entry after a live approved preview")
        mutation.add_argument("--chat", required=True)
        mutation.add_argument("--message-id", required=True, type=positive_message_id)
        approval = mutation.add_mutually_exclusive_group(required=True)
        approval.add_argument("--dry-run", action="store_true")
        approval.add_argument("--confirm", action="store_true")
        mutation.add_argument("--approval-hash")
        if name == "scheduled-edit":
            body = mutation.add_mutually_exclusive_group()
            body.add_argument("--message")
            body.add_argument("--message-file")
            mutation.add_argument("--schedule-at")
    search = commands.add_parser(
        "search",
        help="Search messages in one exact chat or across accessible cloud chats",
    )
    search_scope = search.add_mutually_exclusive_group(required=True)
    search_scope.add_argument("--chat")
    search_scope.add_argument(
        "--global",
        dest="global_search",
        action="store_true",
        help="Search every accessible Telegram cloud chat; secret chats are excluded",
    )
    search.add_argument("--query", help="Text, optional when an explicit sender/date/media filter is present")
    search.add_argument("--from", dest="from_user", help="Exact author in --chat scope; Telegram global search has no sender filter")
    search.add_argument("--since", help="Inclusive ISO date/time in --timezone")
    search.add_argument("--until", help="Exclusive ISO date/time in --timezone")
    search.add_argument("--timezone", default=DEFAULT_EXPORT_TIMEZONE)
    search.add_argument("--media-type", choices=tuple(SEARCH_MEDIA_FILTERS), default="any")
    search.add_argument("--before-id", type=positive_message_id, help="Continue an exact-chat filtered search from nextBeforeId")
    search.add_argument("--limit", type=int, choices=range(1, 201), default=20, metavar="1..200")
    search.add_argument(
        "--cursor",
        help="Opaque nextCursor from the previous global-search page",
    )
    search.add_argument(
        "--context",
        type=int,
        choices=range(0, MAX_SEARCH_CONTEXT_RADIUS + 1),
        default=0,
        metavar=f"0..{MAX_SEARCH_CONTEXT_RADIUS}",
        help=(
            "Attach this many chronological messages before and after every hit; "
            f"a non-zero value requires --limit 1..{MAX_SEARCH_CONTEXT_RESULTS}"
        ),
    )
    export = commands.add_parser(
        "export",
        aliases=["daily-export"],
        help="Export a bounded half-open period from exact chats or dialogs",
    )
    add_export_arguments(export)
    download = commands.add_parser("download", help="Download media from one selected message")
    download.add_argument("--chat", required=True)
    download.add_argument("--message-id", required=True, type=int)
    download.add_argument("--output", required=True)
    send = commands.add_parser("send", help="Send one message authorized in the current conversation")
    send.add_argument("--chat", required=True)
    send.add_argument("--message")
    send.add_argument("--message-file")
    send.add_argument("--file")
    send.add_argument(
        "--schedule-at",
        help="Future RFC 3339 timestamp with seconds and an explicit UTC offset or Z",
    )
    send.add_argument("--confirm", action="store_true")
    edit = commands.add_parser(
        "edit",
        help="Edit one own outgoing message after a live dry-run preview",
    )
    edit.add_argument("--chat", required=True)
    edit.add_argument("--message-id", required=True, type=positive_message_id)
    edit_body = edit.add_mutually_exclusive_group(required=True)
    edit_body.add_argument("--message")
    edit_body.add_argument("--message-file")
    edit_approval = edit.add_mutually_exclusive_group(required=True)
    edit_approval.add_argument("--dry-run", action="store_true")
    edit_approval.add_argument("--confirm", action="store_true")
    edit.add_argument("--approval-hash")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        reexec_in_runtime_if_needed(args.command)
        if args.command == "bootstrap":
            result = command_bootstrap(args)
        elif args.command == "doctor":
            result = command_doctor(args)
        elif args.command == "policy":
            result = command_policy(args)
        else:
            result = run_async_command(args)
    except (TelegramRuntimeError, OSError, UnicodeError, ValueError) as error:
        if BROWSER_PROMPT_SESSION is not None:
            BROWSER_PROMPT_SESSION.finish(
                title="Вход не завершён",
                message="Вернитесь в Codex, проверьте сообщение об ошибке и запустите вход заново.",
            )
            time.sleep(0.4)
        if isinstance(error, TelegramRuntimeError):
            error_payload = error.public_payload()
        else:
            error_payload = {"ok": False, "error": str(error)}
        print(json.dumps(error_payload, ensure_ascii=False), file=sys.stderr)
        return 2
    finally:
        shutdown_browser_prompt_session()
    output = {"ok": True, **result}
    if args.command in {"export", "daily-export"}:
        # Period exports are potentially large machine-readable artifacts. A
        # compact encoding makes --max-output-bytes deterministic and avoids
        # spending most of that budget on indentation.
        print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
    else:
        print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
