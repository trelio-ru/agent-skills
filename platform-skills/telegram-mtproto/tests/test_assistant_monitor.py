"""Passive provider differences: synthetic account/channel, no session or network.

Assert native requests, cursor continuity, output privacy and failure behavior.
No fixture can authorize a task, send a message or mark a message read.
"""
import asyncio
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace as NS
from unittest import mock

PATH = pathlib.Path(__file__).parents[1] / 'scripts' / 'trelio-telegram.py'
SPEC = importlib.util.spec_from_file_location('telegram_assistant_monitor_runtime', PATH)
M = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = M
SPEC.loader.exec_module(M)
BUILD_CLIENT = M.build_client


def tl(name, **fields):
    return type(name, (NS,), {})(**fields)


def request(name):
    return lambda **fields: tl(name, **fields)


NOW = datetime(2026, 10, 21, 12, tzinfo=timezone.utc)
FUNCTIONS = tuple(request(name) for name in ('GetState', 'GetDifference', 'GetChannelDifference', 'GetFullChannel', 'Empty'))


def peer_id(value):
    if hasattr(value, 'channel_id'):
        return -1_000_000_000_000 - value.channel_id
    if type(value).__name__ == 'Channel':
        return -1_000_000_000_000 - value.id
    if hasattr(value, 'chat_id'):
        return -value.chat_id
    return value.user_id


def position(pts=10, qts=0, date=NOW):
    return NS(pts=pts, qts=qts, seq=1, date=date)


def message(message_id=1, peer=None, text='PRIVATE BODY', sender=None, **extra):
    return tl('Message', id=message_id, peer_id=peer or tl('PeerUser', user_id=77),
              message=text, from_id=sender or tl('PeerUser', user_id=77), date=NOW,
              edit_date=extra.pop('edit_date', None), out=extra.pop('out', False), entities=extra.pop('entities', []),
              media=None, reply_to=None, fwd_from=extra.pop('fwd_from', None), **extra)


