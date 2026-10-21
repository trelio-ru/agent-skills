"""Bounded inbox reads and reviewed personal navigation changes.

Import has no SDK/storage/network side effects. Native filter objects stay in
memory: public previews expose peer IDs and known settings, never access hashes.
Telegram has no CAS for personal settings; fingerprints prevent observed stale
writes and exact post-reads detect races without trying to restore old state.
"""
import argparse
import copy

VERSION = "2.13.0"
READS = {"mentions", "unread-reactions", "drafts", "folder-info", "dialog-state"}
MUTATIONS = {"folder-create", "folder-rename", "folder-add-chat", "folder-remove-chat",
             "chat-pin", "chat-unpin", "mark-read", "mark-unread"}
COMMANDS = READS | MUTATIONS
FOLDER_FLAGS = ("contacts", "non_contacts", "groups", "broadcasts", "bots",
                "exclude_muted", "exclude_read", "exclude_archived", "title_noanimate")
FOLDER_LISTS = ("pinned_peers", "include_peers", "exclude_peers")
FOLDER_FIELDS = {"_", "id", "title", "emoticon", "color", *FOLDER_FLAGS, *FOLDER_LISTS}


def bounded_int(value, low, high, r):
    if type(value) is not int or not low <= value <= high:
        raise r.TelegramRuntimeError("Telegram returned invalid bounded metadata.")
    return value


def add_parsers(commands, positive_id):
    def message_id(value):
        number = positive_id(value)
        if number >= 2**31:
            raise argparse.ArgumentTypeError("Message ID must fit positive int32")
        return number

    for name in sorted(COMMANDS):
        p = commands.add_parser(name, help="Read inbox or review one personal navigation change")
        if name in {"mentions", "unread-reactions"}:
            p.add_argument("--chat", action="append", required=True)
            p.add_argument("--limit", type=int, choices=range(1, 101), default=20)
            p.add_argument("--before-id", type=message_id)
        elif name == "drafts":
            p.add_argument("--limit", type=int, choices=range(1, 101), default=20)
            p.add_argument("--offset", type=int, default=0)
            p.add_argument("--include-text", action="store_true")
        elif name.startswith("folder-"):
            if name != "folder-create":
                p.add_argument("--folder-id", type=int, choices=range(2, 256), required=True)
            if name in {"folder-create", "folder-rename"}:
                p.add_argument("--title", required=True)
            if name in {"folder-create", "folder-add-chat", "folder-remove-chat"}:
                p.add_argument("--chat", action="append", required=True)
        else:
            p.add_argument("--chat", required=True)
            if name == "mark-read":
                p.add_argument("--message-id", type=message_id, required=True)
        if name in MUTATIONS:
            mode = p.add_mutually_exclusive_group(required=True)
            mode.add_argument("--dry-run", action="store_true")
            mode.add_argument("--confirm", action="store_true")
            p.add_argument("--approval-hash")


