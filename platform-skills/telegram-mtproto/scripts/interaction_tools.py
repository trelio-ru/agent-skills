"""Exact chat capabilities, per-call authorship and one own-message deletion.

Importing this signed sibling performs no SDK, account or filesystem IO. The
existing one-use journal binds previews to the actual account and fresh target;
Telegram remains the final ACL authority and offers no atomic content CAS.
"""
import argparse
import copy
import re
from contextlib import contextmanager

VERSION = "2.11.0"
READS = {"chat-info", "send-as"}
MUTATIONS = {"delete"}
COMMANDS = READS | MUTATIONS


def add_parsers(commands, positive_id):
    for name in sorted(COMMANDS):
        p = commands.add_parser(name, help="Read exact Telegram capabilities or delete one own message")
        p.add_argument("--chat", required=True)
        if name == "delete":
            def native_id(value):
                number = positive_id(value)
                if number >= 2**31:
                    raise argparse.ArgumentTypeError("Telegram message ID must fit int32")
                return number
            p.add_argument("--message-id", type=native_id, required=True)
            p.add_argument("--scope", choices=("me", "everyone"), required=True)
            mode = p.add_mutually_exclusive_group(required=True)
            mode.add_argument("--dry-run", action="store_true")
            mode.add_argument("--confirm", action="store_true")
            p.add_argument("--approval-hash")


def sender_parser(parser, *, simple=False):
    parser.add_argument("--send-as", help="self or one exact ID/@username returned by send-as for this destination")
    if simple:
        # Existing ordinary send/reply retain their direct --confirm ABI. An
        # explicit author adds a reviewed operation, not a persistent default.
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument("--approval-hash")


def api(r):
    r.import_telethon_workflows()  # safe bootstrap diagnostic before SDK import
    return r.import_community_tools().api()


async def sender_catalog(client, entity, me, r, f, u):
    if type(me).__name__ != "User" or type(me.id) is not int or me.id <= 0:
        raise r.TelegramRuntimeError("Telegram did not confirm the actual personal account.")
    if type(entity).__name__ in {"User", "Chat"}:
        return [(me, False)]
    if type(entity).__name__ != "Channel":
        raise r.TelegramRuntimeError("This Telegram peer does not support sender selection.")
    response = await client(f.channels.GetSendAsRequest(peer=entity))
    rows = getattr(response, "peers", None)
    if not isinstance(rows, list) or len(rows) > 100:
        raise r.TelegramRuntimeError("Telegram sender catalog is unavailable or exceeds its bound.")
    users, chats = getattr(response, "users", None), getattr(response, "chats", None)
    if not isinstance(users, list) or not isinstance(chats, list) or len(users) + len(chats) > 200:
        raise r.TelegramRuntimeError("Telegram sender dictionaries are unavailable or exceed their bound.")
    entities = [me] + users + chats
    result, seen = [], set()
    for row in rows:
        if type(row).__name__ != "SendAsPeer" or type(getattr(row, "peer", None)).__name__ not in {"PeerUser", "PeerChannel"}:
            raise r.TelegramRuntimeError("Telegram returned an unsupported sender identity.")
        key = u.get_peer_id(row.peer)
        matches = [value for value in entities if type(value).__name__ in {"User", "Channel"} and u.get_peer_id(value) == key]
        # Resolve only from this response, never by a similar name or by an
        # unrelated cached channel. Duplicate dictionary entries may be the
        # same self user; the native identity still has to be unambiguous.
        if key in seen or not matches or (type(row.peer).__name__ == "PeerUser" and key != me.id):
            raise r.TelegramRuntimeError("Telegram sender catalog has missing, duplicate or foreign identities.")
        seen.add(key)
        result.append((matches[-1], getattr(row, "premium_required", False) is True))
    return result


def sender_row(entity, premium, me, r, u):
    return {**r.public_entity(entity), "peerId": u.get_peer_id(entity),
            "premiumRequired": premium, "available": not premium or getattr(me, "premium", False) is True}


