"""Cloud drafts and exact authoring/admin changes, without import-time IO.

All changes use the existing account-bound one-use journal. Drafts are cloud
mutations too: saving is never confused with local text preparation or sending.
Telegram has no draft CAS; a fresh preflight and post-read detect observed races,
but cannot promise an atomic snapshot across other logged-in devices.
"""
import argparse
import hashlib
import io
import re
from pathlib import Path

VERSION = "2.10.0"
READS = {"draft"}
MUTATIONS = {"draft-save", "draft-clear", "invite-edit", "invite-revoke",
             "topic-create", "topic-rename", "topic-close", "topic-reopen", "edit-media"}
COMMANDS = READS | MUTATIONS
MAX_FILE_BYTES = 20 * 1024 * 1024


def add_parsers(commands, positive_id):
    def native_id(value):
        number = positive_id(value)
        if number >= 2**31:
            raise argparse.ArgumentTypeError("Telegram message/topic ID must fit int32")
        return number

    for name in sorted(COMMANDS):
        p = commands.add_parser(name, help="Exact Telegram " + name + " workflow")
        p.add_argument("--chat", required=True)
        if name.startswith("draft"):
            p.add_argument("--topic-id", type=native_id)
        if name == "draft-save":
            body = p.add_mutually_exclusive_group(required=True)
            body.add_argument("--message")
            body.add_argument("--message-file")
            p.add_argument("--reply-to", type=native_id)
            p.add_argument("--no-link-preview", action="store_true")
        if name in {"topic-create", "topic-rename"}:
            p.add_argument("--title", required=True)
        if name in {"topic-rename", "topic-close", "topic-reopen"}:
            p.add_argument("--topic-id", type=native_id, required=True)
        if name.startswith("invite-"):
            p.add_argument("--invite-link", required=True)
        if name == "invite-edit":
            p.add_argument("--title")
            p.add_argument("--expires-at")
            p.add_argument("--usage-limit", type=int, choices=range(1, 100001))
            p.add_argument("--request-needed", choices=("on", "off"))
        if name == "edit-media":
            p.add_argument("--message-id", type=native_id, required=True)
            p.add_argument("--file", required=True)
            p.add_argument("--as-file", action="store_true")
        if name in MUTATIONS:
            mode = p.add_mutually_exclusive_group(required=True)
            mode.add_argument("--dry-run", action="store_true")
            mode.add_argument("--confirm", action="store_true")
            p.add_argument("--approval-hash")


def delivery_parsers(parser, *, preview=True):
    parser.add_argument("--silent", action="store_true", help="Send without notification sound")
    if preview:
        parser.add_argument("--no-link-preview", action="store_true", help="Disable webpage preview")


def delivery_options(args):
    # Absence preserves SDK/server defaults, including existing muted chats.
    result = {}
    if getattr(args, "silent", False):
        result["silent"] = True
    if getattr(args, "no_link_preview", False):
        result["link_preview"] = False
    return result


def verify_delivery(message, args, r):
    # A missing webpage alone never proves that preview was requested. This
    # check verifies a requested suppression; enabling preview cannot force
    # Telegram to generate a card for an unsupported URL.
    if getattr(args, "silent", False) and getattr(message, "silent", None) is not True:
        raise r.TelegramRuntimeError("Telegram did not confirm silent delivery; do not retry automatically.")
    if getattr(args, "no_link_preview", False) and type(getattr(message, "media", None)).__name__ == "MessageMediaWebPage":
        raise r.TelegramRuntimeError("Telegram did not confirm disabled link preview; do not retry automatically.")


async def delivery_readback(client, entity, message, args, r):
    if not delivery_options(args):
        return message
    # UpdateShortSentMessage lacks silent metadata. Read the exact history or
    # queue entry rather than rejecting/claiming success from that short reply.
    # Queue IDs must never be looked up in ordinary history with the same ID.
    if getattr(args, "schedule_at", None):
        after = await r.get_scheduled_target(client, entity, message.id)
    else:
        after = await client.get_messages(entity, ids=message.id)
    _f, _t, u, _events, _md = r.import_telethon_workflows()
    r.exact_provider_message(after, entity, message.id, u)
    if not getattr(after, "out", False) or getattr(after, "message", None) != getattr(message, "message", None):
        raise r.TelegramRuntimeError("Telegram delivery read-back changed; do not retry automatically.")
    verify_delivery(after, args, r)
    return after


