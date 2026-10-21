"""Changing synthetic server: exact text, partial delivery and personal state.

Use the production parser and real one-use journal. No account, application
identity, session or network is present in these fixtures on any CI platform.
"""
import asyncio
import copy
import json
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace as NS
from unittest import mock

import test_interaction_tools as interaction
import test_message_workflows as base

M, TL = base.M, base.tl_type
C, I = M.import_conversation_tools(), M.import_interaction_tools()
REAL_BUILD_CLIENT = M.build_client


class ConversationTests(unittest.TestCase):
    setUpBase = base.MessageWorkflowsTests.setUp
    message = base.MessageWorkflowsTests.message
    send = interaction.InteractionTests.send

    def setUp(self):
        interaction.InteractionTests.setUp(self)
        f, t, u, md = I.api(M)
        extra = NS(**{name: TL(name) for name in ("GetPeerDialogsRequest GetNotifySettingsRequest UpdateNotifySettingsRequest "
                   "EditPeerFoldersRequest SendMessageRequest").split()})
        self.functions = NS(**{**vars(self.functions), **vars(extra)})
        self.types = NS(**{**vars(t), **{name: TL(name) for name in
                    "InputDialogPeer InputNotifyPeer InputPeerNotifySettings InputFolderPeer InputReplyToMessage".split()}})
        self.enterContext(mock.patch.object(I, "api", return_value=(
            NS(messages=self.functions, channels=self.functions, account=self.functions, folders=self.functions), self.types, u, md)))
        self.folder, self.pinned, self.send_count = None, False, 0
        self.notify = TL("PeerNotifySettings")(mute_until=None, show_previews=False, silent=True,
                    ios_sound=TL("NotificationSoundDefault")(), stories_muted=True)
        self.client.dispatch = self.dispatch

    def dispatch(self, request):
        name = type(request).__name__
        if name == "GetPeerDialogsRequest":
            return NS(dialogs=[TL("Dialog")(peer=base.PeerChannel(channel_id=77), folder_id=self.folder, pinned=self.pinned)])
        if name == "GetNotifySettingsRequest":
            return copy.deepcopy(self.notify)
        if name == "UpdateNotifySettingsRequest":
            self.notify.mute_until = request.settings.mute_until
            return True
        if name == "EditPeerFoldersRequest":
            self.folder = request.folder_peers[0].folder_id
            self.pinned = False
            return NS(updates=[])
        if name == "SendMessageRequest":
            self.send_count += 1
            header = copy.deepcopy(request.reply_to)
            if header is not None:
                header.forum_topic = getattr(self.group, "forum", False)
                header.reply_to_top_id = getattr(header, "top_msg_id", None)
            message = self.message(100 + self.send_count, message=request.message, entities=request.entities,
                from_id=base.PeerUser(user_id=1), reply_to=header,
                reply_to_msg_id=getattr(header, "reply_to_msg_id", None), silent=request.silent)
            return NS(updates=[TL("UpdateMessageID")(id=message.id, random_id=request.random_id)])
        return interaction.InteractionTests.dispatch(self, request)

    def cli(self, *argv):
        args = M.build_parser().parse_args(list(argv))
        return asyncio.run(M.command_reply_async(args, self.identity) if args.command == "reply" else C.run(args, self.identity, M))

    def apply(self, *argv):
        preview = self.cli(*argv, "--dry-run")
        return preview, self.cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])

    def writes(self):
        return [row for row in self.client.calls if type(row).__name__ in
                {"SendMessageRequest", "UpdateNotifySettingsRequest", "EditPeerFoldersRequest"}]

    def test_quote_uses_native_utf16_offset_and_original_formatting(self):
        self.current.message = "😀 Первый вопрос, второй вопрос"
        self.current.entities = [TL("MessageEntityBold")(offset=3, length=6)]
        preview, result = self.apply("reply", "--chat", "@group", "--message-id", "42", "--quote-text", "Первый", "--message", "Ответ")
        self.assertEqual(preview["preview"]["quote"], {"text": "Первый", "offset": 3})
        reply = self.writes()[0].reply_to
        self.assertEqual((reply.quote_entities[0].offset, reply.quote_entities[0].length), (0, 6))
        self.assertTrue(result["complete"])
        self.assertFalse(self.writes()[0].clear_draft)

    def test_repeated_quote_requires_an_explicit_exact_offset(self):
        self.current.message = "да да"
        args = ("reply", "--chat", "@group", "--message-id", "42", "--quote-text", "да", "--message", "Ответ")
        with self.assertRaisesRegex(M.TelegramRuntimeError, "repeated"):
            self.cli(*args, "--dry-run")
        preview, _result = self.apply(*args, "--quote-offset", "3")
        self.assertEqual(preview["preview"]["quote"]["offset"], 3)
        self.assertEqual(self.writes()[0].reply_to.quote_offset, 3)

    def test_quote_absence_surrogate_interior_negative_and_oversize_are_rejected(self):
        self.current.message = "😀 слово " + "я" * 1025
        for quote, offset in (("нет", None), ("слово", "1"), ("слово", "-1"), ("я" * 513, None)):
            with self.subTest(quote=quote[:10]), self.assertRaises(M.TelegramRuntimeError):
                extra = ["--quote-offset", offset] if offset is not None else []
                self.cli("reply", "--chat", "@group", "--message-id", "42", "--quote-text", quote,
                         "--message", "Ответ", *extra, "--dry-run")
        self.assertEqual(self.writes(), [])

    def test_quote_source_edit_after_preview_does_not_dispatch(self):
        args = ("reply", "--chat", "@group", "--message-id", "42", "--quote-text", "текст", "--message", "Ответ")
        preview = self.cli(*args, "--dry-run")
        self.current.message = "Изменённый текст"
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(self.writes(), [])

    def test_quote_wrong_readback_is_unknown_and_not_replayed(self):
        old = self.dispatch
        def wrong(q):
            result = old(q)
            if type(q).__name__ == "SendMessageRequest":
                self.client.messages[(-1000000000077, 101)].reply_to.quote_text = "Другое"
            return result
        self.client.dispatch = wrong
        args = ("reply", "--chat", "@group", "--message-id", "42", "--quote-text", "текст", "--message", "Ответ")
        preview = self.cli(*args, "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError) as context:
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(context.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(len(self.writes()), 1)

    def test_series_prefers_paragraphs_preserves_text_and_clips_styles(self):
        text = "a" * 3000 + "\n\n" + "б" * 2000
        styles = [TL("MessageEntityBold")(offset=0, length=len(text))]
        parts = C.split_text(text, styles, M)
        self.assertEqual(parts[0][0], "a" * 3000 + "\n\n")
        self.assertEqual("".join(row[0] for row in parts), text)
        self.assertEqual(parts[1][1][0].offset, 0)
        self.assertEqual(parts[1][1][0].length, 2000)
        self.assertEqual(styles[0].length, len(text))

    def test_series_never_splits_emoji_combining_zwj_or_flags(self):
        for cluster in ("😀", "e\u0301", "👩‍💻", "🇷🇺", "👍🏽", "x\r\ny"):
            with self.subTest(cluster=cluster):
                source = "a" * 4095 + cluster + "b" * 100
                parts = C.split_text(source, [], M)
                self.assertEqual("".join(row[0] for row in parts), source)
                self.assertTrue(all(C.units(row[0]) <= 4096 for row in parts))
                index = len(parts[0][0])
                self.assertTrue(C.grapheme_boundary(source, index))

    def test_indivisible_link_moves_whole_and_oversized_link_is_rejected(self):
        text = "a" * 4000 + "linked" * 40
        link = TL("MessageEntityTextUrl")(offset=4000, length=240, url="https://example.com")
        parts = C.split_text(text, [link], M)
        self.assertEqual(len(parts[0][0]), 4000)
        self.assertEqual(parts[1][1][0].offset, 0)
        with self.assertRaises(M.TelegramRuntimeError):
            C.split_text("a" * 5000, [TL("MessageEntityTextUrl")(offset=0, length=5000, url="https://example.com")], M)

    def test_series_full_preview_then_ordered_exact_delivery(self):
        text = "a" * 3000 + "\n\n" + "b" * 2000
        preview, result = self.apply("send-series", "--chat", "@group", "--message", text, "--silent", "--no-link-preview")
        self.assertEqual(len(preview["preview"]["parts"]), 2)
        self.assertEqual([row["messageId"] for row in result["confirmedParts"]], [101, 102])
        self.assertEqual("".join(q.message for q in self.writes()), text)
        self.assertTrue(all(q.silent and q.no_webpage for q in self.writes()))

    def test_partial_delivery_reports_verified_uncertain_and_not_attempted_parts(self):
        old = self.dispatch
        def lost(q):
            if type(q).__name__ == "SendMessageRequest" and self.send_count == 1:
                raise TimeoutError("PRIVATE_PROVIDER_BODY")
            return old(q)
        self.client.dispatch = lost
        args = ("send-series", "--chat", "@group", "--message", "a" * 9000)
        preview = self.cli(*args, "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError) as context:
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        error = context.exception
        self.assertEqual(error.code, "TELEGRAM_SERIES_DELIVERY_UNKNOWN")
        self.assertEqual(error.details["confirmedParts"][0]["messageId"], 101)
        self.assertEqual(error.details["uncertainPart"], 2)
        self.assertEqual(error.details["notAttemptedParts"], [3])
        self.assertNotIn("PRIVATE_", json.dumps(error.public_payload()))
        self.assertEqual(len(self.writes()), 2)
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(len(self.writes()), 2)

    def test_series_oversized_preview_and_total_are_rejected_before_send(self):
        for text in ("я" * 12001, "😀" * 6000, "x" * 60001):
            with self.subTest(size=len(text)), self.assertRaises(M.TelegramRuntimeError):
                self.cli("send-series", "--chat", "@group", "--message", text, "--dry-run")
        self.assertEqual(self.writes(), [])

    def test_forum_series_requires_exact_topic_and_stays_there(self):
        self.group.forum = True
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("send-series", "--chat", "@group", "--message", "Текст", "--dry-run")
        _preview, result = self.apply("send-series", "--chat", "@group", "--topic-id", "11", "--message", "Текст")
        self.assertTrue(result["complete"])
        self.assertEqual(self.writes()[0].reply_to.reply_to_msg_id, 11)

    def test_personal_settings_are_metadata_only_with_unknown_inherited_mute(self):
        result = self.cli("chat-settings", "--chat", "@group")
        self.assertFalse(result["settings"]["archived"])
        self.assertTrue(result["settings"]["muteInherited"])
        self.assertIsNone(result["settings"]["muted"])
        self.assertEqual(self.client.reads, [])
        self.assertEqual(self.writes(), [])
        self.assertNotIn("PRIVATE_", json.dumps(result))

    def test_archive_and_unarchive_touch_one_exact_peer_and_keep_notifications(self):
        self.pinned = True
        previous = copy.deepcopy(self.notify.to_dict())
        preview, result = self.apply("archive", "--chat", "@group")
        self.assertTrue(preview["preview"]["pinMayBeRemoved"])
        self.assertTrue(result["settings"]["archived"])
        self.assertEqual(len(self.writes()[0].folder_peers), 1)
        self.assertEqual(base.peer_id(self.writes()[0].folder_peers[0].peer), -1000000000077)
        self.assertEqual(self.notify.to_dict(), previous)
        self.assertFalse(self.apply("unarchive", "--chat", "@group")[1]["settings"]["archived"])

    def test_mute_and_unmute_preserve_other_platform_notification_preferences(self):
        preview, result = self.apply("mute", "--chat", "@group", "--until", "2026-10-30T10:00:00+03:00")
        self.assertTrue(result["settings"]["muted"])
        self.assertEqual(result["settings"]["muteUntil"], 1793343600)
        self.assertEqual(set(vars(self.writes()[0].settings)), {"mute_until"})
        self.assertFalse(self.notify.show_previews)
        self.assertTrue(self.notify.stories_muted)
        _preview, result = self.apply("unmute", "--chat", "@group")
        self.assertEqual(result["settings"]["muteUntil"], 0)
        self.assertFalse(result["settings"]["muteInherited"])

    def test_concurrent_archive_or_notification_change_invalidates_approval(self):
        for change in (lambda: setattr(self, "folder", 1), lambda: setattr(self.notify, "show_previews", True)):
            with self.subTest(change=change):
                self.folder, self.notify.show_previews = None, False
                preview = self.cli("mute", "--chat", "@group", "--until", "2026-10-30T10:00:00Z", "--dry-run")
                change()
                with self.assertRaises(M.TelegramRuntimeError):
                    self.cli("mute", "--chat", "@group", "--until", "2026-10-30T10:00:00Z", "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(self.writes(), [])

    def test_missing_or_summary_dialog_is_not_an_own_chat(self):
        old = self.dispatch
        self.client.dispatch = lambda q: NS(dialogs=[TL("DialogFolder")(peer=base.PeerChannel(channel_id=77), folder_id=1)]) if type(q).__name__ == "GetPeerDialogsRequest" else old(q)
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("archive", "--chat", "@group", "--dry-run")
        self.assertEqual(self.writes(), [])

    def test_unchanged_archive_consumes_approval_without_redundant_mutation(self):
        self.folder = 1
        args = ("archive", "--chat", "@group")
        preview, result = self.apply(*args)
        self.assertFalse(result["changed"])
        self.assertEqual(self.writes(), [])
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])

    def test_notification_ack_without_readback_is_unknown(self):
        old = self.dispatch
        self.client.dispatch = lambda q: True if type(q).__name__ == "UpdateNotifySettingsRequest" else old(q)
        args = ("unmute", "--chat", "@group")
        preview = self.cli(*args, "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError) as context:
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(context.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")

    def test_read_only_allows_preview_but_no_write(self):
        args = ("archive", "--chat", "@group")
        with mock.patch.object(M, "load_policy", return_value={"sendMode": "read-only"}):
            preview = self.cli(*args, "--dry-run")
            with self.assertRaises(M.TelegramRuntimeError):
                self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(self.writes(), [])

    def test_cleanup_failure_after_personal_write_remains_unknown(self):
        preview = self.cli("archive", "--chat", "@group", "--dry-run")
        self.client.disconnect.side_effect = OSError("PRIVATE_NATIVE")
        with self.assertRaises(M.TelegramRuntimeError) as context:
            self.cli("archive", "--chat", "@group", "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(context.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")
        self.assertNotIn("PRIVATE_", str(context.exception))

    def test_series_preview_is_bound_to_every_part_and_actual_account(self):
        args = ["send-series", "--chat", "@group", "--message", "a" * 5000]
        preview = self.cli(*args, "--dry-run")
        args[-1] += "changed"
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        args[-1] = "a" * 5000
        self.client.account.id = 2
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(self.writes(), [])

    def test_foreign_quote_peer_and_wrong_series_author_do_not_verify(self):
        old = self.dispatch
        def foreign(q):
            value = old(q)
            if type(q).__name__ == "SendMessageRequest":
                self.client.messages[(-1000000000077, 101)].reply_to.reply_to_peer_id = base.PeerChannel(channel_id=99)
            return value
        self.client.dispatch = foreign
        args = ("reply", "--chat", "@group", "--message-id", "42", "--quote-text", "текст", "--message", "Ответ")
        preview = self.cli(*args, "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError) as context:
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(context.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")

    def test_muted_other_settings_changed_by_provider_are_not_reported_as_success(self):
        old = self.dispatch
        def alters(q):
            value = old(q)
            if type(q).__name__ == "UpdateNotifySettingsRequest":
                self.notify.show_previews = True
            return value
        self.client.dispatch = alters
        args = ("mute", "--chat", "@group", "--until", "2026-10-30T10:00:00Z")
        preview = self.cli(*args, "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError) as context:
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(context.exception.code, "TELEGRAM_ACTION_OUTCOME_UNKNOWN")

    def test_series_cleanup_error_keeps_verified_part_ids(self):
        args = ("send-series", "--chat", "@group", "--message", "Текст")
        preview = self.cli(*args, "--dry-run")
        self.client.disconnect.side_effect = OSError("PRIVATE_CLEANUP")
        with self.assertRaises(M.TelegramRuntimeError) as context:
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(context.exception.details["confirmedParts"][0]["messageId"], 101)
        self.assertTrue(context.exception.details["allPartsVerified"])

    def test_short_native_reply_and_missing_random_id_mapping(self):
        old = self.dispatch
        def short(q):
            value = old(q)
            return TL("UpdateShortSentMessage")(id=101, out=True) if type(q).__name__ == "SendMessageRequest" else value
        self.client.dispatch = short
        self.assertTrue(self.apply("send-series", "--chat", "@group", "--message", "Текст")[1]["complete"])
        self.client.dispatch = lambda q: NS(updates=[]) if type(q).__name__ == "SendMessageRequest" else old(q)
        args = ("send-series", "--chat", "@group", "--message", "Ещё")
        preview = self.cli(*args, "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError) as context:
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(context.exception.code, "TELEGRAM_SERIES_DELIVERY_UNKNOWN")

    def test_quote_schedule_uses_queue_namespace_instead_of_colliding_history(self):
        args = ("reply", "--chat", "@group", "--message-id", "42", "--quote-text", "текст", "--message", "Ответ",
                "--schedule-at", "2026-10-30T10:00:00Z")
        preview = self.cli(*args, "--dry-run")
        async def queue(client, entity, message_id):
            value = copy.deepcopy(self.client.messages[(base.peer_id(entity), message_id)])
            value.date = datetime(2026, 10, 30, 10, tzinfo=timezone.utc)
            return value
        with mock.patch.object(M, "get_scheduled_target", new=queue) as _queue:
            result = self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertTrue(result["scheduled"])
        self.assertFalse(result["sent"])
        self.assertEqual(self.writes()[0].schedule_date, datetime(2026, 10, 30, 10, tzinfo=timezone.utc))

    def test_invalid_mute_deadline_and_quote_offset_without_quote_fail(self):
        for until in ("2026-01-01T00:00:00Z", "2026-10-30", "2040-01-01T00:00:00Z"):
            with self.subTest(until=until), self.assertRaises(M.TelegramRuntimeError):
                self.cli("mute", "--chat", "@group", "--until", until, "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("reply", "--chat", "@group", "--message-id", "42", "--quote-offset", "0", "--message", "Текст", "--confirm")
        self.assertEqual(self.writes(), [])

    def test_new_write_clients_disable_updates_and_implicit_retries(self):
        constructor = mock.Mock()
        with mock.patch.object(M, "require_app_credentials", return_value=(12345, "SYNTHETIC", False)), \
             mock.patch.object(M, "import_telethon", return_value=(constructor, None, None)):
            for command in sorted(C.MUTATIONS):
                REAL_BUILD_CLIENT(NS(command=command), self.identity)
                options = constructor.call_args.kwargs
                self.assertEqual(options["request_retries"], 0)
                self.assertEqual(options["flood_sleep_threshold"], 0)
                self.assertFalse(options["receive_updates"])

    def test_unknown_formatting_and_private_input_mentions_fail_closed(self):
        for entity in (TL("UnknownEntity")(offset=0, length=1, token="PRIVATE_TOKEN"),
                       TL("InputMessageEntityMentionName")(offset=0, length=1, user_id=NS(access_hash="PRIVATE_HASH"))):
            with self.assertRaises(M.TelegramRuntimeError):
                C.split_text("hello", [entity], M)

    def test_series_rejects_whitespace_only_tail_without_modifying_text(self):
        with self.assertRaisesRegex(M.TelegramRuntimeError, "whitespace-only"):
            C.split_text("a" + " " * 5000, [], M)
        self.assertEqual(self.writes(), [])

    def test_series_wrong_selected_channel_author_stops_before_next_part(self):
        args = ("send-series", "--chat", "@group", "--send-as", "@editorial", "--message", "a" * 5000)
        preview = self.cli(*args, "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError) as context:
            self.cli(*args, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(context.exception.details["uncertainPart"], 1)
        self.assertEqual(context.exception.details["notAttemptedParts"], [2])
        self.assertEqual(len(self.writes()), 1)

    def test_quote_rejects_service_message_before_dispatch(self):
        self.current.action = NS()
        with self.assertRaises(M.TelegramRuntimeError):
            self.cli("reply", "--chat", "@group", "--message-id", "42", "--quote-text", "текст", "--message", "Ответ", "--dry-run")
        self.assertEqual(self.writes(), [])


if __name__ == "__main__":
    unittest.main()
