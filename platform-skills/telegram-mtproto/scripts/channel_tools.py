"""Bounded channel analytics and explicitly reviewed bulk message operations.

The entrypoint supplies the existing runtime primitives; importing this module
does not touch credentials, sessions, Telethon, the network or local files.
"""

import hashlib
import argparse
import io
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path


VERSION = "2.8.0"
MAX_ALBUM_ITEMS = 10
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_ALBUM_BYTES = 100 * 1024 * 1024
GRAPH_FIELDS = {
    "growth": "growth_graph", "followers": "followers_graph",
    "views-by-source": "views_by_source_graph",
    "new-followers-by-source": "new_followers_by_source_graph",
    "top-hours": "top_hours_graph", "interactions": "interactions_graph",
}


def add_parsers(commands, positive_id):
    def bounded_id(value):
        parsed = positive_id(value)
        if parsed >= 2**31:
            raise argparse.ArgumentTypeError("message id must fit a positive Telegram int32")
        return parsed

    stats = commands.add_parser("channel-stats", help="Read available channel analytics and its provider-selected period")
    stats.add_argument("--chat", required=True)
    stats.add_argument("--graph", choices=tuple(GRAPH_FIELDS), help="Read one bounded graph; never a caller-supplied token")
    album = commands.add_parser("album", help="Read the media group around one exact message")
    album.add_argument("--chat", required=True)
    album.add_argument("--message-id", type=bounded_id, required=True)
    send = commands.add_parser("send-album", help="Preview/send 2..10 local photos or MP4 videos")
    send.add_argument("--chat", required=True)
    send.add_argument("--file", action="append", required=True)
    body = send.add_mutually_exclusive_group()
    body.add_argument("--message")
    body.add_argument("--message-file")
    forward = commands.add_parser("forward", help="Preview/forward exact originals to one destination")
    forward.add_argument("--from-chat", required=True)
    forward.add_argument("--chat", required=True)
    forward.add_argument("--message-id", type=bounded_id, action="append", required=True)
    for parser in (send, forward):
        mode = parser.add_mutually_exclusive_group(required=True)
        mode.add_argument("--dry-run", action="store_true")
        mode.add_argument("--confirm", action="store_true")
        parser.add_argument("--approval-hash")


def api():
    from telethon import functions, utils
    from telethon.extensions import markdown
    return functions, utils, markdown


def finite(value, *, signed=False):
    if type(value) not in (int, float):
        return None
    try:
        if not math.isfinite(value):
            return None
    except OverflowError:
        return None
    return value if signed or value >= 0 else None


def pair(value):
    return {"current": finite(getattr(value, "current", None)),
            "previous": finite(getattr(value, "previous", None))}


def graph_status(graph):
    return {"StatsGraph": "available", "StatsGraphAsync": "pending"}.get(type(graph).__name__, "unavailable")


def public_graph(graph):
    """Project chart series, never raw JSON, async tokens or provider errors.

    Validate the whole bounded graph first, then explicitly cap the displayed
    series/points. A clipped chart must not become proof for an entire period.
    Axis values stay in Telegram's units: top-hours is not a timestamp series.
    """

    status = graph_status(graph)
    result = {"status": status, "complete": False, "series": []}
    if status != "available":
        return result
    raw = getattr(getattr(graph, "json", None), "data", None)
    if not isinstance(raw, str) or len(raw) > 65_536 or len(raw.encode("utf-8")) > 65_536:
        return {**result, "status": "unavailable", "reason": "graph_invalid_or_too_large"}
    try:
        data = json.loads(raw)
        columns, types, names = data["columns"], data["types"], data.get("names", {})
        if not isinstance(columns, list) or not 2 <= len(columns) <= 33 or not isinstance(types, dict) or not isinstance(names, dict):
            raise ValueError
        indexed = {}
        for column in columns:
            if (not isinstance(column, list) or not 2 <= len(column) <= 1001
                    or not isinstance(column[0], str) or len(column[0]) > 32 or column[0] in indexed
                    or any(finite(value, signed=True) is None for value in column[1:])):
                raise ValueError
            indexed[column[0]] = column[1:]
        xkeys = [key for key in indexed if types.get(key) == "x"]
        if len(xkeys) != 1:
            raise ValueError
        x = indexed.pop(xkeys[0])
        if any(len(values) != len(x) for values in indexed.values()):
            raise ValueError
        if any(types.get(key) not in {"line", "area", "bar", "step"} for key in indexed):
            raise ValueError
        keys = list(indexed)
        # Keep the latest 100 points in provider order and at most 8 series.
        # These limits also keep native/text-compatible MCP envelopes bounded.
        series = [{"key": key, "name": names.get(key)[:80] if isinstance(names.get(key), str) else None,
                   "type": types[key], "values": indexed[key][-100:]} for key in keys[:8]]
        return {"status": "available", "complete": len(x) <= 100 and len(keys) <= 8,
                "axisUnits": "provider", "x": x[-100:], "series": series,
                "coverage": {"reportedPoints": len(x), "returnedPoints": min(len(x), 100),
                             "reportedSeries": len(keys), "returnedSeries": min(len(keys), 8)}}
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
        return {**result, "status": "unavailable", "reason": "graph_invalid_or_too_large"}


