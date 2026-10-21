"""Synthetic channel/album/forward regressions through the actual CLI paths."""

import asyncio
import copy
import json
import pathlib
import unittest
from types import SimpleNamespace as NS
from unittest import mock

import test_message_workflows as base


M = base.M
C = M.import_channel_tools()
TL = base.tl_type
GetFullChannel = TL("GetFullChannelRequest")
GetStats = TL("GetBroadcastStatsRequest")
LoadGraph = TL("LoadAsyncGraphRequest")


class ChannelToolsTests(unittest.TestCase):
    original_builder = staticmethod(M.build_client)
    setUpBase = base.MessageWorkflowsTests.setUp
    message = base.MessageWorkflowsTests.message

    def setUp(self):
        self.setUpBase()
        self.group.broadcast = True
        self.client.session = NS(dc_id=2)
        self.api = NS(channels=NS(GetFullChannelRequest=GetFullChannel),
                      stats=NS(GetBroadcastStatsRequest=GetStats, LoadAsyncGraphRequest=LoadGraph))
        self.enterContext(mock.patch.object(C, "api", return_value=(self.api, NS(get_peer_id=base.peer_id), NS(parse=base.markdown))))
        self.full = TL("ChannelFull")(id=77, can_view_stats=True, stats_dc=2)
        self.stats = TL("BroadcastStats")(
            period=NS(min_date=1700000000, max_date=1700600000),
            followers=NS(current=1200, previous=1000), views_per_post=NS(current=100.5, previous=90.2),
            growth_graph=self.graph(), followers_graph=TL("StatsGraphAsync")(token="PRIVATE_TOKEN"))
        self.client.dispatch = lambda request: NS(full_chat=self.full) if isinstance(request, GetFullChannel) else self.stats
        self.original_get_messages = self.client.get_messages

        async def get_messages(entity, *, ids):
            if isinstance(ids, list):
                return [await self.original_get_messages(entity, ids=value) for value in ids]
            return await self.original_get_messages(entity, ids=ids)

        self.client.get_messages = get_messages

    def graph(self, points=3, series=1):
        data = {"columns": [["x", *range(points)]], "types": {"x": "x"}, "names": {}}
        for index in range(series):
            key = "y" + str(index)
            data["columns"].append([key, *range(points)])
            data["types"][key] = "line"
            data["names"][key] = "Прирост"
        return TL("StatsGraph")(json=NS(data=json.dumps(data)), zoom_token="PRIVATE_ZOOM")

    def run_cli(self, *argv):
        args = M.build_parser().parse_args(list(argv))
        return asyncio.run(C.run(args, self.identity, M))

    def test_post_counters_are_nullable_and_group_id_preserves_int64(self):
        for count in (0, 7, 2**31 - 1):
            row = M.public_message(self.message(forwards=count, replies=NS(replies=count, comments=True), grouped_id=2**62))
            self.assertEqual((row["forwards"], row["replyCount"], row["commentsCount"]), (count, count, count))
            self.assertEqual(row["groupedId"], str(2**62))
        for count in (None, True, -1, 2**31, "10", 1.0):
            row = M.public_message(self.message(forwards=count, replies=NS(replies=count, comments=True)))
            self.assertIsNone(row["forwards"])
            self.assertIsNone(row["commentsCount"])
        self.assertIsNone(M.public_message(self.message(replies=NS(replies=2, comments=False)))["commentsCount"])
        self.assertIsNone(M.public_message(self.message(grouped_id=True))["groupedId"])
        self.assertEqual(self.client.calls, [])

    def test_stats_summary_has_real_period_and_never_returns_tokens_or_tl(self):
        result = self.run_cli("channel-stats", "--chat", "@channel")
        self.assertTrue(result["available"])
        self.assertEqual(result["period"]["selectedBy"], "telegram")
        self.assertEqual(result["metrics"]["followers"], {"current": 1200, "previous": 1000})
        self.assertEqual(result["metrics"]["sharesPerPost"], {"current": None, "previous": None})
        self.assertEqual(result["graphs"]["followers"], "pending")
        self.assertNotIn("PRIVATE_", json.dumps(result))
        self.assertEqual(len(self.client.calls), 2)
        self.assertFalse(result["readState"]["marksRead"])

    def test_stats_permission_and_datacenter_fail_closed_before_stats_request(self):
        for value, expected in ((False, "statistics_not_available_for_account"), (None, "statistics_not_available_for_account")):
            self.full.can_view_stats = value
            result = self.run_cli("channel-stats", "--chat", "@channel")
            self.assertFalse(result["available"])
            self.assertEqual(result["reason"], expected)
        self.assertTrue(all(isinstance(request, GetFullChannel) for request in self.client.calls))
        self.full.can_view_stats = True
        self.full.stats_dc = None
        self.assertEqual(self.run_cli("channel-stats", "--chat", "@channel")["reason"], "statistics_datacenter_unavailable")

    def test_stats_wrong_peer_and_period_are_rejected(self):
        self.full.id = 78
        with self.assertRaisesRegex(M.TelegramRuntimeError, "mismatched"):
            self.run_cli("channel-stats", "--chat", "@channel")
        self.full.id = 77
        self.stats.period.max_date = self.stats.period.min_date
        with self.assertRaisesRegex(M.TelegramRuntimeError, "period"):
            self.run_cli("channel-stats", "--chat", "@channel")

    def test_graph_async_load_uses_selected_token_once_and_keeps_summary_on_failure(self):
        def dispatch(request):
            if isinstance(request, GetFullChannel):
                return NS(full_chat=self.full)
            if isinstance(request, LoadGraph):
                self.assertEqual(request.token, "PRIVATE_TOKEN")
                return self.graph()
            return self.stats
        self.client.dispatch = dispatch
        result = self.run_cli("channel-stats", "--chat", "@channel", "--graph", "followers")
        self.assertTrue(result["graph"]["complete"])
        self.assertEqual(len(self.client.calls), 3)
        self.assertNotIn("PRIVATE_", json.dumps(result))
        self.client.dispatch = lambda request: (_ for _ in ()).throw(TimeoutError("PRIVATE_RPC")) if isinstance(request, LoadGraph) else dispatch(request)
        result = self.run_cli("channel-stats", "--chat", "@channel", "--graph", "followers")
        self.assertTrue(result["available"])
        self.assertEqual(result["graph"]["status"], "unavailable")

    def test_exported_statistics_sender_is_returned_even_after_error(self):
        request = NS(resolve=mock.AsyncMock())
        sender = NS(send=mock.AsyncMock(return_value=self.stats))
        self.client._borrow_exported_sender = mock.AsyncMock(return_value=sender)
        self.client._return_exported_sender = mock.AsyncMock()
        result = asyncio.run(C.stats_request(self.client, request, 4, "utils"))
        self.assertIs(result, self.stats)
        request.resolve.assert_awaited_once_with(self.client, "utils")
        self.client._return_exported_sender.assert_awaited_once_with(sender)
        sender.send.side_effect = RuntimeError("PRIVATE")
        with self.assertRaises(RuntimeError):
            asyncio.run(C.stats_request(self.client, request, 4, "utils"))
        self.assertEqual(self.client._return_exported_sender.await_count, 2)

    def test_graph_projection_bounds_points_series_and_rejects_malformed_json(self):
        result = C.public_graph(self.graph(points=120, series=9))
        self.assertFalse(result["complete"])
        self.assertEqual(len(result["series"]), 8)
        self.assertEqual(result["x"], list(range(20, 120)))
        self.assertEqual(result["coverage"]["reportedSeries"], 9)
        for raw in ("{", "{}", "NaN", '"string"', "[1]", "{" * 2000):
            result = C.public_graph(TL("StatsGraph")(json=NS(data=raw)))
            self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(C.finite(float("nan")))
        self.assertIsNone(C.finite(True))
        self.assertIsNone(C.finite(10**1000))

    def test_album_returns_only_matching_group_with_honest_window_coverage(self):
        self.message(41, grouped_id=2**62, media=base.TL(), photo=base.TL())
        self.message(42, grouped_id=2**62, media=base.TL(), photo=base.TL())
        self.message(43, grouped_id=111)
        result = self.run_cli("album", "--chat", "@channel", "--message-id", "42")
        self.assertEqual([row["id"] for row in result["messages"]], [41, 42])
        self.assertFalse(result["coverage"]["complete"])
        self.assertTrue(result["coverage"]["windowOnly"])
        self.assertFalse(result["readState"]["marksRead"])
        self.assertEqual(self.client.calls, [])
        self.assertEqual(len(self.client.reads), 23)

    def test_album_detects_missing_and_changed_selected_message(self):
        self.message()
        self.assertEqual(self.run_cli("album", "--chat", "@channel", "--message-id", "42")["reason"], "message_has_no_album")
        self.message(grouped_id=123)
        original = self.client.get_messages
        count = 0
        async def changing(entity, *, ids):
            nonlocal count
            result = await original(entity, ids=ids)
            if ids == 42:
                count += 1
                if count == 2:
                    result = copy.copy(result)
                    result.message = "Edited concurrently"
            return result
        self.client.get_messages = changing
        with self.assertRaisesRegex(M.TelegramRuntimeError, "changed"):
            self.run_cli("album", "--chat", "@channel", "--message-id", "42")

    def source_forward(self):
        self.message(42)
        self.client.forward_messages = mock.AsyncMock(return_value=[
            self.message(100, fwd_from=base.TL(from_id=base.PeerChannel(channel_id=77), channel_post=42))])
        return ["forward", "--from-chat", "@source", "--chat", "@destination", "--message-id", "42"]

    def test_forward_preview_then_verified_delivery_preserves_source_and_disables_replay(self):
        argv = self.source_forward()
        preview = self.run_cli(*argv, "--dry-run")
        self.client.forward_messages.assert_not_awaited()
        self.assertTrue(preview["preview"]["preservesAttribution"])
        result = self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(result["messageIds"], [100])
        self.assertFalse(self.client.forward_messages.call_args.kwargs["drop_author"])
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(self.client.forward_messages.await_count, 1)

    def test_forward_selected_author_is_in_preview_native_call_and_exact_readback(self):
        argv = self.source_forward() + ["--send-as", "self"]
        self.client.messages[(-1000000000077, 100)].from_id = base.PeerUser(user_id=1)
        selected = {"peerId": 1, "title": "Владелец"}
        with mock.patch.object(M.import_interaction_tools(), "select_sender", new=mock.AsyncMock(return_value=(self.client.account, selected))):
            preview = self.run_cli(*argv, "--dry-run")
            self.assertEqual(preview["preview"]["sender"], selected)
            result = self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(self.client.forward_messages.call_args.kwargs["send_as"].id, 1)
        self.assertEqual(result["sender"], selected)

    def test_album_wrong_selected_author_stays_unknown_after_one_dispatch(self):
        argv = self.album_argv() + ["--send-as", "self"]
        self.client.send_file = mock.AsyncMock(return_value=[
            self.message(100, message="Альбом", entities=base.markdown("**Альбом**")[1], grouped_id=999, media=base.TL(), photo=base.TL(), from_id=base.PeerUser(user_id=8)),
            self.message(101, message="", grouped_id=999, media=base.TL(), photo=base.TL(), from_id=base.PeerUser(user_id=1))])
        with mock.patch.object(M.import_interaction_tools(), "select_sender", new=mock.AsyncMock(return_value=(self.client.account, {"peerId": 1}))):
            preview = self.run_cli(*argv, "--dry-run")
            with self.assertRaises(M.TelegramRuntimeError) as context:
                self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
            self.assertEqual(context.exception.code, "TELEGRAM_BULK_DELIVERY_UNKNOWN")
            self.assertEqual(self.client.send_file.call_args.kwargs["send_as"].id, 1)
            with self.assertRaises(M.TelegramRuntimeError):
                self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(self.client.send_file.await_count, 1)

    def test_forward_rechecks_changed_source_and_read_only_without_dispatch(self):
        argv = self.source_forward()
        preview = self.run_cli(*argv, "--dry-run")
        self.client.messages[(-1000000000077, 42)].message = "Changed original"
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.client.forward_messages.assert_not_awaited()
        with mock.patch.object(M, "load_policy", return_value={"sendMode": "read-only"}):
            self.run_cli(*argv, "--dry-run")
            with self.assertRaises(M.TelegramRuntimeError):
                self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.client.forward_messages.assert_not_awaited()

    def test_protected_source_and_partial_or_wrong_destination_forward_never_report_success(self):
        argv = self.source_forward()
        self.group.noforwards = True
        with self.assertRaisesRegex(M.TelegramRuntimeError, "protects"):
            self.run_cli(*argv, "--dry-run")
        self.group.noforwards = False
        for sent in ([], [self.message(101, peer_id=base.PeerChannel(channel_id=99))], [self.message(102)]):
            preview = self.run_cli(*argv, "--dry-run")
            self.client.forward_messages.return_value = sent
            with self.assertRaises(M.TelegramRuntimeError) as caught:
                self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
            self.assertEqual(caught.exception.code, "TELEGRAM_BULK_DELIVERY_UNKNOWN")

    def files(self):
        files = []
        for index in range(2):
            path = pathlib.Path(self.temp) / (str(index) + ".jpg")
            path.write_bytes(b"\xff\xd8\xffsynthetic-jpeg")
            path.chmod(0o600)
            files.append(str(path))
        return files

    def album_argv(self):
        files = self.files()
        return ["send-album", "--chat", "@destination", "--file", files[0], "--file", files[1], "--message", "**Альбом**"]

    def test_album_send_freezes_bytes_and_checks_group_caption_and_media(self):
        argv = self.album_argv()
        self.client.send_file = mock.AsyncMock(return_value=[
            self.message(100, message="Альбом", entities=base.markdown("**Альбом**")[1], grouped_id=999, media=base.TL(), photo=base.TL()),
            self.message(101, message="", grouped_id=999, media=base.TL(), photo=base.TL())])
        preview = self.run_cli(*argv, "--dry-run")
        self.client.send_file.assert_not_awaited()
        self.assertEqual(preview["preview"]["caption"], "Альбом")
        result = self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertTrue(result["sent"])
        call = self.client.send_file.call_args
        self.assertEqual(call.kwargs["caption"], ["**Альбом**", ""])
        self.assertFalse(call.kwargs["clear_draft"])
        self.assertTrue(all(file.closed for file in call.args[1]))
        self.assertFalse(any(isinstance(file, str) for file in call.args[1]))

    def test_changed_upload_bytes_require_new_preview_before_network(self):
        argv = self.album_argv()
        self.client.send_file = mock.AsyncMock()
        preview = self.run_cli(*argv, "--dry-run")
        pathlib.Path(argv[4]).write_bytes(b"\xff\xd8\xffchanged")
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.client.send_file.assert_not_awaited()

    def test_bad_album_files_and_duplicate_ids_are_rejected_before_send(self):
        files = self.files()
        for selected in ([files[0]], [files[0]] * 2, ["https://example.com/photo.jpg", files[0]]):
            with self.assertRaises(M.TelegramRuntimeError):
                C.frozen_files(selected, M)
        pathlib.Path(files[0]).write_bytes(b"not-a-photo")
        with self.assertRaises(M.TelegramRuntimeError):
            C.frozen_files(files, M)
        argv = self.source_forward()
        with self.assertRaisesRegex(M.TelegramRuntimeError, "distinct"):
            self.run_cli(*argv, "--message-id", "42", "--dry-run")

    def test_selected_readable_media_does_not_require_credential_permissions(self):
        files = self.files()
        pathlib.Path(files[0]).chmod(0o644)
        frozen, preview = C.frozen_files(files, M)
        try:
            self.assertEqual(len(preview), 2)
            self.assertEqual(len(frozen), 2)
        finally:
            for item in frozen:
                item.close()

    def test_bulk_sdk_policy_disables_automatic_mutation_retries(self):
        for command in ("send-album", "forward"):
            constructor = mock.Mock()
            with mock.patch.object(M, "require_app_credentials", return_value=(1, "synthetic", False)), \
                    mock.patch.object(M, "import_telethon", return_value=(constructor, None, None)), \
                    mock.patch.object(M, "session_path", return_value="synthetic.session"):
                self.original_builder(NS(command=command), self.identity)
            self.assertEqual(constructor.call_args.kwargs["request_retries"], 0)
            self.assertEqual(constructor.call_args.kwargs["flood_sleep_threshold"], 0)
            self.assertTrue(constructor.call_args.kwargs["raise_last_call_error"])

    def test_ambiguous_upload_consumes_approval_and_never_leaks_provider_error(self):
        argv = self.album_argv()
        self.client.send_file = mock.AsyncMock(side_effect=RuntimeError("PRIVATE_PROVIDER"))
        preview = self.run_cli(*argv, "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(caught.exception.code, "TELEGRAM_BULK_DELIVERY_UNKNOWN")
        self.assertNotIn("PRIVATE_", json.dumps(caught.exception.public_payload()))
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(self.client.send_file.await_count, 1)

    def test_confirmation_binds_account_destination_and_expiry(self):
        argv = self.source_forward()
        preview = self.run_cli(*argv, "--dry-run")
        self.client.account.id = 999
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.client.account.id = 1
        with mock.patch.object(M.time, "time", return_value=M.time.time() + 600):
            with self.assertRaises(M.TelegramRuntimeError):
                self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        preview = self.run_cli(*argv, "--dry-run")
        self.group.id = 78
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.client.forward_messages.assert_not_awaited()

    def test_failed_album_shape_is_unknown_and_token_stays_consumed(self):
        argv = self.album_argv()
        self.client.send_file = mock.AsyncMock(return_value=[])
        preview = self.run_cli(*argv, "--dry-run")
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(caught.exception.code, "TELEGRAM_BULK_DELIVERY_UNKNOWN")
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_cli(*argv, "--confirm", "--approval-hash", preview["approvalHash"])
        self.assertEqual(self.client.send_file.await_count, 1)

    def test_preview_budget_and_paid_destination_block_before_send(self):
        argv = self.source_forward()
        self.client.messages[(-1000000000077, 42)].message = "Текст" * 3000
        argv += ["--message-id", "43"]
        self.message(43, message="Текст" * 3000)
        with self.assertRaisesRegex(M.TelegramRuntimeError, "budget"):
            self.run_cli(*argv, "--dry-run")
        self.group.send_paid_messages_stars = 5
        with self.assertRaisesRegex(M.TelegramRuntimeError, "Paid"):
            self.run_cli(*argv, "--dry-run")
        self.client.forward_messages.assert_not_awaited()


class ScheduledBulkTests(unittest.TestCase):
    files = ChannelToolsTests.files
    album_argv = ChannelToolsTests.album_argv
    setUpBase = base.MessageWorkflowsTests.setUp
    setUp = ChannelToolsTests.setUp
    message = ChannelToolsTests.message
    graph = ChannelToolsTests.graph
    run_cli = ChannelToolsTests.run_cli
    source_forward = ChannelToolsTests.source_forward

    def setUp(self):
        ChannelToolsTests.setUp(self)
        self.client._call = mock.AsyncMock()

    def test_forward_of_incoming_original_and_schedule_verified_in_queue_namespace(self):
        argv = self.source_forward() + ['--schedule-at', '2026-10-30T12:00:00Z']
        self.client.messages[(-1000000000077, 42)].out = False
        queued = self.client.forward_messages.return_value[0]
        queued.date = M.parse_schedule_at('2026-10-30T12:00:00Z')
        with mock.patch.object(M, 'get_scheduled_target', new=mock.AsyncMock(return_value=queued)) as read_queue:
            preview = self.run_cli(*argv, '--dry-run')
            result = self.run_cli(*argv, '--confirm', '--approval-hash', preview['approvalHash'])
            self.assertTrue(result['scheduled'])
            self.assertFalse(result['sent'])
            read_queue.assert_awaited_once_with(self.client, self.group, 100)
            self.assertEqual(self.client.forward_messages.call_args.kwargs['schedule'], queued.date)

    def test_schedule_change_requires_new_preview_and_missing_queue_is_unknown(self):
        argv = self.source_forward()
        schedule = ['--schedule-at', '2026-10-30T12:00:00Z']
        preview = self.run_cli(*argv, *schedule, '--dry-run')
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_cli(*argv, '--confirm', '--approval-hash', preview['approvalHash'])
        self.client.forward_messages.assert_not_awaited()
        with mock.patch.object(M, 'get_scheduled_target', new=mock.AsyncMock(side_effect=M.TelegramRuntimeError('missing'))):
            with self.assertRaises(M.TelegramRuntimeError) as caught:
                self.run_cli(*argv, *schedule, '--confirm', '--approval-hash', preview['approvalHash'])
            self.assertEqual(caught.exception.code, 'TELEGRAM_BULK_DELIVERY_UNKNOWN')

    def test_incoming_album_can_be_read_without_own_queue_restrictions(self):
        self.message(41, grouped_id=11, out=False, media=base.TL(), photo=base.TL())
        self.message(42, grouped_id=11, out=False, media=base.TL(), photo=base.TL())
        result = self.run_cli('album', '--chat', '@group', '--message-id', '42')
        self.assertEqual([row['id'] for row in result['messages']], [41, 42])

    def test_schedule_below_lead_time_fails_before_upload_or_send(self):
        argv = self.source_forward()
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_cli(*argv, '--schedule-at', '2026-09-05T00:00:30Z', '--dry-run')
        self.client.forward_messages.assert_not_awaited()

    def test_album_schedule_keeps_bytes_and_verifies_every_queue_entry(self):
        argv = self.album_argv() + ['--schedule-at', '2026-10-30T12:00:00Z']
        date = M.parse_schedule_at('2026-10-30T12:00:00Z')
        rows = [self.message(100, date=date, message='Альбом', entities=base.markdown('**Альбом**')[1], grouped_id=99, media=base.TL(), photo=base.TL()),
                self.message(101, date=date, message='', grouped_id=99, media=base.TL(), photo=base.TL())]
        self.client.send_file = mock.AsyncMock(return_value=rows)
        with mock.patch.object(M, 'get_scheduled_target', new=mock.AsyncMock(side_effect=rows)) as queue:
            preview = self.run_cli(*argv, '--dry-run')
            result = self.run_cli(*argv, '--confirm', '--approval-hash', preview['approvalHash'])
            self.assertTrue(result['scheduled'])
            self.assertFalse(result['sent'])
            self.assertEqual(queue.await_count, 2)
            self.assertEqual(self.client.send_file.call_args.kwargs['schedule'], date)
            self.assertTrue(all(file.closed for file in self.client.send_file.call_args.args[1]))

    def test_slow_upload_cannot_turn_scheduled_album_into_immediate_send(self):
        date = M.parse_schedule_at('2026-10-30T12:00:00Z')
        original = self.client._call
        with self.assertRaises(M.TelegramRuntimeError):
            with C.scheduled_request_fence(self.client, date, M):
                with mock.patch.object(M, 'utc_now', return_value=date):
                    asyncio.run(self.client._call('sender', TL('SendMultiMediaRequest')()))
        original.assert_not_awaited()
        self.assertIs(self.client._call, original)


if __name__ == '__main__':
    unittest.main()