async def draft_snapshot(client, entity, args, r, c, f, t, u):
    topic_id = args.topic_id
    if getattr(entity, "forum", False):
        if topic_id is None:
            raise r.TelegramRuntimeError("A forum draft requires an exact --topic-id, including General=1.")
        row = await c.topic(client, entity, topic_id, r, f)
        native = getattr(row, "draft", None)
    else:
        if topic_id is not None:
            raise r.TelegramRuntimeError("--topic-id requires a forum supergroup.")
        response = await client(f.messages.GetPeerDialogsRequest(peers=[t.InputDialogPeer(peer=await client.get_input_entity(entity))]))
        rows = getattr(response, "dialogs", [])
        if (len(rows) != 1 or type(rows[0]).__name__ != "Dialog"
                or u.get_peer_id(rows[0].peer) != u.get_peer_id(entity)):
            raise r.TelegramRuntimeError("Telegram did not return the exact dialog draft.")
        native = getattr(rows[0], "draft", None)
    if native is None or type(native).__name__ == "DraftMessageEmpty":
        return {"empty": True, "text": "", "replyToMessageId": None, "linkPreview": True,
                "formattingDigest": r.provider_content_digest([])}, r.provider_content_digest(native)
    if type(native).__name__ != "DraftMessage":
        raise r.TelegramRuntimeError("Unsupported Telegram draft constructor.")
    body = getattr(native, "message", None)
    if not isinstance(body, str) or len(body) > 4096:
        raise r.TelegramRuntimeError("The draft cannot be reviewed completely.")
    # Do not overwrite a media/effect/rich/quoted draft with a plain text draft.
    # The entire native snapshot is fingerprinted, but never serialized.
    if any(getattr(native, key, None) is not None for key in ("media", "effect", "suggested_post", "rich_message")):
        raise r.TelegramRuntimeError("This media/effect/rich draft is unsupported; preserve it in Telegram.")
    reply = getattr(native, "reply_to", None)
    if reply is not None:
        if (type(reply).__name__ != "InputReplyToMessage" or any(getattr(reply, key, None) is not None for key in
                ("reply_to_peer_id", "quote_text", "quote_entities", "quote_offset", "monoforum_peer_id", "todo_item_id", "poll_option"))):
            raise r.TelegramRuntimeError("This draft has an unsupported reply target; preserve it in Telegram.")
        if getattr(reply, "top_msg_id", None) not in (None, topic_id):
            raise r.TelegramRuntimeError("The draft belongs to another forum topic.")
    entities = getattr(native, "entities", None) or []
    links, truncated = r.public_link_entities(body, entities)
    if truncated:
        raise r.TelegramRuntimeError("The draft links cannot be reviewed completely.")
    return {"empty": not body and (reply is None or getattr(reply, "reply_to_msg_id", None) == topic_id), "text": body,
            "replyToMessageId": getattr(reply, "reply_to_msg_id", None),
            "linkPreview": not bool(getattr(native, "no_webpage", False)),
            "formattingDigest": r.provider_content_digest(entities),
            "linkEntities": links, "previewAbove": bool(getattr(native, "invert_media", False))}, r.provider_content_digest(native)


