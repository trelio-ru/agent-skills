"""Quoted replies, reviewed text series and exact personal chat settings.

Import is inert. Private text exists only in this invocation; the shared approval
journal stores digests, never a second outbox. Every dispatch is followed by an
exact native read, and an uncertain part stops a series without replay.
"""
import argparse
import copy
import pathlib
import secrets
import unicodedata
from datetime import datetime, timezone

VERSION = "2.13.0"
READS = {"chat-settings"}
MUTATIONS = {"send-series", "archive", "unarchive", "mute", "unmute"}
COMMANDS = READS | MUTATIONS
STYLE = {"MessageEntityBold", "MessageEntityItalic", "MessageEntityUnderline", "MessageEntityStrike",
         "MessageEntitySpoiler", "MessageEntityCode", "MessageEntityPre", "MessageEntityBlockquote"}
ENTITIES = STYLE | {"MessageEntityTextUrl", "MessageEntityUrl", "MessageEntityEmail", "MessageEntityPhone",
                    "MessageEntityMention", "MessageEntityMentionName", "MessageEntityHashtag", "MessageEntityCashtag",
                    "MessageEntityBotCommand", "MessageEntityCustomEmoji"}


def add_parsers(commands, positive_id):
    for name in sorted(COMMANDS):
        p = commands.add_parser(name, help="Reviewed Telegram text series or personal chat settings")
        p.add_argument("--chat", required=True)
        if name == "send-series":
            body = p.add_mutually_exclusive_group(required=True)
            body.add_argument("--message")
            body.add_argument("--message-file")
            p.add_argument("--topic-id", type=positive_id)
            p.add_argument("--send-as")
            p.add_argument("--silent", action="store_true")
            p.add_argument("--no-link-preview", action="store_true")
        if name == "mute":
            p.add_argument("--until", required=True, help="Explicit RFC3339 time with seconds and offset")
        if name in MUTATIONS:
            mode = p.add_mutually_exclusive_group(required=True)
            mode.add_argument("--dry-run", action="store_true")
            mode.add_argument("--confirm", action="store_true")
            p.add_argument("--approval-hash")


def quote_parser(p):
    p.add_argument("--quote-text", help="Exact original substring, not Markdown")
    p.add_argument("--quote-offset", type=int, help="Explicit UTF-16 offset when the substring occurs repeatedly")


def units(text):
    return len(text.encode("utf-16-le")) // 2


def entity_slice(entities, start, end, r):
    """Clip styles in UTF-16 space; indivisible semantic entities stay whole."""
    if not isinstance(entities, list) or len(entities) > 1000:
        raise r.TelegramRuntimeError("Telegram formatting exceeds the supported entity bound.")
    result = []
    for value in entities:
        if type(value).__name__ not in ENTITIES:
            raise r.TelegramRuntimeError("Unsupported Telegram formatting cannot be preserved safely.")
        offset, length = getattr(value, "offset", None), getattr(value, "length", None)
        if type(offset) is not int or type(length) is not int or offset < 0 or length <= 0:
            raise r.TelegramRuntimeError("Telegram formatting has invalid offsets.")
        finish = offset + length
        if offset >= end or finish <= start:
            continue
        if (offset < start or finish > end) and type(value).__name__ not in STYLE:
            raise r.TelegramRuntimeError("An indivisible Telegram entity crosses the selected boundary.")
        row = copy.copy(value)
        row.offset, row.length = max(offset, start) - start, min(finish, end) - max(offset, start)
        result.append(row)
    return result


def public_entities(entities):
    # Never serialize arbitrary TL objects or input-user access hashes into a
    # preview. These are the complete public fields of the supported entities.
    return [{"type": type(row).__name__, **{key: getattr(row, key) for key in
            ("offset", "length", "url", "user_id", "document_id", "language", "collapsed")
            if getattr(row, key, None) is not None}} for row in entities]