class Provider:
    def __init__(self):
        self.calls = []
        self.response = None
        self.authorized = True
        self.connect = mock.AsyncMock()
        self.disconnect = mock.AsyncMock()
        self.channel = tl('Channel', id=55, access_hash='PRIVATE ACCESS HASH')

    async def is_user_authorized(self):
        return self.authorized

    async def get_me(self):
        return NS(id=12345)

    async def __call__(self, call):
        self.calls.append(call)
        name = type(call).__name__
        if name == 'GetState':
            return position()
        if name == 'GetFullChannel':
            return NS(full_chat=NS(pts=10))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class Monitor(unittest.TestCase):
    def setUp(self):
        self.temp = self.enterContext(tempfile.TemporaryDirectory())
        self.provider = Provider()
        self.identity = M.Identity(company_id='11111111-1111-4111-8111-111111111111',
                                   member_id='22222222-2222-4222-8222-222222222222',
                                   connection_id='33333333-3333-4333-8333-333333333333')
        self.enterContext(mock.patch.object(M, 'connection_root', return_value=pathlib.Path(self.temp)))
        self.enterContext(mock.patch.object(M, 'build_client', return_value=self.provider))
        self.enterContext(mock.patch.object(M, 'import_telethon_monitor', return_value=(*FUNCTIONS, NS(get_peer_id=peer_id))))
        self.resolve = self.enterContext(mock.patch.object(M, 'resolve_entity', new=mock.AsyncMock(return_value=self.provider.channel)))

    def run_page(self, cursor=None, chat=None, **extra):
        return asyncio.run(M.command_monitor_async(NS(command='monitor', limit=100, cursor=cursor, chat=chat, **extra), self.identity))

    def baseline(self, chat=None):
        result = self.run_page(chat=chat)
        self.assertTrue(result['baselineOnly'])
        self.assertEqual(result['events'], [])
        self.assertFalse(result['coverage']['historicalBackfill'])
        self.assertFalse(result['readState']['readReceiptsSent'])
        return result['nextCursor']

    def difference(self, messages=None, updates=None, **extra):
        return tl('Difference', new_messages=messages or [], other_updates=updates or [],
                  state=position(pts=12), **extra)

    def unread_backfill(self, history=None, dialog=None):
        self.enterContext(mock.patch.object(M, 'import_telethon_monitor_history', return_value=(
            request('GetDialogs'), request('GetHistory'), request('InputDialogPeer'))))
        self.provider.get_input_entity = mock.AsyncMock(return_value=tl('InputPeerChannel', channel_id=55))
        old = self.provider.__class__.__call__
        self.history = list(history or [])
        self.dialog = dialog or tl('Dialog', peer=tl('PeerChannel', channel_id=55), read_inbox_max_id=5, top_message=9)
        async def dispatch(provider, call):
            if type(call).__name__ in ('GetDialogs', 'GetHistory'):
                provider.calls.append(call)
                if type(call).__name__ == 'GetDialogs':
                    return NS(dialogs=[self.dialog])
                result = self.history.pop(0)
                if isinstance(result, Exception):
                    raise result
                return result
            return await old(provider, call)
        self.enterContext(mock.patch.object(self.provider.__class__, '__call__', dispatch))

    def test_unread_backfill_freezes_interval_and_catches_up_original_pts_without_ack(self):
        rows = [message(i, peer=tl('PeerChannel', channel_id=55)) for i in (9, 8)]
        self.unread_backfill([tl('ChannelMessages', messages=rows),
            tl('MessagesSlice', messages=[message(6, peer=tl('PeerChannel', channel_id=55))]), tl('Messages', messages=[])])
        first = self.run_page(chat='-1000000000055', unread_backfill=True)
        self.assertFalse(first['baselineOnly'])
        self.assertTrue(first['coverage']['initialUnreadOnly'])
        self.assertFalse(first['coverage']['snapshotAtomic'])
        self.assertEqual([row['messageId'] for row in first['events']], ['9', '8'])
        self.assertNotIn('PRIVATE', json.dumps(first))
        self.assertTrue(first['hasMore'])
        # Another device reads the dialog and new traffic moves its top. The
        # signed checkpoint, not this changed unread flag, retains 5 < id <= 9.
        self.dialog.read_inbox_max_id = 100
        self.dialog.top_message = 101
        second = self.run_page(first['nextCursor'], chat='-1000000000055')
        self.assertEqual([row['messageId'] for row in second['events']], ['6'])
        empty = self.run_page(second['nextCursor'], chat='-1000000000055')
        self.assertTrue(empty['hasMore'], 'history exhaustion still requires the original-pts difference')
        self.provider.response = tl('ChannelDifference', pts=15, final=True,
            new_messages=[message(10, peer=tl('PeerChannel', channel_id=55))], other_updates=[])
        done = self.run_page(empty['nextCursor'], chat='-1000000000055')
        self.assertFalse(done['hasMore'])
        self.assertEqual(done['events'][0]['messageId'], '10')
        self.assertEqual(self.provider.calls[-1].pts, 10, 'the pre-history pts is never replaced by current state')
        calls = self.provider.calls
        self.assertEqual([type(call).__name__ for call in calls],
            ['GetFullChannel', 'GetDialogs', 'GetHistory', 'GetHistory', 'GetHistory', 'GetChannelDifference'])
        history = [call for call in calls if type(call).__name__ == 'GetHistory']
        self.assertEqual([(call.offset_id, call.min_id, call.max_id, call.limit) for call in history],
            [(10, 5, 10, 100), (8, 5, 10, 100), (6, 5, 10, 100)])

    def test_initial_unread_empty_interval_still_needs_difference_not_fresh_baseline(self):
        self.unread_backfill(dialog=tl('Dialog', peer=tl('PeerChannel', channel_id=55), read_inbox_max_id=9, top_message=9))
        first = self.run_page(chat='-1000000000055', unread_backfill=True)
        self.assertFalse(first['baselineOnly'])
        self.assertEqual(first['events'], [])
        self.assertTrue(first['hasMore'])
        self.assertEqual([type(call).__name__ for call in self.provider.calls], ['GetFullChannel', 'GetDialogs'])

    def test_unread_backfill_foreign_duplicate_unavailable_and_oversized_pages_never_return_cursor(self):
        wrong = message(9, peer=tl('PeerChannel', channel_id=56))
        valid = message(9, peer=tl('PeerChannel', channel_id=55))
        for rows in ([wrong], [valid, valid], [message(10, peer=tl('PeerChannel', channel_id=55))],
                     [tl('MessageEmpty', id=8)], [valid]*101):
            with self.subTest(rows=len(rows)):
                # Each attempt is a read-only initial call, not mutation replay.
                with mock.patch.object(M, 'import_telethon_monitor_history', return_value=(request('GetDialogs'), request('GetHistory'), request('InputDialogPeer'))):
                    self.provider.get_input_entity = mock.AsyncMock(return_value=tl('InputPeerChannel', channel_id=55))
                    original = self.provider.__class__.__call__
                    async def dispatch(provider, call):
                        if type(call).__name__ == 'GetDialogs':
                            return NS(dialogs=[tl('Dialog', peer=tl('PeerChannel', channel_id=55), read_inbox_max_id=5, top_message=9)])
                        if type(call).__name__ == 'GetHistory':
                            return tl('Messages', messages=rows)
                        return await original(provider, call)
                    with mock.patch.object(self.provider.__class__, '__call__', dispatch), self.assertRaises(M.TelegramRuntimeError):
                        self.run_page(chat='-1000000000055', unread_backfill=True)

    def test_unread_backfill_failure_retains_exact_checkpoint_and_service_only_page_advances(self):
        service = tl('MessageService', id=8, peer_id=tl('PeerChannel', channel_id=55))
        self.unread_backfill([tl('MessagesSlice', messages=[service]), TimeoutError('PRIVATE SESSION'),
            tl('Messages', messages=[])])
        first = self.run_page(chat='-1000000000055', unread_backfill=True)
        self.assertEqual(first['events'], [])
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.run_page(first['nextCursor'], chat='-1000000000055')
        self.assertEqual(caught.exception.code, 'TELEGRAM_MONITOR_UNAVAILABLE')
        self.assertNotIn('PRIVATE', json.dumps(caught.exception.public_payload()))
        done = self.run_page(first['nextCursor'], chat='-1000000000055')
        self.assertTrue(done['hasMore'])
        self.assertEqual(self.provider.calls[-1].offset_id, 8)
        self.assertEqual(self.provider.calls[-2].offset_id, 8)

    def test_unread_backfill_cannot_reset_cursor_or_guess_channel_before_session_io(self):
        with mock.patch.object(M, 'build_client') as build:
            for chat, cursor in ((None, None), ('@name', None), ('-1000000000055', 'old-cursor')):
                with self.assertRaises(M.TelegramRuntimeError) as caught:
                    self.run_page(cursor, chat=chat, unread_backfill=True)
                self.assertEqual(caught.exception.code, 'TELEGRAM_MONITOR_INVALID_INPUT')
            build.assert_not_called()
        self.assertEqual(self.provider.calls, [])
        self.assertEqual(self.provider.connect.await_count, 0)

    def test_unread_backfill_rejects_unknown_dialog_scope_or_read_boundary(self):
        self.unread_backfill()
        for dialog in (tl('DialogFolder', peer=tl('PeerChannel', channel_id=55)),
                       tl('Dialog', peer=tl('PeerChannel', channel_id=56), read_inbox_max_id=5, top_message=9),
                       tl('Dialog', peer=tl('PeerChannel', channel_id=55), read_inbox_max_id=None, top_message=9),
                       tl('Dialog', peer=tl('PeerChannel', channel_id=55), read_inbox_max_id=True, top_message=9),
                       tl('Dialog', peer=tl('PeerChannel', channel_id=55), read_inbox_max_id=0, top_message=2**31-1)):
            self.dialog = dialog
            with self.assertRaises(M.TelegramRuntimeError):
                self.run_page(chat='-1000000000055', unread_backfill=True)
        self.assertNotIn('GetHistory', [type(call).__name__ for call in self.provider.calls])

    def test_account_checkpoint_interval_includes_already_read_messages_and_equal_timestamp(self):
        seed = self.baseline()
        newer = message(9, peer=tl('PeerChannel', channel_id=55)); newer.date = NOW + timedelta(seconds=3)
        equal = message(8, peer=tl('PeerChannel', channel_id=55))
        older = message(7, peer=tl('PeerChannel', channel_id=55)); older.date = NOW - timedelta(seconds=1)
        self.unread_backfill([tl('ChannelMessages', messages=[newer, equal, older])],
            dialog=tl('Dialog', peer=tl('PeerChannel', channel_id=55), read_inbox_max_id=9, top_message=9))
        first = self.run_page(chat='-1000000000055', initial_account_cursor=seed)
        self.assertEqual([row['messageId'] for row in first['events']], ['9', '8'])
        self.assertTrue(first['coverage']['initialAccountInterval'])
        self.assertNotIn('initialUnreadOnly', first['coverage'])
        self.assertFalse(first['coverage']['earlierEditsIncluded'])
        self.assertTrue(first['hasMore'])
        self.assertEqual(self.provider.calls[-1].min_id, 0, 'another device read marker never supplies the initial floor')
        self.provider.response = tl('ChannelDifference', pts=20, final=True,
            new_messages=[message(10, peer=tl('PeerChannel', channel_id=55))], other_updates=[])
        final = self.run_page(first['nextCursor'], chat='-1000000000055')
        self.assertEqual(self.provider.calls[-1].pts, 10)
        self.assertFalse(final['hasMore'])
        self.assertEqual(final['events'][0]['messageId'], '10')
        self.assertNotIn('PRIVATE', json.dumps(first))

    def test_account_interval_checkpoint_survives_pages_but_refuses_reverse_native_date_order(self):
        seed = self.baseline()
        first_row = message(9, peer=tl('PeerChannel', channel_id=55)); first_row.date = NOW + timedelta(seconds=2)
        later_row = message(8, peer=tl('PeerChannel', channel_id=55)); later_row.date = NOW + timedelta(seconds=3)
        equal = message(8, peer=tl('PeerChannel', channel_id=55))
        self.unread_backfill([tl('MessagesSlice', messages=[first_row]), tl('Messages', messages=[later_row]),
                             tl('MessagesSlice', messages=[equal]), tl('Messages', messages=[])])
        first = self.run_page(chat='-1000000000055', initial_account_cursor=seed)
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.run_page(first['nextCursor'], chat='-1000000000055')
        self.assertEqual(caught.exception.code, 'TELEGRAM_MONITOR_GAP')
        continued = self.run_page(first['nextCursor'], chat='-1000000000055')
        self.assertTrue(continued['coverage']['initialAccountInterval'])
        self.assertEqual([row['messageId'] for row in continued['events']], ['8'])
        done = self.run_page(continued['nextCursor'], chat='-1000000000055')
        self.assertTrue(done['hasMore'])
        self.assertEqual([call.offset_id for call in self.provider.calls if type(call).__name__=='GetHistory'], [10, 9, 9, 8])

    def test_account_interval_seed_is_exact_native_account_scope_not_timestamp_channel_or_overview(self):
        account = self.baseline()
        channel = self.baseline(chat='-1000000000055')
        self.unread_backfill()
        for seed in (channel, account+'x', '1710000000'):
            with self.assertRaises(M.TelegramRuntimeError):
                self.run_page(chat='-1000000000055', initial_account_cursor=seed)
        original = self.identity
        self.identity = M.Identity(company_id='88888888-8888-4888-8888-888888888888',
            member_id=original.member_id, connection_id=original.connection_id)
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_page(chat='-1000000000055', initial_account_cursor=account)
        self.identity = original
        self.assertNotIn('GetHistory', [type(call).__name__ for call in self.provider.calls])

    def test_account_interval_mode_and_channel_reset_are_rejected_before_client_io(self):
        with mock.patch.object(M, 'build_client') as build:
            for options in ({'unread_backfill':True,'initial_account_cursor':'seed'},
                            {'initial_account_cursor':''}, {'initial_account_cursor':'bad cursor'},
                            {'initial_account_cursor':'seed','cursor':'old'}):
                with self.assertRaises(M.TelegramRuntimeError):
                    self.run_page(chat='-1000000000055', **options)
            build.assert_not_called()

    def test_baseline_is_explicit_and_only_reads_current_position(self):
        self.baseline()
        self.assertEqual([type(call).__name__ for call in self.provider.calls], ['GetState'])
        self.assertEqual(self.provider.disconnect.await_count, 1)
        self.resolve.assert_not_awaited()

    def test_new_and_edited_references_without_text_or_transport_credentials(self):
        token = self.baseline()
        edited = message(2, sender=tl('PeerUser', user_id=9007199254740993123),
                         edit_date=NOW+timedelta(seconds=1), fwd_from=NS(from_id=NS(id=11)))
        self.provider.response = self.difference([message()], [tl('UpdateEditMessage', message=edited)])
        result = self.run_page(token)
        self.assertFalse(result['baselineOnly'])
        self.assertEqual([row['kind'] for row in result['events']], ['new','edit'])
        self.assertEqual(result['events'][1]['senderUserId'], '9007199254740993123')
        self.assertEqual(result['events'][1]['senderNamespace'], 'telegram_user_id')
        self.assertTrue(result['events'][1]['forwarded'])
        self.assertNotIn('PRIVATE', json.dumps(result))
        call = self.provider.calls[-1]
        self.assertEqual(type(call).__name__, 'GetDifference')
        self.assertEqual((call.pts, call.qts, call.pts_limit), (10, 0, 100))
        self.assertFalse(hasattr(call,'pts_total_limit'),'a recoverable large backlog must not request a fast-update reset')
        replay = self.run_page(token)
        self.assertEqual(replay['events'], result['events'])
        self.assertEqual([type(call).__name__ for call in self.provider.calls], ['GetState','GetDifference','GetDifference'])

    def test_cursor_retains_edits_and_can_continue_intermediate_slices(self):
        token = self.baseline()
        self.provider.response = tl('DifferenceSlice',new_messages=[message()],other_updates=[], intermediate_state=position(pts=11))
        page = self.run_page(token)
        self.assertTrue(page['hasMore'])
        self.provider.response = tl('DifferenceEmpty',date=NOW+timedelta(seconds=10),seq=2)
        done = self.run_page(page['nextCursor'])
        self.assertEqual(self.provider.calls[-1].pts,11)
        self.assertFalse(done['hasMore'])
        self.assertEqual(done['events'],[])

    def test_too_long_malformed_and_nonadvancing_pages_do_not_deliver_a_new_cursor(self):
        token = self.baseline()
        for response in (tl('DifferenceTooLong',pts=9000), tl('FutureDifference'),
                         tl('DifferenceSlice',new_messages=[],other_updates=[],intermediate_state=position()),
                         self.difference([message(i+1) for i in range(101)]),
                         self.difference([tl('MessageEmpty',id=1)])):
            self.provider.response = response
            with self.assertRaises(M.TelegramRuntimeError):
                self.run_page(token)
        self.provider.response = self.difference([message()])
        recovered = self.run_page(token)
        self.assertEqual(self.provider.calls[-1].pts,10,'every failure retained the original checkpoint')
        self.assertEqual(len(recovered['events']),1)

    def test_unavailable_does_not_reset_cursor_login_or_ack(self):
        token = self.baseline()
        self.provider.response = TimeoutError('PRIVATE HTTP SESSION COOKIE')
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.run_page(token)
        self.assertEqual(caught.exception.code,'TELEGRAM_MONITOR_UNAVAILABLE')
        self.assertNotIn('PRIVATE',json.dumps(caught.exception.public_payload()))
        self.provider.authorized=False
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_page(token)
        self.assertEqual(self.provider.disconnect.await_count,3,'cleanup includes authorization failures')

    def test_mutated_or_other_account_cursor_cannot_continue(self):
        token = self.baseline()
        for invalid in (token+'x', 'not-a-cursor'):
            with self.assertRaises(M.TelegramRuntimeError):
                self.run_page(invalid)
        with mock.patch.object(self.provider,'get_me',new=mock.AsyncMock(return_value=NS(id=12346))):
            with self.assertRaises(M.TelegramRuntimeError):
                self.run_page(token)
        self.assertEqual([type(call).__name__ for call in self.provider.calls],['GetState'])

    def test_host_binding_changes_cannot_reuse_a_checkpoint_with_the_same_native_account(self):
        fields = {"company_id": self.identity.company_id, "member_id": self.identity.member_id,
                  "connection_id": self.identity.connection_id,
                  "account": {"id": "44444444-4444-4444-8444-444444444444", "companyBinding": "a" * 64}}
        self.identity = M.Identity(**fields)
        token = self.baseline()
        for key in ("company_id", "member_id", "connection_id", "account"):
            changed = {**fields, key: {**fields["account"], "companyBinding": "b" * 64} if key == "account"
                       else "55555555-5555-4555-8555-555555555555"}
            self.identity = M.Identity(**changed)
            with self.assertRaises(M.TelegramRuntimeError) as caught:
                self.run_page(token)
            self.assertEqual(caught.exception.code, "TELEGRAM_MONITOR_INVALID_CURSOR")
        self.identity = M.Identity(**{**fields, "account": {**fields["account"], "id": "66666666-6666-4666-8666-666666666666"}})
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_page(token)
        self.assertEqual([type(call).__name__ for call in self.provider.calls], ["GetState"])

    def test_monitor_checkpoint_survives_downtime_and_clock_change_without_reset_or_auth_grant(self):
        token = self.baseline()
        self.provider.response = self.difference([message()])
        now = M.time.time()
        cursors = []
        for shifted in (now + 30 * 86400, now + 366 * 86400, now - 86400):
            with mock.patch.object(M.time, "time", return_value=shifted):
                page = self.run_page(token)
            self.assertFalse(page["baselineOnly"])
            self.assertEqual(self.provider.calls[-1].pts, 10)
            self.assertEqual(page["events"][0]["messageId"], "1")
            cursors.append(page["nextCursor"])
        self.assertEqual(len(set(cursors)), 1, "a checkpoint contains counters, not an authorization deadline")
        with mock.patch.object(M, "MESSAGE_WORKFLOW_VERSION", "synthetic-human-workflow-update"):
            self.assertEqual(self.run_page(token)["nextCursor"], cursors[0],
                             "an unrelated human preview epoch cannot reset native monitor counters")
        self.provider.authorized = False
        with mock.patch.object(M.time, "time", return_value=now + 366 * 86400):
            with self.assertRaises(M.TelegramRuntimeError):
                self.run_page(token)
        self.assertEqual(len(self.provider.calls), 5, "live session denial occurs before another difference")

    def test_monitor_hmac_domain_is_separate_and_human_overview_expiry_is_unchanged(self):
        binding = "same-synthetic-binding"
        now = M.time.time()
        token = M.overview_cursor(self.identity, binding, state={"position": {"pts": 10}}, purpose="monitor")
        human = M.overview_cursor(self.identity, binding, state={"expires": now + M.OVERVIEW_CURSOR_TTL, "inventory": {}})
        with self.assertRaises(M.TelegramRuntimeError):
            M.overview_cursor(self.identity, binding, token=token)
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            M.overview_cursor(self.identity, binding, token=human, purpose="monitor")
        self.assertEqual(caught.exception.code, "TELEGRAM_MONITOR_INVALID_CURSOR")
        with mock.patch.object(M.time, "time", return_value=now + M.OVERVIEW_CURSOR_TTL + 1):
            with self.assertRaises(M.TelegramRuntimeError):
                M.overview_cursor(self.identity, binding, token=human)
            self.assertEqual(M.overview_cursor(self.identity, binding, token=token, purpose="monitor"), {"position": {"pts": 10}})
        with self.assertRaises(M.TelegramRuntimeError):
            M.overview_cursor(self.identity, binding, token=token, purpose="unknown")

    def test_channel_stream_uses_independent_pts_and_fresh_native_resolution(self):
        token = self.baseline(chat='@example')
        self.provider.response = tl('ChannelDifference',pts=15,final=True,
                                    new_messages=[message(peer=tl('PeerChannel',channel_id=55))],other_updates=[])
        page = self.run_page(token,chat='@example')
        call = self.provider.calls[-1]
        self.assertEqual(type(call).__name__,'GetChannelDifference')
        self.assertEqual((call.pts,call.limit,call.force),(10,100,False))
        self.assertEqual(page['events'][0]['chatId'],'-1000000000055')
        self.assertEqual(page['stream'],{'kind':'channel','chatId':'-1000000000055'})
        self.assertEqual(self.resolve.await_count,2)
        self.provider.response = tl('ChannelDifference',pts=16,final=True,
                                    new_messages=[message(peer=tl('PeerChannel',channel_id=56))],other_updates=[])
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_page(token,chat='@example')
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_page(token)

    def test_channel_gaps_and_unknown_final_flags_cannot_claim_exhaustion(self):
        token = self.baseline(chat='channel')
        self.provider.response=tl('ChannelDifferenceTooLong',dialog=NS(pts=300))
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.run_page(token,chat='channel')
        self.assertEqual(caught.exception.code,'TELEGRAM_MONITOR_GAP')
        self.provider.response=tl('ChannelDifferenceEmpty',pts=11,final=None)
        self.assertTrue(self.run_page(token,chat='channel')['hasMore'])

    def test_deleted_ids_are_not_assigned_to_a_guessed_peer(self):
        token = self.baseline()
        self.provider.response=self.difference(updates=[tl('UpdateDeleteMessages',messages=[41,42]),
                                                       tl('UpdateChannelTooLong',channel_id=55)])
        page=self.run_page(token)
        self.assertEqual(page['events'],[])
        self.assertEqual(page['unresolvedDeletionIds'],['41','42'])
        self.assertEqual(page['channelsToSync'],['55'])
        token=self.baseline(chat='channel')
        self.provider.response=tl('ChannelDifference',pts=13,final=True,new_messages=[],other_updates=[
            tl('UpdateDeleteChannelMessages',channel_id=55,messages=[41])])
        page=self.run_page(token,chat='channel')
        self.assertEqual(page['events'][0]['kind'],'delete')
        self.assertEqual(page['events'][0]['chatId'],'-1000000000055')

    def test_sender_is_native_user_identity_not_a_forwarded_author_or_channel(self):
        native=message(sender=tl('PeerChannel',channel_id=99),fwd_from=NS(from_id=tl('PeerUser',user_id=77)))
        native.sender=NS(id=77,username='team_owner',phone='PRIVATE_PHONE')
        value=M.monitor_message(native,NS(get_peer_id=peer_id),kind='new',channel_peer=None)
        self.assertIsNone(value['senderUserId'])
        self.assertIsNone(value['senderNamespace'])
        self.assertTrue(value['forwarded'])
        self.assertNotIn('PRIVATE',json.dumps(value))
        self.assertNotIn('team_owner',json.dumps(value))

    def test_revision_detects_content_format_media_edits_without_file_reference_churn(self):
        value=message()
        utils=NS(get_peer_id=peer_id)
        def digest():
            return M.monitor_message(value,utils,kind='new',channel_peer=None)['revision']
        original=digest()
        value.entities=[tl('MessageEntityMentionName',offset=0,length=2,user_id=tl('InputUser',user_id=77,access_hash=123))]
        first=digest()
        self.assertNotEqual(first,original)
        value.entities[0].user_id.access_hash=456
        self.assertEqual(first,digest())
        value.entities[0].user_id.user_id=78
        self.assertNotEqual(first,digest())
        value.document=NS(id=8,file_reference=b'PRIVATE'); value.media=tl('MessageMediaDocument')
        first=digest(); value.document.file_reference=b'CHANGED'
        self.assertEqual(first,digest())
        value.document.id=9
        self.assertNotEqual(first,digest())

    def test_parser_and_dispatch_share_the_passive_command(self):
        args=M.build_parser().parse_args(['monitor','--limit','10'])
        with mock.patch.object(M,'identity_from_args',return_value=self.identity), mock.patch.object(M,'session_lock',return_value=mock.MagicMock()):
            result=M.run_async_command(args)
        self.assertTrue(result['baselineOnly'])
        self.assertEqual([type(call).__name__ for call in self.provider.calls],['GetState'])

    def test_monitor_disables_sdk_passive_subscription_without_changing_ordinary_commands(self):
        constructor=mock.Mock()
        with mock.patch.object(M,'require_app_credentials',return_value=(1,'synthetic',False)), \
             mock.patch.object(M,'import_telethon',return_value=(constructor,None,None)), \
             mock.patch.object(M,'session_path',return_value=pathlib.Path(self.temp)/'fixture.session'):
            BUILD_CLIENT(NS(command='monitor'),self.identity)
            self.assertIs(constructor.call_args.kwargs['receive_updates'],False)
            BUILD_CLIENT(NS(command='read-reference'),self.identity)
            self.assertIs(constructor.call_args.kwargs['receive_updates'],False)
            BUILD_CLIENT(NS(command='ack-reference'),self.identity)
            self.assertIs(constructor.call_args.kwargs['receive_updates'],False)
            self.assertEqual(constructor.call_args.kwargs['request_retries'],0)
            self.assertEqual(constructor.call_args.kwargs['flood_sleep_threshold'],0)
            self.assertTrue(constructor.call_args.kwargs['raise_last_call_error'])
            BUILD_CLIENT(NS(command='read'),self.identity)
            self.assertNotIn('receive_updates',constructor.call_args.kwargs)
            BUILD_CLIENT(NS(command='send'),self.identity)
            self.assertEqual(constructor.call_args.kwargs['request_retries'],0)

    def test_smaller_page_budget_can_retry_the_same_read_without_skipping_events(self):
        token=self.baseline()
        self.provider.response=self.difference([message(i+1) for i in range(101)])
        with self.assertRaises(M.TelegramRuntimeError):
            self.run_page(token)
        self.provider.response=tl('DifferenceSlice',new_messages=[message(i+1) for i in range(10)],
                                  other_updates=[],intermediate_state=position(pts=11))
        args=NS(command='monitor',limit=10,cursor=token,chat=None)
        page=asyncio.run(M.command_monitor_async(args,self.identity))
        self.assertEqual(self.provider.calls[-1].pts_limit,10)
        self.assertEqual(self.provider.calls[-1].pts,10)
        self.assertEqual(len(page['events']),10)
        self.assertTrue(page['hasMore'])

    def test_empty_response_requires_timezone_aware_date_and_rejects_regressed_pts(self):
        token=self.baseline()
        for native in (tl('DifferenceEmpty',date=NOW.replace(tzinfo=None),seq=2),
                       tl('Difference',state=position(pts=9),new_messages=[],other_updates=[])):
            self.provider.response=native
            with self.assertRaises(M.TelegramRuntimeError):
                self.run_page(token)
        self.provider.response=self.difference([message()])
        self.assertEqual(self.run_page(token)['events'][0]['messageId'],'1')
        self.assertEqual(self.provider.calls[-1].pts,10)

    def test_cleanup_failure_is_safe_and_cannot_mask_the_original_gap(self):
        self.provider.disconnect.side_effect=RuntimeError('PRIVATE SESSION PATH')
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.run_page()
        self.assertEqual(caught.exception.code,'TELEGRAM_MONITOR_UNAVAILABLE')
        self.assertNotIn('PRIVATE',json.dumps(caught.exception.public_payload()))
        self.provider.disconnect.side_effect=None
        token=self.baseline()
        self.provider.response=tl('DifferenceTooLong',pts=300)
        self.provider.disconnect.side_effect=RuntimeError('PRIVATE SESSION PATH')
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.run_page(token)
        self.assertEqual(caught.exception.code,'TELEGRAM_MONITOR_GAP')

    def test_omitted_private_from_id_uses_only_the_incoming_native_peer(self):
        native=message()
        native.from_id=None
        utils=NS(get_peer_id=peer_id)
        self.assertEqual(M.monitor_message(native,utils,kind='new',channel_peer=None)['senderUserId'],'77')
        native.out=True
        self.assertIsNone(M.monitor_message(native,utils,kind='new',channel_peer=None)['senderUserId'])
        native.out=False
        native.peer_id=tl('PeerChannel',channel_id=55)
        self.assertIsNone(M.monitor_message(native,utils,kind='new',channel_peer=None)['senderUserId'])