async def select_sender(client, entity, me, selector, r):
    f, _t, u, _md = api(r)
    rows = await sender_catalog(client, entity, me, r, f, u)
    if not isinstance(selector, str) or not selector or len(selector) > 128:
        raise r.TelegramRuntimeError("Choose self or an exact sender from send-as.")
    def matches(value):
        if selector == "self":
            return type(value).__name__ == "User" and value.id == me.id
        if re.fullmatch(r"-?[1-9][0-9]*", selector):
            return str(u.get_peer_id(value)) == selector
        username = getattr(value, "username", None)
        return isinstance(username, str) and bool(username) and selector.startswith("@") and selector[1:].casefold() == username.casefold()
    selected = [(value, premium) for value, premium in rows if matches(value)]
    if len(selected) != 1:
        raise r.TelegramRuntimeError("The exact sender is not available for this destination; read send-as again.")
    value, premium = selected[0]
    public = sender_row(value, premium, me, r, u)
    if not public["available"]:
        raise r.TelegramRuntimeError("This Telegram sender requires Premium on the actual account.")
    native = await client.get_input_entity(value)
    if u.get_peer_id(native) != public["peerId"]:
        raise r.TelegramRuntimeError("Telegram input sender identity changed.")
    return native, public


def verify_sender(message, entity, selected, r, u):
    raw = getattr(message, "from_id", None)
    actual = u.get_peer_id(raw) if raw is not None else None
    # Native broadcast posts can omit from_id when the channel itself is the
    # displayed author. Do not generalize this to anonymous groups or users.
    if raw is None and getattr(entity, "broadcast", False) is True and getattr(message, "post", False) is True:
        actual = u.get_peer_id(entity)
    if actual != selected["peerId"]:
        raise r.TelegramRuntimeError("Telegram did not confirm the selected sender; do not retry automatically.")


async def chat_info(client, entity, r, f, u):
    kind = type(entity).__name__
    full = None
    if kind in {"Channel", "Chat"}:
        response = await client(f.channels.GetFullChannelRequest(channel=entity) if kind == "Channel"
                                else f.messages.GetFullChatRequest(chat_id=entity.id))
        full = getattr(response, "full_chat", None)
        if type(full).__name__ != ("ChannelFull" if kind == "Channel" else "ChatFull") or full.id != entity.id:
            raise r.TelegramRuntimeError("Telegram did not return the exact chat metadata.")
        # Rights must come from the same fresh response, not an old session
        # cache. Auxiliary users/participants/invites are never serialized.
        matches = [row for row in getattr(response, "chats", []) if type(row).__name__ == kind and row.id == entity.id]
        if len(matches) != 1:
            raise r.TelegramRuntimeError("Fresh Telegram rights are unavailable for this exact chat.")
        entity = matches[0]
    elif kind != "User":
        raise r.TelegramRuntimeError("Unsupported Telegram chat type.")
    about, clipped = r.bounded_string(getattr(full, "about", None), 4096)
    rights = getattr(entity, "admin_rights", None)
    def flags(value, names):
        return {key: getattr(value, key, False) is True for key in names}
    reactions = getattr(full, "available_reactions", None)
    reaction_kind = type(reactions).__name__
    allowed = []
    if reaction_kind == "ChatReactionsSome":
        raw = getattr(reactions, "reactions", None)
        if not isinstance(raw, list) or len(raw) > 64:
            raise r.TelegramRuntimeError("Allowed Telegram reactions exceed their supported bound.")
        for row in raw:
            if type(row).__name__ == "ReactionEmoji" and isinstance(row.emoticon, str) and len(row.emoticon) <= 32:
                allowed.append({"type": "emoji", "emoji": row.emoticon})
            elif type(row).__name__ == "ReactionCustomEmoji" and type(row.document_id) is int:
                allowed.append({"type": "custom_emoji", "documentId": str(row.document_id)})
            else:
                raise r.TelegramRuntimeError("Allowed Telegram reaction metadata is unsupported.")
    c = r.import_community_tools()
    linked = getattr(full, "linked_chat_id", None)
    default = getattr(full, "default_send_as", None)
    return {"chat": r.public_entity(entity), "chatType": "channel" if getattr(entity, "broadcast", False) else "group" if kind in {"Channel", "Chat"} else "user", "about": about,
            "aboutAvailable": full is not None and isinstance(getattr(full, "about", None), str),
            "aboutTruncated": clipped, "audienceCount": c.count(getattr(full if kind == "Channel" else entity, "participants_count", None)),
            "creator": getattr(entity, "creator", False) is True,
            "adminRights": flags(rights, ("post_messages", "edit_messages", "delete_messages", "ban_users", "invite_users", "pin_messages", "manage_topics", "anonymous")),
            "restrictions": {label: {**flags(getattr(entity, field, None), ("send_messages", "send_plain", "send_media", "send_photos", "send_videos", "send_docs", "send_polls")),
                                       "until": c.stamp(getattr(getattr(entity, field, None), "until_date", None))}
                             for label, field in (("personal", "banned_rights"), ("default", "default_banned_rights"))},
            "left": getattr(entity, "left", False) is True, "forum": getattr(entity, "forum", False) is True,
            "protectedContent": getattr(entity, "noforwards", False) is True,
            "linkedChatPeerId": -1000000000000 - linked if type(linked) is int and linked > 0 else None,
            "linkedChatContentRead": False,
            "linkedChatRelation": "discussion" if getattr(entity, "broadcast", False) else "channel" if type(linked) is int and linked > 0 else None,
            "slowmodeSeconds": c.count(getattr(full, "slowmode_seconds", None)),
            "nextSendAt": c.stamp(getattr(full, "slowmode_next_send_date", None)),
            "defaultSendAsPeerId": u.get_peer_id(default) if type(default).__name__ in {"PeerUser", "PeerChannel"} else None,
            "allowedReactions": {"mode": {"ChatReactionsAll": "all", "ChatReactionsNone": "none", "ChatReactionsSome": "selected"}.get(reaction_kind, "unknown"), "reactions": allowed},
            "serverChecksRequired": True, "snapshotAtomic": False,
            "readState": {"marksRead": False, "mode": "chat-metadata-only"}}