def safe_error(error, r, *, stage="provider_command"):
    """Classify only fixed exception identities, never provider text or args.

    Existing outcome-unknown/recovery codes keep precedence. A permission or
    flood exception after dispatch cannot turn an uncertain write into a safe
    retry. Bounded causal traversal also handles deliberately cyclic chains.
    """
    known = {
        "FloodWaitError": ("TELEGRAM_RATE_LIMITED", "rate_limit", "wait_then_read"),
        "FloodPremiumWaitError": ("TELEGRAM_RATE_LIMITED", "rate_limit", "wait_then_read"),
        "SlowModeWaitError": ("TELEGRAM_RATE_LIMITED", "slowmode", "wait_then_read"),
        "ChannelPrivateError": ("TELEGRAM_ACCESS_DENIED", "chat_unavailable", "check_chat_access"),
        "UserBannedInChannelError": ("TELEGRAM_ACCESS_DENIED", "chat_unavailable", "check_chat_access"),
        "ChatAdminRequiredError": ("TELEGRAM_PERMISSION_REQUIRED", "admin_required", "check_permissions"),
        "ChatWriteForbiddenError": ("TELEGRAM_PERMISSION_REQUIRED", "write_forbidden", "check_permissions"),
        "ChatSendMediaForbiddenError": ("TELEGRAM_PERMISSION_REQUIRED", "media_forbidden", "check_permissions"),
        "AuthKeyUnregisteredError": ("TELEGRAM_SESSION_UNAVAILABLE", "authorization_required", "review_personal_connection"),
        "SessionRevokedError": ("TELEGRAM_SESSION_UNAVAILABLE", "session_revoked", "review_personal_connection"),
        "SessionExpiredError": ("TELEGRAM_SESSION_UNAVAILABLE", "session_expired", "review_personal_connection"),
        "TimeoutError": ("TELEGRAM_NETWORK_UNAVAILABLE", "timeout", "check_connection_then_read"),
        "ConnectionError": ("TELEGRAM_NETWORK_UNAVAILABLE", "connection_failed", "check_connection_then_read"),
        "ConnectionResetError": ("TELEGRAM_NETWORK_UNAVAILABLE", "connection_reset", "check_connection_then_read"),
        "ConnectionRefusedError": ("TELEGRAM_NETWORK_UNAVAILABLE", "connection_refused", "check_connection_then_read"),
    }
    cause, seen, diagnostic = error, set(), None
    for _ in range(8):
        if cause is None or id(cause) in seen:
            break
        seen.add(id(cause))
        item = known.get(type(cause).__name__)
        if item is not None and diagnostic is None:
            diagnostic = {"category": item[1], "stage": stage, "nextStep": item[2], "automaticRetry": False}
            seconds = getattr(cause, "seconds", None)
            if item[0] == "TELEGRAM_RATE_LIMITED" and type(seconds) is int and 0 <= seconds <= 86400 * 365:
                diagnostic["retryAfterSeconds"] = seconds
            code = item[0]
        cause = cause.__cause__ or cause.__context__
    if isinstance(error, r.TelegramRuntimeError):
        if diagnostic:
            details = dict(error.details or {})
            details["diagnostic"] = diagnostic
            # Preserve unknown-outcome instructions instead of suggesting a
            # retry merely because the underlying transport timed out.
            if error.code and ("UNKNOWN" in error.code or "DELIVERY" in error.code):
                diagnostic["nextStep"] = "verify_exact_live_state_before_any_retry"
            error.details = details
            if not error.code:
                error.code = code
        return error
    return r.TelegramRuntimeError("Telegram request failed; inspect the safe diagnostic before continuing.",
        code=code if diagnostic else "TELEGRAM_REQUEST_FAILED",
        details={"diagnostic": diagnostic or {"category": "unclassified", "stage": stage,
                 "nextStep": "inspect_exact_operation", "automaticRetry": False}})


async def own_dialog(client, entity, r, f, t, u):
    peer = await client.get_input_entity(entity)
    response = await client(f.messages.GetPeerDialogsRequest(peers=[t.InputDialogPeer(peer=peer)]))
    rows = getattr(response, "dialogs", None)
    if not isinstance(rows, list) or len(rows) != 1 or type(rows[0]).__name__ != "Dialog":
        raise r.TelegramRuntimeError("Exact own dialog metadata is unavailable.")
    row = rows[0]
    if u.get_peer_id(row.peer) != u.get_peer_id(entity) or not hasattr(row, "folder_id"):
        raise r.TelegramRuntimeError("Telegram returned a different or incomplete dialog.")
    state = {"folderId": 0 if row.folder_id is None else bounded_int(row.folder_id, 0, 1, r),
             "pinned": getattr(row, "pinned", None) is True,
             "unreadMark": getattr(row, "unread_mark", None) is True,
             "readInboxMaxId": bounded_int(getattr(row, "read_inbox_max_id", None), 0, 2**31 - 1, r),
             "topMessageId": bounded_int(getattr(row, "top_message", None), 0, 2**31 - 1, r)}
    return peer, state