def grapheme_boundary(text, index):
    # Never cut a surrogate (Python already uses code points), combining mark,
    # emoji modifier/variation, ZWJ chain, CRLF or a regional-indicator pair.
    if not 0 < index < len(text):
        return True
    left, right = text[index - 1], text[index]
    if (unicodedata.category(right).startswith("M") or right == "\u200d" or left == "\u200d"
            or unicodedata.combining(left) == 9 or 0xE0020 <= ord(right) <= 0xE007F
            or 0x1F3FB <= ord(right) <= 0x1F3FF or (left == "\r" and right == "\n")):
        return False
    if 0x1F1E6 <= ord(left) <= 0x1F1FF and 0x1F1E6 <= ord(right) <= 0x1F1FF:
        run, i = 0, index - 1
        while i >= 0 and 0x1F1E6 <= ord(text[i]) <= 0x1F1FF:
            run, i = run + 1, i - 1
        return run % 2 == 0
    return True


def split_text(body, entities, r):
    if not isinstance(body, str) or not body.strip() or "\x00" in body or units(body) > 12000:
        raise r.TelegramRuntimeError("A text series requires 1..12000 UTF-16 units of complete text.")
    offsets = [0]
    for char in body:
        offsets.append(offsets[-1] + units(char))
    # Validate even entities outside the first part before issuing any preview.
    entity_slice(entities, 0, offsets[-1], r)
    if any(row.offset + row.length > offsets[-1] for row in entities):
        raise r.TelegramRuntimeError("Telegram formatting extends beyond the full text.")
    parts, start = [], 0
    while start < len(body):
        end = start + 1
        while end <= len(body) and offsets[end] - offsets[start] <= 4096:
            end += 1
        end -= 1
        candidates = []
        for i in range(start + 1, end + 1):
            if not grapheme_boundary(body, i):
                continue
            if any(row.offset < offsets[i] < row.offset + row.length and type(row).__name__ not in STYLE for row in entities):
                continue
            candidates.append(i)
        if not candidates:
            raise r.TelegramRuntimeError("A text entity or grapheme cannot fit one Telegram message.")
        end = candidates[-1]
        if end < len(body):
            # Prefer a paragraph, then a line/word, in the latter half of a part.
            # Keep separators in the output: concatenation reconstructs the text.
            latter = [i for i in candidates if offsets[i] - offsets[start] >= 2048]
            for predicate in (lambda i: body[max(start, i - 2):i] == "\n\n",
                              lambda i: body[i - 1] == "\n", lambda i: body[i - 1].isspace()):
                preferred = [i for i in latter if predicate(i)]
                if preferred:
                    end = preferred[-1]
                    break
        parts.append((body[start:end], entity_slice(entities, offsets[start], offsets[end], r)))
        start = end
    if len(parts) > 10:
        raise r.TelegramRuntimeError("The text series exceeds ten parts; shorten it or simplify formatting.")
    if any(not text.strip() for text, _entities in parts):
        raise r.TelegramRuntimeError("A series would contain a whitespace-only part; revise the full text before sending.")
    return parts


def quote_selection(target, quote, offset, r):
    original = getattr(target, "message", None)
    if (not isinstance(original, str) or len(original) > r.MAX_READ_TEXT_CHARS or
            not isinstance(quote, str) or not quote or "\x00" in quote or len(quote.encode("utf-8")) > 1024):
        raise r.TelegramRuntimeError("Choose a complete original quote of at most 1024 UTF-8 bytes.")
    matches = [units(original[:i]) for i in range(len(original)) if original.startswith(quote, i)]
    if offset is None:
        if len(matches) != 1:
            raise r.TelegramRuntimeError("The quote is absent or repeated; select its exact UTF-16 --quote-offset.")
        offset = matches[0]
    if type(offset) is not int or offset < 0 or offset not in matches:
        raise r.TelegramRuntimeError("The quote does not match the original at this UTF-16 offset.")
    # Retain formatting from the original instead of reparsing the excerpt.
    entities = entity_slice(getattr(target, "entities", None) or [], offset, offset + units(quote), r)
    return {"text": quote, "offset": offset}, entities


