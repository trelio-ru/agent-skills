"""Explicit, bounded forum, reaction, poll, pin and channel-admin workflows.

No SDK, identity store or filesystem is opened on import. All mutations share
one live-preview journal with the existing runtime, not a second authority or
persistent copy of private content. Native payloads stay process-local.
"""
import argparse
import copy
import json
import re
from datetime import datetime

VERSION = "2.12.0"
READS = {"topics", "topic-read", "poll", "pins", "message-stats", "public-forwards", "invites", "join-requests"}
MUTATIONS = {"topic-send", "react", "poll-create", "poll-vote", "poll-close", "pin", "unpin", "invite-create", "join-request"}
COMMANDS = READS | MUTATIONS
MAX_PAGE = 30


def api():
    from telethon import functions, types, utils
    from telethon.extensions import markdown
    return functions, types, utils, markdown


def add_parsers(commands, positive_id):
    def message_id(value):
        number = positive_id(value)
        if number >= 2**31:
            raise argparse.ArgumentTypeError("Telegram message/topic ID must fit int32")
        return number

    def nonnegative(value):
        number = int(value)
        if not 0 <= number < 2**31:
            raise argparse.ArgumentTypeError("Offset must fit a nonnegative int32")
        return number

    for name in sorted(COMMANDS):
        p = commands.add_parser(name, help="Bounded Telegram " + name + " workflow")
        p.add_argument("--chat", required=True)
        if name in {"topics", "topic-read", "pins", "public-forwards", "invites", "join-requests"}:
            p.add_argument("--limit", type=int, choices=range(1, MAX_PAGE + 1), default=20)
        if name in {"react", "poll", "poll-vote", "poll-close", "pin", "unpin", "message-stats", "public-forwards"}:
            p.add_argument("--message-id", type=message_id, required=True)
        if name in {"topic-read", "topic-send"}:
            p.add_argument("--topic-id", type=message_id, required=True)
        if name in {"pins", "topic-read"}:
            p.add_argument("--before-id", type=message_id)
        if name == "topics":
            p.add_argument("--query")
            p.add_argument("--offset-id", type=nonnegative, default=0)
            p.add_argument("--offset-topic", type=nonnegative, default=0)
            p.add_argument("--offset-date", type=nonnegative, default=0)
        if name == "topic-send":
            body = p.add_mutually_exclusive_group(required=True)
            body.add_argument("--message")
            body.add_argument("--message-file")
            p.add_argument("--silent", action="store_true")
            p.add_argument("--no-link-preview", action="store_true")
        if name == "react":
            selected = p.add_mutually_exclusive_group(required=True)
            selected.add_argument("--emoji", action="append")
            selected.add_argument("--clear", action="store_true")
        if name == "poll-create":
            p.add_argument("--question", required=True)
            p.add_argument("--option", action="append", required=True)
            p.add_argument("--multiple", action="store_true")
            p.add_argument("--public-voters", action="store_true")
        if name == "poll-vote":
            p.add_argument("--option", action="append", type=int, required=True, help="1-based option from poll read")
        if name == "pin":
            p.add_argument("--notify", action="store_true", help="Notify members; default is silent")
        if name == "message-stats":
            p.add_argument("--graph", choices=("views", "reactions"), default="views")
        if name == "public-forwards":
            p.add_argument("--offset", default="")
        if name == "invites":
            p.add_argument("--offset-date", type=nonnegative, default=0)
            p.add_argument("--offset-link", default="")
        if name == "invite-create":
            p.add_argument("--title", required=True)
            p.add_argument("--expires-at", required=True)
            p.add_argument("--usage-limit", type=int, choices=range(1, 100001))
            p.add_argument("--request-needed", action="store_true")
        if name == "join-requests":
            p.add_argument("--offset-date", type=nonnegative, default=0)
            p.add_argument("--offset-user", type=positive_id)
        if name == "join-request":
            p.add_argument("--user-id", type=positive_id, required=True)
            p.add_argument("--decision", choices=("approve", "decline"), required=True)
        if name in {"topic-send", "poll-create"}:
            p.add_argument("--send-as")
        if name in MUTATIONS:
            mode = p.add_mutually_exclusive_group(required=True)
            mode.add_argument("--dry-run", action="store_true")
            mode.add_argument("--confirm", action="store_true")
            p.add_argument("--approval-hash")


def bounded_result(value, r, limit=28000):
    if len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > limit:
        raise r.TelegramRuntimeError("Telegram result exceeds its budget; reduce --limit or narrow the selection.")
    return value


def text(value, maximum, r):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\x00" in value:
        raise r.TelegramRuntimeError("Telegram text is empty, invalid or exceeds its supported bound.")
    return value


def stamp(value):
    if isinstance(value, datetime):
        value = int(value.timestamp())
    return value if type(value) is int and 0 <= value < 2**31 else None


def count(value):
    return value if type(value) is int and 0 <= value < 2**31 else None