def validate_approval(args, r):
    if (args.dry_run and (args.confirm or args.approval_hash)) or (not args.dry_run and
            (not args.confirm or not re.fullmatch(r"[0-9a-f]{64}", args.approval_hash or ""))):
        raise r.TelegramRuntimeError("Prepare --dry-run, then the unchanged --confirm --approval-hash operation.")


async def delete_message(client, entity, args, identity, me, r, f, u):
    validate_approval(args, r)
    if not args.dry_run:
        r.assert_send_allowed(identity, confirmed=True)
    c = r.import_channel_tools()
    message = await r.import_community_tools().exact(client, entity, args.message_id, r, u)
    sender = getattr(message, "from_id", None)
    # out alone is not an authorship proof for anonymous/channel identities.
    # Never turn administrator deletion permission into permission to remove
    # somebody else's post. A personally attributed outgoing message is needed.
    if (getattr(message, "out", None) is not True or type(sender).__name__ != "PeerUser" or sender.user_id != me.id
            or getattr(message, "action", None) is not None):
        raise r.TelegramRuntimeError("Deletion requires one own, personally attributed outgoing history message.")
    if type(entity).__name__ == "Channel" and args.scope != "everyone":
        raise r.TelegramRuntimeError("Channels and supergroups support only --scope everyone.")
    if type(entity).__name__ not in {"Channel", "Chat", "User"}:
        raise r.TelegramRuntimeError("This Telegram chat type cannot be deleted from.")
    public = c.public_row(r, message, entity)
    operation = {"version": VERSION, "command": "delete", "chatId": u.get_peer_id(entity), "messageId": message.id,
                 "scope": args.scope, "content": c.content_snapshot(message, r),
                 "authorId": me.id, "editDate": r.provider_content_digest(getattr(message, "edit_date", None))}
    preview = {"chat": r.public_entity(entity), "actingAccount": r.public_entity(me), "message": public,
               "scope": args.scope, "irreversible": True, "albumExpanded": False, "snapshotAtomic": False}
    r.import_community_tools().bounded_result(preview, r, 20000)
    if args.dry_run:
        return {"dryRun": True, "preview": preview, "approvalHash": r.scheduled_approval(identity, me.id, operation),
                "expiresInSeconds": r.MESSAGE_APPROVAL_TTL_SECONDS}
    r.scheduled_approval(identity, me.id, operation, args.approval_hash)
    try:
        # Use exactly one native ID. SDK convenience deletion accepts IDs from
        # other private chats; it must not resolve or widen this reviewed scope.
        request = f.channels.DeleteMessagesRequest(channel=entity, id=[message.id]) if type(entity).__name__ == "Channel" else \
                  f.messages.DeleteMessagesRequest(id=[message.id], revoke=args.scope == "everyone")
        affected = await client(request)
        if type(affected).__name__ != "AffectedMessages" or type(getattr(affected, "pts_count", None)) is not int or affected.pts_count <= 0:
            raise ValueError("Missing native affected-state proof")
        after = await client.get_messages(entity, ids=message.id)
        if after is not None and not (type(after).__name__ == "MessageEmpty" and after.id == message.id):
            raise ValueError("Exact message absence not confirmed")
        return {"deleted": True, "chat": r.public_entity(entity), "messageId": message.id, "scope": args.scope,
                "verification": "native_affected_state_and_exact_absence", "snapshotAtomic": False}
    except Exception as error:
        raise r.TelegramRuntimeError("Telegram deletion is not fully verified. Read exact live state before any retry.",
                                     code="TELEGRAM_ACTION_OUTCOME_UNKNOWN") from error