async def stats_request(client, request, dc, utils):
    """Use Telegram's exact statistics DC without moving the personal session.

    Telethon's documented get_stats uses this same exported-sender lifecycle.
    The graph token remains process-local and is used only for this read.
    """

    if dc == client.session.dc_id:
        return await client(request)
    await request.resolve(client, utils)
    sender = await client._borrow_exported_sender(dc)
    try:
        return await sender.send(request)
    finally:
        await client._return_exported_sender(sender)


async def channel_stats(client, args, r):
    functions, utils, _markdown = api()
    entity = await r.resolve_entity(client, args.chat)
    if type(entity).__name__ != "Channel" or not getattr(entity, "broadcast", False):
        raise r.TelegramRuntimeError("channel-stats requires one exact broadcast channel.")
    result = {"available": False, "chat": r.public_entity(entity), "reason": None,
              "readState": {"mode": "statistics-only", "marksRead": False}}
    full = (await client(functions.channels.GetFullChannelRequest(channel=entity))).full_chat
    if type(full).__name__ != "ChannelFull" or type(full.id) is not int or full.id != entity.id:
        raise r.TelegramRuntimeError("Telegram returned mismatched channel statistics metadata.")
    if getattr(full, "can_view_stats", None) is not True:
        return {**result, "reason": "statistics_not_available_for_account"}
    dc = getattr(full, "stats_dc", None)
    if type(dc) is not int or not 0 < dc < 100:
        return {**result, "reason": "statistics_datacenter_unavailable"}
    try:
        stats = await stats_request(client, functions.stats.GetBroadcastStatsRequest(channel=entity), dc, utils)
    except Exception as error:
        reason = r.participant_access_reason(error)
        if reason is None:
            raise
        return {**result, "reason": reason}
    if type(stats).__name__ != "BroadcastStats":
        raise r.TelegramRuntimeError("Telegram returned an unexpected channel statistics response.")
    period = getattr(stats, "period", None)
    start = r.telegram_status_timestamp(getattr(period, "min_date", None))
    end = r.telegram_status_timestamp(getattr(period, "max_date", None))
    if not start or not end or start >= end:
        raise r.TelegramRuntimeError("Telegram statistics period is unavailable.")
    result.update(available=True, period={"since": start, "until": end, "selectedBy": "telegram"},
                  observedAt=datetime.now(timezone.utc).isoformat(),
                  metrics={key: pair(getattr(stats, field, None)) for key, field in (
                      ("followers", "followers"), ("viewsPerPost", "views_per_post"),
                      ("sharesPerPost", "shares_per_post"), ("reactionsPerPost", "reactions_per_post"))},
                  graphs={name: graph_status(getattr(stats, field, None)) for name, field in GRAPH_FIELDS.items()})
    if args.graph:
        graph = getattr(stats, GRAPH_FIELDS[args.graph], None)
        if type(graph).__name__ == "StatsGraphAsync":
            token = getattr(graph, "token", None)
            if isinstance(token, str) and 0 < len(token) <= 4096:
                try:
                    graph = await stats_request(client, functions.stats.LoadAsyncGraphRequest(token=token), dc, utils)
                except Exception:
                    # Summary remains useful; graph failure is neither an empty
                    # graph nor permission to re-submit through another route.
                    graph = None
        result["graph"] = {"name": args.graph, **public_graph(graph)}
    return result