def page(rows, total, limit, *, has_more=None):
    # A short native page alone is not an exhaustive snapshot. Use the native
    # total only for this exact response, keep change/race semantics explicit.
    total = count(total)
    more = has_more if has_more is not None else (False if not rows else None if total is None else total > len(rows))
    return {"returned": len(rows), "reportedTotal": total, "hasMore": more,
            "complete": more is False, "snapshotAtomic": False, "limit": limit}


async def exact(client, entity, message_id, r, u):
    return r.import_channel_tools().checked_message(r, u, entity, await client.get_messages(entity, ids=message_id), message_id)


async def poll_message(client, entity, message_id, r, f, u):
    message = await exact(client, entity, message_id, r, u)
    poll = poll_state(message, r)[0]
    # Full message snapshots may carry min results shared across users. The
    # native read API supplies the current user's own choices without marking
    # poll votes or chat history read. A zero cache hash requests fresh data.
    response = await client(f.messages.GetPollResultsRequest(peer=entity, msg_id=message_id, poll_hash=0))
    updates = [row for row in getattr(response, "updates", [])
               if type(row).__name__ == "UpdateMessagePoll" and row.poll_id == poll.id]
    if len(updates) > 1:
        raise r.TelegramRuntimeError("Telegram returned inconsistent exact poll results.")
    if updates:
        message = copy.copy(message)
        message.media = copy.copy(message.media)
        if getattr(updates[0], "poll", None) is not None:
            if updates[0].poll.id != poll.id:
                raise r.TelegramRuntimeError("Telegram returned a different poll.")
            message.media.poll = updates[0].poll
        message.media.results = updates[0].results
    return message


async def forum(client, entity, r):
    if type(entity).__name__ != "Channel" or not getattr(entity, "forum", False) or getattr(entity, "broadcast", False):
        raise r.TelegramRuntimeError("This command requires an exact forum supergroup.")


async def topic(client, entity, topic_id, r, f):
    await forum(client, entity, r)
    result = await client(f.messages.GetForumTopicsByIDRequest(peer=entity, topics=[topic_id]))
    rows = getattr(result, "topics", [])
    if len(rows) != 1 or type(rows[0]).__name__ != "ForumTopic" or rows[0].id != topic_id:
        raise r.TelegramRuntimeError("The exact topic is unavailable or deleted.")
    _f, _t, u, _md = api()
    if u.get_peer_id(rows[0].peer) != u.get_peer_id(entity):
        raise r.TelegramRuntimeError("Telegram returned a topic from another chat.")
    return rows[0]


def topic_row(row, r):
    if type(row).__name__ != "ForumTopic" or type(row.id) is not int or not 0 < row.id < 2**31:
        raise r.TelegramRuntimeError("Telegram returned an invalid forum topic.")
    return {"id": row.id, "title": text(row.title, 128, r),
            "closed": bool(getattr(row, "closed", False)), "hidden": bool(getattr(row, "hidden", False)),
            "pinned": bool(getattr(row, "pinned", False)), "topMessageId": count(getattr(row, "top_message", None))}


def in_topic(row, topic_id):
    header = getattr(row, "reply_to", None)
    if getattr(header, "forum_topic", False):
        return (getattr(header, "reply_to_top_id", None) or getattr(header, "reply_to_msg_id", None)) == topic_id
    # The General topic is the forum's unthreaded history, not the root of
    # every other thread. An explicit non-forum reply remains in General.
    return topic_id == 1


async def search_page(client, entity, args, r, f, t, u, *, topic_id=None):
    response = await client(f.messages.SearchRequest(
        peer=entity, q="", filter=t.InputMessagesFilterPinned() if topic_id is None else t.InputMessagesFilterEmpty(),
        min_date=None, max_date=None, offset_id=args.before_id or 0, add_offset=0,
        limit=args.limit + 1, max_id=0, min_id=0, hash=0, top_msg_id=topic_id))
    rows = getattr(response, "messages", [])
    if len(rows) > args.limit + 1:
        raise r.TelegramRuntimeError("Telegram exceeded the bounded message page.")
    seen, previous = set(), args.before_id or 2**31
    for row in rows:
        r.exact_provider_message(row, entity, row.id, u)
        if row.id in seen or row.id >= previous or (topic_id is not None and not in_topic(row, topic_id)):
            raise r.TelegramRuntimeError("Telegram returned a foreign topic or non-advancing page.")
        if topic_id is None and getattr(row, "pinned", None) is not True:
            raise r.TelegramRuntimeError("Telegram did not confirm pinned state.")
        seen.add(row.id)
        previous = row.id
    selected = rows[:args.limit]
    # A full page, provider inexact flag or an offset is not proof that all
    # pinned/topic messages have been read. Only this scoped page is returned.
    total = count(getattr(response, "count", None))
    # Without a total, a short response is still an observed page, not proof
    # of complete history. A contradictory first-page total remains partial.
    more = len(rows) > args.limit or (not args.before_id and total is not None and total > len(rows))
    coverage = {"returned": len(selected), "reportedTotal": total,
                "hasMore": more if total is not None or more else None,
                "complete": not args.before_id and total is not None and total == len(rows) and not more and not bool(getattr(response, "inexact", False)),
                "nextBeforeId": selected[-1].id if (more or total is None) and selected else None,
                "snapshotAtomic": False, "attachmentsContentRead": False}
    return {"messages": [r.import_channel_tools().public_row(r, row, entity) for row in selected], "coverage": coverage}


