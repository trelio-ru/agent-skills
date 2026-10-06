"""Behavioral provider contracts without a personal Telegram session or network.

The fake server keeps ordinary and scheduled IDs separate, can deliver messages
between operations, and exposes public search hits beside my_results. Tests
assert observable scope and side effects rather than instruction wording.
"""

import asyncio
import importlib.util
import pathlib
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace as NS
from unittest import mock


SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "trelio-telegram.py"
SPEC = importlib.util.spec_from_file_location("telegram_workflows_test_runtime", SCRIPT)
M = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = M
SPEC.loader.exec_module(M)


class TL(NS):
    def to_dict(self):
        return {"_": type(self).__name__, **vars(self)}


def tl_type(name):
    return type(name, (TL,), {})


User, Channel, PeerUser, PeerChannel = map(tl_type, ("User", "Channel", "PeerUser", "PeerChannel"))
Message = tl_type("Message")
UpdateTranscribedAudio = tl_type("UpdateTranscribedAudio")
UpdateDeleteScheduledMessages = tl_type("UpdateDeleteScheduledMessages")
FUNCTIONS = NS(**{name: tl_type(name) for name in (
    "GetDiscussionMessageRequest", "GetRepliesRequest", "SearchRequest", "SearchGlobalRequest",
    "GetScheduledMessagesRequest", "GetDialogFiltersRequest", "EditMessageRequest", "DeleteScheduledMessagesRequest",
    "SendScheduledMessagesRequest", "TranscribeAudioRequest", "GetPeerDialogsRequest",
)})
TYPES = NS(**{name: tl_type(name) for name in M.SEARCH_MEDIA_FILTERS.values()},
           UpdateTranscribedAudio=UpdateTranscribedAudio)


def peer_id(entity):
    if isinstance(entity, int):
        return entity
    if hasattr(entity, "channel_id"):
        return -1_000_000_000_000 - entity.channel_id
    if isinstance(entity, Channel):
        return -1_000_000_000_000 - entity.id
    return getattr(entity, "user_id", getattr(entity, "id", None))


def markdown(text):
    if text.startswith("**") and text.endswith("**"):
        plain = text[2:-2]
        return plain, [tl_type("MessageEntityBold")(offset=0, length=len(plain))]
    return text, []


class Client:
    def __init__(self, group):
        self.group = group
        self.account = User(id=1, first_name="Владелец")
        self.messages = {}
        self.calls = []
        self.reads = []
        self.handler = None
        self.disconnect = mock.AsyncMock()
        self.send_message = mock.AsyncMock()
        self.dispatch = lambda request: NS(messages=[], users=[], chats=[], updates=[])

    async def __call__(self, request):
        self.calls.append(request)
        result = self.dispatch(request)
        if asyncio.iscoroutine(result):
            return await result
        return result

    async def get_entity(self, reference):
        if reference in ("@alice", 8):
            return User(id=8, first_name="Алиса")
        return self.group

    async def get_input_entity(self, reference):
        if reference == "@alice":
            return User(id=8, first_name="Алиса")
        return reference

    async def get_messages(self, entity, *, ids):
        self.reads.append((peer_id(entity), ids))
        return self.messages.get((peer_id(entity), ids))

    async def get_me(self):
        return self.account

    def iter_dialogs(self, **_kwargs):
        raise AssertionError("Server search must not scan recent dialogs")

    def add_event_handler(self, handler, event):
        self.handler = handler

    def remove_event_handler(self, handler):
        assert handler is self.handler
        self.handler = None