async def send_native(client, entity, body, entities, reply, sender, args, r, f, t, u, scheduled=None):
    """Use explicit TL InputReplyTo: SDK's int reply helper drops quote fields."""
    request = f.messages.SendMessageRequest(peer=await client.get_input_entity(entity), message=body,
        random_id=secrets.randbits(63), entities=entities, reply_to=reply, send_as=sender,
        silent=args.silent, no_webpage=args.no_link_preview, clear_draft=False, schedule_date=scheduled)
    if scheduled:
        r.assert_schedule_lead_time(scheduled)
    response = await client(request)
    if type(response).__name__ == "UpdateShortSentMessage":
        message_id = response.id
    else:
        updates = getattr(response, "updates", None)
        if not isinstance(updates, list) or len(updates) > 1000:
            raise ValueError("Missing bounded native send response")
        mappings = [row.id for row in updates if type(row).__name__ == "UpdateMessageID" and row.random_id == request.random_id]
        if len(mappings) != 1:
            raise ValueError("Missing unique random-id mapping")
        message_id = mappings[0]
    if type(message_id) is not int or not 0 < message_id < 2**31:
        raise ValueError("Invalid sent message ID")
    after = await r.get_scheduled_target(client, entity, message_id) if scheduled else await client.get_messages(entity, ids=message_id)
    r.exact_provider_message(after, entity, message_id, u)
    if (getattr(after, "out", None) is not True or after.message != body or
            r.provider_content_digest(getattr(after, "entities", None) or []) != r.provider_content_digest(entities)):
        raise ValueError("Sent text/formatting was not confirmed")
    if getattr(after, "media", None) is not None and (args.no_link_preview or type(after.media).__name__ != "MessageMediaWebPage"):
        raise ValueError("Unexpected outgoing media")
    if args.silent and getattr(after, "silent", None) is not True:
        raise ValueError("Silent delivery was not confirmed")
    if sender is not None:
        r.import_interaction_tools().verify_sender(after, entity, {"peerId": u.get_peer_id(sender)}, r, u)
    header = getattr(after, "reply_to", None)
    if reply is not None:
        reply_peer = getattr(header, "reply_to_peer_id", None)
        if reply_peer is not None and u.get_peer_id(reply_peer) != u.get_peer_id(entity):
            raise ValueError("Foreign reply peer")
        if getattr(header, "reply_to_msg_id", None) != reply.reply_to_msg_id:
            raise ValueError("Reply target was not confirmed")
        expected_top = getattr(reply, "top_msg_id", None)
        if expected_top and r.message_thread_id(after) != expected_top:
            raise ValueError("Reply topic was not confirmed")
        quote = getattr(reply, "quote_text", None)
        if quote is not None and (getattr(header, "quote_text", None) != quote or
                getattr(header, "quote_offset", None) != reply.quote_offset or
                r.provider_content_digest(getattr(header, "quote_entities", None) or []) !=
                r.provider_content_digest(getattr(reply, "quote_entities", None) or [])):
            raise ValueError("Quoted text/offset/formatting was not confirmed")
    elif header is not None:
        raise ValueError("Unexpected reply target")
    if scheduled and r.normalize_schedule_datetime(after.date) != scheduled:
        raise ValueError("Scheduled queue date was not confirmed")
    return after


def text_file(args, r):
    if args.message_file:
        path = pathlib.Path(args.message_file).expanduser()
        r.ensure_private_file(path)
        if path.stat().st_size > 60000:
            raise r.TelegramRuntimeError("The source text exceeds 60000 bytes.")
        raw = path.read_text(encoding="utf-8")
    else:
        raw = args.message or ""
    if len(raw.encode("utf-8")) > 60000:
        raise r.TelegramRuntimeError("The source text exceeds 60000 bytes.")
    return raw