@contextmanager
def request_fence(client, scheduled, r):
    """Check single-message schedule after SDK upload, at the final RPC."""
    if scheduled is None:
        yield
        return
    original = getattr(client, "_call", None)
    if not callable(original):
        raise r.TelegramRuntimeError("The SDK cannot enforce the final schedule; run bootstrap.")
    async def guarded(sender, request, *args, **kwargs):
        for row in request if isinstance(request, (list, tuple)) else [request]:
            if type(row).__name__ in {"SendMessageRequest", "SendMediaRequest"}:
                r.assert_schedule_lead_time(scheduled)
        return await original(sender, request, *args, **kwargs)
    client._call = guarded
    try:
        yield
    finally:
        client._call = original


async def explicit_send(client, entity, target, args, identity, me, r, u, markdown):
    validate_approval(args, r)
    if not args.dry_run:
        r.assert_send_allowed(identity, confirmed=True)
    authoring, c = r.import_authoring_tools(), r.import_channel_tools()
    sender, selected = await select_sender(client, entity, me, args.send_as, r)
    if getattr(entity, "send_paid_messages_stars", None):
        raise r.TelegramRuntimeError("Paid Telegram destinations are unsupported.")
    raw = r.outgoing_text(args)
    body, entities = markdown.parse(raw)
    if len(body) > (1024 if args.file else 4096):
        raise r.TelegramRuntimeError("Telegram message/caption exceeds its supported bound.")
    scheduled = r.parse_schedule_at(args.schedule_at) if args.schedule_at else None
    options = authoring.delivery_options(args)
    frozen = None
    try:
        file_row = None
        if args.file:
            file_args = copy.copy(args)
            file_args.as_file = False
            frozen, file_row = authoring.freeze_file(file_args, r)
        operation = {"version": VERSION, "command": args.command, "chatId": u.get_peer_id(entity),
                     "sender": selected, "body": raw, "file": file_row, "delivery": options,
                     "scheduledAt": r.format_utc_datetime(scheduled) if scheduled else None,
                     "reply": c.content_snapshot(target, r) if target is not None else None,
                     "replyId": target.id if target is not None else None}
        preview = {"chat": r.public_entity(entity), "actingAccount": r.public_entity(me), "sender": selected,
                   "text": body, "file": file_row, "deliveryOptions": options, "scheduledAt": operation["scheduledAt"],
                   "replyToMessageId": operation["replyId"], "parseMode": r.TELEGRAM_TEXT_PARSE_MODE_NAME}
        r.import_community_tools().bounded_result(preview, r, 20000)
        if args.dry_run:
            return {"dryRun": True, "preview": preview, "approvalHash": r.scheduled_approval(identity, me.id, operation),
                    "expiresInSeconds": r.MESSAGE_APPROVAL_TTL_SECONDS}
        if scheduled:
            r.assert_schedule_lead_time(scheduled)
        r.scheduled_approval(identity, me.id, operation, args.approval_hash)
        try:
            with request_fence(client, scheduled, r):
                sent = await client.send_message(entity, raw or None, file=frozen, send_as=sender,
                    reply_to=target.id if target is not None else None, schedule=scheduled,
                    force_document=file_row is not None and file_row["mediaType"] == "document",
                    parse_mode=r.TELEGRAM_TEXT_PARSE_MODE, clear_draft=False, **options)
            r.exact_provider_message(sent, entity, sent.id, u)
            after = await r.get_scheduled_target(client, entity, sent.id) if scheduled else await client.get_messages(entity, ids=sent.id)
            r.exact_provider_message(after, entity, sent.id, u)
            verify_sender(after, entity, selected, r, u)
            authoring.verify_delivery(after, args, r)
            if (getattr(after, "out", None) is not True or after.message != body or
                    r.provider_content_digest(getattr(after, "entities", None) or []) != r.provider_content_digest(entities)):
                raise ValueError("Outgoing content not confirmed")
            if file_row and r.message_media_type(after) != file_row["mediaType"]:
                raise ValueError("Attachment type not confirmed")
            if file_row and authoring.media_identity(after, r) != authoring.media_identity(sent, r):
                raise ValueError("Native attachment identity changed during read-back")
            if target is not None and (getattr(after, "reply_to_msg_id", None) != target.id or
                    (r.message_thread_id(target) is not None and r.message_thread_id(after) != r.message_thread_id(target))):
                raise ValueError("Reply/thread not confirmed")
            if scheduled and r.normalize_schedule_datetime(after.date) != scheduled:
                raise ValueError("Queue delivery time not confirmed")
            return r.import_community_tools().bounded_result({"sent": scheduled is None, "scheduled": scheduled is not None, "scheduledAt": operation["scheduledAt"],
                    "sender": selected, "chat": r.public_entity(entity), "messageId": after.id,
                    "replyToMessageId": target.id if target is not None else None, "message": c.public_row(r, after, entity)}, r)
        except Exception as error:
            raise r.TelegramRuntimeError("Telegram selected-author delivery is not fully verified. Read exact chat/queue before any retry.",
                                         code="TELEGRAM_ACTION_OUTCOME_UNKNOWN") from error
    finally:
        if frozen is not None:
            frozen.close()