def poll_state(message, r):
    media = getattr(message, "media", None)
    poll = getattr(media, "poll", None)
    if type(media).__name__ != "MessageMediaPoll" or poll is None:
        raise r.TelegramRuntimeError("The selected message is not a poll.")
    question = text(getattr(getattr(poll, "question", None), "text", None), 300, r)
    answers = getattr(poll, "answers", None)
    if not isinstance(answers, list) or not 2 <= len(answers) <= 10:
        raise r.TelegramRuntimeError("This poll exceeds the supported 2..10 answer bound.")
    options = []
    for answer in answers:
        label = text(getattr(getattr(answer, "text", None), "text", None), 100, r)
        option = getattr(answer, "option", None)
        if not isinstance(option, bytes) or not 1 <= len(option) <= 64 or getattr(answer, "media", None) is not None:
            raise r.TelegramRuntimeError("This poll answer format is unsupported.")
        options.append((label, option))
    if len({option for _label, option in options}) != len(options):
        raise r.TelegramRuntimeError("Telegram returned duplicate poll options.")
    raw_results = getattr(media, "results", None)
    result_rows = getattr(raw_results, "results", None) or []
    if len(result_rows) > 10:
        raise r.TelegramRuntimeError("Telegram returned oversized poll results.")
    indexed = {getattr(row, "option", None): row for row in result_rows}
    if len(indexed) != len(result_rows) or any(option not in {opt for _label, opt in options} for option in indexed):
        raise r.TelegramRuntimeError("Telegram returned inconsistent poll results.")
    complete = raw_results is not None and not getattr(raw_results, "min", False) and len(indexed) == len(options)
    public = {"question": question, "closed": bool(getattr(poll, "closed", False)),
              "multipleChoice": bool(getattr(poll, "multiple_choice", False)),
              "anonymous": not bool(getattr(poll, "public_voters", False)), "quiz": bool(getattr(poll, "quiz", False)),
              "totalVoters": count(getattr(raw_results, "total_voters", None)), "resultsComplete": complete,
              "options": [{"index": i + 1, "text": label, "voters": count(getattr(indexed.get(option), "voters", None)),
                           "chosen": bool(getattr(indexed.get(option), "chosen", False)) if complete else None}
                          for i, (label, option) in enumerate(options)]}
    # Vote totals and poll.hash legitimately change between preview and apply.
    # Bind the definition, restrictions and own choices, not volatile totals.
    definition = {"id": str(poll.id), "question": question, "options": [(label, option.hex()) for label, option in options],
                  "closed": public["closed"], "multiple": public["multipleChoice"], "anonymous": public["anonymous"],
                  "quiz": public["quiz"], "choices": [item["chosen"] for item in public["options"]],
                  "restrictions": r.provider_content_digest({key: getattr(poll, key, None) for key in
                      ("subscribers_only", "countries_iso2", "revoting_disabled", "close_date", "close_period", "open_answers")})}
    return poll, options, public, definition


async def admin(entity, r):
    if type(entity).__name__ not in {"Channel", "Chat"} or not (
        getattr(entity, "creator", False) or getattr(getattr(entity, "admin_rights", None), "invite_users", False)):
        raise r.TelegramRuntimeError("Current Telegram invite_users administrator rights are required.")


def invite_row(invite, r):
    link = getattr(invite, "link", None)
    if type(invite).__name__ != "ChatInviteExported" or not isinstance(link, str) or not re.fullmatch(r"https://t\.me/(?:\+|joinchat/)[A-Za-z0-9_-]{1,256}", link):
        raise r.TelegramRuntimeError("Telegram returned an unsupported invite link.")
    return {"link": link, "title": (getattr(invite, "title", None) or "")[:32],
            "expiresAt": stamp(getattr(invite, "expire_date", None)), "usageLimit": count(getattr(invite, "usage_limit", None)),
            "usage": count(getattr(invite, "usage", None)), "requestNeeded": bool(getattr(invite, "request_needed", False)),
            "revoked": bool(getattr(invite, "revoked", False)), "createdAt": stamp(getattr(invite, "date", None))}


async def request_page(client, entity, r, f, t, u, *, limit=100, offset_date=0, offset_user=None):
    user = t.InputUserEmpty() if offset_user is None else u.get_input_user(await client.get_input_entity(offset_user))
    result = await client(f.messages.GetChatInviteImportersRequest(peer=entity, requested=True, limit=limit,
                         offset_date=offset_date, offset_user=user))
    rows = getattr(result, "importers", [])
    if len(rows) > limit or any(type(getattr(row, "user_id", None)) is not int or row.user_id <= 0 or stamp(getattr(row, "date", None)) is None for row in rows):
        raise r.TelegramRuntimeError("Telegram returned an invalid pending request page.")
    if len({row.user_id for row in rows}) != len(rows):
        raise r.TelegramRuntimeError("Telegram returned duplicate pending requests.")
    return result, rows


