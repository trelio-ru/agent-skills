"""Search scope, pagination and grouped context through a synthetic provider.

The tests assert actual request boundaries and returned completeness. They use
no Telegram account, credentials, personal history or network connection.
"""

import asyncio
import json
import unittest
from types import SimpleNamespace as NS
from unittest import mock

import test_message_workflows as base


M = base.M


class SearchWorkflowsTests(unittest.TestCase):
    setUp = base.MessageWorkflowsTests.setUp
    args = base.MessageWorkflowsTests.args
    call = base.MessageWorkflowsTests.call
    message = base.MessageWorkflowsTests.message

    def groups(self):
        second = base.Channel(id=78, title="Юристы", username="lawyers", broadcast=False)
        async def resolve(reference):
            return second if reference in ("lawyers", -1000000000078) or getattr(reference, "channel_id", None) == 78 else self.group
        self.client.get_entity = mock.AsyncMock(side_effect=resolve)
        return second

    def history_provider(self, rows):
        def provider(request):
            selected = [row for row in rows
                        if base.peer_id(row.peer_id) == base.peer_id(request.peer)
                        and (not request.offset_id or row.id < request.offset_id)]
            return NS(messages=selected[:request.limit], chats=[self.group], users=[])
        self.client.dispatch = provider

    def global_provider(self, responses):
        self.enterContext(mock.patch.object(M, "import_telethon_global_search", return_value=(
            base.FUNCTIONS.SearchGlobalRequest, base.TYPES.InputMessagesFilterEmpty,
            lambda: NS(), base.tl_type("MessageEmpty"), NS(get_peer_id=base.peer_id),
        )))
        self.client.dispatch = mock.Mock(side_effect=responses)

    def global_message(self, message_id, **kwargs):
        message = self.message(message_id, **kwargs)
        message.input_chat = self.group
        message.chat = self.group
        return message

    def test_multiple_chats_preserve_equal_message_ids_and_read_aliases_once(self):
        self.groups()
        rows = [self.message(42), self.message(42, peer_id=base.PeerChannel(channel_id=78))]
        self.history_provider(rows)
        result = self.call(M.command_search_async, "search", "--chat", "old_group",
                           "--chat", "-1000000000077", "--chat", "lawyers", "--from", "8")
        self.assertEqual(result["scope"], "selected_chats")
        self.assertEqual({row["chat"]["id"] for row in result["messages"]}, {77, 78})
        self.assertEqual(len(result["messages"]), 2)
        self.assertEqual(len(self.client.calls), 2)
        self.assertTrue(result["coverage"]["complete"])
        self.assertTrue(all(chat["complete"] for chat in result["coverage"]["chats"]))
        self.assertEqual([chat["authorFilter"] for chat in result["coverage"]["chats"]], ["server", "server"])

    def test_shared_limit_gives_both_chats_a_share_and_keeps_resumable_offsets(self):
        self.groups()
        rows = [self.message(i, peer_id=base.PeerChannel(channel_id=peer))
                for peer in (77, 78) for i in (10, 9, 8)]
        self.history_provider(rows)
        argv = ("search", "--chat", "old_group", "--chat", "lawyers", "--media-type", "document", "--limit", "2")
        first = self.call(M.command_search_async, *argv)
        self.assertEqual(len(first["messages"]), 2)
        self.assertEqual({row["chat"]["id"] for row in first["messages"]}, {77, 78})
        self.assertFalse(first["coverage"]["complete"])
        second = self.call(M.command_search_async, *argv, "--cursor", first["coverage"]["nextCursor"])
        self.assertEqual([row["id"] for row in second["messages"]], [9, 9])
        self.assertFalse(second["coverage"]["complete"])
        self.assertFalse(second["coverage"]["absenceProven"])

    def test_selected_cursor_rejects_changed_chat_set_or_author_before_search(self):
        self.groups()
        self.history_provider([self.message(i) for i in (10, 9)])
        argv = ("search", "--chat", "old_group", "--chat", "lawyers", "--from", "8", "--limit", "1")
        first = self.call(M.command_search_async, *argv)
        token = first["coverage"]["nextCursor"]
        count = len(self.client.calls)
        for changed in (("search", "--chat", "old_group", "--from", "8"),
                        ("search", "--chat", "old_group", "--chat", "lawyers", "--from", "9")):
            with self.subTest(changed=changed), self.assertRaisesRegex(M.TelegramRuntimeError, "does not belong"):
                self.call(M.command_search_async, *changed, "--cursor", token)
        self.assertEqual(len(self.client.calls), count)

    def test_multiple_chats_keep_failed_scope_separate_from_empty_scope(self):
        self.groups()
        def provider(request):
            if base.peer_id(request.peer) == -1000000000078:
                raise TimeoutError("private provider diagnostic and credential")
            return NS(messages=[], chats=[], users=[])
        self.client.dispatch = provider
        result = self.call(M.command_search_async, "search", "--chat", "old_group", "--chat", "lawyers", "--from", "8")
        coverage = result["coverage"]
        self.assertEqual(coverage["status"], "partial")
        self.assertFalse(coverage["absenceProven"])
        self.assertTrue(coverage["chats"][0]["absenceProven"])
        self.assertEqual(coverage["chats"][1]["status"], "unavailable")
        self.assertNotIn("private provider diagnostic", json.dumps(result))

    def test_all_unavailable_chats_do_not_prove_absence(self):
        self.client.get_entity = mock.AsyncMock(side_effect=TimeoutError("private"))
        result = self.call(M.command_search_async, "search", "--chat", "first", "--chat", "second", "--query", "план")
        self.assertEqual(result["coverage"]["status"], "unavailable")
        self.assertFalse(result["coverage"]["absenceProven"])
        self.assertEqual(self.client.calls, [])

    def test_native_global_scope_flags_and_folder_zero_are_forwarded(self):
        for chat_type, flag in (("user", "users_only"), ("group", "groups_only"), ("channel", "broadcasts_only")):
            with self.subTest(chat_type=chat_type):
                with mock.patch.object(M, "import_telethon_global_search", return_value=(
                    base.FUNCTIONS.SearchGlobalRequest, base.TYPES.InputMessagesFilterEmpty,
                    lambda: NS(), base.tl_type("MessageEmpty"), NS(get_peer_id=base.peer_id),
                )):
                    self.call(M.command_search_async, "search", "--global", "--query", "план",
                              "--chat-type", chat_type, "--folder-id", "0")
                request = self.client.calls[-1]
                self.assertTrue(getattr(request, flag))
                self.assertEqual(request.folder_id, 0)
                self.assertEqual({key for key in vars(request) if key.endswith("_only")}, {flag})

    def test_global_cursor_binds_chat_type_and_folder(self):
        self.global_provider([NS(messages=[self.global_message(10)], chats=[self.group], users=[], count=3, next_rate=1)])
        argv = ("search", "--global", "--query", "план", "--chat-type", "group", "--folder-id", "0", "--limit", "1")
        token = self.call(M.command_search_async, *argv)["coverage"]["nextCursor"]
        for changed in (("--chat-type", "channel", "--folder-id", "0"),
                        ("--chat-type", "group", "--folder-id", "1")):
            with self.subTest(changed=changed), self.assertRaisesRegex(M.TelegramRuntimeError, "does not belong"):
                self.call(M.command_search_async, "search", "--global", "--query", "план", *changed, "--cursor", token)
        self.assertEqual(len(self.client.calls), 1)

    def test_invalid_scopes_and_budgets_fail_before_provider_requests(self):
        cases = (("--chat", "old_group", "--chat-type", "group"),
                 ("--global", "--folder-id", "-1"),
                 ("--global", "--folder-id", str(2**31)),
                 ("--chat", "old_group", "--chat", "lawyers", "--before-id", "10"))
        for case in cases:
            with self.subTest(case=case), self.assertRaises(M.TelegramRuntimeError):
                self.call(M.command_search_async, "search", "--query", "план", *case)
        args = self.args("search", "--chat", "old_group", "--query", "план")
        args.pages = True
        with self.assertRaises(M.TelegramRuntimeError):
            asyncio.run(M.command_search_async(args, self.identity))
        self.assertEqual(self.client.calls, [])

    def test_automatic_pages_reach_matches_after_an_empty_bounded_local_scan(self):
        rows = [self.message(i, from_id=base.PeerUser(user_id=9 if i > 1000 else 8))
                for i in range(2000, 999, -1)]
        self.history_provider(rows)
        result = self.call(M.command_search_async, "search", "--chat", "old_group", "--from", "8", "--media-type", "document")
        self.assertEqual([row["id"] for row in result["messages"]], [1000])
        self.assertEqual(result["coverage"]["pagesRead"], 2)
        self.assertTrue(result["coverage"]["complete"])
        self.assertFalse(result["coverage"]["scanLimitReached"])

    def test_page_budget_zero_matches_remain_partial_and_continuable(self):
        rows = [self.message(i, from_id=base.PeerUser(user_id=9)) for i in range(2000, 999, -1)]
        self.history_provider(rows)
        result = self.call(M.command_search_async, "search", "--chat", "old_group", "--from", "8", "--media-type", "document", "--pages", "1")
        self.assertEqual(result["messages"], [])
        self.assertEqual(result["coverage"]["status"], "partial")
        self.assertFalse(result["coverage"]["absenceProven"])
        self.assertIn("page_budget_reached", result["coverage"]["incompleteReasons"])
        self.assertTrue(result["coverage"]["nextCursor"])

    def test_global_automatic_pages_deduplicate_without_losing_peer_identity(self):
        messages = [self.global_message(i) for i in (12, 11, 10)]
        self.global_provider([NS(messages=messages[:2], chats=[self.group], users=[], count=4, next_rate=1),
                              NS(messages=messages[1:], chats=[self.group], users=[], count=4, next_rate=2),
                              NS(messages=[], chats=[], users=[], count=4)])
        result = self.call(M.command_search_async, "search", "--global", "--query", "план", "--limit", "4", "--page-size", "2")
        self.assertEqual([row["id"] for row in result["messages"]], [12, 11, 10])
        self.assertEqual(result["coverage"]["pagesRead"], 3)
        self.assertEqual(result["coverage"]["seenBefore"], 0)
        self.assertEqual(result["coverage"]["seenThrough"], 4)
        self.assertTrue(result["coverage"]["complete"])

    def test_global_inexact_count_never_proves_exhaustiveness(self):
        self.global_provider([NS(messages=[self.global_message(10)], chats=[self.group], users=[], count=1, next_rate=1, inexact=True),
                              NS(messages=[], chats=[], users=[], count=1)])
        result = self.call(M.command_search_async, "search", "--global", "--query", "план", "--limit", "1")
        self.assertTrue(result["coverage"]["hasMore"])
        self.assertFalse(result["coverage"]["complete"])
        self.assertTrue(result["coverage"]["providerMayLimitResults"])

    def test_empty_complete_search_is_distinguished_from_partial_search(self):
        result = self.call(M.command_search_async, "search", "--chat", "old_group", "--from", "8")
        self.assertEqual(result["coverage"]["status"], "complete")
        self.assertTrue(result["coverage"]["absenceProven"])
        self.assertIn("Совпадений нет", result["coverage"]["summary"])

    def test_text_search_continues_with_lookahead_without_losing_a_hit(self):
        rows = [self.message(i) for i in (10, 9, 8, 7)]
        calls = []
        async def history(entity, **kwargs):
            calls.append(kwargs)
            before = kwargs.get("offset_id", 0)
            for row in [row for row in rows if not before or row.id < before][:kwargs["limit"]]:
                yield row
        self.client.iter_messages = history
        result = self.call(M.command_search_async, "search", "--chat", "old_group",
                           "--query", "план", "--page-size", "2", "--limit", "10")
        self.assertEqual([row["id"] for row in result["messages"]], [10, 9, 8, 7])
        self.assertEqual([call.get("offset_id") for call in calls], [None, 9])
        self.assertTrue(result["coverage"]["complete"])
        self.assertEqual(result["coverage"]["pagesRead"], 2)

    def test_scan_budget_is_shared_by_all_chats_and_still_has_a_safe_cursor(self):
        self.groups()
        rows = [self.message(i, peer_id=base.PeerChannel(channel_id=peer), from_id=base.PeerUser(user_id=9))
                for peer in (77, 78) for i in range(20, 9, -1)]
        self.history_provider(rows)
        with mock.patch.object(M, "MAX_SELECTED_SEARCH_SCAN", 5):
            result = self.call(M.command_search_async, "search", "--chat", "old_group",
                               "--chat", "lawyers", "--from", "8", "--media-type", "document")
        self.assertEqual(result["messages"], [])
        self.assertEqual(result["coverage"]["scanned"], 5)
        self.assertEqual(sum(call.limit for call in self.client.calls), 5)
        self.assertIn("scan_budget_reached", result["coverage"]["incompleteReasons"])
        self.assertFalse(result["coverage"]["absenceProven"])
        self.assertTrue(result["coverage"]["nextCursor"])

    def test_text_before_id_can_continue_with_cursor_without_inventing_filters(self):
        rows = [self.message(i) for i in (10, 9, 8)]
        async def history(entity, **kwargs):
            before = kwargs.get("offset_id", 0)
            for row in [row for row in rows if not before or row.id < before][:kwargs["limit"]]:
                yield row
        self.client.iter_messages = history
        argv = ("search", "--chat", "old_group", "--query", "план", "--limit", "1")
        first = self.call(M.command_search_async, *argv, "--before-id", "10")
        second = self.call(M.command_search_async, *argv, "--cursor", first["coverage"]["nextCursor"])
        self.assertEqual([row["id"] for row in first["messages"]], [9])
        self.assertEqual([row["id"] for row in second["messages"]], [8])
        self.assertFalse(second["coverage"]["complete"])

    def test_result_cursor_ceiling_returns_no_unusable_continuation(self):
        self.history_provider([self.message(i) for i in (10, 9, 8)])
        with mock.patch.object(M, "MAX_GLOBAL_SEARCH_CURSOR_RESULTS", 1):
            result = self.call(M.command_search_async, "search", "--chat", "old_group", "--from", "8")
        self.assertEqual(len(result["messages"]), 1)
        self.assertTrue(result["coverage"]["cursorLimitReached"])
        self.assertIsNone(result["coverage"]["nextCursor"])
        self.assertFalse(result["coverage"]["complete"])

    def test_failed_page_keeps_received_hits_in_the_shared_scan_budget(self):
        self.groups()
        second_peer = base.PeerChannel(channel_id=78)
        malformed = [self.message(20), self.message(19, peer_id=second_peer)]
        remaining = [self.message(i, peer_id=second_peer, from_id=base.PeerUser(user_id=9))
                     for i in range(20, 10, -1)]
        def provider(request):
            rows = malformed if base.peer_id(request.peer) == base.peer_id(self.group) else remaining
            return NS(messages=rows[:request.limit], users=[], chats=[])
        self.client.dispatch = provider
        with mock.patch.object(M, "MAX_SELECTED_SEARCH_SCAN", 5):
            result = self.call(M.command_search_async, "search", "--chat", "old_group",
                               "--chat", "lawyers", "--from", "8", "--media-type", "document")
        self.assertEqual([request.limit for request in self.client.calls], [5, 3])
        self.assertEqual(result["coverage"]["scanned"], 5)
        self.assertEqual([chat["scanned"] for chat in result["coverage"]["chats"]], [2, 3])
        self.assertEqual(result["messages"], [])
        self.assertFalse(result["coverage"]["absenceProven"])

    def test_unresolved_chat_does_not_create_an_all_done_cursor(self):
        async def resolve(reference):
            if reference == "missing":
                raise TimeoutError("private lookup failure")
            return self.group
        self.client.get_entity = mock.AsyncMock(side_effect=resolve)
        result = self.call(M.command_search_async, "search", "--chat", "old_group",
                           "--chat", "missing", "--from", "8")
        self.assertIsNone(result["coverage"]["hasMore"])
        self.assertIsNone(result["coverage"]["nextCursor"])
        self.assertEqual(result["coverage"]["status"], "partial")
        self.assertFalse(result["coverage"]["absenceProven"])

    def test_global_changing_count_requires_exhaustion_even_after_reported_total(self):
        self.global_provider([
            NS(messages=[self.global_message(10)], chats=[self.group], users=[], count=3, next_rate=1),
            NS(messages=[self.global_message(9)], chats=[self.group], users=[], count=2, next_rate=2),
            NS(messages=[], chats=[], users=[], count=2),
        ])
        result = self.call(M.command_search_async, "search", "--global", "--query", "план", "--page-size", "1")
        self.assertEqual(result["coverage"]["pagesRead"], 3)
        self.assertTrue(result["coverage"]["providerCountChanged"])
        self.assertTrue(result["coverage"]["complete"])

    def test_global_repeated_offset_with_duplicate_cannot_be_resumed(self):
        row = self.global_message(10)
        self.global_provider([
            NS(messages=[row], chats=[self.group], users=[], count=3, next_rate=1),
            NS(messages=[row], chats=[self.group], users=[], count=3, next_rate=1),
        ])
        result = self.call(M.command_search_async, "search", "--global", "--query", "план", "--page-size", "1")
        self.assertEqual(len(result["messages"]), 1)
        self.assertFalse(result["coverage"]["complete"])
        self.assertIsNone(result["coverage"]["nextCursor"])
        self.assertEqual(result["coverage"]["incompleteReason"], "provider_cursor_unavailable")

    def folder_provider(self, folders, rows=(), dialogs=()):
        def provider(request):
            if type(request).__name__ == "GetDialogFiltersRequest":
                return NS(filters=folders)
            matches = [row for row in rows if base.peer_id(row.peer_id) == base.peer_id(request.peer)
                       and (not request.offset_id or row.id < request.offset_id)]
            return NS(messages=matches[:request.limit], users=[], chats=[self.group])
        self.client.dispatch = provider
        async def dialog_rows(**kwargs):
            for dialog in dialogs[:kwargs["limit"]]:
                yield dialog
        self.client.iter_dialogs = mock.Mock(side_effect=dialog_rows)

    def folder(self, **kwargs):
        return base.tl_type("DialogFilter")(id=2, title=NS(text="Работа"), **kwargs)

    def test_folder_inventory_returns_names_without_peer_lists_or_access_hashes(self):
        folder = self.folder(include_peers=[NS(id=77, access_hash=123)], hidden="private")
        self.folder_provider([folder])
        result = self.call(M.command_folders_async, "folders")
        self.assertEqual(result["folders"], [{"id": 2, "title": "Работа"}])
        self.assertNotIn("access_hash", json.dumps(result))
        self.assertNotIn("include_peers", json.dumps(result))

    def test_explicit_folder_search_does_not_scan_recent_dialogs_or_use_global_api(self):
        self.groups()
        folder = self.folder(include_peers=[base.PeerChannel(channel_id=77), base.PeerChannel(channel_id=78)],
                             exclude_peers=[base.PeerChannel(channel_id=78)])
        self.folder_provider([folder], [self.message(10)])
        result = self.call(M.command_search_async, "search", "--folder", "Работа", "--query", "план")
        self.assertEqual(result["scope"], "folder")
        self.assertEqual([row["chat"]["id"] for row in result["messages"]], [77])
        self.assertTrue(result["coverage"]["complete"])
        self.assertEqual(result["folder"]["coverage"]["scannedDialogs"], 0)
        self.client.iter_dialogs.assert_not_called()
        self.assertFalse(any(type(request).__name__ == "SearchGlobalRequest" for request in self.client.calls))

    def test_explicit_folder_can_resolve_a_peer_missing_from_session_cache(self):
        input_peer = base.tl_type("InputPeerChannel")(channel_id=77, access_hash=123)
        self.folder_provider([self.folder(include_peers=[input_peer])], [self.message(10)])
        async def resolve(reference):
            if reference is input_peer:
                return self.group
            raise ValueError("numeric peer is not in the session cache")
        self.client.get_entity = mock.AsyncMock(side_effect=resolve)
        result = self.call(M.command_search_async, "search", "--folder", "Работа", "--query", "план")
        self.assertEqual([row["id"] for row in result["messages"]], [10])
        self.assertTrue(result["coverage"]["complete"])
        self.client.get_entity.assert_awaited_once_with(input_peer)
        self.assertNotIn("access_hash", json.dumps(result))

    def test_dynamic_folder_respects_category_archive_read_and_explicit_overrides(self):
        second = self.groups()
        folder = self.folder(groups=True, exclude_archived=True, exclude_read=True,
                             include_peers=[base.PeerChannel(channel_id=78)])
        dialogs = [NS(entity=self.group, is_group=True, unread_count=0, dialog=NS(folder_id=1)),
                   NS(entity=second, is_group=True, unread_count=0, dialog=NS(folder_id=1)),
                   NS(entity=base.User(id=9), is_user=True, unread_count=2, dialog=NS(folder_id=0))]
        self.folder_provider([folder], [self.message(10, peer_id=base.PeerChannel(channel_id=78))], dialogs)
        result = self.call(M.command_search_async, "search", "--folder", "2", "--query", "план", "--chat-type", "group")
        self.assertEqual([row["chat"]["id"] for row in result["messages"]], [78])
        self.assertTrue(result["folder"]["coverage"]["complete"])

    def test_dynamic_folder_missing_mute_metadata_never_broadens_scope_or_proves_absence(self):
        folder = self.folder(groups=True, exclude_muted=True)
        dialogs = [NS(entity=self.group, is_group=True, dialog=NS(notify_settings=NS(mute_until=None)))]
        self.folder_provider([folder], dialogs=dialogs)
        result = self.call(M.command_search_async, "search", "--folder", "Работа", "--query", "план")
        self.assertEqual(result["messages"], [])
        self.assertFalse(result["coverage"]["absenceProven"])
        self.assertIn("folder_membership_unavailable", result["coverage"]["incompleteReasons"])

    def test_folder_chat_and_dialog_limits_remain_explicit(self):
        folder = self.folder(groups=True)
        dialogs = [NS(entity=base.Channel(id=i), is_group=True) for i in range(77, 82)]
        self.folder_provider([folder], dialogs=dialogs)
        with mock.patch.object(M, "MAX_FOLDER_DIALOGS", 3), mock.patch.object(M, "MAX_SEARCH_CHATS", 2):
            references, metadata = asyncio.run(M.resolve_search_folder(self.client, "Работа", None))
        self.assertEqual(len(references), 2)
        self.assertFalse(metadata["coverage"]["complete"])
        self.assertEqual(metadata["coverage"]["incompleteReasons"], ["folder_chat_limit_reached", "folder_dialog_limit_reached"])

    def test_folder_cursor_rejects_changed_definition_without_reading_history(self):
        folder = self.folder(include_peers=[base.PeerChannel(channel_id=77)])
        self.folder_provider([folder], [self.message(10), self.message(9)])
        argv = ("search", "--folder", "Работа", "--query", "план", "--limit", "1")
        first = self.call(M.command_search_async, *argv)
        count = sum(type(request).__name__ == "SearchRequest" for request in self.client.calls)
        folder.exclude_read = True
        with self.assertRaisesRegex(M.TelegramRuntimeError, "does not belong"):
            self.call(M.command_search_async, *argv, "--cursor", first["coverage"]["nextCursor"])
        self.assertEqual(sum(type(request).__name__ == "SearchRequest" for request in self.client.calls), count)

    def test_duplicate_folder_names_require_exact_id_instead_of_guessing(self):
        second = self.folder()
        second.id = 3
        self.folder_provider([self.folder(), second])
        with self.assertRaisesRegex(M.TelegramRuntimeError, "ambiguous"):
            self.call(M.command_search_async, "search", "--folder", "Работа", "--query", "план")
        self.assertEqual(len(self.client.calls), 1)

    def context_history(self, rows, fail_before=None):
        async def history(entity, **kwargs):
            if fail_before is not None and kwargs.get("offset_id") == fail_before:
                raise TimeoutError("private context failure")
            same_chat = [row for row in rows if base.peer_id(row.peer_id) == base.peer_id(entity)]
            if "offset_id" in kwargs:
                selected = sorted((row for row in same_chat if row.id < kwargs["offset_id"]), key=lambda row: -row.id)
            else:
                selected = sorted((row for row in same_chat if row.id > kwargs["min_id"]), key=lambda row: row.id)
            for row in selected[:kwargs["limit"]]:
                yield row
        self.client.iter_messages = history

    def test_overlapping_contexts_merge_transitively_and_keep_all_match_indexes(self):
        rows = [self.message(i) for i in range(7, 16)]
        self.context_history(rows)
        matches = [rows[1], rows[3], rows[5]]
        public = asyncio.run(M.public_messages(matches, self.group))
        result = asyncio.run(M.attach_search_contexts(self.client, matches, public, 1, chats=[self.group] * 3))
        self.assertEqual(len(result["groups"]), 1)
        self.assertEqual([row["id"] for row in result["groups"][0]["messages"]], list(range(7, 14)))
        self.assertEqual(result["groups"][0]["matchIds"], [8, 10, 12])
        self.assertEqual([row["context"]["matchIndex"] for row in public], [1, 3, 5])
        self.assertTrue(all("messages" not in row["context"] for row in public))

    def test_contexts_with_equal_ids_in_different_chats_never_merge(self):
        second = self.groups()
        matches = [self.message(10), self.message(10, peer_id=base.PeerChannel(channel_id=78))]
        self.context_history(matches)
        public = [{"id": 10}, {"id": 10}]
        result = asyncio.run(M.attach_search_contexts(self.client, matches, public, 1, chats=[self.group, second]))
        self.assertEqual(len(result["groups"]), 2)
        self.assertEqual([row["context"]["groupIndex"] for row in public], [0, 1])

    def test_foreign_context_peer_is_unavailable_instead_of_grouped_with_hit(self):
        hit = self.message(10)
        foreign = self.message(9, peer_id=base.PeerChannel(channel_id=78))
        async def history(entity, **kwargs):
            if "offset_id" in kwargs:
                yield foreign
        self.client.iter_messages = history
        public = [{"id": 10}]
        result = asyncio.run(M.attach_search_contexts(self.client, [hit], public, 1, chats=[self.group]))
        self.assertEqual([row["id"] for row in result["groups"][0]["messages"]], [10])
        self.assertFalse(result["complete"])
        self.assertEqual(public[0]["context"]["coverage"]["incompleteReasons"], ["before_unavailable"])

    def test_grouped_context_preserves_per_hit_failure_and_never_exposes_diagnostics(self):
        rows = [self.message(i) for i in (9, 10, 11)]
        self.context_history(rows, fail_before=10)
        public = [{"id": 10}, {"id": 11}]
        result = asyncio.run(M.attach_search_contexts(self.client, rows[1:], public, 1, chats=[self.group] * 2))
        self.assertEqual(len(result["groups"]), 1)
        self.assertFalse(result["complete"])
        self.assertFalse(result["groups"][0]["coverage"]["complete"])
        self.assertEqual(public[0]["context"]["coverage"]["incompleteReasons"], ["before_unavailable"])
        self.assertTrue(public[1]["context"]["coverage"]["complete"])
        self.assertNotIn("private context failure", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