async def delivery(client, entity, target, args, identity, me, r, f, t, u, markdown):
    i, c = r.import_interaction_tools(), r.import_community_tools()
    i.validate_approval(args, r)
    if not args.dry_run:
        r.assert_send_allowed(identity, confirmed=True)
    if getattr(args, "file", None):
        raise r.TelegramRuntimeError("Quoted replies and text series accept text only; send attachments separately.")
    if getattr(entity, "send_paid_messages_stars", None):
        raise r.TelegramRuntimeError("Paid Telegram destinations are unsupported.")
    selector = args.send_as if args.send_as is not None else "self"
    sender, selected = await i.select_sender(client, entity, me, selector, r)
    raw = text_file(args, r)
    body, entities = markdown.parse(raw)
    quote, quote_entities, reply, topic_state = None, None, None, None
    scheduled = r.parse_schedule_at(args.schedule_at) if getattr(args, "schedule_at", None) else None
    if target is not None:
        r.import_channel_tools().checked_message(r, u, entity, target, target.id)
        quote, quote_entities = quote_selection(target, args.quote_text, args.quote_offset, r)
        parts = [(body, entities)]
        if not body.strip() or units(body) > 4096:
            raise r.TelegramRuntimeError("A quoted reply requires 1..4096 UTF-16 units of text.")
        top = r.message_thread_id(target)
        reply = t.InputReplyToMessage(reply_to_msg_id=target.id,
             top_msg_id=top if top not in (None, 1, target.id) else None,
             quote_text=quote["text"], quote_offset=quote["offset"], quote_entities=quote_entities)
    else:
        parts = split_text(body, entities, r)
        if getattr(entity, "forum", False):
            if args.topic_id is None:
                raise r.TelegramRuntimeError("A forum text series requires an exact --topic-id, including General=1.")
            topic = await c.topic(client, entity, args.topic_id, r, f)
            if getattr(topic, "closed", False) or getattr(topic, "hidden", False):
                raise r.TelegramRuntimeError("The selected topic is closed or hidden.")
            topic_state = {"id": topic.id, "title": topic.title, "closed": False, "hidden": False}
            if topic.id != 1:
                reply = t.InputReplyToMessage(reply_to_msg_id=topic.id)
        elif args.topic_id is not None:
            raise r.TelegramRuntimeError("--topic-id requires a forum supergroup.")
    operation = {"version": VERSION, "command": args.command, "chatId": u.get_peer_id(entity), "sender": selected,
                 "body": raw, "quote": quote, "quoteEntities": r.provider_content_digest(quote_entities),
                 "source": r.import_channel_tools().content_snapshot(target, r) if target is not None else None,
                 "sourceId": target.id if target is not None else None, "topic": topic_state,
                 "silent": args.silent, "noLinkPreview": args.no_link_preview,
                 "scheduledAt": r.format_utc_datetime(scheduled) if scheduled else None}
    preview = {"chat": r.public_entity(entity), "actingAccount": r.public_entity(me), "sender": selected,
               "quote": quote, "replyToMessageId": operation["sourceId"], "topic": topic_state,
               "source": r.import_channel_tools().public_row(r, target, entity) if target is not None else None,
               "parts": [{"index": n + 1, "text": text, "entities": public_entities(styles)} for n, (text, styles) in enumerate(parts)],
               "silent": args.silent, "noLinkPreview": args.no_link_preview, "scheduledAt": operation["scheduledAt"],
               "atomic": False, "automaticReplay": False}
    c.bounded_result(preview, r, 20000)
    if args.dry_run:
        return {"dryRun": True, "preview": preview, "approvalHash": r.scheduled_approval(identity, me.id, operation),
                "expiresInSeconds": r.MESSAGE_APPROVAL_TTL_SECONDS}
    if scheduled:
        r.assert_schedule_lead_time(scheduled)
    r.scheduled_approval(identity, me.id, operation, args.approval_hash)
    confirmed, attempted = [], 0
    try:
        for n, (text, styles) in enumerate(parts):
            # A series has one selected topic, not a chain of accidental replies
            # to the preceding part. Each native call is individually verified.
            attempted = n + 1
            after = await send_native(client, entity, text, styles, reply, sender, args, r, f, t, u, scheduled)
            if target is not None and r.message_thread_id(target) is not None and r.message_thread_id(after) != r.message_thread_id(target):
                raise ValueError("Quoted reply thread was not confirmed")
            if topic_state and topic_state["id"] != 1 and r.message_thread_id(after) != topic_state["id"]:
                raise ValueError("Series topic was not confirmed")
            if after.id in [row["messageId"] for row in confirmed]:
                raise ValueError("Repeated series message ID")
            confirmed.append({"part": n + 1, "messageId": after.id, "link": r.message_link(entity, after.id)})
        return {"sent": scheduled is None, "scheduled": scheduled is not None, "chat": r.public_entity(entity),
                "confirmedParts": confirmed, "partCount": len(parts), "complete": True, "atomic": False}
    except Exception as error:
        raise r.TelegramRuntimeError("Delivery stopped. Verify the uncertain part before sending any remaining text; do not replay the series.",
            code="TELEGRAM_SERIES_DELIVERY_UNKNOWN" if target is None else "TELEGRAM_ACTION_OUTCOME_UNKNOWN",
            details={"chatId": u.get_peer_id(entity), "confirmedParts": confirmed, "uncertainPart": attempted,
                     "notAttemptedParts": list(range(attempted + 1, len(parts) + 1)), "partCount": len(parts)}) from error