class MessageWorkflowsTests(unittest.TestCase):
    def setUp(self):
        self.group = Channel(id=77, title="Старая группа", username="old_group", broadcast=False)
        self.client = Client(self.group)
        self.identity = M.Identity("company", "member", "connection")
        self.temp = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(mock.patch.object(M, "connection_root", return_value=pathlib.Path(self.temp)))
        self.enterContext(mock.patch.object(M, "build_client", return_value=self.client))
        self.enterContext(mock.patch.object(M, "ensure_authorized", new=mock.AsyncMock()))
        self.enterContext(mock.patch.object(M, "load_policy", return_value={"sendMode": "confirm"}))
        self.enterContext(mock.patch.object(M, "utc_now", return_value=datetime(2026, 9, 5, tzinfo=timezone.utc)))
        self.enterContext(mock.patch.object(M, "import_telethon_workflows", return_value=(
            FUNCTIONS, TYPES, NS(get_peer_id=peer_id), NS(Raw=lambda value: value), NS(parse=markdown),
        )))
        self.enterContext(mock.patch.object(M, "import_telethon_dialog_search", return_value=(
            FUNCTIONS.SearchRequest, FUNCTIONS.GetPeerDialogsRequest,
            lambda peer: NS(peer=peer), NS(get_peer_id=peer_id),
        )))

    def args(self, *args):
        return M.build_parser().parse_args(list(args))

    def call(self, function, *args):
        return asyncio.run(function(self.args(*args), self.identity))

    def message(self, message_id=42, **overrides):
        values = dict(id=message_id, peer_id=PeerChannel(channel_id=77),
                      date=datetime(2026, 9, 7, 12, tzinfo=timezone.utc), out=True,
                      message="Исходный текст", entities=[], media=None, file=None,
                      sender=None, reply_to=None, reply_to_msg_id=None, action=None)
        values.update(overrides)
        message = Message(**values)
        self.client.messages[(peer_id(message.peer_id), message_id)] = message
        return message

    def test_message_links_preserve_public_private_topic_and_comment_identity(self):
        cases = [
            ("https://t.me/old_group/42", ("@old_group", 42, None, None)),
            ("t.me/c/77/11/42", ("-1000000000077", 42, 11, None)),
            ("https://t.me/old_group/11/42?thread=11", ("@old_group", 42, 11, None)),
            ("https://t.me/old_group/42?comment=91", ("@old_group", 42, None, 91)),
            ("tg://privatepost?channel=77&post=42", ("-1000000000077", 42, None, None)),
            ("tg://resolve?domain=old_group&post=42&thread=11", ("@old_group", 42, 11, None)),
        ]
        for link, expected in cases:
            with self.subTest(link=link):
                reference = M.message_reference(self.args("read", "--link", link))
                self.assertEqual((reference.chat, reference.message_id, reference.thread_id, reference.comment_id), expected)

    def test_invalid_or_conflicting_links_fail_before_provider_calls(self):
        for link in ("https://evil.example/old_group/42", "https://t.me/old_group/42?comment=1&comment=2",
                     "https://t.me/old_group/11/42?thread=12", "https://t.me/old_group/42?start=action",
                     "https://user@t.me/old_group/42", "https://t.me/old_group/0", "https://t.me/+invite",
                     "https://t.me/old_group/s/42", "tg://resolve?domain=old_group&post=-1"):
            with self.subTest(link=link), self.assertRaises(M.TelegramRuntimeError):
                self.call(M.command_message_read_async, "read", "--link", link)
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.client.reads, [])

    def test_exact_read_does_not_read_recent_history_and_returns_source_link(self):
        self.message()
        result = self.call(M.command_read_async, "read", "--link", "https://t.me/old_group/42")
        self.assertEqual(self.client.reads, [(-1000000000077, 42)])
        self.assertEqual(result["message"]["link"], "https://t.me/old_group/42")
        self.assertFalse(result["readState"]["marksRead"])

    def test_read_context_uses_the_resolved_chat_even_without_a_message_cache(self):
        self.message()
        async def history():
            if False:
                yield None
        self.client.iter_messages = mock.Mock(side_effect=lambda *_a, **_kw: history())
        result = self.call(M.command_read_async, "read", "--chat", "old_group", "--message-id", "42", "--context", "2")
        self.assertTrue(result["context"]["coverage"]["complete"])
        self.assertEqual(result["context"]["matchIndex"], 0)
        self.assertEqual(self.client.iter_messages.call_count, 2)

    def test_exact_message_rejects_wrong_peer_and_wrong_topic(self):
        self.message(reply_to=TL(reply_to_msg_id=11, reply_to_top_id=11, forum_topic=True))
        with self.assertRaisesRegex(M.TelegramRuntimeError, "thread"):
            self.call(M.command_read_async, "read", "--link", "https://t.me/old_group/12/42")
        self.client.messages[(-1000000000077, 42)].peer_id = PeerChannel(channel_id=99)
        with self.assertRaisesRegex(M.TelegramRuntimeError, "another chat"):
            self.call(M.command_read_async, "read", "--chat", "old_group", "--message-id", "42")

    def test_comment_link_resolves_the_group_using_channel_provenance_not_id_order(self):
        channel = Channel(id=66, title="Канал", username="news_channel", broadcast=True)
        self.client.group = channel
        self.message(5, peer_id=PeerChannel(channel_id=66))
        root = self.message(100, fwd_from=TL(from_id=PeerChannel(channel_id=66), channel_post=5))
        self.message(101, reply_to=TL(reply_to_msg_id=100, reply_to_top_id=None))
        self.client.dispatch = lambda _request: NS(messages=[root], chats=[self.group], users=[])
        result = self.call(M.command_read_async, "read", "--link", "https://t.me/news_channel/5?comment=101")
        self.assertEqual(result["chat"]["id"], 77)
        self.assertEqual(result["message"]["id"], 101)

    def test_reply_preserves_exact_message_and_topic_and_checks_provider_receipt(self):
        header = TL(reply_to_msg_id=11, reply_to_top_id=11, forum_topic=True)
        self.message(reply_to=header)
        sent = self.message(99, message="Ответ", reply_to_msg_id=42,
                            reply_to=TL(reply_to_msg_id=42, reply_to_top_id=11, forum_topic=True))
        self.client.send_message.return_value = sent
        result = self.call(M.command_reply_async, "reply", "--link", "https://t.me/old_group/11/42", "--message", "Ответ", "--confirm")
        self.assertEqual(result["replyToMessageId"], 42)
        self.client.send_message.assert_awaited_once_with(self.group, "Ответ", reply_to=42, file=None, parse_mode="md")
        sent.reply_to_msg_id = 43
        with self.assertRaisesRegex(M.TelegramRuntimeError, "ambiguous"):
            self.call(M.command_reply_async, "reply", "--chat", "old_group", "--message-id", "42", "--message", "Ответ", "--confirm")
        self.assertEqual(self.client.send_message.await_count, 2)

    def test_reply_respects_read_only_policy_before_connecting(self):
        with mock.patch.object(M, "load_policy", return_value={"sendMode": "read-only"}):
            with self.assertRaisesRegex(M.TelegramRuntimeError, "read-only"):
                self.call(M.command_reply_async, "reply", "--chat", "old_group", "--message-id", "42", "--message", "Ответ", "--confirm")
        self.client.send_message.assert_not_awaited()

    def test_thread_returns_chronological_bounded_page_and_exclusive_continuation(self):
        self.message(11)
        self.message(42, reply_to=TL(reply_to_top_id=11))
        rows = [self.message(i, reply_to=TL(reply_to_top_id=11)) for i in (44, 43, 42)]
        self.client.dispatch = lambda _request: NS(messages=rows, users=[], chats=[self.group])
        result = self.call(M.command_thread_async, "thread", "--chat", "old_group", "--message-id", "42", "--limit", "2")
        self.assertEqual([m["id"] for m in result["messages"]], [43, 44])
        self.assertEqual(result["coverage"]["nextBeforeId"], 43)
        self.assertFalse(result["coverage"]["complete"])
        self.assertEqual(self.client.calls[0].msg_id, 11)

    def test_dialog_search_finds_old_group_without_enumerating_recent_dialogs(self):
        public = Channel(id=88, title="Публичная одноимённая группа", username="public_group")
        def provider(request):
            if type(request).__name__ == "SearchRequest":
                self.assertEqual(request.q, "Старая группа")
                self.assertEqual(request.limit, 1)
                return NS(my_results=[PeerChannel(channel_id=77)], results=[PeerChannel(channel_id=88)],
                          chats=[public, self.group], users=[])
            self.assertEqual(len(request.peers), 1)
            return NS(dialogs=[NS(peer=PeerChannel(channel_id=77), unread_count=3)])
        self.client.dispatch = provider
        result = self.call(M.command_dialogs_async, "dialogs", "--query", "Старая группа", "--limit", "1")
        self.assertEqual(result["dialogs"], [{"id": -1000000000077, "title": "Старая группа",
                                            "unreadCount": 3, "entity": M.public_entity(self.group)}])
        self.assertEqual(result["coverage"]["scope"], "my_results")
        self.assertFalse(result["coverage"]["complete"])
        self.assertFalse(result["coverage"]["publicResultsIncluded"])

    def test_public_only_search_stays_empty_and_does_not_claim_exhaustiveness(self):
        self.client.dispatch = lambda _request: NS(my_results=[], results=[PeerChannel(channel_id=77)], chats=[self.group], users=[])
        result = self.call(M.command_dialogs_async, "dialogs", "--query", "Публичная")
        self.assertEqual(result["dialogs"], [])
        self.assertIsNone(result["coverage"]["hasMore"])
        self.assertFalse(result["coverage"]["complete"])
        self.assertEqual(len(self.client.calls), 1)

    def test_unavailable_unread_count_is_null_and_never_faked_as_zero(self):
        def provider(request):
            if type(request).__name__ == "GetPeerDialogsRequest":
                raise TimeoutError("private diagnostic")
            return NS(my_results=[PeerChannel(channel_id=77)], results=[], chats=[self.group], users=[])
        self.client.dispatch = provider
        result = self.call(M.command_dialogs_async, "dialogs", "--query", "Старая")
        self.assertIsNone(result["dialogs"][0]["unreadCount"])
        self.assertFalse(result["coverage"]["unreadCountsComplete"])
        self.assertNotIn("private diagnostic", str(result))

    def test_author_and_media_avoid_the_unsupported_native_combination(self):
        self.client.dispatch = lambda _request: NS(messages=[], users=[], chats=[])
        result = self.call(M.command_search_async, "search", "--chat", "old_group", "--from", "@alice",
                           "--media-type", "document", "--since", "2026-08-01", "--until", "2026-09-01")
        request = self.client.calls[0]
        self.assertEqual(type(request.filter).__name__, "InputMessagesFilterDocument")
        self.assertIsNone(request.from_id)
        self.assertEqual(result["coverage"]["authorFilter"], "bounded_local")
        self.assertEqual(request.q, "")
        self.assertEqual(request.min_date.isoformat(), "2026-07-31T20:59:59+00:00")
        self.assertEqual(request.max_date.isoformat(), "2026-08-31T21:00:00+00:00")
        self.assertTrue(result["coverage"]["complete"])

    def test_combined_media_search_keeps_only_the_exact_author(self):
        rows = [self.message(44, from_id=PeerUser(user_id=9)), self.message(43, from_id=PeerUser(user_id=8))]
        def provider(request):
            # Reproduce Telegram's RPC failure on the unsupported combination.
            if request.from_id is not None:
                raise RuntimeError("native author/media combination is unavailable")
            return NS(messages=rows, users=[], chats=[self.group])
        self.client.dispatch = provider
        result = self.call(M.command_search_async, "search", "--chat", "old_group", "--from", "@alice", "--media-type", "document")
        self.assertEqual([m["id"] for m in result["messages"]], [43])
        self.assertTrue(result["coverage"]["complete"])

    def test_private_chat_author_is_checked_when_telegram_ignores_from_id(self):
        private = User(id=8, first_name="Алиса")
        self.client.get_entity = mock.AsyncMock(return_value=private)
        rows = [self.message(44, peer_id=PeerUser(user_id=8), out=True),
                self.message(43, peer_id=PeerUser(user_id=8), out=False)]
        self.client.dispatch = lambda _request: NS(messages=rows, users=[private], chats=[])
        result = self.call(M.command_search_async, "search", "--chat", "@alice", "--from", "@alice")
        self.assertIsNone(self.client.calls[0].from_id)
        self.assertEqual([m["id"] for m in result["messages"]], [43])
        self.assertEqual(result["coverage"]["authorFilter"], "bounded_local")

    def test_empty_local_filter_page_keeps_a_cursor_after_1000_native_hits(self):
        rows = [self.message(i, from_id=PeerUser(user_id=8 if i == 1000 else 9)) for i in range(2000, 999, -1)]
        def provider(request):
            self.assertLessEqual(request.limit, 100)
            candidates = [m for m in rows if not request.offset_id or m.id < request.offset_id]
            return NS(messages=candidates[:request.limit], users=[], chats=[self.group])
        self.client.dispatch = provider
        args = ("search", "--chat", "old_group", "--from", "@alice", "--media-type", "document", "--limit", "1")
        first = self.call(M.command_search_async, *args, "--pages", "1")
        self.assertEqual(first["messages"], [])
        self.assertEqual(first["coverage"]["scanned"], 1000)
        self.assertTrue(first["coverage"]["scanLimitReached"])
        self.assertTrue(first["coverage"]["hasMore"])
        self.assertFalse(first["coverage"]["complete"])
        self.assertEqual(first["coverage"]["nextBeforeId"], 1001)
        second = self.call(M.command_search_async, *args, "--before-id", "1001")
        self.assertEqual([m["id"] for m in second["messages"]], [1000])
        self.assertFalse(second["coverage"]["complete"])

    def test_date_bounds_are_verified_when_media_search_ignores_them(self):
        rows = [self.message(44, date=datetime(2026, 9, 3, tzinfo=timezone.utc)),
                self.message(43, date=datetime(2026, 9, 2, tzinfo=timezone.utc)),
                self.message(42, date=datetime(2026, 8, 30, tzinfo=timezone.utc))]
        self.client.dispatch = lambda _request: NS(messages=rows, users=[], chats=[self.group])
        result = self.call(M.command_search_async, "search", "--chat", "old_group", "--media-type", "document",
                           "--since", "2026-09-01T00:00:00Z", "--until", "2026-09-03T00:00:00Z")
        self.assertEqual([m["id"] for m in result["messages"]], [43])

    def test_global_dates_alone_fail_before_an_unsupported_provider_request(self):
        with self.assertRaisesRegex(M.TelegramRuntimeError, "dates alone"):
            self.call(M.command_search_async, "search", "--global", "--since", "2026-09-01")
        self.assertEqual(self.client.calls, [])

    def test_numeric_author_is_resolved_as_peer_id_instead_of_phone_string(self):
        with mock.patch.object(self.client, "get_entity", wraps=self.client.get_entity) as resolve:
            self.call(M.command_search_async, "search", "--chat", "old_group", "--from", "8")
        self.assertIn(mock.call(8), resolve.call_args_list)
        self.assertNotIn(mock.call("8"), resolve.call_args_list)
        self.assertEqual(self.client.calls[0].from_id.id, 8)

    def test_fractional_search_boundaries_preserve_half_open_second_precision(self):
        self.call(M.command_search_async, "search", "--chat", "old_group",
                  "--since", "2026-09-01T00:00:00.5Z", "--until", "2026-09-02T00:00:00.5Z")
        request = self.client.calls[0]
        self.assertEqual(request.min_date.isoformat(), "2026-09-01T00:00:00+00:00")
        self.assertEqual(request.max_date.isoformat(), "2026-09-02T00:00:01+00:00")

    def test_out_of_range_search_date_cannot_wrap_to_another_period(self):
        with self.assertRaisesRegex(M.TelegramRuntimeError, "timestamp range"):
            self.call(M.command_search_async, "search", "--chat", "old_group", "--until", "2100-01-01")
        self.assertEqual(self.client.calls, [])

    def test_filtered_search_traverses_provider_pages_instead_of_treating_100_as_complete(self):
        rows = [self.message(i) for i in range(300, 99, -1)]
        def provider(request):
            self.assertLessEqual(request.limit, 100)
            selected = [m for m in rows if not request.offset_id or m.id < request.offset_id]
            return NS(messages=selected[:request.limit], users=[], chats=[self.group])
        self.client.dispatch = provider
        result = self.call(M.command_search_async, "search", "--chat", "old_group", "--media-type", "document", "--limit", "200")
        self.assertEqual(len(result["messages"]), 200)
        self.assertEqual(len(self.client.calls), 4)
        self.assertEqual(result["coverage"]["nextBeforeId"], 101)
        self.assertTrue(result["coverage"]["hasMore"])
        self.assertFalse(result["coverage"]["complete"])

    def test_thread_at_provider_ceiling_has_continuation_and_wrong_thread_is_rejected(self):
        self.message(1)
        rows = [self.message(i, reply_to=TL(reply_to_top_id=1)) for i in range(200, 100, -1)]
        self.client.dispatch = lambda _request: NS(messages=rows, users=[], chats=[self.group])
        result = self.call(M.command_thread_async, "thread", "--chat", "old_group", "--message-id", "1", "--limit", "100")
        self.assertTrue(result["coverage"]["hasMore"])
        self.assertEqual(self.client.calls[0].limit, 100)
        rows[0].reply_to = TL(reply_to_top_id=2)
        with self.assertRaisesRegex(M.TelegramRuntimeError, "outside"):
            self.call(M.command_thread_async, "thread", "--chat", "old_group", "--message-id", "1")

    def test_dialog_limit_caps_own_results_and_missing_entities_stay_explicit(self):
        extra = Channel(id=79, title="Вторая старая группа", username="another_group")
        def provider(request):
            if type(request).__name__ == "SearchRequest":
                return NS(my_results=[PeerChannel(channel_id=77), PeerChannel(channel_id=79), PeerChannel(channel_id=80)],
                          results=[], chats=[self.group, extra], users=[])
            return NS(dialogs=[])
        self.client.dispatch = provider
        result = self.call(M.command_dialogs_async, "dialogs", "--query", "старая", "--limit", "1")
        self.assertEqual(len(result["dialogs"]), 1)
        self.assertIn("own_result_entity_unavailable", result["coverage"]["incompleteReasons"])
        self.assertTrue(result["coverage"]["limitReached"])

    def test_scheduled_confirmation_is_required_and_read_only_blocks(self):
        self.scheduled_server(self.message())
        preview = self.preview("scheduled-cancel")
        with mock.patch.object(M, "load_policy", return_value={"sendMode": "read-only"}):
            with self.assertRaisesRegex(M.TelegramRuntimeError, "read-only"):
                self.execute("scheduled-cancel", preview)
        with mock.patch.object(M, "load_policy", return_value={"sendMode": "confirm"}):
            with self.assertRaisesRegex(M.TelegramRuntimeError, "approval-hash"):
                self.call(M.command_scheduled_mutation_async, "scheduled-cancel", "--chat", "old_group", "--message-id", "42", "--confirm")
        self.assertTrue(all(type(r).__name__ == "GetScheduledMessagesRequest" for r in self.client.calls))

    def test_transcription_rejects_non_voice_before_using_quota(self):
        self.message(document=TL(id=4))
        with self.assertRaisesRegex(M.TelegramRuntimeError, "voice"):
            self.call(M.command_transcribe_async, "transcribe", "--chat", "old_group", "--message-id", "42")
        self.assertEqual(self.client.calls, [])

    def test_schedule_rechecks_time_at_execution_before_mutating(self):
        self.scheduled_server(self.message())
        preview = self.preview("scheduled-edit", "--schedule-at", "2026-09-08T12:00:00Z")
        with mock.patch.object(M, "utc_now", return_value=datetime(2026, 9, 8, 11, 59, 30, tzinfo=timezone.utc)):
            with self.assertRaisesRegex(M.TelegramRuntimeError, "60 seconds"):
                self.execute("scheduled-edit", preview, "--schedule-at", "2026-09-08T12:00:00Z")
        self.assertTrue(all(type(r).__name__ == "GetScheduledMessagesRequest" for r in self.client.calls))

    def test_global_sender_filter_is_rejected_instead_of_silently_excluding_channels(self):
        with self.assertRaisesRegex(M.TelegramRuntimeError, "no sender filter"):
            self.call(M.command_search_async, "search", "--global", "--from", "@alice", "--query", "отчёт")
        self.assertEqual(self.client.calls, [])

    def test_filtered_global_cursor_is_bound_to_dates_and_media(self):
        message = self.message()
        message.input_chat = self.group
        self.client.dispatch = lambda _request: NS(messages=[message], users=[], chats=[self.group], count=2, next_rate=1)
        with mock.patch.object(M, "import_telethon_global_search", return_value=(
            FUNCTIONS.SearchGlobalRequest, TYPES.InputMessagesFilterEmpty, lambda: NS(), tl_type("MessageEmpty"), NS(get_peer_id=peer_id),
        )):
            first = self.call(M.command_search_async, "search", "--global", "--query", "отчёт", "--media-type", "document", "--limit", "1")
            token = first["coverage"]["nextCursor"]
            self.assertTrue(token)
            with self.assertRaisesRegex(M.TelegramRuntimeError, "does not belong"):
                self.call(M.command_search_async, "search", "--global", "--query", "отчёт", "--media-type", "voice", "--cursor", token)
        self.assertEqual(len(self.client.calls), 1)

    def test_transcription_handles_early_update_and_ignores_other_messages(self):
        self.message(voice=TL(id=3))
        async def provider(request):
            await self.client.handler(UpdateTranscribedAudio(peer=PeerChannel(channel_id=99), msg_id=42,
                                                            transcription_id=5, text="Чужой текст", pending=False))
            await self.client.handler(UpdateTranscribedAudio(peer=PeerChannel(channel_id=77), msg_id=42,
                                                            transcription_id=5, text="Готовая расшифровка", pending=False))
            return NS(transcription_id=5, text="", pending=True, trial_remains_num=1)
        self.client.dispatch = provider
        result = self.call(M.command_transcribe_async, "transcribe", "--chat", "old_group", "--message-id", "42")
        self.assertTrue(result["complete"])
        self.assertEqual(result["text"], "Готовая расшифровка")
        self.assertEqual(result["remainingTrialCount"], 1)
        self.assertEqual(len(self.client.calls), 1)
        self.assertIsNone(self.client.handler)

    def test_transcription_pending_does_not_resubmit_or_claim_completion(self):
        self.message(voice=TL(id=3))
        self.client.dispatch = lambda _request: NS(transcription_id=5, text="Начало", pending=True)
        result = self.call(M.command_transcribe_async, "transcribe", "--chat", "old_group", "--message-id", "42", "--wait-seconds", "0")
        self.assertTrue(result["pending"])
        self.assertFalse(result["complete"])
        self.assertFalse(result["automaticRetry"])
        self.assertEqual(len(self.client.calls), 1)

    def test_transcription_quota_failure_is_safe_and_does_not_fallback(self):
        self.message(voice=TL(id=3))
        error = RuntimeError("secret provider diagnostic")
        error.message = "PREMIUM_ACCOUNT_REQUIRED"
        def provider(_request):
            raise error
        self.client.dispatch = provider
        result = self.call(M.command_transcribe_async, "transcribe", "--chat", "old_group", "--message-id", "42")
        self.assertEqual(result["reason"], "premium_or_quota_required")
        self.assertNotIn("secret provider diagnostic", str(result))
        self.assertEqual(len(self.client.calls), 1)

    def scheduled_server(self, target, *, delivery_race=False, no_delivery_proof=False, fail_write=False):
        queue = {target.id: target}
        def provider(request):
            name = type(request).__name__
            if name == "GetScheduledMessagesRequest":
                return NS(messages=[queue[i] for i in request.id if i in queue], users=[], chats=[self.group])
            if fail_write:
                raise TimeoutError("lost response")
            if name == "EditMessageRequest":
                entry = queue[request.id]
                if request.message is not None:
                    entry.message, entry.entities = request.message, request.entities
                entry.date = request.schedule_date
                return NS(updates=[])
            entry = queue.pop(request.id[0])
            delivered = name == "SendScheduledMessagesRequest" or delivery_race
            if delivered:
                values = {**vars(entry), "id": 999, "from_scheduled": True}
                values.pop("peer_id")
                self.message(999, **{k: v for k, v in values.items() if k != "id"})
            update = UpdateDeleteScheduledMessages(peer=PeerChannel(channel_id=77), messages=[entry.id],
                                                    sent_messages=[999] if delivered and not no_delivery_proof else None)
            return NS(updates=[update])
        self.client.dispatch = provider
        return queue

    def preview(self, command, *extra):
        return self.call(M.command_scheduled_mutation_async, command, "--chat", "old_group", "--message-id", "42", *extra, "--dry-run")

    def execute(self, command, preview, *extra):
        return self.call(M.command_scheduled_mutation_async, command, "--chat", "old_group", "--message-id", "42", *extra,
                         "--confirm", "--approval-hash", preview["approvalHash"])

    def test_scheduled_body_edit_always_addresses_queue_not_colliding_history_id(self):
        target = self.message()
        self.scheduled_server(target)
        self.client.messages[(-1000000000077, 42)] = self.message(42, message="Другая обычная реплика")
        preview = self.preview("scheduled-edit", "--message", "**Новый текст**")
        result = self.execute("scheduled-edit", preview, "--message", "**Новый текст**")
        edit = next(r for r in self.client.calls if type(r).__name__ == "EditMessageRequest")
        self.assertEqual(edit.schedule_date, datetime(2026, 9, 7, 12, tzinfo=timezone.utc))
        self.assertEqual(result["message"]["text"], "Новый текст")
        self.assertEqual(self.client.messages[(-1000000000077, 42)].message, "Другая обычная реплика")
        self.assertEqual(self.client.reads, [])

    def test_reschedule_preserves_body_formatting_attachment_and_repetition(self):
        target = self.message(media=TL(document=TL(id=4, file_reference=b"private")),
                              entities=[TL(offset=0, length=8)], schedule_repeat_period=86400)
        self.scheduled_server(target)
        preview = self.preview("scheduled-edit", "--schedule-at", "2026-09-08T15:00:00+03:00")
        result = self.execute("scheduled-edit", preview, "--schedule-at", "2026-09-08T15:00:00+03:00")
        self.assertEqual(result["scheduledAt"], "2026-09-08T12:00:00Z")
        edit = next(r for r in self.client.calls if type(r).__name__ == "EditMessageRequest")
        self.assertIsNone(edit.message)
        self.assertIsNone(edit.entities)
        self.assertNotIn("private", str(preview))
        self.assertEqual(target.schedule_repeat_period, 86400)

    def test_schedule_approval_rejects_changed_target_account_runtime_and_expiry(self):
        for change in ("target", "account", "runtime", "expiry"):
            with self.subTest(change=change):
                target = self.message()
                self.client.account.id = 1
                self.scheduled_server(target)
                preview = self.preview("scheduled-cancel")
                if change == "target": target.message = "Изменено другим клиентом"
                if change == "account": self.client.account.id = 2
                # Runtime changes must differ from the current release. Keep
                # unrelated cases on that release so they prove their own
                # target/account boundary rather than an incidental mismatch.
                patch = mock.patch.object(M, "MESSAGE_WORKFLOW_VERSION", M.MESSAGE_WORKFLOW_VERSION + "-changed") if change == "runtime" else (
                    mock.patch.object(M.time, "time", return_value=M.time.time() + 301) if change == "expiry" else mock.patch.object(M, "MESSAGE_WORKFLOW_VERSION", M.MESSAGE_WORKFLOW_VERSION))
                count = len(self.client.calls)
                with patch, self.assertRaisesRegex(M.TelegramRuntimeError, "approval"):
                    self.execute("scheduled-cancel", preview)
                self.assertTrue(all(type(r).__name__ == "GetScheduledMessagesRequest" for r in self.client.calls[count:]))

    def test_cancel_requires_provider_proof_and_consumes_approval(self):
        self.scheduled_server(self.message())
        preview = self.preview("scheduled-cancel")
        result = self.execute("scheduled-cancel", preview)
        self.assertTrue(result["cancelled"])
        self.assertFalse((pathlib.Path(self.temp) / "config/message-operation-approval.json").exists())
        with self.assertRaises(M.TelegramRuntimeError):
            self.execute("scheduled-cancel", preview)
        self.assertEqual(sum(type(r).__name__ == "DeleteScheduledMessagesRequest" for r in self.client.calls), 1)

    def test_cancel_does_not_claim_success_when_delivery_wins_the_race(self):
        self.scheduled_server(self.message(), delivery_race=True)
        preview = self.preview("scheduled-cancel")
        with self.assertRaisesRegex(M.TelegramRuntimeError, "ambiguous"):
            self.execute("scheduled-cancel", preview)

    def test_send_now_returns_verified_normal_history_id(self):
        self.scheduled_server(self.message())
        preview = self.preview("scheduled-send-now")
        result = self.execute("scheduled-send-now", preview)
        self.assertTrue(result["sent"])
        self.assertEqual(result["scheduledMessageId"], 42)
        self.assertEqual(result["messageId"], 999)
        self.assertEqual(self.client.reads, [(-1000000000077, 999)])

    def test_send_now_without_mapping_is_ambiguous_not_retried(self):
        self.scheduled_server(self.message(), no_delivery_proof=True)
        preview = self.preview("scheduled-send-now")
        with self.assertRaisesRegex(M.TelegramRuntimeError, "ambiguous"):
            self.execute("scheduled-send-now", preview)
        self.assertEqual(sum(type(r).__name__ == "SendScheduledMessagesRequest" for r in self.client.calls), 1)

    def test_failed_mutation_consumes_approval_and_cannot_be_blindly_replayed(self):
        self.scheduled_server(self.message(), fail_write=True)
        preview = self.preview("scheduled-cancel")
        with self.assertRaisesRegex(M.TelegramRuntimeError, "ambiguous"):
            self.execute("scheduled-cancel", preview)
        with self.assertRaisesRegex(M.TelegramRuntimeError, "approval"):
            self.execute("scheduled-cancel", preview)
        self.assertEqual(sum(type(r).__name__ == "DeleteScheduledMessagesRequest" for r in self.client.calls), 1)


class RequestPolicyTests(unittest.TestCase):
    def test_mutations_and_transcription_disable_implicit_rpc_resubmission(self):
        constructor = mock.Mock()
        identity = M.Identity("company", "member", "connection")
        with mock.patch.object(M, "require_app_credentials", return_value=(12345, "synthetic", False)), \
             mock.patch.object(M, "session_path", return_value=pathlib.Path("unused.session")), \
             mock.patch.object(M, "import_telethon", return_value=(constructor, None, None)):
            for command in ("send", "edit", "reply", "transcribe", "scheduled-edit",
                            "scheduled-cancel", "scheduled-send-now"):
                with self.subTest(command=command):
                    M.build_client(NS(command=command), identity)
                    options = constructor.call_args.kwargs
                    self.assertEqual(options["request_retries"], 0)
                    self.assertEqual(options["flood_sleep_threshold"], 0)
                    self.assertTrue(options["raise_last_call_error"])
            M.build_client(NS(command="dialogs"), identity)
            self.assertNotIn("request_retries", constructor.call_args.kwargs)


if __name__ == "__main__":
    unittest.main()
