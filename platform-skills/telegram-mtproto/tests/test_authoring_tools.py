"""Changing cloud-state fixtures exercise the production CLI and one-use journal.

No account, network or real Telegram mutation is used. The fake server can edit
a draft during save, or a message while its replacement is uploading; successful
SDK dispatch alone must never be mistaken for a verified business outcome.
"""
import asyncio
import copy
import pathlib
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS
from unittest import mock

import test_community_tools as community
import test_message_workflows as base

M, TL = base.M, base.tl_type
A, C = M.import_authoring_tools(), M.import_community_tools()


class AuthoringTests(unittest.TestCase):
    setUpBase = base.MessageWorkflowsTests.setUp
    message = base.MessageWorkflowsTests.message

    def setUp(self):
        community.CommunityTests.setUp(self)
        self.native = TL("DraftMessageEmpty")()
        self.group.forum = False
        self.invite.admin_id = 1
        self.topic.icon_color, self.topic.icon_emoji_id, self.topic.pinned = 1, None, False
        self.client.upload_file = mock.AsyncMock(return_value=NS(name="replacement.pdf"))
        self.client.edit_message = mock.AsyncMock(side_effect=self.edit_media)
        self.uploaded = None
        self.client.dispatch = self.dispatch
        names = community.NAMES + ["SaveDraftRequest", "EditExportedChatInviteRequest", "CreateForumTopicRequest", "EditForumTopicRequest", "GetPeerDialogsRequest"]
        self.functions = NS(**{name: TL(name) for name in names})
        self.types = NS(**vars(community.T), InputDialogPeer=TL("InputDialogPeer"), InputReplyToMessage=TL("InputReplyToMessage"))
        self.utils = NS(**vars(community.U), get_attributes=lambda *a, **kw: ([], "application/pdf"))
        self.enterContext(mock.patch.object(C, "api", return_value=(NS(messages=self.functions, channels=self.functions, stats=self.functions),
                          self.types, self.utils, NS(parse=base.markdown))))
        self.file = pathlib.Path(self.temp) / "replacement.pdf"
        self.file.write_bytes(b"%PDF-1.7\nSYNTHETIC_ONLY")

    def dispatch(self, request):
        name = type(request).__name__
        if name == "GetPeerDialogsRequest":
            return NS(dialogs=[TL("Dialog")(peer=base.PeerChannel(channel_id=77), draft=copy.deepcopy(self.native))])
        if name in {"GetForumTopicsRequest", "GetForumTopicsByIDRequest"}:
            self.topic.draft = copy.deepcopy(self.native)
            return NS(topics=[copy.deepcopy(self.topic)], count=1, messages=[])
        if name == "SaveDraftRequest":
            self.native = TL("DraftMessage")(message=request.message, date=datetime(2026, 9, 5, tzinfo=timezone.utc),
                          entities=request.entities, reply_to=request.reply_to, no_webpage=request.no_webpage)
            if not request.message:
                self.native = TL("DraftMessageEmpty")()
            return True
        if name == "EditExportedChatInviteRequest":
            for key in ("title", "expire_date", "usage_limit", "request_needed", "revoked"):
                if hasattr(request, key):
                    setattr(self.invite, key, getattr(request, key))
            return TL("ExportedChatInvite")(invite=copy.deepcopy(self.invite))
        if name == "CreateForumTopicRequest":
            self.topic.id, self.topic.title = 100, request.title
            service = self.message(100, action=TL("MessageActionTopicCreate")(title=request.title))
            return NS(updates=[TL("UpdateNewChannelMessage")(message=service)])
        if name == "EditForumTopicRequest":
            for key in ("title", "closed"):
                if hasattr(request, key):
                    setattr(self.topic, key, getattr(request, key))
            return NS(updates=[])
        return community.CommunityTests.dispatch(self, request)

    def cli(self, *argv):
        return asyncio.run(A.run(M.build_parser().parse_args(list(argv)), self.identity, M))

    def apply(self, *argv):
        preview = self.cli(*argv, "--dry-run")
        return preview, self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])

    def media(self, **changes):
        document = TL("Document")(id=10, size=20, mime_type="application/pdf", attributes=[])
        return self.message(media=TL("MessageMediaDocument")(document=document), document=document, **changes)

    async def edit_media(self, entity, message_id, **kwargs):
        before = self.client.messages[(base.peer_id(entity), message_id)]
        self.current = copy.deepcopy(before)
        self.current.media.document.id = 11
        self.client.messages[(base.peer_id(entity), message_id)] = self.current
        return copy.deepcopy(self.current)

    def test_draft_read_is_exact_metadata_and_never_history_or_ack(self):
        result = self.cli("draft", "--chat", "@group")
        self.assertTrue(result["draft"]["empty"])
        self.assertFalse(result["readState"]["marksRead"])
        self.assertEqual(self.client.reads, [])
        self.assertEqual([type(row).__name__ for row in self.client.calls], ["GetPeerDialogsRequest"])

    def test_sdk_gate_fails_before_api_import_or_client_creation(self):
        with mock.patch.object(M, "import_telethon_workflows", side_effect=M.TelegramRuntimeError("Run bootstrap first")), \
             mock.patch.object(C, "api", side_effect=AssertionError("SDK import must not happen")):
            with self.assertRaisesRegex(M.TelegramRuntimeError, "bootstrap"):
                self.cli("draft", "--chat", "@group")
        M.build_client.assert_not_called()

    def test_save_existing_draft_shows_both_versions_and_does_not_send(self):
        self.native = TL("DraftMessage")(message="Уже набрано", entities=[], date=None)
        preview, result = self.apply("draft-save", "--chat", "@group", "--message", "**Новый ответ**", "--no-link-preview")
        self.assertEqual(preview["preview"]["previousDraft"]["text"], "Уже набрано")
        self.assertEqual(result["draft"]["text"], "Новый ответ")
        self.assertFalse(result["draft"]["linkPreview"])
        self.assertFalse(result["sent"])
        self.assertFalse(result["snapshotAtomic"])
        self.client.send_message.assert_not_called()

    def test_clear_draft_requires_its_own_live_preview(self):
        self.native = TL("DraftMessage")(message="Личный ответ", entities=[], date=None)
        preview, result = self.apply("draft-clear", "--chat", "@group")
        self.assertIsNone(preview["preview"]["newDraft"])
        self.assertTrue(result["cleared"])
        self.assertTrue(result["draft"]["empty"])

    def test_draft_change_on_another_device_invalidates_approval(self):
        argv = ["draft-save", "--chat", "@group", "--message", "Ответ"]
        preview = self.cli(*argv, "--dry-run")
        self.native = TL("DraftMessage")(message="Правка с телефона", entities=[], date=None)
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertFalse(any(type(row).__name__ == "SaveDraftRequest" for row in self.client.calls))

    def test_draft_post_save_race_is_unknown_and_token_stays_consumed(self):
        argv = ["draft-save", "--chat", "@group", "--message", "Ответ"]
        preview = self.cli(*argv, "--dry-run")
        dispatch = self.client.dispatch
        def race(request):
            result = dispatch(request)
            if type(request).__name__ == "SaveDraftRequest":
                self.native.message = "Другая версия"
            return result
        self.client.dispatch = race
        with self.assertRaises(M.TelegramRuntimeError) as failure:
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(failure.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(sum(type(row).__name__ == "SaveDraftRequest" for row in self.client.calls), 1)

    def test_forum_drafts_require_exact_topic_and_preserve_routing(self):
        self.group.forum = True
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("draft", "--chat", "@forum")
        _, result = self.apply("draft-save", "--chat", "@forum", "--topic-id", "11", "--message", "Ответ")
        self.assertEqual(result["draft"]["replyToMessageId"], 11)
        request = next(row for row in self.client.calls if type(row).__name__ == "SaveDraftRequest")
        self.assertEqual(request.reply_to.top_msg_id, 11)
        _, result = self.apply("draft-clear", "--chat", "@forum", "--topic-id", "11")
        self.assertTrue(result["cleared"])

    def test_draft_reply_rejects_another_topic(self):
        self.group.forum = True
        self.message(reply_to=NS(forum_topic=True, reply_to_msg_id=12))
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("draft-save", "--chat", "@forum", "--topic-id", "11", "--reply-to", "42", "--message", "Ответ", "--dry-run")

    def test_advanced_and_oversized_drafts_are_preserved(self):
        for changes in ({"media": TL("InputMediaPhoto")(id=1)}, {"effect": 5}, {"message": "x" * 4097}, {"rich_message": NS()}):
            self.native = TL("DraftMessage")(message="Черновик", date=None, entities=[])
            vars(self.native).update(changes)
            with self.subTest(changes=changes), self.assertRaises(M.TelegramRuntimeError):
                self.cli("draft-clear", "--chat", "@group", "--dry-run")

    def test_draft_foreign_peer_is_not_an_empty_draft(self):
        self.client.dispatch = lambda request: NS(dialogs=[TL("Dialog")(peer=base.PeerChannel(channel_id=99), draft=None)])
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("draft", "--chat", "@group")

    def test_readonly_allows_preview_and_blocks_cloud_mutation(self):
        with mock.patch.object(M, "load_policy", return_value={"sendMode": "read-only"}):
            preview = self.cli("draft-save", "--chat", "@group", "--message", "Ответ", "--dry-run")
            with self.assertRaises(M.TelegramRuntimeError):
                self.cli("draft-save", "--chat", "@group", "--message", "Ответ", "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertFalse(any(type(row).__name__ == "SaveDraftRequest" for row in self.client.calls))

    def test_account_and_expiry_bind_the_approval(self):
        argv = ["draft-save", "--chat", "@group", "--message", "Ответ"]
        preview = self.cli(*argv, "--dry-run")
        self.client.account.id = 2
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.client.account.id = 1
        with mock.patch.object(M.time, "time", return_value=M.time.time() + 301):
            with self.assertRaises(M.TelegramRuntimeError):
                self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])

    def test_invite_edit_preserves_omitted_settings_and_checks_readback(self):
        preview, result = self.apply("invite-edit", "--chat", "@group", "--invite-link", self.invite.link, "--title", "Другая встреча")
        self.assertEqual(preview["preview"]["previousInvite"]["title"], "Встреча")
        self.assertEqual(result["invite"]["title"], "Другая встреча")
        self.assertEqual(result["invite"]["usageLimit"], 5)

    def test_invite_revoke_does_not_rotate_or_create_links(self):
        _, result = self.apply("invite-revoke", "--chat", "@group", "--invite-link", self.invite.link)
        self.assertTrue(result["invite"]["revoked"])
        self.assertFalse(any(type(row).__name__ == "ExportChatInviteRequest" for row in self.client.calls))

    def test_invite_joins_are_volatile_but_managed_changes_invalidate_approval(self):
        argv = ["invite-edit", "--chat", "@group", "--invite-link", self.invite.link, "--title", "Новое"]
        preview = self.cli(*argv, "--dry-run")
        self.invite.usage = 2
        self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        argv[-1] = "Ещё новое"
        preview = self.cli(*argv, "--dry-run")
        self.invite.usage_limit = 6
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])

    def test_invite_foreign_owner_permanent_and_paid_are_blocked(self):
        for key, value in (("admin_id", 2), ("permanent", True), ("subscription_pricing", NS())):
            with mock.patch.object(self.invite, key, value, create=True):
                with self.subTest(key=key), self.assertRaises(M.TelegramRuntimeError):
                    self.cli("invite-revoke", "--chat", "@group", "--invite-link", self.invite.link, "--dry-run")

    def test_invite_requires_nonempty_compatible_changes_and_future_expiry(self):
        for flags in ([], ["--request-needed", "on"], ["--expires-at", "2026-09-05T00:00:01Z"]):
            with self.subTest(flags=flags), self.assertRaises(M.TelegramRuntimeError):
                self.cli("invite-edit", "--chat", "@group", "--invite-link", self.invite.link, *flags, "--dry-run")

    def test_create_topic_uses_provider_id_and_exact_metadata(self):
        self.group.forum = True
        _, result = self.apply("topic-create", "--chat", "@forum", "--title", "Договоры")
        self.assertTrue(result["created"])
        self.assertEqual(result["topic"]["id"], 100)
        request = next(row for row in self.client.calls if type(row).__name__ == "CreateForumTopicRequest")
        self.assertEqual(type(request.send_as).__name__, "InputPeerSelf")

    def test_topic_rename_close_reopen_preserve_other_metadata(self):
        self.group.forum = True
        for command, extra in (("topic-rename", ["--title", "Договоры"]), ("topic-close", []), ("topic-reopen", [])):
            _, result = self.apply(command, "--chat", "@forum", "--topic-id", "11", *extra)
            self.assertTrue(result["applied"])
            self.assertEqual(result["topic"]["iconColor"], 1)
        self.assertEqual(self.topic.title, "Договоры")
        self.assertFalse(self.topic.closed)

    def test_topic_acl_and_utf8_limit_precede_dispatch(self):
        self.group.forum, self.group.creator = True, False
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("topic-create", "--chat", "@forum", "--title", "Договоры", "--dry-run")
        self.group.creator = True
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("topic-create", "--chat", "@forum", "--title", "Ж" * 65, "--dry-run")

    def test_media_preview_does_not_upload_and_apply_preserves_caption(self):
        self.media()
        preview, result = self.apply("edit-media", "--chat", "@group", "--message-id", "42", "--file", str(self.file))
        self.assertTrue(preview["preview"]["preservesCaption"])
        self.assertTrue(result["applied"])
        self.assertEqual(result["message"]["text"], "Исходный текст")
        self.client.upload_file.assert_awaited_once()
        kwargs = self.client.edit_message.call_args.kwargs
        self.assertIsNone(kwargs["parse_mode"])
        self.assertEqual(kwargs["text"], "Исходный текст")

    def test_changed_file_cannot_reuse_media_approval(self):
        self.media()
        argv = ["edit-media", "--chat", "@group", "--message-id", "42", "--file", str(self.file)]
        preview = self.cli(*argv, "--dry-run")
        self.client.upload_file.assert_not_called()
        self.file.write_bytes(b"DIFFERENT SYNTHETIC FILE")
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.client.upload_file.assert_not_called()

    def test_media_edit_on_another_device_during_upload_is_not_overwritten(self):
        message = self.media()
        async def upload(*args, **kwargs):
            message.message = "Изменено с телефона"
            return NS(name=self.file.name)
        self.client.upload_file.side_effect = upload
        argv = ["edit-media", "--chat", "@group", "--message-id", "42", "--file", str(self.file)]
        preview = self.cli(*argv, "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError) as failure:
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(failure.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")
        self.client.edit_message.assert_not_called()

    def test_media_rejects_incoming_messages_and_unsupported_album_transition(self):
        self.media(out=False)
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("edit-media", "--chat", "@group", "--message-id", "42", "--file", str(self.file), "--dry-run")
        self.media(grouped_id=8)
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("edit-media", "--chat", "@group", "--message-id", "42", "--file", str(self.file), "--dry-run")
        self.client.upload_file.assert_not_called()

    def test_media_rejects_url_symlink_empty_and_oversized_sources(self):
        self.media()
        link = pathlib.Path(self.temp) / "link.pdf"
        try:
            link.symlink_to(self.file)
        except OSError:
            link = None
        empty = pathlib.Path(self.temp) / "empty.pdf"
        empty.write_bytes(b"")
        for path in ["https://example.invalid/file.pdf", str(empty)] + ([str(link)] if link else []):
            with self.subTest(path=path), self.assertRaises(M.TelegramRuntimeError):
                self.cli("edit-media", "--chat", "@group", "--message-id", "42", "--file", path, "--dry-run")

    def test_outgoing_conversation_uses_native_marked_peer_and_monitor_hmac_without_replaying_send(self):
        args = M.build_parser().parse_args(["send", "--chat", "@group", "--message", "Ответ", "--confirm", "--conversation-reference"])
        self.client.send_message.return_value = self.message()
        with mock.patch.object(M, "overview_binding", new=mock.AsyncMock(return_value="a" * 64)), \
             mock.patch.object(M, "overview_cursor_key", return_value=b"synthetic-monitor-private-key"):
            result = asyncio.run(M.command_send_async(args, self.identity))
            expected = M.monitor_conversation_key(self.identity, "a" * 64, base.peer_id(self.group))
        self.assertTrue(result["sent"])
        self.assertEqual(result["conversationReference"], {"available": True, "conversationKey": expected})
        self.client.send_message.assert_awaited_once()
        self.client.send_message.reset_mock()
        with mock.patch.object(M, "overview_binding", new=mock.AsyncMock(side_effect=RuntimeError("PRIVATE_HINT_ERROR"))):
            result = asyncio.run(M.command_send_async(args, self.identity))
        self.assertTrue(result["sent"])
        self.assertEqual(result["conversationReference"], {"available": False, "code": "TELEGRAM_CONVERSATION_REFERENCE_UNAVAILABLE"})
        self.client.send_message.assert_awaited_once()
        self.assertNotIn("PRIVATE_HINT_ERROR", str(result))

    def test_delivery_flags_reach_send_and_failed_confirmation_is_ambiguous(self):
        args = M.build_parser().parse_args(["send", "--chat", "@group", "--message", "Ответ", "--confirm", "--silent", "--no-link-preview"])
        sent = self.message(silent=True)
        self.client.send_message.return_value = sent
        result = asyncio.run(M.command_send_async(args, self.identity))
        self.assertTrue(result["sent"])
        self.assertTrue(self.client.send_message.call_args.kwargs["silent"])
        self.assertFalse(self.client.send_message.call_args.kwargs["link_preview"])
        sent.silent = False
        with self.assertRaises(M.TelegramRuntimeError):
            asyncio.run(M.command_send_async(args, self.identity))
        sent.silent = True
        sent.media = TL("MessageMediaWebPage")(webpage=NS())
        with self.assertRaises(M.TelegramRuntimeError):
            asyncio.run(M.command_send_async(args, self.identity))

    def test_bulk_silent_flag_is_available_but_default_options_remain_empty(self):
        args = M.build_parser().parse_args(["forward", "--from-chat", "@source", "--chat", "@dest", "--message-id", "42", "--silent", "--dry-run"])
        self.assertEqual(A.delivery_options(args), {"silent": True})
        self.assertEqual(A.delivery_options(NS()), {})

    def test_topic_delivery_flags_are_preview_bound_and_read_back(self):
        self.group.forum = True
        sent = self.message(100, message="Ответ", silent=True, reply_to=NS(forum_topic=True, reply_to_msg_id=11))
        self.client.send_message.return_value = sent
        argv = ["topic-send", "--chat", "@forum", "--topic-id", "11", "--message", "Ответ", "--silent", "--no-link-preview"]
        def call(flags):
            return asyncio.run(C.run(M.build_parser().parse_args(argv + flags), self.identity, M))
        preview = call(["--dry-run"])
        self.assertEqual(preview["preview"]["deliveryOptions"], {"silent": True, "link_preview": False})
        self.assertTrue(call(["--confirm", "--approval-hash", preview["approvalHash"]])["sent"])
        self.assertTrue(self.client.send_message.call_args.kwargs["silent"])
        self.assertFalse(self.client.send_message.call_args.kwargs["link_preview"])

    def test_short_send_reply_is_verified_from_exact_message(self):
        full = self.message(silent=True)
        short = copy.copy(full)
        del short.silent
        self.client.send_message.return_value = short
        args = M.build_parser().parse_args(["send", "--chat", "@group", "--message", full.message, "--confirm", "--silent"])
        self.assertTrue(asyncio.run(M.command_send_async(args, self.identity))["sent"])
        self.assertEqual(self.client.reads[-1], (base.peer_id(self.group), 42))

    def test_delivery_queue_namespace_never_uses_colliding_history(self):
        history = self.message(silent=False)
        queued = copy.deepcopy(history)
        queued.silent = True
        args = NS(silent=True, no_link_preview=False, schedule_at="2026-10-30T00:00:00Z")
        with mock.patch.object(M, "get_scheduled_target", new=mock.AsyncMock(return_value=queued)) as get_queue:
            result = asyncio.run(A.delivery_readback(self.client, self.group, queued, args, M))
        self.assertIs(result, queued)
        get_queue.assert_awaited_once()
        self.assertEqual(self.client.reads, [])

    def test_topic_creation_without_proven_id_is_unknown_without_second_create(self):
        self.group.forum = True
        dispatch = self.client.dispatch
        self.client.dispatch = lambda request: NS(updates=[]) if type(request).__name__ == "CreateForumTopicRequest" else dispatch(request)
        argv = ["topic-create", "--chat", "@forum", "--title", "Договоры"]
        preview = self.cli(*argv, "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError) as failure:
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(failure.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(sum(type(row).__name__ == "CreateForumTopicRequest" for row in self.client.calls), 1)

    def test_media_readback_rejects_unrequested_caption_change(self):
        self.media()
        edit = self.client.edit_message.side_effect
        async def changed(*args, **kwargs):
            result = await edit(*args, **kwargs)
            self.current.message = "Чужая правка после edit"
            return result
        self.client.edit_message.side_effect = changed
        argv = ["edit-media", "--chat", "@group", "--message-id", "42", "--file", str(self.file)]
        preview = self.cli(*argv, "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError) as failure:
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(failure.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")

    def test_cleanup_failure_after_write_keeps_unknown_outcome(self):
        argv = ["draft-save", "--chat", "@group", "--message", "Ответ"]
        preview = self.cli(*argv, "--dry-run")
        self.client.disconnect.side_effect = OSError("PRIVATE_DIAGNOSTIC")
        with self.assertRaises(M.TelegramRuntimeError) as failure:
            self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(failure.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")
        self.assertNotIn("PRIVATE_DIAGNOSTIC", str(failure.exception))


class AuthoringClientPolicyTests(unittest.TestCase):
    def test_all_authoring_commands_disable_passive_updates_and_writes_disable_retry(self):
        constructor = mock.Mock()
        with mock.patch.object(M, "require_app_credentials", return_value=(12345, "synthetic", False)), \
             mock.patch.object(M, "session_path", return_value=pathlib.Path("unused.session")), \
             mock.patch.object(M, "import_telethon", return_value=(constructor, None, None)):
            for command in sorted(A.COMMANDS):
                with self.subTest(command=command):
                    M.build_client(NS(command=command), M.Identity("company", "member", "connection"))
                    options = constructor.call_args.kwargs
                    self.assertFalse(options["receive_updates"])
                    if command in A.MUTATIONS:
                        self.assertEqual(options["request_retries"], 0)
                        self.assertEqual(options["flood_sleep_threshold"], 0)
                        self.assertTrue(options["raise_last_call_error"])


if __name__ == "__main__":
    unittest.main()