def checked_message(r, utils, entity, message, expected_id):
    message = r.exact_provider_message(message, entity, expected_id, utils)
    if getattr(message, "action", None) is not None or len(getattr(message, "message", "") or "") > r.MAX_READ_TEXT_CHARS:
        raise r.TelegramRuntimeError("The selected message is unsupported or cannot be read completely.")
    return message


def public_row(r, message, entity):
    return {**r.public_message(message), "link": r.message_link(entity, message.id)}


async def read_album(client, args, r):
    _functions, utils, _markdown = api()
    entity = await r.resolve_entity(client, args.chat)
    selected = checked_message(r, utils, entity, await client.get_messages(entity, ids=args.message_id), args.message_id)
    group = r.public_message(selected)["groupedId"]
    if group is None:
        return {"available": False, "reason": "message_has_no_album", "chat": r.public_entity(entity)}
    # Album members normally have nearby IDs. A fixed window cannot prove the
    # whole group, so coverage stays explicitly partial even for ten matches.
    # Never dereference replies or scan the rest of the chat to fill gaps.
    low, high = max(1, selected.id - MAX_ALBUM_ITEMS), min(2**31 - 1, selected.id + MAX_ALBUM_ITEMS)
    ids = list(range(low, high + 1))
    response = await client.get_messages(entity, ids=ids)
    if not isinstance(response, (list, tuple)) or len(response) != len(ids):
        raise r.TelegramRuntimeError("Telegram returned an incomplete album window.")
    rows = []
    for expected, row in zip(ids, response):
        if row is None or type(row).__name__ == "MessageEmpty":
            continue
        row = checked_message(r, utils, entity, row, expected)
        if r.public_message(row)["groupedId"] == group:
            rows.append(row)
    if not rows or len(rows) > MAX_ALBUM_ITEMS or selected.id not in [row.id for row in rows]:
        raise r.TelegramRuntimeError("Telegram album changed or exceeded its supported bound.")
    # Re-read the chosen message to detect a concurrent edit/deletion instead
    # of presenting a mixed source snapshot as a complete immutable album.
    current = checked_message(r, utils, entity, await client.get_messages(entity, ids=selected.id), selected.id)
    if r.scheduled_content(current) != r.scheduled_content(selected) or r.public_message(current)["groupedId"] != group:
        raise r.TelegramRuntimeError("Telegram album changed while it was being read.")
    return {"available": True, "chat": r.public_entity(entity), "groupedId": group,
            "messages": [public_row(r, row, entity) for row in rows],
            "coverage": {"complete": False, "windowOnly": True, "returned": len(rows),
                         "firstCheckedId": low, "lastCheckedId": high, "attachmentsContentRead": False,
                         "reason": "bounded_message_window_not_atomic"},
            "readState": {"mode": "history-only", "marksRead": False}}


def frozen_files(paths, r):
    """Freeze approved upload bytes in bounded RAM, closing file TOCTOU races.

    Do not hand the SDK a mutable pathname, remote URL or a reopened file after
    validation. Buffers are local to this invocation and never stored in state,
    prompt, approval journal or a plaintext temporary directory.
    """

    if not 2 <= len(paths) <= MAX_ALBUM_ITEMS:
        raise r.TelegramRuntimeError("An album requires 2..10 local JPEG/PNG photos or MP4 videos.")
    files, previews, seen, total = [], [], set(), 0
    for value in paths:
        path = Path(value).expanduser()
        if "://" in value or path.is_symlink() or not path.is_file():
            raise r.TelegramRuntimeError("Album uploads require regular local files, without symlinks or URLs.")
        path = path.resolve()
        # These are explicitly selected media, not the credential store. A
        # normal readable 0644 photo is valid; never chmod the user's source.
        if path in seen or path.stat().st_size > MAX_FILE_BYTES:
            raise r.TelegramRuntimeError("Duplicate album file or file exceeds 20 MiB.")
        seen.add(path)
        with path.open("rb") as source:
            content = source.read(MAX_FILE_BYTES + 1)
        total += len(content)
        if not content or len(content) > MAX_FILE_BYTES or total > MAX_ALBUM_BYTES:
            raise r.TelegramRuntimeError("Album upload exceeds 20 MiB per file or 100 MiB total, or a file is empty.")
        suffix = path.suffix.lower()
        photo = ((suffix in {".jpg", ".jpeg"} and content.startswith(b"\xff\xd8\xff"))
                 or (suffix == ".png" and content.startswith(b"\x89PNG\r\n\x1a\n")))
        video = suffix == ".mp4" and len(content) >= 12 and content[4:8] == b"ftyp"
        if not photo and not video:
            raise r.TelegramRuntimeError("Album media must have matching JPEG/PNG/MP4 content and extension.")
        buffer = io.BytesIO(content)
        buffer.name = path.name
        files.append(buffer)
        previews.append({"fileName": path.name[:r.MAX_FILE_NAME_CHARS], "sizeBytes": len(content),
                         "mediaType": "photo" if photo else "video", "sha256": hashlib.sha256(content).hexdigest()})
    return files, previews