async def invite_snapshot(client, entity, link, me, r, c, f):
    await c.admin(entity, r)
    if not isinstance(link, str) or not re.fullmatch(r"https://t\.me/(?:\+|joinchat/)[A-Za-z0-9_-]{1,256}", link):
        raise r.TelegramRuntimeError("Select an exact native invite link from invites.")
    response = await client(f.messages.GetExportedChatInviteRequest(peer=entity, link=link))
    native = response.invite
    row = c.invite_row(native, r)
    if row["link"] != link or getattr(native, "admin_id", None) != me.id:
        raise r.TelegramRuntimeError("Only this account's exact admin invite link can be changed.")
    # Revoking a permanent link may generate a replacement. Keep that separate
    # lifecycle outside this command, and never turn a revoke into link rotation.
    if getattr(native, "permanent", False) or getattr(native, "subscription_pricing", None) is not None:
        raise r.TelegramRuntimeError("Permanent and paid invite links are unsupported by this command.")
    return native, row


async def topic_admin(entity, r, c, client):
    await c.forum(client, entity, r)
    if not (getattr(entity, "creator", False) or getattr(getattr(entity, "admin_rights", None), "manage_topics", False)):
        raise r.TelegramRuntimeError("Current Telegram manage_topics administrator rights are required.")


def topic_state(row, r, c):
    # Traffic, unread counters and top_message may change legitimately between
    # preview/apply. Topic identity and all managed properties must not.
    return {**{key: value for key, value in c.topic_row(row, r).items() if key != "topMessageId"},
            "iconColor": getattr(row, "icon_color", None), "iconEmojiId": str(getattr(row, "icon_emoji_id", None))}