async def find_request(client, entity, user_id, r, f, t, u):
    # The API has no exact pending-user filter. A bounded, advancing native
    # pagination must prove absence; the first 100 rows never do so by default.
    seen, offset_date, offset_user = set(), 0, None
    for _ in range(10):
        result, rows = await request_page(client, entity, r, f, t, u, offset_date=offset_date, offset_user=offset_user)
        for row in rows:
            if row.user_id in seen:
                raise r.TelegramRuntimeError("Pending request pagination did not advance.")
            seen.add(row.user_id)
            if row.user_id == user_id:
                return row
        total = count(getattr(result, "count", None))
        if total is not None and len(seen) == total:
            return None
        if not rows or (total is not None and len(seen) > total):
            raise r.TelegramRuntimeError("Pending request coverage changed or is incomplete; absence is unproven.")
        offset_date, offset_user = stamp(rows[-1].date), rows[-1].user_id
    raise r.TelegramRuntimeError("Pending request scan exceeded 1000 entries; absence is unproven.")


async def read_command(client, entity, args, r, f, t, u):
    c = r.import_channel_tools()
    if args.command == "topics":
        await forum(client, entity, r)
        if args.query is not None:
            text(args.query, 128, r)
        result = await client(f.messages.GetForumTopicsRequest(peer=entity, q=args.query, limit=args.limit,
                             offset_id=args.offset_id, offset_topic=args.offset_topic, offset_date=args.offset_date))
        rows = getattr(result, "topics", [])
        if (len(rows) > args.limit or len({row.id for row in rows}) != len(rows)
                or any(u.get_peer_id(row.peer) != u.get_peer_id(entity) for row in rows)):
            raise r.TelegramRuntimeError("Telegram returned an invalid topic page.")
        projected = [topic_row(row, r) for row in rows]
        coverage = page(rows, getattr(result, "count", None), args.limit)
        # Continuation is the last topic's top-message date, except when the
        # provider explicitly orders topics by creation. Do not invent it from
        # wall-clock time or a different chat's coinciding message ID.
        next_offset = None
        if rows and coverage["hasMore"] is not False:
            last = rows[-1]
            if getattr(result, "order_by_create_date", False):
                date = stamp(getattr(last, "date", None))
            else:
                matches = [row for row in getattr(result, "messages", []) if row.id == last.top_message and u.get_peer_id(row.peer_id) == u.get_peer_id(entity)]
                date = stamp(matches[0].date) if len(matches) == 1 else None
            if date is not None:
                next_offset = {"offsetDate": date, "offsetId": last.top_message, "offsetTopic": last.id}
        return {"topics": projected, "coverage": coverage, "nextOffset": next_offset}
    if args.command == "topic-read":
        selected = await topic(client, entity, args.topic_id, r, f)
        return {"topic": topic_row(selected, r), **await search_page(client, entity, args, r, f, t, u, topic_id=selected.id)}
    if args.command == "pins":
        return await search_page(client, entity, args, r, f, t, u)
    if args.command == "poll":
        message = await poll_message(client, entity, args.message_id, r, f, u)
        return {"messageId": message.id, "poll": poll_state(message, r)[2]}
    if args.command in {"message-stats", "public-forwards"}:
        if type(entity).__name__ != "Channel" or not getattr(entity, "broadcast", False):
            raise r.TelegramRuntimeError("Message statistics require one broadcast channel.")
        await exact(client, entity, args.message_id, r, u)
        full = (await client(f.channels.GetFullChannelRequest(channel=entity))).full_chat
        if type(full).__name__ != "ChannelFull" or full.id != entity.id:
            raise r.TelegramRuntimeError("Mismatched statistics metadata.")
        if getattr(full, "can_view_stats", None) is not True:
            return {"available": False, "reason": "statistics_not_available_for_account"}
        dc = getattr(full, "stats_dc", None)
        if type(dc) is not int or not 0 < dc < 100:
            return {"available": False, "reason": "statistics_datacenter_unavailable"}
        if args.command == "message-stats":
            result = await c.stats_request(client, f.stats.GetMessageStatsRequest(channel=entity, msg_id=args.message_id), dc, u)
            if type(result).__name__ != "MessageStats":
                raise r.TelegramRuntimeError("Unexpected message statistics response.")
            graph = getattr(result, "views_graph" if args.graph == "views" else "reactions_by_emotion_graph", None)
            if type(graph).__name__ == "StatsGraphAsync":
                token = getattr(graph, "token", None)
                if isinstance(token, str) and 0 < len(token) <= 4096:
                    graph = await c.stats_request(client, f.stats.LoadAsyncGraphRequest(token=token), dc, u)
            return {"available": True, "messageId": args.message_id, "graph": {"name": args.graph, **c.public_graph(graph)}}
        if not isinstance(args.offset, str) or len(args.offset) > 1024:
            raise r.TelegramRuntimeError("Public-forward offset exceeds its bound.")
        result = await c.stats_request(client, f.stats.GetMessagePublicForwardsRequest(channel=entity, msg_id=args.message_id,
                                       offset=args.offset, limit=args.limit), dc, u)
        rows, projected = getattr(result, "forwards", []), []
        if len(rows) > args.limit:
            raise r.TelegramRuntimeError("Public-forward page exceeds its bound.")
        chats = {u.get_peer_id(chat): chat for chat in getattr(result, "chats", []) if type(chat).__name__ == "Channel" and getattr(chat, "broadcast", False) and getattr(chat, "username", None)}
        unsupported = 0
        for row in rows:
            message = getattr(row, "message", None)
            target = chats.get(u.get_peer_id(message.peer_id)) if message is not None else None
            if type(row).__name__ != "PublicForwardMessage" or target is None:
                unsupported += 1  # Stories/hidden channels remain outside this reader.
                continue
            r.exact_provider_message(message, target, message.id, u)
            projected.append({"chat": r.public_entity(target), "message": c.public_row(r, message, target)})
        offset = getattr(result, "next_offset", None)
        if offset is not None and (not isinstance(offset, str) or len(offset) > 1024):
            raise r.TelegramRuntimeError("Telegram returned an oversized public-forward offset.")
        return {"available": True, "messageId": args.message_id, "forwards": projected, "nextOffset": offset or None,
                "coverage": {"complete": not args.offset and not offset and unsupported == 0 and count(getattr(result, "count", None)) == len(rows),
                             "hasMore": bool(offset), "unsupported": unsupported,
                             "reportedTotal": count(getattr(result, "count", None)), "privateForwardsIncluded": False}}
    await admin(entity, r)
    if args.command == "invites":
        if args.offset_link and not re.fullmatch(r"https://t\.me/(?:\+|joinchat/)[A-Za-z0-9_-]{1,256}", args.offset_link):
            raise r.TelegramRuntimeError("Unsupported invite offset link.")
        result = await client(f.messages.GetExportedChatInvitesRequest(peer=entity, admin_id=t.InputUserSelf(), limit=args.limit,
                             offset_date=args.offset_date, offset_link=args.offset_link))
        rows = getattr(result, "invites", [])
        if len(rows) > args.limit:
            raise r.TelegramRuntimeError("Invite page exceeds its bound.")
        return {"invites": [invite_row(row, r) for row in rows], "scope": "own_admin_links",
                "coverage": page(rows, getattr(result, "count", None), args.limit),
                "nextOffset": {"offsetDate": stamp(rows[-1].date), "offsetLink": rows[-1].link} if rows else None}
    result, rows = await request_page(client, entity, r, f, t, u, limit=args.limit,
                                     offset_date=args.offset_date, offset_user=args.offset_user)
    users = {user.id: user for user in getattr(result, "users", [])}
    return {"requests": [{"userId": row.user_id, "user": r.public_entity(users[row.user_id]) if row.user_id in users else None,
                           "requestedAt": stamp(row.date), "about": (getattr(row, "about", None) or "")[:500],
                           "aboutTruncated": len(getattr(row, "about", None) or "") > 500} for row in rows],
            "coverage": page(rows, getattr(result, "count", None), args.limit),
            "nextOffset": {"offsetDate": stamp(rows[-1].date), "offsetUser": rows[-1].user_id} if rows else None}