async def run(args, identity, r):
    f, _t, u, markdown = api(r)
    client, failure = r.build_client(args, identity), None
    writing = args.command == "delete" and not args.dry_run
    try:
        await r.ensure_authorized(client)
        entity = await r.resolve_entity(client, args.chat)
        me = await client.get_me()
        if args.command == "chat-info":
            result = await chat_info(client, entity, r, f, u)
        elif args.command == "send-as":
            rows = await sender_catalog(client, entity, me, r, f, u)
            result = {"chat": r.public_entity(entity), "senders": [sender_row(value, premium, me, r, u) for value, premium in rows],
                      "readState": {"marksRead": False, "mode": "sender-metadata-only"}, "snapshotAtomic": False}
        else:
            result = await delete_message(client, entity, args, identity, me, r, f, u)
        return r.import_community_tools().bounded_result({"securityBoundary": "chat-only", **result}, r)
    except Exception as error:
        failure = error if isinstance(error, r.TelegramRuntimeError) else r.TelegramRuntimeError("Telegram exact interaction is unavailable; no verified result was returned.")
        raise failure from error
    finally:
        try:
            await client.disconnect()
        except Exception as error:
            if failure is None:
                raise r.TelegramRuntimeError("Telegram cleanup failed; verify exact state before retrying.",
                       code="TELEGRAM_ACTION_OUTCOME_UNKNOWN" if writing else None) from error