def freeze_file(args, r):
    path = Path(args.file).expanduser()
    if "://" in args.file or path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
        raise r.TelegramRuntimeError("Select one regular local file up to 20 MiB, without URL or symlink.")
    with path.open("rb") as source:
        data = source.read(MAX_FILE_BYTES + 1)
    if not data or len(data) > MAX_FILE_BYTES or len(path.name) > r.MAX_FILE_NAME_CHARS:
        raise r.TelegramRuntimeError("The selected file is empty, oversized or its name exceeds the bound.")
    photo = ((path.suffix.lower() in {".jpg", ".jpeg"} and data.startswith(b"\xff\xd8\xff"))
             or (path.suffix.lower() == ".png" and data.startswith(b"\x89PNG\r\n\x1a\n")))
    video = path.suffix.lower() == ".mp4" and len(data) >= 12 and data[4:8] == b"ftyp"
    mode = "photo" if photo and not args.as_file else "video" if video and not args.as_file else "document"
    buffer = io.BytesIO(data)
    buffer.name = path.name
    return buffer, {"fileName": path.name, "sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "mediaType": mode}


def media_identity(message, r):
    media = getattr(message, "media", None)
    kind = type(media).__name__
    value = getattr(media, "photo", None) if kind == "MessageMediaPhoto" else getattr(media, "document", None) if kind == "MessageMediaDocument" else None
    if value is None or type(getattr(value, "id", None)) is not int:
        raise r.TelegramRuntimeError("The selected message has no supported photo/document attachment.")
    if any(getattr(media, key, None) for key in ("ttl_seconds", "spoiler", "live_photo", "round", "voice", "video_cover", "video_timestamp", "alt_documents")):
        raise r.TelegramRuntimeError("This attachment has unsupported properties; preserve it in Telegram.")
    return kind, value.id


async def prepare(client, entity, args, me, r, c, f, t, u, markdown):
    command = args.command
    operation = {"version": VERSION, "command": command, "chatId": u.get_peer_id(entity)}
    preview = {"command": command, "chat": r.public_entity(entity), "actingAccount": r.public_entity(me)}
    state = {"operation": operation, "preview": preview, "file": None}
    if command.startswith("draft-"):
        before, digest = await draft_snapshot(client, entity, args, r, c, f, t, u)
        body, entities = markdown.parse(r.edit_text(args)) if command == "draft-save" else ("", [])
        if len(body) > 4096 or (command == "draft-save" and not body.strip()):
            raise r.TelegramRuntimeError("Draft text exceeds 4096 characters.")
        reply_id = getattr(args, "reply_to", None)
        if reply_id is not None:
            message = await c.exact(client, entity, reply_id, r, u)
            if args.topic_id is not None and not c.in_topic(message, args.topic_id):
                raise r.TelegramRuntimeError("The reply target belongs to another topic.")
            operation["replyContent"] = r.import_channel_tools().content_snapshot(message, r)
        # Topic drafts need a routing root even when no specific reply is chosen.
        # Clearing uses the same root, otherwise Telegram would clear another draft.
        reply = t.InputReplyToMessage(reply_to_msg_id=reply_id or args.topic_id, top_msg_id=args.topic_id) if reply_id or args.topic_id else None
        expected = {"empty": not body and reply is None, "text": body,
                    "replyToMessageId": reply_id or args.topic_id,
                    "linkPreview": not getattr(args, "no_link_preview", False),
                    "formattingDigest": r.provider_content_digest(entities), "previewAbove": False}
        links, truncated = r.public_link_entities(body, entities)
        if truncated:
            raise r.TelegramRuntimeError("The new draft links cannot be reviewed completely.")
        expected["linkEntities"] = links
        # An empty body with a topic routing root clears that topic. The server
        # may materialize DraftMessageEmpty or omit it altogether afterwards.
        if command == "draft-clear":
            expected = None
        operation.update(before=digest, topicId=args.topic_id, expected=expected)
        preview.update(previousDraft=before, newDraft=expected, topicId=args.topic_id, sendsMessage=False, snapshotAtomic=False)
        state.update(request=f.messages.SaveDraftRequest(peer=entity, message=body, entities=entities, reply_to=reply,
                     no_webpage=getattr(args, "no_link_preview", False)), expected=expected)
    elif command.startswith("invite-"):
        native, before = await invite_snapshot(client, entity, args.invite_link, me, r, c, f)
        if before["revoked"]:
            raise r.TelegramRuntimeError("This invite link is already revoked.")
        # Usage is volatile; a new join must not invalidate a title-only review.
        managed = {key: value for key, value in before.items() if key != "usage"}
        expected, fields = dict(managed), {}
        if command == "invite-revoke":
            expected["revoked"], fields["revoked"] = True, True
        else:
            if args.title is not None:
                fields["title"] = expected["title"] = c.text(args.title, 32, r)
            if args.expires_at is not None:
                expiry = r.parse_schedule_at(args.expires_at)
                if c.stamp(expiry) is None:
                    raise r.TelegramRuntimeError("Invite expiry must fit positive int32.")
                fields["expire_date"], expected["expiresAt"] = expiry, c.stamp(expiry)
            if args.usage_limit is not None:
                fields["usage_limit"] = expected["usageLimit"] = args.usage_limit
            if args.request_needed is not None:
                fields["request_needed"] = expected["requestNeeded"] = args.request_needed == "on"
            if not fields or (expected["requestNeeded"] and expected["usageLimit"] is not None):
                raise r.TelegramRuntimeError("Select changes; request-needed cannot coexist with a usage limit.")
        operation.update(previous=managed, expected=expected)
        preview.update(previousInvite=before, newInvite=expected)
        state.update(request=f.messages.EditExportedChatInviteRequest(peer=entity, link=args.invite_link, **fields), expected=expected)
    elif command.startswith("topic-"):
        await topic_admin(entity, r, c, client)
        if command == "topic-create":
            title = c.text(args.title, 128, r)
            if len(title.encode("utf-8")) > 128:
                raise r.TelegramRuntimeError("Topic title exceeds 128 UTF-8 bytes.")
            operation["title"] = preview["title"] = title
            state["request"] = f.messages.CreateForumTopicRequest(peer=entity, title=title, send_as=t.InputPeerSelf())
        else:
            selected = await c.topic(client, entity, args.topic_id, r, f)
            before = topic_state(selected, r, c)
            expected = dict(before)
            fields = {}
            if command == "topic-rename":
                title = c.text(args.title, 128, r)
                if len(title.encode("utf-8")) > 128:
                    raise r.TelegramRuntimeError("Topic title exceeds 128 UTF-8 bytes.")
                fields["title"] = expected["title"] = title
            else:
                fields["closed"] = expected["closed"] = command == "topic-close"
            if expected == before:
                raise r.TelegramRuntimeError("The topic already has the requested state.")
            operation.update(previous=before, expected=expected)
            preview.update(previousTopic=before, newTopic=expected)
            state.update(request=f.messages.EditForumTopicRequest(peer=entity, topic_id=args.topic_id, **fields), expected=expected)
    else:
        message = await c.exact(client, entity, args.message_id, r, u)
        if not getattr(message, "out", False) or getattr(message, "action", None) or getattr(message, "reply_markup", None):
            raise r.TelegramRuntimeError("Only an own outgoing media message without buttons can be changed.")
        old_kind, old_id = media_identity(message, r)
        before = r.import_channel_tools().content_snapshot(message, r)
        public_before = r.import_channel_tools().public_row(r, message, entity)
        # All fallible projection work precedes allocation of the upload buffer.
        c.bounded_result(public_before, r, 19000)
        buffer, file_row = freeze_file(args, r)
        state["file"] = buffer
        # Albums support photo/video interchange, but not arbitrary document
        # replacement. Preserve that boundary before an upload is attempted.
        if getattr(message, "grouped_id", None) is not None:
            old_type = r.message_media_type(message)
            if (old_type in {"photo", "video"} and file_row["mediaType"] not in {"photo", "video"}) or (old_type not in {"photo", "video"}):
                buffer.close()
                raise r.TelegramRuntimeError("Only photo/video replacement is supported within an album.")
        operation.update(messageId=message.id, before=before, file=file_row)
        preview.update(previousMessage=public_before, newFile=file_row, preservesCaption=True)
        state.update(message=message, oldMedia=(old_kind, old_id), fileRow=file_row)
    return state


async def execute(client, entity, args, me, state, r, c, f, t, u):
    command = args.command
    if command == "edit-media":
        message, buffer = state["message"], state["file"]
        # Upload is intentionally after approval consumption. Pass frozen bytes,
        # then re-read the original after the potentially slow upload. This
        # prevents overwriting an edit made while uploading on another device.
        attributes, _mime = u.get_attributes(buffer, force_document=state["fileRow"]["mediaType"] == "document")
        buffer.seek(0)
        uploaded = await client.upload_file(buffer, file_name=buffer.name)
        fresh = await c.exact(client, entity, message.id, r, u)
        if r.import_channel_tools().content_snapshot(fresh, r) != state["operation"]["before"]:
            raise r.TelegramRuntimeError("The media message changed during upload; do not dispatch the edit.")
        returned = await client.edit_message(entity, message.id, text=message.message or "", formatting_entities=message.entities or [],
                    parse_mode=None, file=uploaded, attributes=attributes, force_document=state["fileRow"]["mediaType"] == "document")
        returned = r.exact_provider_message(returned, entity, message.id, u)
        after = await c.exact(client, entity, message.id, r, u)
        media = media_identity(after, r)
        if media != media_identity(returned, r) or media == state["oldMedia"]:
            raise ValueError("Native replacement identity was not confirmed")
        if not after.out or r.message_media_type(after) != state["fileRow"]["mediaType"]:
            raise ValueError("Wrong media type")
        for key in ("message", "entities", "reply_to", "grouped_id", "reply_markup"):
            if r.provider_content_digest(getattr(after, key, None)) != r.provider_content_digest(getattr(message, key, None)):
                raise ValueError("Unrequested message change")
        return {"applied": True, "message": r.import_channel_tools().public_row(r, after, entity), "file": state["fileRow"],
                "verification": "native_replacement_identity_and_preserved_caption", "sourceBytesUploaded": True}
    response = await client(state["request"])
    if command.startswith("draft-"):
        after, _digest = await draft_snapshot(client, entity, args, r, c, f, t, u)
        expected = state["expected"]
        if response is not True or (not after["empty"] if expected is None else any(after[key] != value for key, value in expected.items())):
            raise ValueError("Draft read-back mismatch")
        return {"saved": command == "draft-save", "cleared": command == "draft-clear", "draft": after,
                "topicId": args.topic_id, "sent": False, "snapshotAtomic": False}
    if command.startswith("invite-"):
        returned = c.invite_row(response.invite, r)
        _native, after = await invite_snapshot(client, entity, args.invite_link, me, r, c, f)
        if any(after[key] != value or returned[key] != value for key, value in state["expected"].items()):
            raise ValueError("Invite read-back mismatch")
        return {"applied": True, "invite": after}
    if command == "topic-create":
        rows = [getattr(update, "message", None) for update in getattr(response, "updates", [])
                if type(update).__name__ in {"UpdateNewMessage", "UpdateNewChannelMessage"}]
        rows = [row for row in rows if row is not None and u.get_peer_id(row.peer_id) == u.get_peer_id(entity)
                and type(getattr(row, "action", None)).__name__ == "MessageActionTopicCreate"]
        if len(rows) != 1 or rows[0].action.title != args.title:
            raise ValueError("Topic creation ID is unknown")
        selected = await c.topic(client, entity, rows[0].id, r, f)
        if selected.title != args.title or getattr(selected, "closed", False) or getattr(selected, "hidden", False):
            raise ValueError("Topic creation read-back mismatch")
        return {"created": True, "topic": c.topic_row(selected, r)}
    after = topic_state(await c.topic(client, entity, args.topic_id, r, f), r, c)
    if after != state["expected"]:
        raise ValueError("Topic read-back mismatch")
    return {"applied": True, "topic": after}


async def run(args, identity, r):
    c = r.import_community_tools()
    f, t, u, markdown = c.api()
    client, state, failure, dispatched = r.build_client(args, identity), None, None, False
    try:
        await r.ensure_authorized(client)
        entity = await r.resolve_entity(client, args.chat)
        if args.command == "draft":
            row, _digest = await draft_snapshot(client, entity, args, r, c, f, t, u)
            return c.bounded_result({"securityBoundary": "chat-only", "chat": r.public_entity(entity), "draft": row,
                      "topicId": args.topic_id, "readState": {"marksRead": False, "mode": "draft-metadata-only"}}, r)
        if (args.dry_run and args.approval_hash) or (not args.dry_run and not re.fullmatch(r"[0-9a-f]{64}", args.approval_hash or "")):
            raise r.TelegramRuntimeError("Prepare --dry-run, then the unchanged --confirm --approval-hash operation.")
        if not args.dry_run:
            r.assert_send_allowed(identity, confirmed=True)
        me = await client.get_me()
        state = await prepare(client, entity, args, me, r, c, f, t, u, markdown)
        c.bounded_result(state["preview"], r, 20000)
        if args.dry_run:
            return {"dryRun": True, "approvalHash": r.scheduled_approval(identity, me.id, state["operation"]),
                    "expiresInSeconds": r.MESSAGE_APPROVAL_TTL_SECONDS, "preview": state["preview"]}
        if args.command == "invite-edit" and getattr(state["request"], "expire_date", None) is not None:
            r.assert_schedule_lead_time(state["request"].expire_date)
        r.scheduled_approval(identity, me.id, state["operation"], args.approval_hash)
        dispatched = True
        result = await execute(client, entity, args, me, state, r, c, f, t, u)
        return c.bounded_result({"securityBoundary": "chat-only", **result}, r)
    except Exception as error:
        if dispatched:
            failure = r.TelegramRuntimeError("Telegram authoring action is not fully verified. Read exact live state before any retry.",
                                            code="TELEGRAM_ACTION_OUTCOME_UNKNOWN")
        elif isinstance(error, r.TelegramRuntimeError):
            failure = error
        else:
            failure = r.TelegramRuntimeError("Telegram authoring state is unavailable; no verified change was returned.")
        raise failure from error
    finally:
        if state and state.get("file") is not None:
            state["file"].close()
        try:
            await client.disconnect()
        except Exception as error:
            if failure is None:
                raise r.TelegramRuntimeError("Telegram cleanup failed; verify exact state before retrying.",
                         code="TELEGRAM_ACTION_OUTCOME_UNKNOWN" if dispatched else None) from error
