"""Exercise metadata counting without accounts, subscriber lists or message IO."""

import asyncio
import contextlib
import json
import unittest
from datetime import datetime
from types import SimpleNamespace as NS
from unittest import mock

import test_message_workflows as base


M = base.M
Chat = base.tl_type("Chat")
ChannelFull = base.tl_type("ChannelFull")
GetFullChannelRequest = base.tl_type("GetFullChannelRequest")


class AudienceCountTests(unittest.TestCase):
    def setUp(self):
        self.entity = base.Channel(id=77, title="Канал 🛰", username="synthetic_channel",
                                   broadcast=True, participants_count=999,
                                   access_hash="PRIVATE_ACCESS", phone="PRIVATE_PHONE")
        self.full = ChannelFull(id=77, participants_count=50_000,
                                exported_invite="PRIVATE_INVITE", about="PRIVATE_ABOUT")
        # A deliberately tiny client: an unexpected history/participants/send
        # call fails instead of silently turning a metadata test into a scrape.
        self.client = NS(get_entity=mock.AsyncMock(side_effect=lambda _ref: self.entity),
                         disconnect=mock.AsyncMock())
        self.requests = []

        class Client:
            def __getattr__(_self, name):
                return getattr(self.client, name)

            async def __call__(_self, request):
                self.requests.append(request)
                if self.failure is not None:
                    raise self.failure
                return NS(full_chat=self.full, users=[NS(phone="PRIVATE_USER")],
                          chats=[NS(access_hash="PRIVATE_AUXILIARY")])

        self.failure = None
        self.provider = Client()
        self.identity = M.Identity("company", "member", "connection")
        self.enterContext(mock.patch.object(M, "build_client", return_value=self.provider))
        self.authorize = self.enterContext(mock.patch.object(M, "ensure_authorized", new=mock.AsyncMock()))
        self.enterContext(mock.patch.object(M, "import_telethon_audience_count", return_value=GetFullChannelRequest))
        self.enterContext(mock.patch.object(M, "load_policy", side_effect=AssertionError("Read needs no send permission")))

    def call(self, reference="@synthetic_channel"):
        args = M.build_parser().parse_args(["audience-count", "--chat", reference])
        return asyncio.run(M.command_audience_count_async(args, self.identity))

    def test_channel_uses_fresh_full_count_even_when_subscriber_list_is_hidden(self):
        self.full.can_view_participants = False
        self.full.participants_hidden = True
        result = self.call()
        self.assertTrue(result["available"])
        self.assertIsNone(result["reason"])
        self.assertEqual(result["count"], 50_000)
        self.assertEqual(result["audience"], "subscribers")
        self.assertEqual(result["countSource"], "channelFull.participants_count")
        self.assertEqual(result["chatType"], "channel")
        self.assertEqual(result["chat"]["title"], "Канал 🛰")
        self.assertEqual(result["readState"], {"mode": "metadata-only", "marksRead": False})
        self.assertEqual(datetime.fromisoformat(result["observedAt"]).utcoffset().total_seconds(), 0)
        self.assertEqual(len(self.requests), 1)
        self.assertIsInstance(self.requests[0], GetFullChannelRequest)
        self.assertIs(self.requests[0].channel, self.entity)
        self.client.get_entity.assert_awaited_once_with("@synthetic_channel")
        self.client.disconnect.assert_awaited_once()
        self.assertNotIn("PRIVATE_", json.dumps(result))

    def test_each_explicit_read_observes_a_new_count(self):
        self.assertEqual(self.call()["count"], 50_000)
        self.full.participants_count = 50_001
        self.assertEqual(self.call()["count"], 50_001)
        self.assertEqual(len(self.requests), 2)

    def test_supergroup_counts_members_instead_of_subscribers(self):
        self.entity.broadcast = False
        self.entity.megagroup = True
        result = self.call("-1000000000077")
        self.assertEqual(result["audience"], "members")
        self.assertEqual(result["chatType"], "group")
        self.assertEqual(result["count"], 50_000)
        self.client.get_entity.assert_awaited_once_with(-1000000000077)

    def test_basic_group_uses_resolved_metadata_without_full_chat_or_participant_rpc(self):
        self.entity = Chat(id=77, title="Группа", participants_count=12)
        result = self.call("-77")
        self.assertEqual(result["count"], 12)
        self.assertEqual(result["audience"], "members")
        self.assertEqual(result["countSource"], "chat.participants_count")
        self.assertEqual(self.requests, [])

    def test_real_zero_and_largest_tl_int_are_known_counts(self):
        for count in (0, 2**31 - 1):
            with self.subTest(count=count):
                self.full.participants_count = count
                result = self.call()
                self.assertTrue(result["available"])
                self.assertIs(type(result["count"]), int)
                self.assertEqual(result["count"], count)

    def test_invalid_or_missing_counts_never_fall_back_to_cached_entity_or_zero(self):
        for count in (None, True, False, -1, 2**31, "123", 1.0, [], {}):
            with self.subTest(count=count):
                self.full.participants_count = count
                result = self.call()
                self.assertFalse(result["available"])
                self.assertIsNone(result["count"])
                self.assertEqual(result["reason"], "count_unavailable")
        del self.full.participants_count
        self.assertIsNone(self.call()["count"])
        self.entity = Chat(id=77, title="Группа")
        self.assertEqual(self.call()["reason"], "count_unavailable")

    def test_wrong_full_peer_or_constructor_is_rejected_without_returning_count(self):
        for full in (None, NS(id=77, participants_count=1),
                     ChannelFull(id=78, participants_count=1),
                     ChannelFull(id=True, participants_count=1)):
            with self.subTest(full=full):
                self.full = full
                with self.assertRaisesRegex(M.TelegramRuntimeError, "mismatched audience metadata"):
                    self.call()

    def test_access_denial_returns_unknown_and_never_a_cached_count(self):
        for error, reason in (("ChatAdminRequiredError", "hidden_or_admin_required"),
                              ("ChannelPrivateError", "not_joined_or_private"),
                              ("UserNotParticipantError", "not_joined_or_private"),
                              ("ChannelInvalidError", "chat_unavailable")):
            with self.subTest(error=error):
                self.failure = type(error, (Exception,), {})("PRIVATE_RPC")
                result = self.call()
                self.assertFalse(result["available"])
                self.assertIsNone(result["count"])
                self.assertIsNone(result["observedAt"])
                self.assertEqual(result["reason"], reason)
                self.assertNotIn("PRIVATE_", json.dumps(result))

    def test_transport_failure_is_sanitized_and_disconnects(self):
        self.failure = TimeoutError("PRIVATE_RPC")
        with self.assertRaisesRegex(M.TelegramRuntimeError, "without a conclusive result") as caught:
            self.call()
        self.assertNotIn("PRIVATE_", json.dumps(caught.exception.public_payload()))
        self.assertEqual(len(self.requests), 1)
        self.client.disconnect.assert_awaited_once()

    def test_resolution_and_cleanup_failures_are_sanitized(self):
        self.client.get_entity.side_effect = ConnectionError("PRIVATE_NETWORK")
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.call()
        self.assertNotIn("PRIVATE_", str(caught.exception))
        self.client.disconnect.assert_awaited_once()
        self.client.get_entity.side_effect = lambda _ref: self.entity
        self.client.disconnect.side_effect = RuntimeError("PRIVATE_CLEANUP")
        with self.assertRaisesRegex(M.TelegramRuntimeError, "cleanup failed"):
            self.call()

    def test_bad_reference_keeps_exact_existing_recovery_and_disconnects(self):
        self.client.get_entity.side_effect = ValueError("PRIVATE_RESOLUTION")
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.call()
        self.assertEqual(caught.exception.public_payload()["code"], "TELEGRAM_CHAT_RESOLUTION_FAILED")
        self.assertEqual(self.requests, [])
        self.client.disconnect.assert_awaited_once()

    def test_users_and_unknown_types_are_rejected_before_metadata_rpc(self):
        for entity in (base.User(id=1, first_name="Личный диалог"),
                       base.User(id=1, first_name="Бот", bot=True),
                       NS(id=1, title="Неизвестный чат", broadcast=True)):
            with self.subTest(entity=entity):
                self.entity = entity
                with self.assertRaisesRegex(M.TelegramRuntimeError, "requires an exact"):
                    self.call()
        self.assertEqual(self.requests, [])

    def test_authorization_failure_still_disconnects_without_reading_metadata(self):
        self.authorize.side_effect = M.TelegramRuntimeError("Not authorized")
        with self.assertRaisesRegex(M.TelegramRuntimeError, "Not authorized"):
            self.call()
        self.client.get_entity.assert_not_awaited()
        self.client.disconnect.assert_awaited_once()

    def test_parser_and_real_dispatcher_route_the_new_read_command(self):
        args = M.build_parser().parse_args(["audience-count", "--chat", "@synthetic_channel"])
        with mock.patch.object(M, "identity_from_args", return_value=self.identity), \
                mock.patch.object(M, "session_lock", return_value=contextlib.nullcontext()):
            self.assertEqual(M.run_async_command(args)["count"], 50_000)

    def test_sdk_disables_unrelated_update_subscription_for_metadata_read(self):
        args = M.build_parser().parse_args(["audience-count", "--chat", "@synthetic_channel"])
        # Call the real builder, outside setUp's credential-free command patch.
        original_builder = self._original_build_client
        constructor = mock.Mock()
        with mock.patch.object(M, "require_app_credentials", return_value=(1, "synthetic", False)), \
                mock.patch.object(M, "import_telethon", return_value=(constructor, None, None)), \
                mock.patch.object(M, "session_path", return_value="synthetic.session"):
            original_builder(args, self.identity)
        self.assertFalse(constructor.call_args.kwargs["receive_updates"])

    _original_build_client = staticmethod(M.build_client)


if __name__ == "__main__":
    unittest.main()
