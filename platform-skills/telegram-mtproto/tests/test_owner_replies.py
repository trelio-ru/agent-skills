"""Taskless replies reuse the real parser/send/read-back, never a live account."""
import asyncio
import importlib.util
import io
import json
import pathlib
import sys
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace as NS
from unittest import mock

SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "trelio-telegram.py"
SPEC = importlib.util.spec_from_file_location("telegram_owner_reply_runtime", SCRIPT)
M = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = M
SPEC.loader.exec_module(M)
BUILD_CLIENT = M.build_client


def tl(name, **fields):
    return type(name, (NS,), {})(**fields)


def peer_id(value):
    if type(value).__name__ == "User":
        return value.id
    return getattr(value, "user_id", None)


class OwnerReplies(unittest.TestCase):
    def setUp(self):
        self.identity = M.Identity(company_id="11111111-1111-4111-8111-111111111111",
                                   member_id="22222222-2222-4222-8222-222222222222",
                                   connection_id="33333333-3333-4333-8333-333333333333")
        self.peer = tl("User", id=77)
        self.original = tl("Message", id=10, peer_id=tl("PeerUser", user_id=77),
                           from_id=tl("PeerUser", user_id=77), message="PRIVATE QUESTION",
                           date=datetime(2026, 10, 27, tzinfo=timezone.utc), edit_date=None,
                           out=False, entities=[], media=None, reply_to=None, fwd_from=None, via_bot_id=None)
        self.sent = tl("Message", id=11, peer_id=tl("PeerUser", user_id=77), out=True,
                       message="PRIVATE ANSWER", reply_to_msg_id=10, reply_to=None, media=None)
        self.provider = NS(send_message=mock.AsyncMock(return_value=self.sent),
                           get_messages=mock.AsyncMock(return_value=self.sent), disconnect=mock.AsyncMock())
        self.enterContext(mock.patch.object(M, "build_client", return_value=self.provider))
        self.enterContext(mock.patch.object(M, "ensure_authorized", new=mock.AsyncMock()))
        self.enterContext(mock.patch.object(M, "assert_send_allowed", return_value="confirm"))
        self.resolve = self.enterContext(mock.patch.object(M, "resolve_message_target", new=mock.AsyncMock(return_value=(self.peer, self.original))))
        self.key = "telegram-conversation/v1." + "c" * 64
        self.enterContext(mock.patch.object(M, "reference_conversation_key", new=mock.AsyncMock(return_value=self.key)))
        self.presence = self.enterContext(mock.patch.object(M, "publish_online_presence", new=mock.AsyncMock(return_value=True)))
        self.enterContext(mock.patch.object(M, "import_telethon_workflows", return_value=(
            NS(), NS(), NS(get_peer_id=peer_id), NS(), NS(parse=lambda value: (value, [])))))

    def args(self, **changes):
        revision = M.monitor_message(self.original, NS(get_peer_id=peer_id), kind="new", channel_peer=77)["revision"]
        args = M.build_parser().parse_args(["reply-reference", "--chat", "77", "--message-id", "10",
            "--expected-revision", revision, "--expected-conversation-key", self.key,
            "--expected-owner-id", "77", "--confirm"])
        for key, value in changes.items():
            setattr(args, key, value)
        return args

    def run_reply(self, args=None, text="PRIVATE ANSWER"):
        stream = NS(buffer=io.BytesIO(json.dumps({"text": text}, ensure_ascii=False).encode("utf-8")))
        with mock.patch.object(sys, "stdin", stream):
            return asyncio.run(M.command_reply_async(args or self.args(), self.identity))

    def test_exact_native_reply_is_one_send_with_plain_text_and_positive_readback(self):
        result = self.run_reply()
        self.assertEqual(result["protocol"], "telegram-owner-reply/v1")
        self.assertEqual(result["messageId"], 11)
        self.assertEqual(result["reference"]["conversationKey"], self.key)
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertFalse(result["automaticRetryAllowed"])
        self.provider.send_message.assert_awaited_once_with(self.peer, "PRIVATE ANSWER",
            reply_to=10, file=None, parse_mode=None, link_preview=False)
        self.provider.get_messages.assert_awaited_once_with(self.peer, ids=11)
        self.presence.assert_awaited_once_with(self.provider)
        self.provider.disconnect.assert_awaited_once()

    def test_group_or_wrong_owner_denies_before_any_client(self):
        with mock.patch.object(M, "build_client", side_effect=AssertionError("must refuse before credentials")):
            for args in (self.args(chat="-77"), self.args(expected_owner_id="78"), self.args(confirm=False)):
                with self.assertRaises(M.TelegramRuntimeError):
                    self.run_reply(args)

    def test_forward_bot_outgoing_changed_revision_and_non_user_never_send(self):
        for change in ({"fwd_from": NS()}, {"via_bot_id": 55}, {"out": True}, {"message": "CHANGED"}):
            args = self.args()
            old = {name: getattr(self.original, name) for name in change}
            try:
                for name, value in change.items():
                    setattr(self.original, name, value)
                with self.assertRaises(M.TelegramRuntimeError):
                    self.run_reply(args)
            finally:
                for name, value in old.items():
                    setattr(self.original, name, value)
        self.resolve.return_value = (tl("Channel", id=77), self.original)
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_reply()
        self.provider.send_message.assert_not_awaited()

    def test_readback_failure_keeps_a_single_unknown_send(self):
        self.provider.get_messages.side_effect = RuntimeError("PRIVATE PROVIDER FAILURE")
        with self.assertRaises(M.TelegramRuntimeError) as raised:
            self.run_reply()
        self.assertNotIn("PRIVATE", str(raised.exception))
        self.provider.send_message.assert_awaited_once()

    def test_stdin_is_bounded_strict_and_cannot_accept_extra_selectors(self):
        for raw in (b'{}', b'{"text":""}', b'{"text":"ok","chat":78}', b'\xff', b'x' * 16385):
            with mock.patch.object(sys, "stdin", NS(buffer=io.BytesIO(raw))):
                with self.assertRaises(M.TelegramRuntimeError):
                    M.read_owner_reply_input()
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_reply(text="😀" * 2049)
        self.provider.send_message.assert_not_awaited()

    def test_source_reply_has_no_implicit_sdk_retry_or_update_subscription(self):
        constructor = mock.Mock()
        with mock.patch.object(M, "require_app_credentials", return_value=(1, "synthetic", False)), \
             mock.patch.object(M, "import_telethon", return_value=(constructor, None, None)), \
             mock.patch.object(M, "session_path", return_value=pathlib.Path("synthetic.session")):
            BUILD_CLIENT(self.args(), self.identity)
        policy = constructor.call_args.kwargs
        self.assertEqual(policy["request_retries"], 0)
        self.assertFalse(policy["receive_updates"])
        self.assertEqual(policy["flood_sleep_threshold"], 0)


class Presence(unittest.TestCase):
    def test_presence_is_explicit_native_online_without_offline_or_private_diagnostics(self):
        request = object()
        make_request = mock.Mock(return_value=request)
        client = mock.AsyncMock(return_value=True)
        api = NS(account=NS(UpdateStatusRequest=make_request))
        with mock.patch.object(M, "import_telethon_workflows", return_value=(api, None, None, None, None)):
            self.assertTrue(asyncio.run(M.publish_online_presence(client)))
            make_request.assert_called_once_with(offline=False)
            client.assert_awaited_once_with(request)
            client.side_effect = RuntimeError("PRIVATE TRANSPORT DETAIL")
            self.assertFalse(asyncio.run(M.publish_online_presence(client)))
            client.side_effect = asyncio.CancelledError()
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(M.publish_online_presence(client))
        self.assertFalse(M.build_parser().parse_args(["monitor"]).online_presence)
        self.assertTrue(M.build_parser().parse_args(["monitor", "--online-presence"]).online_presence)


if __name__ == "__main__":
    unittest.main()
