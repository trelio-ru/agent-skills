"""Exercise the real parser, one-use journal and changing synthetic server.

No account/network is used. Provider error canaries and InputPeer access hashes
must never appear in previews or diagnostics on Linux, macOS or Windows.
"""
import asyncio
import copy
import contextlib
import io
import json
import sys
import unittest
from types import SimpleNamespace as NS
from unittest import mock

import test_message_workflows as base

M, TL = base.M, base.tl_type
B, I = M.import_inbox_tools(), M.import_interaction_tools()
REAL_BUILD = M.build_client


class InboxTests(unittest.TestCase):
    message = base.MessageWorkflowsTests.message

    def setUp(self):
        base.MessageWorkflowsTests.setUp(self)
        names = ("GetPeerDialogsRequest GetUnreadMentionsRequest GetUnreadReactionsRequest GetAllDraftsRequest "
                 "GetDialogFiltersRequest UpdateDialogFilterRequest ToggleDialogPinRequest MarkDialogUnreadRequest ReadHistoryRequest")
        self.f = NS(**{key: TL(key) for key in names.split()})
        types = "InputDialogPeer InputPeerChannel InputPeerUser TextWithEntities DialogFilter"
        self.t = NS(**{key: TL(key) for key in types.split()})
        self.u = NS(get_peer_id=base.peer_id)
        self.enterContext(mock.patch.object(I, "api", return_value=(NS(messages=self.f, channels=self.f), self.t, self.u, None)))
        async def input_peer(entity):
            if type(entity).__name__ == "User":
                return self.t.InputPeerUser(user_id=entity.id, access_hash=987654321)
            return self.t.InputPeerChannel(channel_id=entity.id, access_hash=987654321)
        self.client.get_input_entity = input_peer
        self.dialog = TL("Dialog")(peer=base.PeerChannel(channel_id=77), folder_id=None, pinned=False,
                                   unread_mark=False, read_inbox_max_id=10, top_message=100)
        self.folders = [self.folder(2, "Работа")]
        self.updates, self.incoming, self.total = [], [], 0
        self.client.dispatch = self.dispatch

    def folder(self, key, title):
        return self.t.DialogFilter(id=key, title=self.t.TextWithEntities(text=title, entities=[]),
            pinned_peers=[], include_peers=[self.t.InputPeerChannel(channel_id=77, access_hash=987654321)],
            exclude_peers=[], groups=True, exclude_muted=True, emoticon="💼", color=3)

    def dispatch(self, q):
        name = type(q).__name__
        if name == "GetPeerDialogsRequest":
            peer_id = base.peer_id(q.peers[0].peer)
            row = copy.deepcopy(self.dialog)
            row.peer = base.PeerUser(user_id=8) if peer_id == 8 else row.peer
            return NS(dialogs=[row])
        if name == "GetDialogFiltersRequest":
            return NS(filters=copy.deepcopy(self.folders))
        if name == "UpdateDialogFilterRequest":
            self.folders = [row for row in self.folders if row.id != q.id] + [copy.deepcopy(q.filter)]
            return True
        if name == "ToggleDialogPinRequest":
            self.dialog.pinned = q.pinned
            return True
        if name == "MarkDialogUnreadRequest":
            self.dialog.unread_mark = q.unread
            return True
        if name == "ReadHistoryRequest":
            self.dialog.read_inbox_max_id = q.max_id
            return True
        if name in {"GetUnreadMentionsRequest", "GetUnreadReactionsRequest"}:
            rows = [row for row in self.incoming if not q.offset_id or row.id < q.offset_id][:q.limit]
            return TL("MessagesSlice")(messages=copy.deepcopy(rows), count=self.total)
        if name == "GetAllDraftsRequest":
            return NS(updates=copy.deepcopy(self.updates), users=[], chats=[self.group])
        raise AssertionError(name)

    def cli(self, *args):
        return asyncio.run(B.run(M.build_parser().parse_args(list(args)), self.identity, M))

    def apply(self, *args):
        preview = self.cli(*args, "--dry-run")
        return preview, self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])

    def writes(self):
        return [row for row in self.client.calls if type(row).__name__ in
                {"UpdateDialogFilterRequest", "ToggleDialogPinRequest", "MarkDialogUnreadRequest", "ReadHistoryRequest"}]

    def test_mentions_are_passive_bounded_and_continued_by_native_id(self):
        self.incoming = [self.message(42, out=False), self.message(41, out=False)]
        self.total = 3
        first = self.cli("mentions", "--chat", "@group", "--limit", "1")
        self.assertEqual(first["chats"][0]["coverage"]["nextBeforeId"], 42)
        second = self.cli("mentions", "--chat", "@group", "--limit", "1", "--before-id", "42")
        self.assertEqual(second["chats"][0]["messages"][0]["id"], 41)
        self.assertFalse(second["readState"]["marksRead"])
        self.assertFalse(second["readState"]["reactionsMarkedRead"])
        self.assertEqual(self.writes(), [])

    def test_reactions_use_their_own_rpc_and_known_zero_is_complete(self):
        result = self.cli("unread-reactions", "--chat", "@group")
        self.assertTrue(result["coverage"]["complete"])
        self.assertEqual([type(q).__name__ for q in self.client.calls], ["GetUnreadReactionsRequest"])

    def test_unknown_empty_count_does_not_prove_absence(self):
        self.total = None
        result = self.cli("mentions", "--chat", "@group")
        self.assertFalse(result["coverage"]["complete"])
        self.assertIsNone(result["chats"][0]["coverage"]["hasMore"])

    def test_foreign_duplicate_or_nonadvancing_inbox_rows_are_not_returned(self):
        for rows in ([self.message(42), self.message(42)], [self.message(42, peer_id=base.PeerUser(user_id=8))]):
            self.incoming, self.total = rows, len(rows)
            result = self.cli("mentions", "--chat", "@group")
            self.assertFalse(result["coverage"]["complete"])
            self.assertEqual(result["chats"][0]["messages"], [])

    def test_common_limit_and_alias_deduplication(self):
        self.incoming, self.total = [self.message(42)], 1
        result = self.cli("mentions", "--chat", "@group", "--chat", "@alias", "--limit", "1")
        self.assertEqual(result["coverage"]["returned"], 1)
        self.assertEqual(len(self.client.calls), 1)

    def test_one_failed_chat_does_not_erase_other_results(self):
        self.incoming, self.total = [self.message(42)], 1
        original = self.client.get_entity
        async def lookup(ref):
            if ref == "@broken":
                raise TimeoutError("PRIVATE_TIMEOUT_TOKEN")
            return await original(ref)
        self.client.get_entity = lookup
        result = self.cli("mentions", "--chat", "@broken", "--chat", "@group")
        self.assertFalse(result["coverage"]["complete"])
        self.assertEqual(result["coverage"]["returned"], 1)
        self.assertNotIn("PRIVATE_", json.dumps(result))

    def draft(self, text="PRIVATE_DRAFT_TEXT", topic=None):
        return TL("UpdateDraftMessage")(peer=base.PeerChannel(channel_id=77), top_msg_id=topic,
            draft=TL("DraftMessage")(message=text, date=M.utc_now()))

    def test_draft_inventory_defaults_to_metadata_and_text_is_explicit(self):
        self.updates = [self.draft()]
        result = self.cli("drafts")
        self.assertNotIn("PRIVATE_DRAFT_TEXT", json.dumps(result))
        self.assertTrue(result["coverage"]["complete"])
        self.assertEqual(self.cli("drafts", "--include-text")["drafts"][0]["text"], "PRIVATE_DRAFT_TEXT")
        self.assertEqual(self.client.reads, [])
        self.assertEqual(self.writes(), [])

    def test_draft_topics_paginate_without_claiming_atomic_snapshot(self):
        self.updates = [self.draft("one", 10), self.draft("two", 20)]
        first = self.cli("drafts", "--limit", "1")
        second = self.cli("drafts", "--limit", "1", "--offset", str(first["coverage"]["nextOffset"]))
        self.assertEqual(second["drafts"][0]["topicId"], 20)
        self.assertFalse(second["coverage"]["snapshotAtomic"])

    def test_draft_unknown_saved_or_duplicate_update_keeps_explicit_limits(self):
        update = self.draft()
        update.saved_peer_id = base.PeerUser(user_id=8)
        self.updates = [update]
        self.assertFalse(self.cli("drafts")["coverage"]["complete"])
        self.updates = [self.draft(), self.draft()]
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("drafts")

    def test_folder_rename_preserves_rules_appearance_and_access_hash_privacy(self):
        preview, result = self.apply("folder-rename", "--folder-id", "2", "--title", "Команда")
        self.assertEqual(result["folder"]["title"], "Команда")
        self.assertTrue(self.folders[0].exclude_muted)
        self.assertTrue(self.folders[0].groups)
        self.assertEqual(self.folders[0].color, 3)
        self.assertNotIn("987654321", json.dumps(preview))
        self.assertFalse(preview["preview"]["changesAccess"])
        self.assertEqual(len(self.writes()), 1)

    def test_folder_create_selects_free_id_and_only_explicit_own_chats(self):
        preview, result = self.apply("folder-create", "--title", "Личное", "--chat", "@alice")
        self.assertIsNone(preview["preview"]["before"])
        self.assertEqual(result["folder"]["id"], 3)
        self.assertEqual(result["folder"]["include_peers"], [8])

    def test_folder_add_removes_explicit_exclusion_preserving_other_lists(self):
        self.folders[0].exclude_peers = [self.t.InputPeerUser(user_id=8, access_hash=123)]
        _preview, result = self.apply("folder-add-chat", "--folder-id", "2", "--chat", "@alice")
        self.assertEqual(result["folder"]["exclude_peers"], [])
        self.assertIn(8, result["folder"]["include_peers"])

    def test_folder_remove_excludes_dynamic_membership_and_unpins_inside_folder(self):
        self.folders[0].pinned_peers = [self.t.InputPeerChannel(channel_id=77, access_hash=987654321)]
        _preview, result = self.apply("folder-remove-chat", "--folder-id", "2", "--chat", "@group")
        self.assertEqual(result["folder"]["pinned_peers"], [])
        self.assertEqual(result["folder"]["include_peers"], [])
        self.assertIn(base.peer_id(self.group), result["folder"]["exclude_peers"])

    def test_shared_unknown_or_empty_folder_change_is_rejected_before_write(self):
        for bad in (TL("DialogFilterChatlist")(**vars(self.folders[0])), self.folder(2, "Работа")):
            self.folders = [bad]
            if type(bad).__name__ == "DialogFilter":
                bad.unknown_future_rule = True
            with self.assertRaises(M.TelegramRuntimeError):
                self.cli("folder-rename", "--folder-id", "2", "--title", "Новое", "--dry-run")
        self.folders = [self.folder(2, "Работа")]
        self.folders[0].groups = False
        with self.assertRaisesRegex(M.TelegramRuntimeError, "inclusion"):
            self.cli("folder-remove-chat", "--folder-id", "2", "--chat", "@group", "--dry-run")
        self.assertEqual(self.writes(), [])

    def test_concurrent_folder_change_invalidates_preview(self):
        args = ("folder-rename", "--folder-id", "2", "--title", "Новое")
        preview = self.cli(*args, "--dry-run")
        self.folders[0].exclude_muted = False
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(self.writes(), [])

    def test_folder_unknown_result_consumes_token_without_replay(self):
        args = ("folder-rename", "--folder-id", "2", "--title", "Новое")
        preview = self.cli(*args, "--dry-run")
        original = self.dispatch
        def lost(q):
            result = original(q)
            if type(q).__name__ == "UpdateDialogFilterRequest":
                raise TimeoutError("PRIVATE_RPC")
            return result
        self.client.dispatch = lost
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(caught.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")
        self.assertEqual(caught.exception.details["diagnostic"]["nextStep"], "verify_exact_live_state_before_any_retry")
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(len(self.writes()), 1)

    def test_chat_pin_unpin_is_distinct_from_message_pin(self):
        self.apply("chat-pin", "--chat", "@group")
        self.assertTrue(self.dialog.pinned)
        self.apply("chat-unpin", "--chat", "@group")
        self.assertFalse(self.dialog.pinned)
        self.assertEqual({type(q).__name__ for q in self.writes()}, {"ToggleDialogPinRequest"})
        self.assertEqual(self.dialog.read_inbox_max_id, 10)

    def test_mark_read_uses_exact_id_and_unread_mark_does_not_undo_receipt(self):
        self.message(42)
        preview, result = self.apply("mark-read", "--chat", "@group", "--message-id", "42")
        self.assertTrue(preview["preview"]["mayNotifySender"])
        self.assertTrue(result["marksRead"])
        self.assertEqual(self.writes()[0].max_id, 42)
        preview, _result = self.apply("mark-unread", "--chat", "@group")
        self.assertTrue(preview["preview"]["unreadMarkDoesNotUndoReceipt"])
        self.assertTrue(self.dialog.unread_mark)
        self.assertEqual(self.dialog.read_inbox_max_id, 42)

    def test_already_read_boundary_does_not_dispatch(self):
        self.message(9)
        _preview, result = self.apply("mark-read", "--chat", "@group", "--message-id", "9")
        self.assertFalse(result["changed"])
        self.assertEqual(self.writes(), [])

    def test_dialog_state_is_metadata_only_without_history(self):
        result = self.cli("dialog-state", "--chat", "@group")
        self.assertEqual(result["state"]["readInboxMaxId"], 10)
        self.assertFalse(result["readState"]["marksRead"])
        self.assertEqual(self.client.reads, [])
        self.assertEqual(self.writes(), [])

    def test_changed_account_or_expired_preview_does_not_dispatch(self):
        args = ("chat-pin", "--chat", "@group")
        preview = self.cli(*args, "--dry-run")
        self.client.account.id = 2
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.client.account.id = 1
        with mock.patch.object(M.time, "time", return_value=M.time.time() + 301):
            with self.assertRaises(M.TelegramRuntimeError):
                self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(self.writes(), [])

    def test_folder_id_collision_after_preview_does_not_create_again(self):
        args = ("folder-create", "--title", "Личное", "--chat", "@alice")
        preview = self.cli(*args, "--dry-run")
        self.folders.append(self.folder(3, "Чужое"))
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(self.writes(), [])

    def test_folder_create_readback_normalizes_native_flags_and_transport_refresh(self):
        original = self.dispatch
        def server(q):
            result = original(q)
            if type(q).__name__ == "UpdateDialogFilterRequest":
                native = next(row for row in self.folders if row.id == q.id)
                for field in B.FOLDER_FLAGS:
                    setattr(native, field, bool(getattr(native, field, None)))
                native.include_peers[0].access_hash = 123456789
            return result
        self.client.dispatch = server
        _preview, result = self.apply("folder-create", "--title", "Новое", "--chat", "@group")
        self.assertTrue(result["changed"])

    def test_preserved_title_formatting_is_bound_to_folder_preview(self):
        args = ("folder-add-chat", "--folder-id", "2", "--chat", "@alice")
        preview = self.cli(*args, "--dry-run")
        self.folders[0].title.entities = [TL("MessageEntityBold")(offset=0, length=6)]
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(self.writes(), [])

    def test_complete_preview_size_is_enforced_before_issuing_token(self):
        self.updates = [self.draft("я" * 20000)]
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("drafts", "--include-text")
        self.assertEqual(self.cli("drafts")["drafts"][0]["textLength"], 20000)

    def test_recovery_and_sending_policy_diagnostics_keep_precedence(self):
        error = M.TelegramRuntimeError("Find the exact chat.", code="TELEGRAM_CHAT_RESOLUTION_FAILED",
                                      next_action={"command": "dialogs"})
        error.__cause__ = type("ChannelPrivateError", (Exception,), {})("PRIVATE")
        result = B.safe_error(error, M).public_payload()
        self.assertEqual(result["code"], "TELEGRAM_CHAT_RESOLUTION_FAILED")
        self.assertEqual(result["nextAction"], {"command": "dialogs"})

    def test_foreign_read_target_or_dialog_summary_never_acknowledges(self):
        self.message(42, peer_id=base.PeerUser(user_id=8))
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("mark-read", "--chat", "@group", "--message-id", "42", "--dry-run")
        self.dialog = TL("DialogFolder")(**vars(self.dialog))
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("chat-pin", "--chat", "@group", "--dry-run")
        self.assertEqual(self.writes(), [])

    def test_readonly_allows_preview_but_prevents_every_write(self):
        self.enterContext(mock.patch.object(M, "load_policy", return_value={"sendMode": "read-only"}))
        for command in ("chat-pin", "mark-unread"):
            preview = self.cli(command, "--chat", "@group", "--dry-run")
            with self.assertRaises(M.TelegramRuntimeError):
                self.cli(command, "--chat", "@group", "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(self.writes(), [])

    def test_readback_mismatch_and_cleanup_failure_do_not_claim_success(self):
        original = self.dispatch
        def ignored(q):
            return True if type(q).__name__ == "ToggleDialogPinRequest" else original(q)
        self.client.dispatch = ignored
        preview = self.cli("chat-pin", "--chat", "@group", "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.cli("chat-pin", "--chat", "@group", "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(caught.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")
        self.client.dispatch = original
        preview = self.cli("chat-pin", "--chat", "@group", "--dry-run")
        self.client.disconnect.side_effect = RuntimeError("PRIVATE_CLEANUP")
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.cli("chat-pin", "--chat", "@group", "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(caught.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")

    def test_client_flags_disable_updates_and_implicit_mutation_retries(self):
        fake_client = mock.Mock()
        with mock.patch.object(M, "require_app_credentials", return_value=(1, "synthetic", False)), \
                mock.patch.object(M, "import_telethon", return_value=(fake_client, None, None)):
            for command in B.COMMANDS:
                REAL_BUILD(NS(command=command), self.identity)
                self.assertFalse(fake_client.call_args.kwargs["receive_updates"])
                if command in B.MUTATIONS:
                    self.assertEqual(fake_client.call_args.kwargs["request_retries"], 0)

    def test_ordinary_send_timeout_preserves_unknown_outcome_and_hides_provider_body(self):
        self.client.send_message.side_effect = TimeoutError("PRIVATE_SEND_BODY")
        args = M.build_parser().parse_args(["send", "--chat", "@group", "--message", "Reply", "--confirm"])
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            asyncio.run(M.command_send_async(args, self.identity))
        error = B.safe_error(caught.exception, M)
        self.assertEqual(error.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")
        self.assertNotIn("PRIVATE_", json.dumps(error.public_payload()))
        self.assertEqual(self.client.send_message.await_count, 1)


class DiagnosticTests(unittest.TestCase):
    def test_fixed_rpc_categories_and_bounded_wait_without_provider_text(self):
        for name, code in (("FloodWaitError", "TELEGRAM_RATE_LIMITED"),
                           ("ChannelPrivateError", "TELEGRAM_ACCESS_DENIED"),
                           ("ChatAdminRequiredError", "TELEGRAM_PERMISSION_REQUIRED"),
                           ("SessionRevokedError", "TELEGRAM_SESSION_UNAVAILABLE")):
            error = type(name, (Exception,), {})("PRIVATE_CREDENTIAL")
            error.seconds = 23
            payload = B.safe_error(error, M).public_payload()
            self.assertEqual(payload["code"], code)
            self.assertNotIn("PRIVATE_", json.dumps(payload))
            if name == "FloodWaitError":
                self.assertEqual(payload["details"]["diagnostic"]["retryAfterSeconds"], 23)

    def test_existing_unknown_code_keeps_no_replay_even_with_timeout_cause(self):
        error = M.TelegramRuntimeError("Verify exact state.", code="TELEGRAM_BULK_DELIVERY_UNKNOWN")
        error.__cause__ = TimeoutError("PRIVATE_URL")
        payload = B.safe_error(error, M).public_payload()
        self.assertEqual(payload["code"], "TELEGRAM_BULK_DELIVERY_UNKNOWN")
        self.assertEqual(payload["details"]["diagnostic"]["nextStep"], "verify_exact_live_state_before_any_retry")

    def test_exception_cycles_and_unbounded_wait_values_are_sanitized(self):
        error = type("FloodWaitError", (Exception,), {})("PRIVATE")
        error.seconds, error.__cause__ = 10**50, error
        payload = B.safe_error(error, M).public_payload()
        self.assertNotIn("retryAfterSeconds", payload["details"]["diagnostic"])
        self.assertNotIn("PRIVATE", json.dumps(payload))

    def test_real_cli_boundary_sanitizes_unexpected_failures(self):
        for error in (ValueError("PRIVATE_BODY"), OSError("PRIVATE_PATH"), TimeoutError("PRIVATE_URL")):
            out = io.StringIO()
            with mock.patch.object(sys, "argv", [str(base.SCRIPT), "doctor"]), \
                    mock.patch.object(M, "reexec_in_runtime_if_needed"), \
                    mock.patch.object(M, "command_doctor", side_effect=error), contextlib.redirect_stderr(out):
                self.assertEqual(M.main(), 2)
            self.assertNotIn("PRIVATE_", out.getvalue())
            self.assertFalse(json.loads(out.getvalue())["ok"])


if __name__ == "__main__":
    unittest.main()
