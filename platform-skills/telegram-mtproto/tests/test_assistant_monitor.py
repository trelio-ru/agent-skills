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


if __name__=='__main__':
    unittest.main()