async def inbox(client, args, r, f, t, u):
    if not 1 <= len(args.chat) <= 20 or (args.before_id and len(args.chat) != 1):
        raise r.TelegramRuntimeError("Choose 1..20 chats; --before-id continues exactly one chat.")
    # Divide a common budget before reading; repeated aliases cannot enlarge it.
    budget, result, seen = args.limit, [], set()
    for index, reference in enumerate(args.chat):
        try:
            entity = await r.resolve_entity(client, reference)
            key = u.get_peer_id(entity)
            if key in seen:
                continue
            seen.add(key)
            take = min(100, max(1, budget // (len(args.chat) - index))) if budget else 0
            if not take:
                result.append({"chat": r.public_entity(entity), "messages": [], "coverage": {"complete": False, "reason": "common_limit"}})
                continue
            request = f.messages.GetUnreadMentionsRequest if args.command == "mentions" else f.messages.GetUnreadReactionsRequest
            response = await client(request(peer=await client.get_input_entity(entity), offset_id=args.before_id or 0,
                                           add_offset=0, limit=take, max_id=0, min_id=0))
            messages = getattr(response, "messages", None)
            if not isinstance(messages, list) or len(messages) > take:
                raise r.TelegramRuntimeError("Telegram inbox page is missing or exceeds the requested bound.")
            previous, public = args.before_id or 2**31, []
            for message in messages:
                message_id = bounded_int(getattr(message, "id", None), 1, previous - 1, r)
                r.exact_provider_message(message, entity, message_id, u)
                previous = message_id
                public.append(r.import_channel_tools().public_row(r, message, entity))
            total = getattr(response, "count", None)
            total = total if type(total) is int and total >= 0 else None
            exhausted = type(response).__name__ == "Messages" or (total is not None and total == len(public))
            # inexact or changed counts cannot prove absence. An empty page
            # with a nonzero/unknown count has no safe continuation.
            complete = exhausted and not getattr(response, "inexact", False)
            result.append({"chat": r.public_entity(entity), "messages": public,
                "coverage": {"complete": complete, "returned": len(public), "reportedTotal": total,
                    "nextBeforeId": previous if public and not complete else None,
                    "hasMore": False if complete else (True if public else None), "snapshotAtomic": False}})
            budget -= len(public)
        except Exception as error:
            projected = safe_error(error, r, stage="inbox_read")
            result.append({"selectionIndex": index, "messages": [], "error": projected.public_payload(),
                           "coverage": {"complete": False, "hasMore": None}})
    return {"chats": result, "coverage": {"complete": all(row["coverage"]["complete"] for row in result),
            "returned": sum(len(row["messages"]) for row in result), "snapshotAtomic": False},
            "readState": {"marksRead": False, "reactionsMarkedRead": False, "mode": "inbox-only"}}


async def drafts(client, args, r, f, t, u):
    if not 0 <= args.offset <= 10000:
        raise r.TelegramRuntimeError("Draft offset must be between zero and 10000.")
    response = await client(f.messages.GetAllDraftsRequest())
    updates = getattr(response, "updates", None)
    if not isinstance(updates, list) or len(updates) > 10000:
        raise r.TelegramRuntimeError("The cloud draft response is unavailable or exceeds its bound.")
    entities = getattr(response, "users", []) + getattr(response, "chats", [])
    if len(entities) > 20000:
        raise r.TelegramRuntimeError("The draft identity dictionary exceeds its bound.")
    # Only identities supplied with this response are projected, without extra
    # profile reads. Topic/saved selectors are never merged into another draft.
    lookup = {u.get_peer_id(row): row for row in entities if type(row).__name__ in {"User", "Chat", "Channel"}}
    rows, seen, skipped = [], set(), 0
    for update in updates:
        if type(update).__name__ != "UpdateDraftMessage" or getattr(update, "saved_peer_id", None) is not None:
            skipped += 1
            continue
        native, peer = getattr(update, "draft", None), getattr(update, "peer", None)
        if type(peer).__name__ not in {"PeerUser", "PeerChat", "PeerChannel"}:
            raise r.TelegramRuntimeError("The draft response contains an invalid peer.")
        key, topic = u.get_peer_id(peer), getattr(update, "top_msg_id", None)
        if topic is not None:
            bounded_int(topic, 1, 2**31 - 1, r)
        if (key, topic) in seen:
            raise r.TelegramRuntimeError("The cloud draft response contains duplicate targets.")
        seen.add((key, topic))
        if type(native).__name__ == "DraftMessageEmpty":
            continue
        if type(native).__name__ != "DraftMessage":
            skipped += 1
            continue
        body = getattr(native, "message", None)
        if not isinstance(body, str) or len(body) > 32768:
            raise r.TelegramRuntimeError("A cloud draft exceeds the supported text bound.")
        row = {"peerId": key, "chat": r.public_entity(lookup[key]) if key in lookup else None,
               "topicId": topic, "hasText": bool(body), "textLength": len(body),
               "textIncluded": args.include_text, "date": r.format_utc_datetime(native.date) if getattr(native, "date", None) else None}
        if args.include_text:
            row["text"] = body
        rows.append(row)
    rows.sort(key=lambda row: (str(row["peerId"]), row["topicId"] or 0))
    selected = rows[args.offset:args.offset + args.limit]
    end = args.offset + len(selected)
    return {"drafts": selected, "coverage": {"returned": len(selected), "reportedDrafts": len(rows),
             "nextOffset": end if end < len(rows) else None, "hasMore": end < len(rows), "pageComplete": True,
             "complete": args.offset == 0 and end >= len(rows) and not skipped,
             "unsupportedUpdates": skipped, "scope": "provider_returned_cloud_drafts", "snapshotAtomic": False},
             "readState": {"marksRead": False, "mode": "cloud-draft-list-only"}}


def folder_snapshot(native, r, u):
    if type(native).__name__ != "DialogFilter" or not set(native.to_dict()).issubset(FOLDER_FIELDS):
        raise r.TelegramRuntimeError("Shared or unknown folder types are read-only; preserve their settings in Telegram.")
    title = getattr(native.title, "text", None)
    if not isinstance(title, str) or not title or len(title) > 128:
        raise r.TelegramRuntimeError("The folder title is unavailable.")
    public = {"id": bounded_int(native.id, 2, 255, r), "title": title,
              "flags": {}, "emoticon": None, "color": None}
    for key in FOLDER_FLAGS:
        value = getattr(native, key, None)
        if value is not None and type(value) is not bool:
            raise r.TelegramRuntimeError("A folder setting is unknown.")
        public["flags"][key] = bool(value)
    for key in ("emoticon", "color"):
        value = getattr(native, key, None)
        if (key == "emoticon" and value is not None and (not isinstance(value, str) or len(value) > 32)) or (
                key == "color" and value is not None and (type(value) is not int or not 0 <= value <= 6)):
            raise r.TelegramRuntimeError("A folder appearance setting is unsupported.")
        public[key] = value
    for key in FOLDER_LISTS:
        values = getattr(native, key, None)
        if not isinstance(values, list) or len(values) > 100:
            raise r.TelegramRuntimeError("A folder peer list exceeds its bound.")
        if any(type(peer).__name__ not in {"InputPeerUser", "InputPeerChat", "InputPeerChannel"} for peer in values):
            raise r.TelegramRuntimeError("An unsupported folder peer cannot be changed safely.")
        ids = [u.get_peer_id(peer) for peer in values]
        if len(set(ids)) != len(ids):
            raise r.TelegramRuntimeError("The folder contains duplicate peers.")
        public[key] = ids
    return public


def folder_fingerprint(native, r, u):
    # TL flag absence is None in a newly constructed request and False after
    # Telegram deserializes it. These are the same flag, not a changed rule.
    # InputPeer access_hash is transport metadata and may refresh independently
    # of a peer's identity. Bind exact ordered peer IDs, known rule/appearance
    # fields and title entities instead of requiring credential-byte equality.
    state = folder_snapshot(native, r, u)
    state["titleFormatting"] = r.provider_content_digest(getattr(native.title, "entities", None) or [])
    return r.provider_content_digest(state)


async def filters(client, r, f):
    response = await client(f.messages.GetDialogFiltersRequest())
    rows = response if isinstance(response, list) else getattr(response, "filters", None)
    if not isinstance(rows, list) or len(rows) > 100:
        raise r.TelegramRuntimeError("The folder catalog is unavailable or exceeds its bound.")
    ids = [getattr(row, "id", 0) for row in rows]
    if any(type(key) is not int or not 0 <= key <= 255 for key in ids) or len(set(ids)) != len(ids):
        raise r.TelegramRuntimeError("The folder catalog has invalid or duplicate IDs.")
    return rows


async def folder_change(client, args, identity, me, r, f, t, u):
    catalog = await filters(client, r, f)
    create = args.command == "folder-create"
    if create:
        key = next((value for value in range(2, 256) if value not in [getattr(row, "id", 0) for row in catalog]), None)
        if key is None:
            raise r.TelegramRuntimeError("No free folder ID is available.")
        native, before = t.DialogFilter(id=key, title=t.TextWithEntities(text=args.title, entities=[]),
                                       pinned_peers=[], include_peers=[], exclude_peers=[]), None
    else:
        matches = [row for row in catalog if getattr(row, "id", None) == args.folder_id]
        if len(matches) != 1:
            raise r.TelegramRuntimeError("Select an existing exact folder ID from folders.")
        native = matches[0]
        before = folder_snapshot(native, r, u)
        key = native.id
    if args.command == "folder-info":
        return {"folder": before, "snapshotAtomic": False, "readState": {"marksRead": False}}
    after_native = copy.deepcopy(native)
    if args.command in {"folder-create", "folder-rename"}:
        if not args.title.strip() or "\x00" in args.title or r.import_conversation_tools().units(args.title) > 12:
            raise r.TelegramRuntimeError("Choose a folder title of 1..12 UTF-16 units.")
        # Repeating the existing name is a no-op. In particular it must not
        # strip title entities just because the requested plain text matches.
        if create or args.title != before["title"]:
            after_native.title = t.TextWithEntities(text=args.title, entities=[])
    selected_chats = []
    if args.command in {"folder-create", "folder-add-chat", "folder-remove-chat"}:
        if not 1 <= len(args.chat) <= 20:
            raise r.TelegramRuntimeError("Select 1..20 exact chats for one folder change.")
        for reference in args.chat:
            entity = await r.resolve_entity(client, reference)
            selected_chats.append(r.public_entity(entity))
            # Explicit additions/removals use actual own dialogs; they cannot
            # join a channel or grant another person access to a shared folder.
            await own_dialog(client, entity, r, f, t, u)
            peer, peer_id = await client.get_input_entity(entity), u.get_peer_id(entity)
            if args.command == "folder-remove-chat":
                for field in ("include_peers", "pinned_peers"):
                    setattr(after_native, field, [row for row in getattr(after_native, field) if u.get_peer_id(row) != peer_id])
                field = "exclude_peers"
            else:
                after_native.exclude_peers = [row for row in after_native.exclude_peers if u.get_peer_id(row) != peer_id]
                field = "include_peers"
                if peer_id in [u.get_peer_id(row) for row in after_native.pinned_peers]:
                    continue
            if peer_id not in [u.get_peer_id(row) for row in getattr(after_native, field)]:
                getattr(after_native, field).append(peer)
    after = folder_snapshot(after_native, r, u)
    if not after_native.include_peers and not after_native.pinned_peers and not any(after["flags"][key] for key in FOLDER_FLAGS[:5]):
        raise r.TelegramRuntimeError("This change would leave a folder without any inclusion rule; preserve it or choose another change.")
    operation = {"version": VERSION, "command": args.command, "folderId": key,
                 "before": folder_fingerprint(native, r, u) if not create else None,
                 "after": folder_fingerprint(after_native, r, u),
                 "catalogIds": sorted(getattr(row, "id", 0) for row in catalog) if create else None}
    preview = {"actingAccount": r.public_entity(me), "before": before, "after": after, "selectedChats": selected_chats,
               "personalOnly": True, "changesAccess": False, "marksRead": False, "snapshotAtomic": False}
    r.import_community_tools().bounded_result(preview, r, 20000)
    if args.dry_run:
        return {"dryRun": True, "preview": preview, "approvalHash": r.scheduled_approval(identity, me.id, operation),
                "expiresInSeconds": r.MESSAGE_APPROVAL_TTL_SECONDS}
    r.scheduled_approval(identity, me.id, operation, args.approval_hash)
    changed = before != after
    try:
        if changed and await client(f.messages.UpdateDialogFilterRequest(id=key, filter=after_native)) is not True:
            raise ValueError("Missing native folder acknowledgement")
        observed = [row for row in await filters(client, r, f) if getattr(row, "id", None) == key]
        if len(observed) != 1 or folder_fingerprint(observed[0], r, u) != operation["after"]:
            raise ValueError("Folder state was not confirmed")
        return {"changed": changed, "folder": folder_snapshot(observed[0], r, u), "personalOnly": True,
                "marksRead": False, "snapshotAtomic": False}
    except Exception as error:
        raise r.TelegramRuntimeError("Folder change was not verified. Read folder-info before any retry.",
                                     code="TELEGRAM_ACTION_OUTCOME_UNKNOWN") from error


async def dialog_change(client, args, identity, me, r, f, t, u):
    entity = await r.resolve_entity(client, args.chat)
    peer, before = await own_dialog(client, entity, r, f, t, u)
    if args.command == "dialog-state":
        return {"chat": r.public_entity(entity), "state": before, "snapshotAtomic": False,
                "readState": {"marksRead": False, "mode": "personal-dialog-metadata-only"}}
    after = dict(before)
    if args.command == "mark-read":
        if getattr(entity, "forum", False):
            raise r.TelegramRuntimeError("Topic-specific read acknowledgement is unsupported; preserve forum read state in Telegram.")
        target = await client.get_messages(entity, ids=args.message_id)
        r.exact_provider_message(target, entity, args.message_id, u)
        if args.message_id > before["topMessageId"]:
            raise r.TelegramRuntimeError("The selected read boundary is newer than the exact dialog metadata.")
        after["readInboxMaxId"] = max(before["readInboxMaxId"], args.message_id)
    elif args.command == "mark-unread":
        after["unreadMark"] = True
    else:
        after["pinned"] = args.command == "chat-pin"
    operation = {"version": VERSION, "command": args.command, "peerId": u.get_peer_id(entity),
                 "before": before, "after": after}
    field = "readInboxMaxId" if args.command == "mark-read" else "unreadMark" if args.command == "mark-unread" else "pinned"
    preview = {"chat": r.public_entity(entity), "actingAccount": r.public_entity(me), "before": before, "after": {field: after[field]},
               "marksRead": args.command == "mark-read", "mayNotifySender": args.command == "mark-read",
               "readMarkMayClearUnreadMark": args.command == "mark-read",
               "unreadMarkDoesNotUndoReceipt": args.command == "mark-unread", "snapshotAtomic": False}
    if args.dry_run:
        return {"dryRun": True, "preview": preview, "approvalHash": r.scheduled_approval(identity, me.id, operation),
                "expiresInSeconds": r.MESSAGE_APPROVAL_TTL_SECONDS}
    r.scheduled_approval(identity, me.id, operation, args.approval_hash)
    changed = before != after
    try:
        if changed:
            if args.command in {"chat-pin", "chat-unpin"}:
                if await client(f.messages.ToggleDialogPinRequest(peer=t.InputDialogPeer(peer=peer), pinned=after["pinned"])) is not True:
                    raise ValueError("Missing native pin acknowledgement")
            elif args.command == "mark-unread":
                if await client(f.messages.MarkDialogUnreadRequest(peer=t.InputDialogPeer(peer=peer), unread=True)) is not True:
                    raise ValueError("Missing native unread acknowledgement")
            elif type(entity).__name__ == "Channel":
                if await client(f.channels.ReadHistoryRequest(channel=entity, max_id=args.message_id)) is not True:
                    raise ValueError("Missing native read acknowledgement")
            else:
                result = await client(f.messages.ReadHistoryRequest(peer=peer, max_id=args.message_id))
                if type(result).__name__ != "AffectedMessages":
                    raise ValueError("Missing native affected-state")
        _peer, observed = await own_dialog(client, entity, r, f, t, u)
        field = "readInboxMaxId" if args.command == "mark-read" else "unreadMark" if args.command == "mark-unread" else "pinned"
        verified = observed[field] >= after[field] if field == "readInboxMaxId" else observed[field] == after[field]
        if not verified or observed["folderId"] != before["folderId"]:
            raise ValueError("Personal dialog state was not confirmed")
        if field != "readInboxMaxId" and observed["readInboxMaxId"] != before["readInboxMaxId"]:
            raise ValueError("Read state changed concurrently")
        return {"changed": changed, "chat": r.public_entity(entity), "state": observed,
                "marksRead": args.command == "mark-read", "snapshotAtomic": False}
    except Exception as error:
        raise r.TelegramRuntimeError("Dialog change was not verified. Read exact live state before any retry.",
                                     code="TELEGRAM_ACTION_OUTCOME_UNKNOWN") from error


async def run(args, identity, r):
    f, t, u, _md = r.import_interaction_tools().api(r)
    writing = args.command in MUTATIONS and not args.dry_run
    if args.command in MUTATIONS:
        r.import_interaction_tools().validate_approval(args, r)
        if writing:
            r.assert_send_allowed(identity, confirmed=True)
    client, failure = r.build_client(args, identity), None
    try:
        await r.ensure_authorized(client)
        if args.command in {"mentions", "unread-reactions"}:
            result = await inbox(client, args, r, f, t, u)
        elif args.command == "drafts":
            result = await drafts(client, args, r, f, t, u)
        else:
            me = await client.get_me()
            result = await (folder_change(client, args, identity, me, r, f, t, u)
                            if args.command.startswith("folder-") else dialog_change(client, args, identity, me, r, f, t, u))
        return r.import_community_tools().bounded_result({"securityBoundary": "chat-only", **result}, r)
    except Exception as error:
        failure = safe_error(error, r)
        raise failure from error
    finally:
        try:
            await client.disconnect()
        except Exception as error:
            if failure is None:
                raise r.TelegramRuntimeError("Telegram cleanup failed; verify live state before continuing.",
                    code="TELEGRAM_ACTION_OUTCOME_UNKNOWN" if writing else "TELEGRAM_CLEANUP_FAILED") from error