class ReferenceRead(unittest.TestCase):
    """The real exact-message resolver/projector, with only native I/O faked."""
    def setUp(self):
        self.provider = Provider()
        self.native = message(text='Полный текст 👋🏽')
        self.entity = tl('User', id=77, first_name='Synthetic reader')
        self.utils = NS(get_peer_id=lambda value: value.id if type(value).__name__ == 'User' else peer_id(value))
        self.identity = M.Identity(company_id='11111111-1111-4111-8111-111111111111',
                                   member_id='22222222-2222-4222-8222-222222222222',
                                   connection_id='33333333-3333-4333-8333-333333333333')
        self.client = self.enterContext(mock.patch.object(M, 'build_client', return_value=self.provider))
        self.resolve = self.enterContext(mock.patch.object(M, 'resolve_entity', new=mock.AsyncMock(return_value=self.entity)))
        self.enterContext(mock.patch.object(M, 'import_telethon_workflows', return_value=(NS(), NS(), self.utils, None, None)))
        self.provider.get_messages = mock.AsyncMock(side_effect=lambda *_a, **_kw: self.native)
        self.provider.send_message = mock.AsyncMock(side_effect=AssertionError('Read cannot send'))
        self.enterContext(mock.patch.object(M, 'public_messages', side_effect=AssertionError('Reference read must not resolve replies/context')))

    def revision(self):
        return M.monitor_message(self.native, self.utils, kind='new', channel_peer=77)['revision']

    def args(self, **changes):
        return NS(command='read-reference', chat='77', message_id=1, expected_revision=self.revision(), **changes)

    def read(self, args=None):
        return asyncio.run(M.command_message_read_async(args or self.args(), self.identity))

    def test_exact_revision_delivers_complete_safe_projection_without_history_quote_or_receipt(self):
        self.native.reply_to = NS(reply_to_msg_id=90)
        self.native.get_reply_message = mock.AsyncMock(side_effect=AssertionError('No quoted-message fetch'))
        value = self.read()
        self.assertEqual(value['protocol'], 'telegram-message-read/v1')
        self.assertEqual(value['reference']['id'], 'message:77:1')
        self.assertEqual(value['reference']['revision'], self.revision())
        self.assertNotIn('kind', value['reference'])
        self.assertEqual(value['message']['text'], self.native.message)
        self.assertIsNone(value['message']['replyContext'])
        self.assertEqual(value['coverage'], {'textComplete': True, 'attachmentsContentRead': False, 'contextIncluded': False})
        self.assertFalse(value['readState']['marksRead'])
        self.assertFalse(value['readState']['viewsRegistered'])
        self.assertFalse(value['readState']['readReceiptsSent'])
        self.native.get_reply_message.assert_not_awaited()
        self.provider.get_messages.assert_awaited_once_with(self.entity, ids=1)
        self.provider.send_message.assert_not_awaited()
        self.assertEqual(self.provider.calls, [])
        self.assertEqual(self.provider.disconnect.await_count, 1)

    def test_changed_version_cannot_deliver_the_new_body_as_the_old_event(self):
        args = self.args()
        self.native.message = 'PRIVATE_NEW_BODY_MUST_NOT_BE_DELIVERED'
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.read(args)
        self.assertEqual(caught.exception.code, 'TELEGRAM_REFERENCE_CHANGED')
        self.assertNotIn('PRIVATE_NEW_BODY', json.dumps(caught.exception.public_payload()))
        self.assertEqual(self.provider.disconnect.await_count, 1)

    def test_foreign_peer_missing_or_different_id_is_not_a_successful_read(self):
        args = self.args()
        for native in [None, tl('MessageEmpty', id=1), message(2), message(peer=tl('PeerUser', user_id=88))]:
            self.native = native
            with self.assertRaises(M.TelegramRuntimeError) as caught:
                self.read(args)
            self.assertEqual(caught.exception.code, 'TELEGRAM_REFERENCE_UNAVAILABLE')
        # Prove the literal numeric peer too, even if a faulty resolver and
        # message agree with each other on a different otherwise valid peer.
        self.resolve.return_value = tl('User', id=88)
        self.native = message(peer=tl('PeerUser', user_id=88))
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.read(args)
        self.assertEqual(caught.exception.code, 'TELEGRAM_REFERENCE_UNAVAILABLE')

    def test_truncated_text_does_not_become_a_complete_read_or_an_ack(self):
        self.native.message = 'x' * (M.MAX_READ_TEXT_CHARS + 1)
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.read()
        self.assertEqual(caught.exception.code, 'TELEGRAM_REFERENCE_INCOMPLETE')
        self.assertEqual(self.provider.calls, [])

    def test_sdk_and_cleanup_failures_are_redacted_and_preserve_a_proven_conflict(self):
        self.provider.get_messages.side_effect = RuntimeError('PRIVATE_RPC_DIAGNOSTIC_CANARY')
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.read()
        self.assertEqual(caught.exception.code, 'TELEGRAM_REFERENCE_UNAVAILABLE')
        self.assertNotIn('PRIVATE_RPC', json.dumps(caught.exception.public_payload()))
        self.provider.get_messages.side_effect = lambda *_a, **_kw: self.native
        self.provider.disconnect.side_effect = RuntimeError('PRIVATE_CLEANUP_DIAGNOSTIC_CANARY')
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.read()
        self.assertEqual(caught.exception.code, 'TELEGRAM_REFERENCE_UNAVAILABLE')
        self.assertNotIn('PRIVATE_CLEANUP', json.dumps(caught.exception.public_payload()))
        args = self.args()
        self.native.message = 'changed'
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            self.read(args)
        self.assertEqual(caught.exception.code, 'TELEGRAM_REFERENCE_CHANGED')

    def test_invalid_reference_fails_before_client_and_before_main_bootstrap(self):
        for changes in [{'chat': '@owner'}, {'chat': '-0'}, {'chat': str(2**63)}, {'message_id': True},
                        {'message_id': 2**31}, {'expected_revision': 'A'*64}, {'link': 'https://t.me/fake/1'}, {'context': 1}]:
            args = self.args()
            for key, value in changes.items(): setattr(args, key, value)
            with self.assertRaises(M.TelegramRuntimeError) as caught:
                self.read(args)
            self.assertEqual(caught.exception.code, 'TELEGRAM_REFERENCE_INPUT_INVALID')
        self.client.assert_not_called()
        import contextlib, io
        with mock.patch.object(M.sys, 'argv', ['trelio-telegram.py', 'read-reference', '--chat', '@owner', '--message-id', '1', '--expected-revision', 'a'*64]), \
             mock.patch.object(M, 'reexec_in_runtime_if_needed', side_effect=AssertionError('No bootstrap')) as reexec, \
             contextlib.redirect_stderr(io.StringIO()) as error:
            self.assertEqual(M.main(), 2)
        reexec.assert_not_called()
        self.assertEqual(json.loads(error.getvalue())['code'], 'TELEGRAM_REFERENCE_INPUT_INVALID')

    def test_parser_and_dispatch_keep_the_exact_reference_contract(self):
        args = M.build_parser().parse_args(['read-reference', '--chat', '77', '--message-id', '1', '--expected-revision', self.revision()])
        with mock.patch.object(M, 'identity_from_args', return_value=self.identity), \
             mock.patch.object(M, 'session_lock', return_value=mock.MagicMock()):
            self.assertEqual(M.run_async_command(args)['reference']['revision'], self.revision())

