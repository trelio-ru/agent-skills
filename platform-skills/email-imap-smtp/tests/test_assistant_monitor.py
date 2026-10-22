"""Real IMAP command encoder with synthetic protocol/metadata only.

No mailbox, OS credential, body/header read, SMTP or source authorization.
"""
import base64
import contextlib
import io
import json
import os
import unittest
from dataclasses import replace
from unittest import mock

from test_imap_protocol import ScriptedImap
from test_trelio_email import MODULE as M


ACCOUNT=M.Account(name='synthetic',email_address='fixture@example.test',display_name='',username='fixture@example.test',
                  imap_host='imap.example.test',imap_port=993,smtp_host='smtp.example.test',smtp_port=465,
                  smtp_security='ssl',credential_store='keychain')


def examine(tag,validity=17,next_uid=11,exists=3):
    return (f'* {exists} EXISTS\r\n* OK [UIDVALIDITY {validity}] stable\r\n* OK [UIDNEXT {next_uid}] next\r\n'
            f'TEST{tag} OK [READ-ONLY] examined\r\n').encode()


class Monitor(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch.object(M,'load_account',return_value=ACCOUNT))
        self.enterContext(mock.patch.object(M,'selected_local_account',return_value=None))
        self.enterContext(mock.patch.dict(os.environ,{'TRELIO_SKILL_COMPANY_ID':'synthetic-company',
                                                    'TRELIO_SKILL_MEMBER_ID':'synthetic-member'}))

    def args(self,**overrides):
        values=dict(command='monitor',account='synthetic',folder=None,special_use=None,cursor=None,limit=100)
        values.update(overrides)
        return type('Args',(),values)()

    def cursor(self,uid=10,validity=17,folder='INBOX',account=ACCOUNT):
        return M.email_monitor_cursor(M.email_monitor_scope(account,folder),validity,uid)

    def unread_cursor(self,uid=0,through=10,validity=17,folder='INBOX'):
        return M.email_monitor_cursor(M.email_monitor_scope(ACCOUNT,folder),validity,uid,backfill_through=through)

    def page(self,client,**overrides):
        with mock.patch.object(M,'imap_connection',return_value=contextlib.nullcontext(client)):
            return M.command_monitor(self.args(**overrides))

    def test_initial_position_is_explicit_and_does_not_fetch_old_unread_mail(self):
        client=ScriptedImap(examine(1))
        page=self.page(client)
        self.assertTrue(page['baselineOnly'])
        self.assertEqual(page['events'],[])
        self.assertEqual(client.sent,[b'TEST1 EXAMINE "INBOX"\r\n'])
        self.assertEqual(M.parse_email_monitor_cursor(page['nextCursor'],M.email_monitor_scope(ACCOUNT,'INBOX'))['lastUid'],10)
        self.assertFalse(page['coverage']['historicalBackfill'])
        self.assertFalse(page['readState']['readReceiptsSent'])
        self.assertNotIn('initialUnreadCursor',page,'ordinary monitor retains its original projection')

    def test_opt_in_baseline_returns_separate_forward_and_initial_unread_positions(self):
        client=ScriptedImap(examine(1))
        page=self.page(client,unread_backfill=True)
        self.assertTrue(page['baselineOnly']);self.assertEqual(page['events'],[])
        forward=M.parse_email_monitor_cursor(page['nextCursor'])
        initial=M.parse_email_monitor_cursor(page['initialUnreadCursor'],allow_backfill=True)
        self.assertEqual(forward['v'],1);self.assertEqual(forward['lastUid'],10)
        self.assertEqual(initial,dict(v=2,mode='initial_unread',scope=forward['scope'],
                                      uidValidity=17,lastUid=0,throughUid=10))
        self.assertTrue(page['coverage']['initialUnreadBackfillAvailable'])
        self.assertEqual(client.sent,[b'TEST1 EXAMINE "INBOX"\r\n'])
        with self.assertRaises(M.EmailMonitorError):
            M.parse_email_monitor_cursor(page['initialUnreadCursor'])

    def test_initial_unread_uses_finite_native_unseen_under_original_ceiling(self):
        wire=examine(1,next_uid=14)+b'* SEARCH 3 8 10\r\nTEST2 OK found\r\n'+examine(3,next_uid=16)
        client=ScriptedImap(wire)
        page=self.page(client,cursor=self.unread_cursor(),unread_backfill=True)
        self.assertEqual(client.sent[1],b'TEST2 UID SEARCH UID 1:10 UNSEEN\r\n')
        self.assertEqual([row['uid'] for row in page['events']],['3','8','10'])
        self.assertFalse(page['hasMore'],'new mail must not extend the initial history stream')
        self.assertEqual(M.parse_email_monitor_cursor(page['nextCursor'],allow_backfill=True)['throughUid'],10)
        self.assertTrue(page['coverage']['historicalBackfill']);self.assertTrue(page['coverage']['initialUnreadOnly'])
        self.assertFalse(page['coverage']['snapshotAtomic']);self.assertFalse(page['coverage']['bodyContentRead'])
        self.assertFalse(page['readState']['readReceiptsSent'])
        self.assertEqual(self.page(ScriptedImap(wire),cursor=self.unread_cursor(),unread_backfill=True),page)
        # The ordinary forward position remains independent: it reads all new
        # UIDs, including those read on another device during history paging.
        forward=ScriptedImap(examine(1,next_uid=16)+b'* SEARCH 11 15\r\nTEST2 OK found\r\n'+examine(3,next_uid=16))
        new=self.page(forward,cursor=self.cursor())
        self.assertEqual([row['uid'] for row in new['events']],['11','15'])
        self.assertEqual(forward.sent[1],b'TEST2 UID SEARCH UID 11:15\r\n')

    def test_initial_unread_partial_pages_keep_original_uid_ceiling(self):
        first=ScriptedImap(examine(1)+b'* SEARCH 2 5 8 10\r\nTEST2 OK found\r\n'+examine(3,next_uid=14))
        page=self.page(first,cursor=self.unread_cursor(),unread_backfill=True,limit=2)
        position=M.parse_email_monitor_cursor(page['nextCursor'],allow_backfill=True)
        self.assertEqual(position['lastUid'],5);self.assertEqual(position['throughUid'],10)
        self.assertTrue(page['hasMore'])
        following=ScriptedImap(examine(1,next_uid=20)+b'* SEARCH 8 10\r\nTEST2 OK found\r\n'+examine(3,next_uid=20))
        final=self.page(following,cursor=page['nextCursor'],unread_backfill=True)
        self.assertEqual(following.sent[1],b'TEST2 UID SEARCH UID 6:10 UNSEEN\r\n')
        self.assertEqual([row['uid'] for row in final['events']],['8','10']);self.assertFalse(final['hasMore'])

    def test_initial_unread_empty_slots_and_empty_mailbox_still_finish(self):
        client=ScriptedImap(examine(1,next_uid=30001)+b'* SEARCH\r\nTEST2 OK empty\r\n'+examine(3,next_uid=30001))
        page=self.page(client,cursor=self.unread_cursor(through=25000),unread_backfill=True)
        self.assertEqual(client.sent[1],b'TEST2 UID SEARCH UID 1:10000 UNSEEN\r\n')
        self.assertTrue(page['hasMore']);self.assertEqual(page['events'],[])
        self.assertEqual(M.parse_email_monitor_cursor(page['nextCursor'],allow_backfill=True)['lastUid'],10000)
        empty=ScriptedImap(examine(1,next_uid=1,exists=0)+examine(2,next_uid=2,exists=1))
        final=self.page(empty,cursor=self.unread_cursor(through=0),unread_backfill=True)
        self.assertFalse(final['hasMore']);self.assertEqual(final['events'],[])
        self.assertEqual(len(empty.sent),2,'new arrival is for the forward stream, never a reversed SEARCH range')

    def test_initial_unread_rejects_regressed_or_changed_uid_namespace(self):
        for wire in (examine(1,next_uid=10),examine(1,validity=18),
                     examine(1)+b'* SEARCH 5\r\nTEST2 OK found\r\n'+examine(3,validity=18)):
            with self.assertRaises(M.EmailMonitorError):
                self.page(ScriptedImap(wire),cursor=self.unread_cursor(),unread_backfill=True)

    def test_initial_unread_bad_native_results_are_not_empty_success(self):
        for ids in (b'0',b'11',b'5 5',b'1:2',b'x'):
            with self.assertRaises(M.EmailMonitorError):
                self.page(ScriptedImap(examine(1)+b'* SEARCH '+ids+b'\r\nTEST2 OK found\r\n'),
                          cursor=self.unread_cursor(),unread_backfill=True)

    def test_mode_cursor_mixing_fails_before_native_or_account_io(self):
        cases=[['--unread-backfill','--cursor',self.cursor()],['--cursor',self.unread_cursor()]]
        for extra in cases:
            with mock.patch.object(M,'native_runtime') as native,mock.patch.object(M,'load_password') as password, \
                 mock.patch.object(M,'load_account') as account,contextlib.redirect_stderr(io.StringIO()) as errors, \
                 mock.patch.object(M.sys,'argv',['trelio-email.py','monitor','--account','synthetic',*extra]):
                self.assertEqual(M.main(),2)
                self.assertIn('EMAIL_MONITOR_INVALID_CURSOR',errors.getvalue())
                native.assert_not_called();password.assert_not_called();account.assert_not_called()

    def test_initial_unread_cursor_shape_is_closed_and_stays_scoped(self):
        valid=json.loads(base64.urlsafe_b64decode(self.unread_cursor()+'='*(-len(self.unread_cursor())%4)))
        for update in ({'mode':'forward'},{'throughUid':True},{'throughUid':2**32},
                       {'lastUid':11},{'v':True},{'extra':'untrusted'}):
            encoded=base64.urlsafe_b64encode(json.dumps({**valid,**update}).encode()).decode().rstrip('=')
            with self.assertRaises(M.EmailMonitorError):
                M.parse_email_monitor_cursor(encoded,allow_backfill=True)
        with self.assertRaises(M.EmailMonitorError) as caught:
            self.page(ScriptedImap(examine(1)),cursor=self.unread_cursor(folder='OTHER'),unread_backfill=True)
        self.assertEqual(caught.exception.code,'EMAIL_MONITOR_SCOPE_CHANGED')

    def test_actual_protocol_is_examine_and_finite_uid_search_only(self):
        client=ScriptedImap(examine(1,next_uid=14)+b'* SEARCH 11 12 13\r\nTEST2 OK found\r\n'+examine(3,next_uid=14))
        page=self.page(client,cursor=self.cursor())
        self.assertEqual(client.sent,[b'TEST1 EXAMINE "INBOX"\r\n',b'TEST2 UID SEARCH UID 11:13\r\n',b'TEST3 EXAMINE "INBOX"\r\n'])
        self.assertEqual([r['uid'] for r in page['events']],['11','12','13'])
        self.assertEqual(page['events'][0]['id'],'uid:17:11')
        self.assertFalse(page['hasMore'])
        self.assertFalse(page['coverage']['bodyContentRead'])
        self.assertTrue(client.is_readonly)
        self.assertNotIn('fixture@example',json.dumps(page))
        self.assertNotIn('INBOX',json.dumps(page))

    def test_partial_page_advances_only_through_returned_uids(self):
        client=ScriptedImap(examine(1,next_uid=14)+b'* SEARCH 11 12 13\r\nTEST2 OK found\r\n'+examine(3,next_uid=14))
        page=self.page(client,cursor=self.cursor(),limit=2)
        decoded=M.parse_email_monitor_cursor(page['nextCursor'],M.email_monitor_scope(ACCOUNT,'INBOX'))
        self.assertEqual(decoded['lastUid'],12)
        self.assertTrue(page['hasMore'])
        client=ScriptedImap(examine(1,next_uid=14)+b'* SEARCH 13\r\nTEST2 OK found\r\n'+examine(3,next_uid=14))
        following=self.page(client,cursor=page['nextCursor'])
        self.assertEqual(client.sent[1],b'TEST2 UID SEARCH UID 13:13\r\n')
        self.assertEqual([r['uid'] for r in following['events']],['13'])

    def test_gap_slots_and_concurrent_arrival_do_not_lose_next_page(self):
        client=ScriptedImap(examine(1,next_uid=20)+b'* SEARCH 12 18\r\nTEST2 OK found\r\n'+examine(3,next_uid=22))
        page=self.page(client,cursor=self.cursor())
        self.assertTrue(page['hasMore'])
        decoded=M.parse_email_monitor_cursor(page['nextCursor'],M.email_monitor_scope(ACCOUNT,'INBOX'))
        self.assertEqual(decoded['lastUid'],19)
        client=ScriptedImap(examine(1,next_uid=20)+b'* SEARCH\r\nTEST2 OK none\r\n'+examine(3,next_uid=20))
        empty=self.page(client,cursor=self.cursor())
        self.assertEqual(empty['events'],[])
        self.assertEqual(M.parse_email_monitor_cursor(empty['nextCursor'],M.email_monitor_scope(ACCOUNT,'INBOX'))['lastUid'],19)

    def test_no_new_uid_does_not_use_the_reversed_n_star_range(self):
        client=ScriptedImap(examine(1)+examine(2))
        page=self.page(client,cursor=self.cursor())
        self.assertEqual(page['events'],[])
        self.assertFalse(page['hasMore'])
        self.assertEqual(len(client.sent),2)
        self.assertFalse(any(b' SEARCH ' in line or b'*' in line for line in client.sent))

    def test_validity_change_before_or_after_search_has_no_successful_page(self):
        for wire in (examine(1,validity=18),
                     examine(1,next_uid=12)+b'* SEARCH 11\r\nTEST2 OK found\r\n'+examine(3,validity=18,next_uid=12)):
            client=ScriptedImap(wire)
            with self.assertRaises(M.EmailMonitorError) as caught:
                self.page(client,cursor=self.cursor())
            self.assertEqual(caught.exception.code,'EMAIL_MONITOR_UIDVALIDITY_CHANGED')
            self.assertEqual(M.error_payload(caught.exception)['code'],caught.exception.code)

    def test_unknown_or_regressed_position_is_not_empty_success(self):
        for wire in (examine(1,validity=0),examine(1,next_uid=10),
                     b'* 0 EXISTS\r\nTEST1 OK [READ-ONLY] examined\r\n'):
            with self.assertRaises(M.EmailMonitorError):
                self.page(ScriptedImap(wire),cursor=self.cursor())

    def test_uid_search_rejects_foreign_duplicate_bad_and_oversized_lists(self):
        for ids in (b'10',b'21',b'11 11',b'11:12',b'0',b'4294967296',b'x',b' '* (M.EMAIL_MONITOR_MAX_UID_BYTES+1)):
            client=ScriptedImap(examine(1,next_uid=20)+b'* SEARCH '+ids+b'\r\nTEST2 OK found\r\n')
            with self.assertRaises(M.EmailMonitorError):
                self.page(client,cursor=self.cursor())

    def test_cursor_malformed_or_wrong_account_folder_binding_never_searches(self):
        for cursor,sends in (('x',0),('a'*1025,0),(self.cursor(folder='PRIVATE FOLDER'),1),
                             (self.cursor(account=replace(ACCOUNT,username='other@example.test')),1)):
            client=ScriptedImap(examine(1))
            with self.assertRaises(M.EmailMonitorError):
                self.page(client,cursor=cursor)
            self.assertEqual(len(client.sent),sends,'malformed syntax fails before account selection; scope needs one native EXAMINE')
        cursor=self.cursor()
        with mock.patch.dict(os.environ,{'TRELIO_SKILL_MEMBER_ID':'different-member'}):
            with self.assertRaises(M.EmailMonitorError) as caught:
                self.page(ScriptedImap(examine(1)),cursor=cursor)
            self.assertEqual(caught.exception.code,'EMAIL_MONITOR_SCOPE_CHANGED')

    def test_native_page_is_bounded_even_with_large_uid_holes(self):
        client=ScriptedImap(examine(1,next_uid=30000)+b'* SEARCH\r\nTEST2 OK none\r\n'+examine(3,next_uid=30000))
        page=self.page(client,cursor=self.cursor())
        self.assertEqual(client.sent[1],b'TEST2 UID SEARCH UID 11:10010\r\n')
        self.assertTrue(page['hasMore'])
        decoded=M.parse_email_monitor_cursor(page['nextCursor'],M.email_monitor_scope(ACCOUNT,'INBOX'))
        self.assertEqual(decoded['lastUid'],10010)

    def test_smtp_only_is_fenced_before_unlock_and_network(self):
        with mock.patch.object(M,'load_account',return_value=replace(ACCOUNT,connection_mode='smtp_only')), \
             mock.patch.object(M,'imap_connection') as connection, mock.patch.object(M,'native_runtime') as native:
            with self.assertRaisesRegex(M.MailboxError,'imap_unavailable_smtp_only'):
                M.command_monitor(self.args())
            argv=['trelio-email.py','monitor','--account','synthetic']
            with mock.patch.object(M.sys,'argv',argv), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(M.main(),2)
            native.assert_not_called(); connection.assert_not_called()

    def test_connection_and_cleanup_errors_never_echo_server_credentials(self):
        @contextlib.contextmanager
        def fail_cleanup():
            yield ScriptedImap(examine(1))
            raise RuntimeError('PRIVATE ACCOUNT PASSWORD URL')
        for connection in (mock.Mock(side_effect=OSError('PRIVATE ACCOUNT PASSWORD URL')),mock.Mock(return_value=fail_cleanup())):
            with mock.patch.object(M,'imap_connection',connection), self.assertRaises(M.EmailMonitorError) as caught:
                M.command_monitor(self.args())
            self.assertEqual(caught.exception.code,'EMAIL_MONITOR_UNAVAILABLE')
            self.assertNotIn('PRIVATE',json.dumps(M.error_payload(caught.exception)))

    def test_cursor_is_data_not_a_capability_or_embedded_company_content(self):
        cursor=self.cursor()
        payload=json.loads(base64.urlsafe_b64decode(cursor+'='*(-len(cursor)%4)))
        self.assertEqual(set(payload),{'v','scope','uidValidity','lastUid'})
        self.assertNotIn('fixture',json.dumps(payload))
        self.assertNotIn('INBOX',json.dumps(payload))
        self.assertEqual(M.build_parser().parse_args(['monitor','--account','synthetic']).handler,M.command_monitor)

    def test_invalid_cursor_cli_fails_before_native_or_password_io(self):
        with mock.patch.object(M,'native_runtime') as native, mock.patch.object(M,'load_password') as password, \
             mock.patch.object(M.sys,'argv',['trelio-email.py','monitor','--account','synthetic','--cursor','invalid']), \
             contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit) as caught:
                M.main()
            self.assertEqual(caught.exception.code,2)
            self.assertIn('EMAIL_MONITOR_INVALID_CURSOR',errors.getvalue())
            native.assert_not_called(); password.assert_not_called()

    def test_replayed_page_uses_the_same_ids_and_revisions(self):
        wire=examine(1,next_uid=12)+b'* SEARCH 11\r\nTEST2 OK found\r\n'+examine(3,next_uid=12)
        first=self.page(ScriptedImap(wire),cursor=self.cursor())
        replay=self.page(ScriptedImap(wire),cursor=self.cursor())
        self.assertEqual(first,replay)

    def test_failed_search_is_not_a_successful_empty_page_or_raw_server_prose(self):
        client=ScriptedImap(examine(1,next_uid=12)+b'TEST2 NO PRIVATE PASSWORD REPLY\r\n')
        with self.assertRaises(M.EmailMonitorError) as caught:
            self.page(client,cursor=self.cursor())
        self.assertNotIn('PRIVATE',json.dumps(M.error_payload(caught.exception)))

    def test_unsigned_32_bit_boundary_is_exact_without_wrap_or_float_ids(self):
        maximum=2**32-1
        client=ScriptedImap(examine(1,validity=maximum,next_uid=maximum)+
                            f'* SEARCH {maximum-1}\r\nTEST2 OK found\r\n'.encode()+
                            examine(3,validity=maximum,next_uid=maximum))
        page=self.page(client,cursor=self.cursor(uid=maximum-2,validity=maximum))
        self.assertEqual(page['events'][0]['uid'],str(maximum-1))
        self.assertEqual(page['events'][0]['uidValidity'],str(maximum))
        with self.assertRaises(M.EmailMonitorError):
            self.page(ScriptedImap(examine(1,validity=maximum+1)))


if __name__=='__main__':
    unittest.main()