async def settings(client, entity, r, f, t, u):
    peer = await client.get_input_entity(entity)
    response = await client(f.messages.GetPeerDialogsRequest(peers=[t.InputDialogPeer(peer=peer)]))
    rows = [row for row in getattr(response, "dialogs", []) if type(row).__name__ == "Dialog" and
            u.get_peer_id(row.peer) == u.get_peer_id(entity)]
    if len(rows) != 1 or not hasattr(rows[0], "folder_id"):
        raise r.TelegramRuntimeError("Exact own dialog metadata is unavailable; no chat settings were changed.")
    folder = rows[0].folder_id
    folder = 0 if folder is None else folder
    if type(folder) is not int or folder not in (0, 1):
        raise r.TelegramRuntimeError("The native archive folder is unavailable.")
    notify = await client(f.account.GetNotifySettingsRequest(peer=t.InputNotifyPeer(peer=peer)))
    if type(notify).__name__ != "PeerNotifySettings":
        raise r.TelegramRuntimeError("Exact personal notification settings are unavailable.")
    until = getattr(notify, "mute_until", None)
    until = int(until.timestamp()) if isinstance(until, datetime) else until
    if until is not None and (type(until) is not int or not 0 <= until < 2**31):
        raise r.TelegramRuntimeError("Telegram returned an unsupported mute deadline.")
    public = {"archived": folder == 1, "folderId": folder, "pinned": getattr(rows[0], "pinned", False) is True,
              "muteUntil": until, "muteInherited": until is None,
              "muted": until > int(r.utc_now().timestamp()) if until is not None else None}
    return public, notify, peer