class ReferenceAck(unittest.TestCase):
    """Native range/read-back composition; no real session or external writes."""
    def setUp(self):
        self.provider = Provider()
        self.entity = tl('User', id=77)
        self.utils = NS(get_peer_id=lambda value: value.id if type(value).__name__ in {'User', 'Chat'} else peer_id(value))
        self.rows = [message(9), message(8)]
        self.boundary = 7
        self.history = [tl('MessagesSlice', messages=self.rows), tl('Messages', messages=[])]
        self.write_error = None
        self.post_boundary = None
        self.identity = M.Identity(company_id='11111111-1111-4111-8111-111111111111',
            member_id='22222222-2222-4222-8222-222222222222', connection_id='33333333-3333-4333-8333-333333333333')
        self.build = self.enterContext(mock.patch.object(M, 'build_client', return_value=self.provider))
        self.resolve = self.enterContext(mock.patch.object(M, 'resolve_entity', new=mock.AsyncMock(side_effect=lambda *_a, **_kw: self.entity)))
        self.enterContext(mock.patch.object(M, 'import_telethon_workflows', return_value=(NS(), NS(), self.utils, None, None)))
        self.enterContext(mock.patch.object(M, 'import_telethon_reference_ack', return_value=(
            request('Dialogs'), request('History'), request('Read'), request('ReadChannel'), request('InputDialog'), self.utils)))
        self.policy = self.enterContext(mock.patch.object(M, 'assert_send_allowed'))
        self.provider.get_messages = mock.AsyncMock(side_effect=lambda *_a, **_kw: self.rows[0])
        self.provider.get_input_entity = mock.AsyncMock(return_value=tl('InputPeerUser', user_id=77))
        async def dispatch(_provider, call):
            self.provider.calls.append(call)
            name = type(call).__name__
            if name == 'Dialogs':
                return NS(dialogs=[tl('Dialog', peer=self.rows[0].peer_id, read_inbox_max_id=self.boundary)])
            if name == 'History':
                return self.history.pop(0)
            if name in {'Read', 'ReadChannel'}:
                self.boundary = call.max_id if self.post_boundary is None else self.post_boundary
                if self.write_error:
                    raise self.write_error
                return True if name == 'ReadChannel' else tl('AffectedMessages', pts=1, pts_count=1)
            raise AssertionError(name)
        self.enterContext(mock.patch.object(Provider, '__call__', dispatch))

    def revision(self, row):
        return M.monitor_message(row, self.utils, kind='new', channel_peer=None)['revision']

    def args(self, **changes):
        values = dict(command='ack-reference', chat=str(peer_id(self.rows[0].peer_id)), message_id=9,
            expected_revision=self.revision(self.rows[0]), confirm=True, verify_only=False,
            covered_reference=[f'{row.id}:{self.revision(row)}' for row in self.rows])
        values.update(changes)
        return NS(**values)

    def ack(self, args=None):
        return asyncio.run(M.command_reference_ack_async(args or self.args(), self.identity))

    def writes(self):
        return [call for call in self.provider.calls if type(call).__name__ in {'Read', 'ReadChannel'}]

    def test_exact_range_single_write_readback_keeps_higher_messages_unread(self):
        result = self.ack()
        self.assertEqual(result['protocol'], 'telegram-message-ack/v1')
        self.assertTrue(result['readState']['acknowledged'])
        self.assertEqual(result['readState']['writeOutcome'], 'confirmed')
        self.assertEqual(len(self.writes()), 1)
        self.assertEqual(self.writes()[0].max_id, 9)
        self.assertEqual(self.policy.call_count, 2)
        history = [call for call in self.provider.calls if type(call).__name__ == 'History']
        self.assertEqual([(c.offset_id, c.min_id, c.max_id, c.limit) for c in history], [(10, 7, 10, 100), (8, 7, 10, 1)])
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertFalse(result['readState']['snapshotAtomic'])
        self.assertEqual(self.provider.disconnect.await_count, 1)

    def test_native_channel_uses_channel_read_history_without_view_increment(self):
        self.entity = tl('Channel', id=55)
        for row in self.rows: row.peer_id = tl('PeerChannel', channel_id=55)
        result = self.ack()
        self.assertTrue(result['readState']['acknowledged'])
        self.assertEqual(type(self.writes()[0]).__name__, 'ReadChannel')
        self.assertIs(self.writes()[0].channel, self.entity)
        self.assertFalse(result['readState']['viewsRegistered'])

    def test_already_read_and_verify_only_never_write_or_fetch_history(self):
        for verify, boundary in [(False, 10), (True, 7), (True, 10)]:
            self.provider.calls.clear(); self.boundary = boundary
            value = self.ack(self.args(confirm=not verify, verify_only=verify))
            self.assertEqual(value['readState']['acknowledged'], boundary >= 9)
            self.assertFalse(value['readState']['writeAttempted'])
            self.assertEqual([type(c).__name__ for c in self.provider.calls], ['Dialogs'])
        self.assertEqual(self.writes(), [])

    def test_missing_processed_row_changed_revision_or_nonempty_probe_prevents_range_write(self):
        cases = [([tl('Messages', messages=self.rows), tl('Messages', messages=[])], [self.args().covered_reference[0]]),
            ([tl('Messages', messages=self.rows), tl('Messages', messages=[])], [self.args().covered_reference[0], '8:'+'0'*64]),
            ([tl('Messages', messages=[self.rows[0]]), tl('Messages', messages=[self.rows[1]])], self.args().covered_reference),
            ([tl('Messages', messages=[self.rows[1]]), tl('Messages', messages=[])], self.args().covered_reference),
            ([tl('Messages', messages=[self.rows[0], tl('MessageService', id=8)])], self.args().covered_reference),
            ([tl('Messages', messages=list(reversed(self.rows)))], self.args().covered_reference)]
        for history, covered in cases:
            self.history = list(history)
            with self.assertRaises(M.TelegramRuntimeError) as caught:
                self.ack(self.args(covered_reference=covered))
            self.assertEqual(caught.exception.code, 'TELEGRAM_ACK_RANGE_INCOMPLETE')
            self.assertFalse(caught.exception.details['writeAttempted'])
        self.assertEqual(self.writes(), [])

    def test_lost_write_and_failed_readback_remain_unknown_then_readonly_reconcile(self):
        args = self.args()
        self.write_error = RuntimeError('PRIVATE_TRANSPORT_AFTER_WRITE')
        with self.assertRaises(M.TelegramRuntimeError) as caught: self.ack(args)
        self.assertEqual(caught.exception.code, 'TELEGRAM_ACK_OUTCOME_UNKNOWN')
        self.assertEqual(caught.exception.details, dict(writeAttempted=True, writeOutcome='unknown', automaticRetryAllowed=False))
        self.assertNotIn('PRIVATE', json.dumps(caught.exception.public_payload()))
        self.assertEqual(len(self.writes()), 1)
        self.write_error = None
        value = self.ack(self.args(confirm=False, verify_only=True, covered_reference=[]))
        self.assertTrue(value['readState']['acknowledged'])
        self.assertEqual(len(self.writes()), 1, 'reconcile cannot repeat native readHistory')

    def test_cleanup_and_unconfirmed_native_boundary_cannot_report_success(self):
        self.post_boundary = 7
        with self.assertRaises(M.TelegramRuntimeError) as caught: self.ack()
        self.assertEqual(caught.exception.code, 'TELEGRAM_ACK_OUTCOME_UNKNOWN')
        self.assertTrue(caught.exception.details['writeAttempted'])
        self.boundary = 9
        self.provider.disconnect.side_effect = RuntimeError('PRIVATE_CLEANUP')
        with self.assertRaises(M.TelegramRuntimeError) as caught: self.ack(self.args(confirm=False, verify_only=True))
        self.assertFalse(caught.exception.details['writeAttempted'])
        self.assertNotIn('PRIVATE', json.dumps(caught.exception.public_payload()))

    def test_local_readonly_forum_or_changed_target_prevents_write(self):
        self.policy.side_effect = RuntimeError('PRIVATE_POLICY_PATH')
        with self.assertRaises(M.TelegramRuntimeError) as caught: self.ack()
        self.assertEqual(caught.exception.code, 'TELEGRAM_ACK_UNAVAILABLE')
        self.assertNotIn('PRIVATE', json.dumps(caught.exception.public_payload()))
        self.build.assert_not_called()
        self.policy.side_effect = None
        self.entity = tl('Channel', id=55, forum=True)
        for row in self.rows: row.peer_id = tl('PeerChannel', channel_id=55)
        with self.assertRaises(M.TelegramRuntimeError) as caught: self.ack()
        self.assertEqual(caught.exception.code, 'TELEGRAM_ACK_RANGE_UNSUPPORTED')
        self.entity.forum = False
        args = self.args(); self.rows[0].message = 'CHANGED'
        with self.assertRaises(M.TelegramRuntimeError) as caught: self.ack(args)
        self.assertEqual(caught.exception.code, 'TELEGRAM_REFERENCE_CHANGED')
        self.assertEqual(self.writes(), [])

    def test_exact_peer_and_complete_hundred_row_bound_are_checked_before_write(self):
        self.rows = [message(i) for i in range(109, 9, -1)]
        self.boundary = 9
        self.history = [tl('MessagesSlice', messages=self.rows), tl('Messages', messages=[])]
        value = self.ack(self.args(message_id=109))
        self.assertTrue(value['readState']['acknowledged'])
        self.assertEqual(self.writes()[0].max_id, 109)
        self.provider.calls.clear(); self.boundary = 9
        self.history = [tl('MessagesSlice', messages=self.rows), tl('Messages', messages=[message(9)])]
        with self.assertRaises(M.TelegramRuntimeError) as caught: self.ack(self.args(message_id=109))
        self.assertEqual(caught.exception.code, 'TELEGRAM_ACK_RANGE_INCOMPLETE')
        self.assertEqual(self.writes(), [])
        self.history = [tl('Messages', messages=[message(109, peer=tl('PeerUser', user_id=88))])]
        with self.assertRaises(M.TelegramRuntimeError) as caught: self.ack(self.args(message_id=109))
        self.assertEqual(caught.exception.code, 'TELEGRAM_ACK_UNAVAILABLE')
        self.assertEqual(self.writes(), [])

    def test_malformed_modes_refs_fail_before_bootstrap_and_do_not_extend_task_policy(self):
        for changes in [dict(confirm=False), dict(verify_only=True), dict(covered_reference=[]),
                dict(covered_reference=['9:bad']), dict(covered_reference=self.args().covered_reference*2),
                dict(covered_reference=['10:'+'a'*64]), dict(message_id=2**31-1)]:
            with self.assertRaises(M.TelegramRuntimeError): self.ack(self.args(**changes))
        self.build.assert_not_called()
        import contextlib, io
        argv = ['trelio-telegram.py', 'ack-reference', '--chat', '77', '--message-id', '9', '--expected-revision', 'a'*64, '--confirm']
        with mock.patch.object(M.sys, 'argv', argv), mock.patch.object(M, 'reexec_in_runtime_if_needed') as bootstrap, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(M.main(), 2)
        bootstrap.assert_not_called()
        args = M.build_parser().parse_args(argv[1:] + ['--covered-reference', '9:'+'a'*64])
        self.assertEqual(M.validate_reference_ack(args), {9:'a'*64})
        policy = json.loads((PATH.parent/'trelio-assistant-execution.json').read_text())
        self.assertNotIn('ack-reference', json.dumps(policy))

if __name__=='__main__':
    unittest.main()