def mutation_content(message, r):
    # Hash only stable content; exclude transport file_reference and the new
    # delivery timestamp/ID. Exact source revisions separately bind forwarding.
    return {field: r.provider_content_digest((getattr(message, field, None) or []) if field == "entities" else getattr(message, field, None))
            for field in ("message", "entities", "media")}


async def bulk_mutation(client, args, identity, r):
    if (args.dry_run and args.approval_hash) or (not args.dry_run and not re.fullmatch(r"[0-9a-f]{64}", args.approval_hash or "")):
        raise r.TelegramRuntimeError("Prepare --dry-run, then the unchanged --confirm --approval-hash operation.")
    if not args.dry_run:
        r.assert_send_allowed(identity, confirmed=True)
    _functions, utils, markdown = api()
    destination = await r.resolve_entity(client, args.chat)
    if (getattr(destination, "send_paid_messages_stars", None) or 0) != 0:
        raise r.TelegramRuntimeError("Paid Telegram destinations are unsupported by bulk delivery.")
    account = await client.get_me()
    operation = {"runtimeVersion": VERSION, "command": args.command, "destination": utils.get_peer_id(destination)}
    preview = {"chat": r.public_entity(destination), "chatId": utils.get_peer_id(destination)}
    files = []
    try:
        if args.command == "send-album":
            files, file_previews = frozen_files(args.file, r)
            # Existing caption reader already guards local UTF-8 input. The
            # album has one caption on its first item, not repeated N times.
            caption = r.edit_text(args) if args.message is not None or args.message_file else ""
            text, entities = markdown.parse(caption)
            if len(text) > r.MAX_CAPTION_CHARS:
                raise r.TelegramRuntimeError("Album caption exceeds the supported 1024-character limit.")
            operation.update(files=file_previews, caption=caption)
            preview.update(files=file_previews, caption=text, parseMode=r.TELEGRAM_TEXT_PARSE_MODE_NAME)
        else:
            ids = args.message_id
            if not 1 <= len(ids) <= MAX_ALBUM_ITEMS or len(ids) != len(set(ids)):
                raise r.TelegramRuntimeError("Forward requires 1..10 distinct exact message IDs.")
            source = await r.resolve_entity(client, args.from_chat)
            if getattr(source, "noforwards", False):
                raise r.TelegramRuntimeError("Telegram source chat protects its content from forwarding.")
            raw = await client.get_messages(source, ids=ids)
            if not isinstance(raw, (list, tuple)) or len(raw) != len(ids):
                raise r.TelegramRuntimeError("Telegram did not return every selected original.")
            originals = [checked_message(r, utils, source, row, expected) for row, expected in zip(raw, ids)]
            if any(getattr(row, "noforwards", False) for row in originals):
                raise r.TelegramRuntimeError("A selected Telegram original protects its content from forwarding.")
            operation.update(source=utils.get_peer_id(source), ids=ids,
                             snapshots=[{"content": r.scheduled_content(row), "groupedId": r.public_message(row)["groupedId"],
                                         "origin": r.provider_content_digest(getattr(row, "fwd_from", None))} for row in originals])
            preview.update(sourceChat=r.public_entity(source), sourceChatId=utils.get_peer_id(source),
                           messages=[public_row(r, row, source) for row in originals], preservesAttribution=True)
        # Bound disclosure before granting approval, and again before send.
        # An oversized preview must not become a successful unreviewed batch.
        if len(json.dumps(preview, ensure_ascii=False).encode()) > 20_000:
            raise r.TelegramRuntimeError("Bulk preview exceeds its output budget; select fewer originals.")
        if args.dry_run:
            token = r.scheduled_approval(identity, account.id, operation)
            return {"dryRun": True, "approvalHash": token, "expiresInSeconds": r.MESSAGE_APPROVAL_TTL_SECONDS,
                    "preview": preview, "securityBoundary": "chat-only"}
        # Consume before any upload/send. Failure (including partial delivery)
        # does not restore authority; a new preview is not a retry permission.
        r.scheduled_approval(identity, account.id, operation, args.approval_hash)
        try:
            if args.command == "send-album":
                sent = await client.send_file(destination, files, caption=[caption] + [""] * (len(files) - 1),
                                              parse_mode=r.TELEGRAM_TEXT_PARSE_MODE, clear_draft=False, force_document=False)
                expected_count = len(files)
            else:
                sent = await client.forward_messages(destination, ids, from_peer=source,
                                                     drop_author=False, drop_media_captions=False)
                expected_count = len(ids)
            if not isinstance(sent, (list, tuple)) or len(sent) != expected_count:
                raise ValueError
            seen_ids = set()
            for index, row in enumerate(sent):
                row_id = getattr(row, "id", None)
                if type(row_id) is not int or row_id <= 0 or row_id in seen_ids:
                    raise ValueError
                seen_ids.add(row_id)
                checked_message(r, utils, destination, row, row_id)
                if not getattr(row, "out", False):
                    raise ValueError
                if args.command == "forward":
                    if getattr(row, "fwd_from", None) is None or mutation_content(row, r) != mutation_content(originals[index], r):
                        raise ValueError
                elif ((getattr(row, "message", "") or "") != (text if index == 0 else "")
                      or r.message_media_type(row) != file_previews[index]["mediaType"]
                      or (index == 0 and r.provider_content_digest(getattr(row, "entities", None) or []) != r.provider_content_digest(entities))):
                    raise ValueError
            if args.command == "send-album":
                groups = {r.public_message(row)["groupedId"] for row in sent}
                if len(groups) != 1 or None in groups:
                    raise ValueError
            result = {"sent": True, "chat": r.public_entity(destination), "messageIds": [row.id for row in sent],
                    "messages": [public_row(r, row, destination) for row in sent],
                    "retryPolicy": "Do not repeat automatically; read back exact destination first.",
                    "securityBoundary": "chat-only"}
            if len(json.dumps(result, ensure_ascii=False).encode()) > 28_000:
                raise ValueError
            return result
        except Exception as error:
            raise r.TelegramRuntimeError(
                "Telegram bulk delivery failed or is ambiguous. Do not retry or switch transport; read back the destination first.",
                code="TELEGRAM_BULK_DELIVERY_UNKNOWN") from error
    finally:
        for file in files:
            file.close()


async def run(args, identity, r):
    client = r.build_client(args, identity)
    failure = None
    try:
        await r.ensure_authorized(client)
        if args.command == "channel-stats":
            result = await channel_stats(client, args, r)
        elif args.command == "album":
            result = await read_album(client, args, r)
        else:
            result = await bulk_mutation(client, args, identity, r)
        # Even plain terminal output must stay inside the provider's result
        # budget. Never serialize an unbounded graph, long caption batch or TL.
        if len(json.dumps(result, ensure_ascii=False).encode()) > 28_000:
            raise r.TelegramRuntimeError("Telegram channel result exceeds its output budget; narrow the selection.")
        return {"securityBoundary": "chat-only", **result}
    except r.TelegramRuntimeError as error:
        failure = error
        raise
    except Exception as error:
        failure = r.TelegramRuntimeError("Telegram channel operation is unavailable; no conclusive result was returned.")
        raise failure from error
    finally:
        try:
            await client.disconnect()
        except Exception as error:
            if failure is None:
                raise r.TelegramRuntimeError(
                    "Telegram channel cleanup failed; no result was delivered.",
                    code="TELEGRAM_BULK_DELIVERY_UNKNOWN" if args.command in {"forward", "send-album"} and not args.dry_run else None,
                ) from error