async def personal_change(client, entity, args, identity, me, r, f, t, u):
    i = r.import_interaction_tools()
    if args.command != "chat-settings":
        i.validate_approval(args, r)
        if not args.dry_run:
            r.assert_send_allowed(identity, confirmed=True)
    before, native, peer = await settings(client, entity, r, f, t, u)
    if args.command == "chat-settings":
        return {"chat": r.public_entity(entity), "settings": before, "snapshotAtomic": False,
                "readState": {"marksRead": False, "mode": "personal-chat-settings-only"}}
    after = dict(before)
    if args.command in {"archive", "unarchive"}:
        after.update(archived=args.command == "archive", folderId=1 if args.command == "archive" else 0)
    else:
        deadline = r.parse_schedule_at(args.until) if args.command == "mute" else None
        if deadline is not None:
            r.assert_schedule_lead_time(deadline)
        until = int(deadline.timestamp()) if deadline else 0
        if not 0 <= until < 2**31:
            raise r.TelegramRuntimeError("Mute deadline must fit a positive int32 timestamp.")
        after.update(muteUntil=until, muteInherited=False, muted=until > int(r.utc_now().timestamp()))
    # Include all native notification fields in the fingerprint, including each
    # platform's sound. Only the explicit mute_until patch goes to Telegram.
    operation = {"version": VERSION, "command": args.command, "chatId": u.get_peer_id(entity),
                 "before": before, "nativeNotify": r.provider_content_digest(native), "after": after}
    preview = {"chat": r.public_entity(entity), "actingAccount": r.public_entity(me), "before": before, "after": after,
               "personalOnly": True, "marksRead": False, "snapshotAtomic": False,
               "pinMayBeRemoved": before["pinned"] and args.command in {"archive", "unarchive"}}
    if args.dry_run:
        return {"dryRun": True, "preview": preview, "approvalHash": r.scheduled_approval(identity, me.id, operation),
                "expiresInSeconds": r.MESSAGE_APPROVAL_TTL_SECONDS}
    r.scheduled_approval(identity, me.id, operation, args.approval_hash)
    try:
        archive = args.command in {"archive", "unarchive"}
        changed = before["folderId"] != after["folderId"] if archive else before["muteUntil"] != after["muteUntil"]
        if changed:
            if archive:
                await client(f.folders.EditPeerFoldersRequest(folder_peers=[t.InputFolderPeer(peer=peer, folder_id=after["folderId"])]))
            else:
                result = await client(f.account.UpdateNotifySettingsRequest(peer=t.InputNotifyPeer(peer=peer),
                    settings=t.InputPeerNotifySettings(mute_until=datetime.fromtimestamp(after["muteUntil"], timezone.utc))))
                if result is not True:
                    raise ValueError("Native notification mutation was not acknowledged")
        observed, notify, _peer = await settings(client, entity, r, f, t, u)
        if archive:
            if observed["folderId"] != after["folderId"] or r.provider_content_digest(notify) != operation["nativeNotify"]:
                raise ValueError("Archive or unchanged notifications were not confirmed")
        else:
            previous_rest, current_rest = native.to_dict(), notify.to_dict()
            previous_rest.pop("mute_until", None)
            current_rest.pop("mute_until", None)
            if (observed["muteUntil"] != after["muteUntil"] or observed["folderId"] != before["folderId"] or
                    observed["pinned"] != before["pinned"] or r.provider_content_digest(previous_rest) != r.provider_content_digest(current_rest)):
                raise ValueError("Mute patch or preserved settings were not confirmed")
        return {"changed": changed, "chat": r.public_entity(entity), "settings": observed,
                "personalOnly": True, "marksRead": False, "snapshotAtomic": False}
    except Exception as error:
        raise r.TelegramRuntimeError("Personal chat settings were not fully verified. Read chat-settings before any retry.",
                                     code="TELEGRAM_ACTION_OUTCOME_UNKNOWN") from error


async def run(args, identity, r):
    f, t, u, markdown = r.import_interaction_tools().api(r)
    client, failure, result = r.build_client(args, identity), None, None
    writing = args.command in MUTATIONS and not args.dry_run
    try:
        await r.ensure_authorized(client)
        entity, me = await r.resolve_entity(client, args.chat), await client.get_me()
        if args.command == "send-series":
            result = await delivery(client, entity, None, args, identity, me, r, f, t, u, markdown)
        else:
            result = await personal_change(client, entity, args, identity, me, r, f, t, u)
        return r.import_community_tools().bounded_result({"securityBoundary": "chat-only", **result}, r)
    except Exception as error:
        failure = error if isinstance(error, r.TelegramRuntimeError) else r.TelegramRuntimeError("Telegram conversation metadata or content is unavailable.")
        raise failure from error
    finally:
        try:
            await client.disconnect()
        except Exception as error:
            if failure is None:
                raise r.TelegramRuntimeError("Telegram cleanup failed; verify exact state before retrying.",
                      code="TELEGRAM_ACTION_OUTCOME_UNKNOWN" if writing else None,
                      details={"confirmedParts": result["confirmedParts"], "allPartsVerified": True,
                               "cleanupFailed": True} if result and "confirmedParts" in result else None) from error