async def self_reaction_identity(client, entity, account, r, f, u):
    # sendReaction/sendVote inherit Telegram's default send-as and have no
    # per-request override. Never silently act as a channel instead of the
    # personal account named in the preview. Do not change the saved default.
    if type(entity).__name__ == "Channel":
        full = (await client(f.channels.GetFullChannelRequest(channel=entity))).full_chat
        if type(full).__name__ != "ChannelFull" or full.id != entity.id:
            raise r.TelegramRuntimeError("Send-as metadata does not match the selected chat.")
        sender = getattr(full, "default_send_as", None)
        if sender is not None and u.get_peer_id(sender) != account.id:
            raise r.TelegramRuntimeError("Telegram default send-as is not this personal account; change it explicitly in Telegram first.")


async def reaction_snapshot(client, entity, message, r, f, u):
    response = await client(f.messages.GetMessagesReactionsRequest(peer=entity, id=[message.id]))
    rows = [update for update in getattr(response, "updates", [])
            if type(update).__name__ == "UpdateMessageReactions" and update.msg_id == message.id
            and u.get_peer_id(update.peer) == u.get_peer_id(entity)]
    if len(rows) != 1:
        raise r.TelegramRuntimeError("Telegram did not return exact fresh own reaction metadata.")
    message = copy.copy(message)
    message.reactions = rows[0].reactions
    return message


