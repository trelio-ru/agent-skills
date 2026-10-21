"""Exercise exact authorship and irreversible scope against a changing server.

Fixtures contain no account/session/credentials and never contact Telegram.
The same production parser, handlers and one-use disk journal run on every OS.
"""
import asyncio
import copy
import json
import pathlib
import unittest
from types import SimpleNamespace as NS
from unittest import mock

import test_message_workflows as base
import test_community_tools as community

M, TL = base.M, base.tl_type
I, C = M.import_interaction_tools(), M.import_community_tools()


class InteractionTests(unittest.TestCase):
    setUpBase = base.MessageWorkflowsTests.setUp
    message = base.MessageWorkflowsTests.message

    def setUp(self):
        community.CommunityTests.setUp(self)
        self.author = base.Channel(id=99, title="Редакция", username="editorial", access_hash="PRIVATE_HASH")
        self.senders = [TL("SendAsPeer")(peer=base.PeerUser(user_id=1), premium_required=False),
                        TL("SendAsPeer")(peer=base.PeerChannel(channel_id=99), premium_required=False)]
        self.full = TL("ChannelFull")(id=77, about="Описание", participants_count=0,
                  linked_chat_id=88, slowmode_seconds=30, default_send_as=base.PeerChannel(channel_id=99),
                  available_reactions=TL("ChatReactionsSome")(reactions=[TL("ReactionEmoji")(emoticon="👍")]),
                  exported_invite="PRIVATE_INVITE", participants="PRIVATE_PARTICIPANTS")
        self.functions = NS(**vars(community.F), GetSendAsRequest=TL("GetSendAsRequest"), DeleteMessagesRequest=TL("DeleteMessagesRequest"))
        self.enterContext(mock.patch.object(C, "api", return_value=(NS(messages=self.functions, channels=self.functions, stats=self.functions),
                          community.T, community.U, NS(parse=base.markdown))))
        self.client.dispatch = self.dispatch
        self.group.forum = False
        self.client.send_message.side_effect = self.send
        self.current = self.message(from_id=base.PeerUser(user_id=1))
        self.deleted = False

    def dispatch(self, request):
        name = type(request).__name__
        if name == "GetSendAsRequest":
            return NS(peers=copy.deepcopy(self.senders), users=[self.client.account], chats=[self.author])
        if name == "GetFullChannelRequest":
            return NS(full_chat=copy.deepcopy(self.full), chats=[self.group], users=[NS(phone="PRIVATE_PHONE")])
        if name == "GetFullChatRequest":
            return NS(full_chat=TL("ChatFull")(id=self.group.id, about="Группа"), chats=[self.group])
        if name == "DeleteMessagesRequest":
            self.deleted = True
            self.client.messages.pop((base.peer_id(self.group), request.id[0]), None)
            return TL("AffectedMessages")(pts=2, pts_count=1)
        return community.CommunityTests.dispatch(self, request)

    async def send(self, entity, body, **kwargs):
        sender = kwargs.get("send_as", self.client.account)
        sender_peer = base.PeerUser(user_id=sender.id) if type(sender).__name__ == "User" else base.PeerChannel(channel_id=sender.id)
        text, entities = base.markdown(body or "")
        reply = kwargs.get("reply_to")
        return self.message(100, message=text, entities=entities, from_id=sender_peer, out=True,
                            reply_to_msg_id=reply, reply_to=NS(reply_to_msg_id=reply) if reply else None)

    def cli(self, *argv):
        args = M.build_parser().parse_args(list(argv))
        function = (M.command_send_async if args.command == "send" else M.command_reply_async if args.command == "reply" else None)
        return asyncio.run(function(args, self.identity) if function else I.run(args, self.identity, M))

    def apply(self, *argv):
        preview = self.cli(*argv, "--dry-run")
        result = self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        return preview, result

    def test_capabilities_use_fresh_exact_metadata_without_history_or_private_fields(self):
        self.group.admin_rights = NS(post_messages=True, delete_messages=False)
        result = self.cli("chat-info", "--chat", "@group")
        self.assertEqual(result["audienceCount"], 0)
        self.assertEqual(result["linkedChatPeerId"], -1000000000088)
        self.assertTrue(result["adminRights"]["post_messages"])
        self.assertFalse(result["adminRights"]["delete_messages"])
        self.assertEqual(result["slowmodeSeconds"], 30)
        self.assertEqual(result["allowedReactions"]["reactions"], [{"type": "emoji", "emoji": "👍"}])
        self.assertEqual(self.client.reads, [])
        self.assertNotIn("PRIVATE_", json.dumps(result))
        self.assertFalse(result["readState"]["marksRead"])

    def test_capabilities_reject_foreign_or_missing_fresh_rights(self):
        self.full.id = 78
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("chat-info", "--chat", "@group")
        self.full.id = 77
        old = self.client.dispatch
        self.client.dispatch = lambda q: NS(full_chat=self.full, chats=[]) if type(q).__name__ == "GetFullChannelRequest" else old(q)
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("chat-info", "--chat", "@group")

    def test_unknown_counts_and_long_about_remain_explicit(self):
        self.full.participants_count = None
        self.full.about = "я" * 4097
        result = self.cli("chat-info", "--chat", "@group")
        self.assertIsNone(result["audienceCount"])
        self.assertTrue(result["aboutTruncated"])
        self.assertEqual(len(result["about"]), 4096)

    def test_sender_catalog_has_exact_marked_ids_and_no_private_data(self):
        result = self.cli("send-as", "--chat", "@group")
        self.assertEqual([row["peerId"] for row in result["senders"]], [1, -1000000000099])
        self.assertEqual(self.client.reads, [])
        self.assertNotIn("PRIVATE_", json.dumps(result))

    def test_sender_catalog_rejects_duplicates_foreign_users_missing_entity_and_bounds(self):
        for rows in ([self.senders[0], self.senders[0]], [TL("SendAsPeer")(peer=base.PeerUser(user_id=8))],
                     [TL("SendAsPeer")(peer=base.PeerChannel(channel_id=55))], self.senders * 51):
            with self.subTest(rows=len(rows)):
                original = self.senders
                self.senders = rows
                with self.assertRaises(M.TelegramRuntimeError):
                    self.cli("send-as", "--chat", "@group")
                self.senders = original

    def test_personal_send_as_in_private_chat_has_no_channel_catalog_request(self):
        self.client.group = self.group = base.User(id=8, first_name="Алиса")
        result = self.cli("send-as", "--chat", "@alice")
        self.assertEqual(result["senders"][0]["peerId"], 1)
        self.assertEqual(self.client.calls, [])

    def test_explicit_sender_is_reviewed_sent_and_verified(self):
        preview, result = self.apply("send", "--chat", "@group", "--message", "**Привет**", "--send-as", "@editorial")
        self.assertEqual(preview["preview"]["sender"]["peerId"], -1000000000099)
        self.assertEqual(preview["preview"]["text"], "Привет")
        self.assertTrue(result["sent"])
        self.assertEqual(self.client.send_message.call_args.kwargs["send_as"].id, 99)
        self.assertFalse(self.client.send_message.call_args.kwargs["clear_draft"])
        self.assertEqual(self.client.reads[-1], (-1000000000077, 100))

    def test_selection_removed_after_preview_prevents_send(self):
        args = ("send", "--chat", "@group", "--message", "Привет", "--send-as", "@editorial")
        preview = self.cli(*args, "--dry-run")
        self.senders.pop()
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.client.send_message.assert_not_called()

    def test_sender_and_body_changes_and_token_reuse_fail(self):
        args = ["send", "--chat", "@group", "--message", "Привет", "--send-as", "@editorial"]
        preview = self.cli(*args, "--dry-run")
        changed = args[:-1] + ["self"]
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*changed, "--confirm", "--approval-hash", preview["approvalHash"])
        args[4] = "Другое"
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        args[4] = "Привет"
        self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])

    def test_sender_premium_requirement_is_not_ignored(self):
        self.senders[1].premium_required = True
        result = self.cli("send-as", "--chat", "@group")
        self.assertFalse(result["senders"][1]["available"])
        with self.assertRaisesRegex(M.TelegramRuntimeError, "Premium"):
            self.cli("send", "--chat", "@group", "--message", "Привет", "--send-as", "@editorial", "--dry-run")

    def test_wrong_delivered_author_is_unknown_and_token_stays_consumed(self):
        args = ("send", "--chat", "@group", "--message", "Привет", "--send-as", "@editorial")
        preview = self.cli(*args, "--dry-run")
        original = self.send
        async def wrong(*a, **kw):
            value = await original(*a, **kw)
            value.from_id = base.PeerUser(user_id=1)
            return value
        self.client.send_message.side_effect = wrong
        with self.assertRaises(M.TelegramRuntimeError) as context:
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(context.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(self.client.send_message.call_count, 1)

    def test_exact_reply_keeps_target_and_selected_author(self):
        preview, result = self.apply("reply", "--chat", "@group", "--message-id", "42", "--message", "Ответ", "--send-as", "self")
        self.assertEqual(preview["preview"]["replyToMessageId"], 42)
        self.assertEqual(result["replyToMessageId"], 42)
        self.assertEqual(self.client.send_message.call_args.kwargs["send_as"].id, 1)

    def test_explicit_file_preview_freezes_original_bytes_and_blocks_changed_file(self):
        path = pathlib.Path(self.temp) / "image.png"
        path.write_bytes(b"\x89PNG\r\n\x1a\nSYNTHETIC_ONLY")
        args = ("send", "--chat", "@group", "--file", str(path), "--send-as", "self")
        preview = self.cli(*args, "--dry-run")
        self.assertEqual(preview["preview"]["file"]["mediaType"], "photo")
        path.write_bytes(b"\x89PNG\r\n\x1a\nCHANGED")
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.client.send_message.assert_not_called()

    def test_delete_shows_exact_message_and_never_expands_album(self):
        self.current.grouped_id = 555
        preview, result = self.apply("delete", "--chat", "@group", "--message-id", "42", "--scope", "everyone")
        self.assertEqual(preview["preview"]["message"]["id"], 42)
        self.assertFalse(preview["preview"]["albumExpanded"])
        request = self.client.calls[-1]
        self.assertEqual(request.id, [42])
        self.assertTrue(result["deleted"])
        self.assertEqual(result["scope"], "everyone")

    def test_delete_rejects_incoming_anonymous_service_and_foreign_peer(self):
        for changes in ({"out": False}, {"from_id": base.PeerChannel(channel_id=99)}, {"from_id": base.PeerUser(user_id=8)},
                        {"action": NS()}, {"peer_id": base.PeerChannel(channel_id=99)}):
            with self.subTest(changes=list(changes)):
                original = self.current
                self.current = copy.deepcopy(original)
                for key, value in changes.items():
                    setattr(self.current, key, value)
                self.client.messages[(-1000000000077, 42)] = self.current
                with self.assertRaises(M.TelegramRuntimeError):
                    self.cli("delete", "--chat", "@group", "--message-id", "42", "--scope", "everyone", "--dry-run")
                self.current = original
        self.assertFalse(self.deleted)

    def test_delete_scope_and_content_change_are_bound(self):
        with self.assertRaisesRegex(M.TelegramRuntimeError, "everyone"):
            self.cli("delete", "--chat", "@group", "--message-id", "42", "--scope", "me", "--dry-run")
        args = ("delete", "--chat", "@group", "--message-id", "42", "--scope", "everyone")
        preview = self.cli(*args, "--dry-run")
        self.current.message = "Изменилось"
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertFalse(self.deleted)

    def test_delete_lost_response_is_unknown_without_retry(self):
        args = ("delete", "--chat", "@group", "--message-id", "42", "--scope", "everyone")
        preview = self.cli(*args, "--dry-run")
        old = self.dispatch
        def failure(request):
            if type(request).__name__ == "DeleteMessagesRequest":
                raise TimeoutError("PRIVATE_RPC")
            return old(request)
        self.client.dispatch = failure
        with self.assertRaises(M.TelegramRuntimeError) as context:
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(context.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")
        self.assertNotIn("PRIVATE_", str(context.exception))
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(sum(type(row).__name__ == "DeleteMessagesRequest" for row in self.client.calls), 1)

    def test_delete_retained_message_does_not_count_as_success(self):
        old = self.dispatch
        self.client.dispatch = lambda q: TL("AffectedMessages")(pts=2, pts_count=1) if type(q).__name__ == "DeleteMessagesRequest" else old(q)
        args = ("delete", "--chat", "@group", "--message-id", "42", "--scope", "everyone")
        preview = self.cli(*args, "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError) as context:
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(context.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")

    def test_readonly_allows_preview_and_reads_but_blocks_send_delete(self):
        M.load_policy.return_value = {"sendMode": "read-only"}
        for args in (("delete", "--chat", "@group", "--message-id", "42", "--scope", "everyone"),
                     ("send", "--chat", "@group", "--message", "Привет", "--send-as", "self")):
            preview = self.cli(*args, "--dry-run")
            with self.assertRaises(M.TelegramRuntimeError):
                self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.cli("send-as", "--chat", "@group")
        self.client.send_message.assert_not_called()
        self.assertFalse(self.deleted)

    def test_bootstrap_gate_and_real_dispatch_are_registered(self):
        with mock.patch.object(M, "import_telethon_workflows", side_effect=M.TelegramRuntimeError("Run bootstrap first")), \
             mock.patch.object(C, "api", side_effect=AssertionError("SDK must not be imported")):
            with self.assertRaisesRegex(M.TelegramRuntimeError, "bootstrap"):
                self.cli("chat-info", "--chat", "@group")
        for command in ("chat-info", "send-as"):
            args = M.build_parser().parse_args([command, "--chat", "@group"])
            with mock.patch.object(M, "identity_from_args", return_value=self.identity), \
                 mock.patch.object(M, "session_lock", return_value=mock.MagicMock()):
                self.assertIn("securityBoundary", M.run_async_command(args))

    def test_delete_private_chat_passes_exact_revoke_choice(self):
        self.client.group = self.group = base.User(id=8, first_name="Алиса")
        self.current = self.message(peer_id=base.PeerUser(user_id=8), from_id=base.PeerUser(user_id=1))
        _preview, result = self.apply("delete", "--chat", "@alice", "--message-id", "42", "--scope", "me")
        request = self.client.calls[-1]
        self.assertEqual(request.id, [42])
        self.assertFalse(request.revoke)
        self.assertEqual(result["scope"], "me")

    def test_delivered_scheduled_message_is_normal_history_not_queue_mutation(self):
        self.current.from_scheduled = True
        _preview, result = self.apply("delete", "--chat", "@group", "--message-id", "42", "--scope", "everyone")
        self.assertTrue(result["deleted"])
        self.assertFalse(any("Scheduled" in type(row).__name__ for row in self.client.calls))

    def test_deletion_requires_native_effect_evidence(self):
        args = ("delete", "--chat", "@group", "--message-id", "42", "--scope", "everyone")
        preview = self.cli(*args, "--dry-run")
        old = self.dispatch
        def without_effect(request):
            result = old(request)
            if type(request).__name__ == "DeleteMessagesRequest":
                result.pts_count = 0
            return result
        self.client.dispatch = without_effect
        with self.assertRaises(M.TelegramRuntimeError) as context:
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(context.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")

    def test_expired_preview_and_switched_account_do_not_send(self):
        args = ("send", "--chat", "@group", "--message", "Привет", "--send-as", "@editorial")
        preview = self.cli(*args, "--dry-run")
        self.client.account.id = 2
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.client.account.id = 1
        with mock.patch.object(M.time, "time", return_value=M.time.time() + 301), self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.client.send_message.assert_not_called()

    def test_broadcast_implied_author_is_not_used_for_anonymous_group(self):
        selected = {"peerId": base.peer_id(self.group)}
        row = self.message(from_id=None, post=True)
        with self.assertRaises(M.TelegramRuntimeError):
            I.verify_sender(row, self.group, selected, M, community.U)
        self.group.broadcast = True
        I.verify_sender(row, self.group, selected, M, community.U)

    def test_missing_username_cannot_be_selected_as_literal_none(self):
        self.author.username = None
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("send", "--chat", "@group", "--message", "Привет", "--send-as", "@None", "--dry-run")

    def test_topic_sender_is_bound_to_preview_and_verified(self):
        self.group.forum = True
        original = self.send
        async def topic_send(*a, **kw):
            row = await original(*a, **kw)
            row.reply_to.forum_topic = True
            return row
        self.client.send_message.side_effect = topic_send
        args = M.build_parser().parse_args(["topic-send", "--chat", "@group", "--topic-id", "11", "--message", "Ответ", "--send-as", "@editorial", "--dry-run"])
        preview = asyncio.run(C.run(args, self.identity, M))
        self.assertEqual(preview["preview"]["sender"]["peerId"], -1000000000099)
        args.dry_run, args.confirm, args.approval_hash = False, True, preview["approvalHash"]
        result = asyncio.run(C.run(args, self.identity, M))
        self.assertTrue(result["sent"])
        self.assertEqual(self.client.send_message.call_args.kwargs["send_as"].id, 99)

    def test_poll_sender_is_passed_per_call_and_wrong_author_is_unknown(self):
        args = M.build_parser().parse_args(["poll-create", "--chat", "@group", "--question", "Когда?", "--option", "Сегодня", "--option", "Завтра", "--send-as", "@editorial", "--dry-run"])
        preview = asyncio.run(C.run(args, self.identity, M))
        args.dry_run, args.confirm, args.approval_hash = False, True, preview["approvalHash"]
        # The synthetic native poll server intentionally delivers without the
        # requested author. A successful RPC must still be reported unknown.
        with self.assertRaises(M.TelegramRuntimeError) as context:
            asyncio.run(C.run(args, self.identity, M))
        self.assertEqual(context.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")
        sent = next(row for row in self.client.calls if type(row).__name__ == "SendMediaRequest")
        self.assertEqual(sent.send_as.id, 99)

    def test_single_message_schedule_is_checked_at_native_rpc_after_upload(self):
        client = NS()
        client._call = mock.AsyncMock(return_value=True)
        from datetime import datetime, timedelta, timezone
        scheduled = datetime(2026, 9, 5, tzinfo=timezone.utc) + timedelta(minutes=2)
        async def check():
            original = client._call
            with I.request_fence(client, scheduled, M):
                M.utc_now.return_value += timedelta(seconds=70)
                with self.assertRaises(M.TelegramRuntimeError):
                    await client._call(None, TL("SendMediaRequest")())
            self.assertIs(client._call, original)
            original.assert_not_called()
        asyncio.run(check())


class ClientPolicyTests(unittest.TestCase):
    def test_capability_reads_disable_updates_and_mutations_disable_implicit_retries(self):
        constructor = mock.Mock()
        with mock.patch.object(M, "require_app_credentials", return_value=(12345, "synthetic", False)), \
             mock.patch.object(M, "session_path", return_value=pathlib.Path("unused.session")), \
             mock.patch.object(M, "import_telethon", return_value=(constructor, None, None)):
            for command in sorted(I.COMMANDS):
                M.build_client(NS(command=command), M.Identity("company", "member", "connection"))
                options = constructor.call_args.kwargs
                self.assertFalse(options["receive_updates"])
                if command == "delete":
                    self.assertEqual(options["request_retries"], 0)
                    self.assertEqual(options["flood_sleep_threshold"], 0)
            M.build_client(NS(command="send", send_as="self"), M.Identity("company", "member", "connection"))
            self.assertFalse(constructor.call_args.kwargs["receive_updates"])


if __name__ == "__main__":
    unittest.main()