def own_reactions(message, r):
    result = r.public_message_reactions(message)
    if result is None:
        raise r.TelegramRuntimeError("Own reaction metadata is unavailable, not empty.")
    if (getattr(getattr(message, "reactions", None), "min", False) or not result["complete"]
            or any(row["chosen"] is None for row in result["results"])):
        raise r.TelegramRuntimeError("Own reaction state is unavailable; a replacement cannot be verified.")
    return [{key: value for key, value in row.items() if key in {"type", "emoji", "documentId"}}
            for row in result["results"] if row["chosen"]]


async def mutation(client, entity, args, identity, r, f, t, u, markdown):
    if (args.dry_run and args.approval_hash) or (not args.dry_run and not re.fullmatch(r"[0-9a-f]{64}", args.approval_hash or "")):
        raise r.TelegramRuntimeError("Prepare --dry-run, then the unchanged --confirm --approval-hash operation.")
    if not args.dry_run:
        r.assert_send_allowed(identity, confirmed=True)
    me = await client.get_me()
    operation = {"version": VERSION, "command": args.command, "chatId": u.get_peer_id(entity)}
    preview = {"command": args.command, "chat": r.public_entity(entity), "actingAccount": r.public_entity(me)}
    command, request = args.command, None
    native_sender, selected_sender = None, None
    if command in {"topic-send", "poll-create"} and getattr(args, "send_as", None) is not None:
        native_sender, selected_sender = await r.import_interaction_tools().select_sender(client, entity, me, args.send_as, r)
        operation["sender"] = preview["sender"] = selected_sender
    c = r.import_channel_tools()
    if command in {"react", "poll-vote", "poll-close", "pin", "unpin"}:
        message = await exact(client, entity, args.message_id, r, u)
        preview["message"] = c.public_row(r, message, entity)
        operation.update(messageId=message.id, content=c.content_snapshot(message, r))
        if command == "react":
            await self_reaction_identity(client, entity, me, r, f, u)
            emojis = args.emoji or []
            if len(emojis) > 3 or len(set(emojis)) != len(emojis) or any(not isinstance(value, str) or not value or len(value) > 32 or any(ch.isspace() for ch in value) for value in emojis):
                raise r.TelegramRuntimeError("Choose at most three distinct native emoji reactions, or --clear.")
            message = await reaction_snapshot(client, entity, message, r, f, u)
            before = own_reactions(message, r)
            operation.update(previous=before, emojis=emojis)
            preview.update(previousReactions=before, reactions=emojis, replacesOwnReactions=True)
            request = f.messages.SendReactionRequest(peer=entity, msg_id=message.id,
                        reaction=[t.ReactionEmoji(emoticon=value) for value in emojis], add_to_recent=False)
        elif command in {"poll-vote", "poll-close"}:
            message = await poll_message(client, entity, args.message_id, r, f, u)
            poll, options, public, definition = poll_state(message, r)
            preview["poll"] = public
            # Media includes volatile vote totals; replace that part of the
            # generic message digest with the stable, complete poll definition.
            operation["content"] = {"poll": definition, "text": getattr(message, "message", "")}
            if public["closed"]:
                raise r.TelegramRuntimeError("The selected poll is already closed.")
            if command == "poll-vote":
                await self_reaction_identity(client, entity, me, r, f, u)
                indices = args.option
                if (not public["resultsComplete"] or not 1 <= len(indices) <= len(options)
                        or len(set(indices)) != len(indices) or any(not 1 <= i <= len(options) for i in indices)
                        or (len(indices) > 1 and not public["multipleChoice"])):
                    raise r.TelegramRuntimeError("Choose valid 1-based options from a complete poll result.")
                operation["selected"] = sorted(indices)
                preview["selectedOptions"] = sorted(indices)
                request = f.messages.SendVoteRequest(peer=entity, msg_id=message.id, options=[options[i - 1][1] for i in indices])
            else:
                if not getattr(message, "out", False) and not getattr(poll, "creator", False):
                    raise r.TelegramRuntimeError("Only an own poll can be closed by this command.")
                closed = copy.copy(poll)
                closed.closed = True
                request = f.messages.EditMessageRequest(peer=entity, id=message.id, media=t.InputMediaPoll(poll=closed))
        else:
            operation.update(pinned=bool(getattr(message, "pinned", False)), notify=getattr(args, "notify", False))
            preview.update(pinned=command == "pin", notify=getattr(args, "notify", False))
            request = f.messages.UpdatePinnedMessageRequest(peer=entity, id=message.id, unpin=command == "unpin", silent=not getattr(args, "notify", False))
    elif command == "topic-send":
        selected = await topic(client, entity, args.topic_id, r, f)
        if getattr(selected, "closed", False) or getattr(selected, "hidden", False):
            raise r.TelegramRuntimeError("The selected topic is closed or hidden.")
        raw = r.edit_text(args)
        body, entities = markdown.parse(raw)
        text(body, 4096, r)
        operation.update(topic={key: value for key, value in topic_row(selected, r).items()
                                if key in {"id", "title", "closed", "hidden"}}, body=raw)
        options = r.import_authoring_tools().delivery_options(args)
        operation["deliveryOptions"] = options
        preview.update(topic=topic_row(selected, r), text=body, parseMode=r.TELEGRAM_TEXT_PARSE_MODE_NAME, deliveryOptions=options)
    elif command == "poll-create":
        question = text(args.question, 300, r)
        labels = [text(value, 100, r) for value in args.option]
        if not 2 <= len(labels) <= 10 or len(set(labels)) != len(labels):
            raise r.TelegramRuntimeError("A poll requires 2..10 distinct answers.")
        operation.update(question=question, options=labels, multiple=args.multiple, publicVoters=args.public_voters)
        preview.update(question=question, options=labels, multipleChoice=args.multiple, anonymous=not args.public_voters)
        poll = t.Poll(id=0, question=t.TextWithEntities(text=question, entities=[]), hash=0,
                      answers=[t.PollAnswer(text=t.TextWithEntities(text=label, entities=[]), option=bytes([i])) for i, label in enumerate(labels)],
                      multiple_choice=args.multiple, public_voters=args.public_voters)
        request = f.messages.SendMediaRequest(peer=entity, media=t.InputMediaPoll(poll=poll), message="", clear_draft=False, send_as=native_sender if selected_sender is not None else t.InputPeerSelf())
    elif command == "invite-create":
        await admin(entity, r)
        title = text(args.title, 32, r)
        expiry = r.parse_schedule_at(args.expires_at)
        if stamp(expiry) is None:
            raise r.TelegramRuntimeError("Invite expiration must fit Telegram's positive int32 timestamp.")
        if args.usage_limit is not None and args.request_needed:
            raise r.TelegramRuntimeError("Telegram does not allow usage-limit together with request-needed.")
        operation.update(title=title, expiresAt=stamp(expiry), usageLimit=args.usage_limit, requestNeeded=args.request_needed)
        preview.update({key: operation[key] for key in ("title", "expiresAt", "usageLimit", "requestNeeded")})
        request = f.messages.ExportChatInviteRequest(peer=entity, title=title, expire_date=expiry,
                    usage_limit=args.usage_limit, request_needed=args.request_needed, legacy_revoke_permanent=False)
    else:
        await admin(entity, r)
        pending = await find_request(client, entity, args.user_id, r, f, t, u)
        if pending is None:
            raise r.TelegramRuntimeError("This exact user has no pending join request in the checked list.")
        user = await r.resolve_entity(client, str(args.user_id))
        if type(user).__name__ != "User" or user.id != args.user_id:
            raise r.TelegramRuntimeError("The pending user identity does not match.")
        operation.update(userId=user.id, requestedAt=stamp(pending.date), decision=args.decision,
                         requestDigest=r.provider_content_digest(pending))
        preview.update(user=r.public_entity(user), requestedAt=stamp(pending.date), decision=args.decision)
        request = f.messages.HideChatJoinRequestRequest(peer=entity, user_id=u.get_input_user(user), approved=args.decision == "approve")
    bounded_result(preview, r, 20000)
    if args.dry_run:
        return {"dryRun": True, "approvalHash": r.scheduled_approval(identity, me.id, operation),
                "expiresInSeconds": r.MESSAGE_APPROVAL_TTL_SECONDS, "preview": preview}
    # No provider write (or upload) happens before this atomic, locked consume.
    # A lost reply, verification failure or disconnect never restores the token.
    if command in {"topic-send", "poll-create"} and (getattr(entity, "send_paid_messages_stars", None) or 0):
        raise r.TelegramRuntimeError("Paid Telegram destinations are unsupported.")
    if command == "invite-create":
        r.assert_schedule_lead_time(expiry)
    r.scheduled_approval(identity, me.id, operation, args.approval_hash)
    try:
        if command == "topic-send":
            sent = await client.send_message(entity, raw, reply_to=selected.id if selected.id != 1 else None,
                                            parse_mode=r.TELEGRAM_TEXT_PARSE_MODE, clear_draft=False, send_as=native_sender if selected_sender is not None else me, **options)
            sent = r.exact_provider_message(sent, entity, sent.id, u)
            delivered = await exact(client, entity, sent.id, r, u)
            r.import_authoring_tools().verify_delivery(delivered, args, r)
            if selected_sender is not None:
                r.import_interaction_tools().verify_sender(delivered, entity, selected_sender, r, u)
            if (not getattr(delivered, "out", False) or not in_topic(delivered, selected.id)
                    or delivered.message != body or r.provider_content_digest(getattr(delivered, "entities", None) or []) != r.provider_content_digest(entities)):
                raise ValueError
            result = {"sent": True, "topicId": selected.id, "message": c.public_row(r, delivered, entity)}
        else:
            response = await client(request)
            if command == "poll-create":
                rows = [getattr(update, "message", None) for update in getattr(response, "updates", [])
                        if type(update).__name__ in {"UpdateNewMessage", "UpdateNewChannelMessage"}]
                rows = [row for row in rows if row is not None and u.get_peer_id(row.peer_id) == u.get_peer_id(entity) and getattr(row, "out", False)]
                if len(rows) != 1:
                    raise ValueError
                delivered = await exact(client, entity, rows[0].id, r, u)
                if selected_sender is not None:
                    r.import_interaction_tools().verify_sender(delivered, entity, selected_sender, r, u)
                _poll, _opts, public, _definition = poll_state(delivered, r)
                if (public["question"] != question or [option["text"] for option in public["options"]] != labels
                        or public["multipleChoice"] != args.multiple or public["anonymous"] == args.public_voters or public["closed"]):
                    raise ValueError
                result = {"sent": True, "messageId": delivered.id, "poll": public}
            elif command == "invite-create":
                created = invite_row(response, r)
                verified = await client(f.messages.GetExportedChatInviteRequest(peer=entity, link=created["link"]))
                verified = invite_row(verified.invite, r)
                if any(verified[key] != operation[key] for key in ("title", "expiresAt", "usageLimit", "requestNeeded")) or verified["revoked"]:
                    raise ValueError
                result = {"created": True, "invite": verified}
            elif command == "join-request":
                if await find_request(client, entity, args.user_id, r, f, t, u) is not None:
                    raise ValueError
                if args.decision == "approve":
                    if type(entity).__name__ == "Channel":
                        member = await client(f.channels.GetParticipantRequest(channel=entity, participant=user))
                        participant = member.participant
                        if type(participant).__name__ not in {"ChannelParticipant", "ChannelParticipantSelf", "ChannelParticipantAdmin", "ChannelParticipantCreator"} or participant.user_id != user.id:
                            raise ValueError
                    else:
                        full = await client(f.messages.GetFullChatRequest(chat_id=entity.id))
                        if user.id not in [item.user_id for item in full.full_chat.participants.participants]:
                            raise ValueError
                result = {"applied": True, "userId": args.user_id, "decision": args.decision}
            else:
                after = (await poll_message(client, entity, message.id, r, f, u)
                         if command in {"poll-vote", "poll-close"} else await exact(client, entity, message.id, r, u))
                if command == "react":
                    if c.content_snapshot(after, r) != operation["content"]:
                        raise ValueError
                    after = await reaction_snapshot(client, entity, after, r, f, u)
                    chosen = own_reactions(after, r)
                    if any(row["type"] != "emoji" for row in chosen) or {row["emoji"] for row in chosen} != set(emojis):
                        raise ValueError
                elif command == "poll-vote":
                    _poll, _options, public, after_definition = poll_state(after, r)
                    if {k: v for k, v in after_definition.items() if k != "choices"} != {k: v for k, v in definition.items() if k != "choices"}:
                        raise ValueError
                    if not public["resultsComplete"] or [option["index"] for option in public["options"] if option["chosen"]] != sorted(indices):
                        raise ValueError
                elif command == "poll-close":
                    _poll, _options, public, after_definition = poll_state(after, r)
                    if not public["closed"] or {k: v for k, v in after_definition.items() if k not in {"closed", "choices"}} != {k: v for k, v in definition.items() if k not in {"closed", "choices"}}:
                        raise ValueError
                elif getattr(after, "pinned", None) is not (command == "pin") or c.content_snapshot(after, r) != operation["content"]:
                    raise ValueError
                result = {"applied": True, "message": c.public_row(r, after, entity)}
        return bounded_result(result, r)
    except Exception as error:
        raise r.TelegramRuntimeError("Telegram action was dispatched but its result is not fully verified. Read back exact state before any retry.",
                                     code="TELEGRAM_ACTION_OUTCOME_UNKNOWN") from error


async def run(args, identity, r):
    r.import_telethon_workflows()  # Fail before IO when an old SDK lacks the current TL layer.
    client = r.build_client(args, identity)
    failure, dispatched = None, False
    try:
        await r.ensure_authorized(client)
        entity = await r.resolve_entity(client, args.chat)
        f, t, u, markdown = api()
        if args.command in READS:
            result = await read_command(client, entity, args, r, f, t, u)
            return bounded_result({"securityBoundary": "chat-only", "chat": r.public_entity(entity),
                                   "readState": {"marksRead": False, "mode": "scoped-read"}, **result}, r)
        result = await mutation(client, entity, args, identity, r, f, t, u, markdown)
        dispatched = not args.dry_run
        return {"securityBoundary": "chat-only", **result}
    except r.TelegramRuntimeError as error:
        failure = error
        raise
    except Exception as error:
        failure = r.TelegramRuntimeError("Telegram operation is unavailable; no conclusive result was returned.")
        raise failure from error
    finally:
        try:
            await client.disconnect()
        except Exception as error:
            if failure is None:
                raise r.TelegramRuntimeError("Telegram cleanup failed; verify the exact action before retrying.",
                         code="TELEGRAM_ACTION_OUTCOME_UNKNOWN" if dispatched else None) from error
