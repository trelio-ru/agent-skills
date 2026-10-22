"""Generic OTP workflow: real IMAP encoder/parser, synthetic mail only."""
import contextlib
import datetime as dt
import importlib.util
import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace as NS
import unittest
from unittest import mock

from test_trelio_email import MODULE as M
from test_assistant_monitor import ACCOUNT, examine
from test_imap_protocol import ScriptedImap
from test_message_reference import fetched

spec = importlib.util.spec_from_file_location('browser_mail_auth_fixture', Path(M.__file__).with_name('browser_mail_auth.py'))
B = importlib.util.module_from_spec(spec)
spec.loader.exec_module(B)
RAW = b'From: login@example.test\r\nTo: fixture@example.test\r\nSubject: Sign in\r\nContent-Type: text/plain\r\n\r\nExample account code: 123456\r\n'
NOW = int(dt.datetime(2026, 10, 22, 12, tzinfo=dt.timezone.utc).timestamp() * 1000)
SPEC = dict(api=B.API, skillId='mail-fixture', sender='login@example.test', subjectIncludes='Sign in',
            bodyIncludes='Example account', digits=6, requestedAt=NOW, expiresAt=NOW+60000)
HANDLE = 'd'*64 + '.00000000-0000-4000-8000-000000000001'


class BrowserMailAuthentication(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch.dict(os.environ, {'TRELIO_SKILL_ID': 'mail-fixture'}))
        self.enterContext(mock.patch.object(M, 'load_account', return_value=ACCOUNT))
        self.enterContext(mock.patch.object(M, 'selected_local_account', return_value={
            'id': '00000000-0000-4000-8000-000000000003', 'companyBinding': 'a'*64}))
        self.enterContext(mock.patch.object(M, 'require_credential_lease', return_value=None))
        self.enterContext(mock.patch.object(B.time, 'time', return_value=NOW/1000))
        self.baseline = {'scope': M.email_monitor_scope(ACCOUNT, 'INBOX'), 'uidValidity': 17, 'lastUid': 10}

    def args(self, **changes):
        return NS(**dict(dict(account='synthetic', folder=None, request=HANDLE,
                             mark_read_after_success=True, verify_only=False), **changes))

    def stream(self, raw=RAW, *, date=b'22-Oct-2026 12:00:00 +0000', validity=17):
        return (examine(1, next_uid=12) + b'* SEARCH 11\r\nTEST2 OK searched\r\n'
                + b'* 1 FETCH (UID 11 INTERNALDATE "' + date + b'")\r\nTEST3 OK date\r\n'
                + fetched(tag=4, raw=raw) + examine(5, validity=validity, next_uid=12))

    def find(self, client):
        with mock.patch.object(M, 'imap_connection', return_value=contextlib.nullcontext(client)):
            return B.find_code(ACCOUNT, self.args(), {**SPEC, 'baseline': self.baseline}, M)

    def test_exact_fresh_message_is_peeked_and_no_flags_change_during_extraction(self):
        client = ScriptedImap(self.stream())
        code, reference = self.find(client)
        self.assertEqual(code, '123456')
        self.assertEqual(reference['uid'], 11)
        self.assertEqual(reference['uidValidity'], 17)
        self.assertIn(b'BODY.PEEK[]', client.sent[3])
        self.assertEqual(client.sent[1], b'TEST2 UID SEARCH UID 11:11 FROM "login@example.test"\r\n')
        self.assertFalse(any(b' STORE ' in x or b' SELECT ' in x or b'UNSEEN' in x for x in client.sent))

    def test_sender_recipient_anchor_and_multiple_code_occurrences_fail_closed(self):
        for raw in [RAW.replace(b'login@example', b'other@example'), RAW.replace(b'fixture@example', b'foreign@example'),
                    RAW.replace(b'Example account', b'Other account'), RAW + b'Another 654321\r\n',
                    RAW.replace(b'Subject: Sign in', b'Subject: Other')]:
            self.assertIsNone(B.extract_code(raw, SPEC, ACCOUNT.email_address, M))

    def test_stale_and_changed_uidvalidity_do_not_deliver_or_ack(self):
        # A stale message is excluded before reading its body.
        client = ScriptedImap(examine(1, next_uid=12) + b'* SEARCH 11\r\nTEST2 OK searched\r\n'
            + b'* 1 FETCH (UID 11 INTERNALDATE "21-Oct-2026 12:00:00 +0000")\r\nTEST3 OK date\r\n' + examine(4, next_uid=12))
        self.assertIsNone(self.find(client))
        self.assertFalse(any(b'BODY' in x for x in client.sent))
        with self.assertRaises(M.MailboxError):
            self.find(ScriptedImap(self.stream(validity=18)))

    def test_actual_private_delivery_precedes_authorized_ack_and_returns_no_code(self):
        client, calls = ScriptedImap(self.stream()), []
        def host(value):
            calls.append(value['operation'])
            if value['operation'] == 'status': return {'authenticated': False, 'state': 'waiting', 'finished': False}
            if value['operation'] == 'prepare': return SPEC
            if value['operation'] == 'begin': return {'armed': True}
            if value['operation'] == 'deliver':
                self.assertEqual(value['payload']['code'], '123456')
                self.assertNotIn('ack-reference', calls)
                return {'authenticated': True}
            if value['operation'] == 'claim-ack': return {'action': 'mark_seen_once'}
            if value['operation'] == 'record-ack': return {'acknowledgement': 'complete'}
            self.fail('unknown operation')
        def ack(args):
            calls.append('ack-reference')
            self.assertTrue(args.confirm)
            self.assertEqual(args.uid, '11')
            return {'readState': {'verified': True, 'seen': True, 'writeAttempted': True}}
        with mock.patch.object(B, 'read_baseline', return_value=self.baseline), mock.patch.object(M, 'imap_connection', return_value=contextlib.nullcontext(client)), mock.patch.object(M, 'command_ack_reference', side_effect=ack):
            result = B.complete(self.args(), M, host)
        self.assertEqual(calls, ['status', 'prepare', 'begin', 'deliver', 'claim-ack', 'ack-reference', 'record-ack'])
        self.assertTrue(result['authenticated'])
        self.assertEqual(result['acknowledgement'], 'complete')
        self.assertNotIn('123456', json.dumps(result))
        self.assertNotIn('example.test', json.dumps(result))

    def test_unverified_login_never_marks_seen_and_ack_failure_preserves_verified_login(self):
        for verified in (False, True):
            calls = []
            def host(value):
                calls.append(value['operation'])
                if value['operation'] == 'status': return {'authenticated': False, 'state': 'waiting', 'finished': False}
                if value['operation'] == 'prepare': return SPEC
                if value['operation'] == 'begin': return {'armed': True}
                if value['operation'] == 'deliver': return {'authenticated': verified}
                raise RuntimeError('synthetic private response canary 123456')
            with mock.patch.object(B, 'read_baseline', return_value=self.baseline), mock.patch.object(B, 'find_code', return_value=('123456', {'uid': 11})), mock.patch.object(M, 'command_ack_reference') as ack:
                result = B.complete(self.args(), M, host)
            self.assertEqual(result['authenticated'], verified)
            self.assertEqual(result['acknowledgement'], 'unknown' if verified else 'none')
            ack.assert_not_called()
            self.assertNotIn('123456', json.dumps(result))

    def test_native_unknown_delivery_is_closed_and_no_second_code_or_store_is_sent(self):
        calls = []
        def host(value):
            calls.append(value['operation'])
            if value['operation'] == 'status': return {'authenticated': False, 'state': 'waiting', 'finished': False}
            if value['operation'] == 'prepare': return SPEC
            if value['operation'] == 'begin': return {'armed': True}
            raise RuntimeError('synthetic 123456 MIME credentials canary')
        with mock.patch.object(B, 'read_baseline', return_value=self.baseline), mock.patch.object(B, 'find_code', return_value=('123456', {'uid': 11})), mock.patch.object(M, 'command_ack_reference') as ack:
            with self.assertRaises(M.MailboxError) as caught:
                B.complete(self.args(), M, host)
        self.assertEqual(str(caught.exception), 'EMAIL_BROWSER_AUTH_UNAVAILABLE')
        self.assertEqual(calls, ['status', 'prepare', 'begin', 'deliver'])
        ack.assert_not_called()

    def test_verify_only_uses_previous_exact_ack_without_code_delivery_or_new_store(self):
        calls = []
        reference = {'uid': 11, 'uidValidity': 17, 'revision': 'b'*64, 'originalSha256': 'c'*64}
        def host(value):
            calls.append(value['operation'])
            if value['operation'] == 'status': return {'authenticated': True, 'acknowledgement': 'pending', 'reference': reference}
            if value['operation'] == 'claim-ack': return {'action': 'verify_only'}
            return {'acknowledgement': 'complete'}
        with mock.patch.object(M, 'command_ack_reference', return_value={'readState': {'verified': True, 'seen': True, 'writeAttempted': False}}) as ack:
            result = B.complete(self.args(verify_only=True), M, host)
        self.assertFalse(ack.call_args.args[0].confirm)
        self.assertTrue(ack.call_args.args[0].verify_only)
        self.assertEqual(calls, ['status', 'claim-ack', 'record-ack'])
        self.assertTrue(result['authenticated'])

    def test_baseline_is_captured_readonly_before_any_code_request(self):
        client = ScriptedImap(examine(1, next_uid=11) + examine(2, next_uid=12))
        with mock.patch.object(M, 'imap_connection', return_value=contextlib.nullcontext(client)):
            baseline = B.read_baseline(ACCOUNT, self.args(), M)
        self.assertEqual(baseline['lastUid'], 11)
        self.assertEqual(client.sent, [b'TEST1 EXAMINE "INBOX"\r\n', b'TEST2 EXAMINE "INBOX"\r\n'])

    def test_safe_profile_never_returns_subject_body_code_or_url_and_never_marks_seen(self):
        raw = RAW.replace(b'Subject: Sign in', b'Subject: Example code 123456')
        client = ScriptedImap(examine(1, next_uid=12) + b'* SEARCH 11\r\nTEST2 OK searched\r\n'
            + fetched(tag=3, raw=raw) + examine(4, next_uid=12))
        with mock.patch.object(M, 'imap_connection', return_value=contextlib.nullcontext(client)):
            result = B.profile(NS(account='synthetic', folder=None, brand='Example'), M)
        self.assertEqual(result['profiles'], [{'sender': 'login@example.test', 'subjectAnchor': 'Example',
                         'bodyAnchor': 'Example', 'digits': 6, 'recipientVerified': True}])
        self.assertNotIn('123456', json.dumps(result))
        self.assertNotIn('Example account code', json.dumps(result))
        self.assertEqual(client.sent[1], b'TEST2 UID SEARCH UID 1:11 TEXT "Example"\r\n')
        self.assertFalse(any(b'STORE' in x or b' SELECT ' in x for x in client.sent))

    def test_otp_literal_limit_refuses_before_body_allocation_without_raising_export_limits(self):
        client = ScriptedImap(b'* 1 FETCH (UID 11 RFC822.SIZE 262145 BODY[] {262145}\r\n')
        client.state = 'SELECTED'
        with self.assertRaises(M.EmailReferenceError):
            M.fetch_raw_message(client, '11', verify_reference=True, maximum_bytes=256*1024)
        self.assertTrue(client.responses.closed)

    def test_unicode_profile_uses_one_real_literal_and_bounded_response(self):
        for enabled in (False, True):
            client = ScriptedImap(examine(1, next_uid=12) + b'+ literal ready\r\n'
                + b'* SEARCH\r\nTEST2 OK searched\r\n' + examine(3, next_uid=12))
            if enabled:
                client._mode_utf8()
            with mock.patch.object(M, 'imap_connection', return_value=contextlib.nullcontext(client)):
                result = B.profile(NS(account='synthetic', folder=None, brand='Пример'), M)
            self.assertEqual(result['profiles'], [])
            charset = b'' if enabled else b'CHARSET UTF-8 '
            self.assertEqual(client.sent[1], b'TEST2 UID SEARCH ' + charset + b'UID 1:11 TEXT {12}\r\n')
            self.assertEqual(client.sent[2], 'Пример'.encode())
            self.assertIsNone(client.literal)
            self.assertFalse(any(b'STORE' in x for x in client.sent))

    def test_profile_errors_reveal_only_fixed_stage_never_native_text(self):
        for stream, stage in (
            (examine(1, next_uid=12) + b'TEST2 NO private code 123456\r\n', 'SEARCH'),
            (examine(1, next_uid=12) + b'* SEARCH ' + b' '.join(str(n).encode() for n in range(1, 22))
                + b'\r\nTEST2 OK searched\r\n', 'CANDIDATES'),
            (examine(1, next_uid=12) + b'* SEARCH 11\r\nTEST2 OK searched\r\n'
                + b'* 1 FETCH (UID 11 RFC822.SIZE 262145 BODY[] {262145}\r\n', 'FETCH'),
        ):
            client = ScriptedImap(stream)
            with mock.patch.object(M, 'imap_connection', return_value=contextlib.nullcontext(client)):
                with self.assertRaises(M.MailboxError) as caught:
                    B.profile(NS(account='synthetic', folder=None, brand='Example'), M)
            self.assertEqual(str(caught.exception), 'EMAIL_BROWSER_AUTH_PROFILE_' + stage + '_UNAVAILABLE')
            self.assertFalse(any(b'STORE' in x for x in client.sent))

    def test_actual_private_process_contract_has_no_code_in_argv_env_or_public_errors(self):
        module = Path.cwd() / 'synthetic' / 'trelio-browser-session.mjs'
        node = Path.cwd() / 'synthetic' / 'node'
        with mock.patch.dict(os.environ, {'TRELIO_BROWSER_MAIL_MODULE_URL': module.as_uri(),
                                         'TRELIO_LOCAL_FORM_NODE_EXECUTABLE': str(node)}), \
             mock.patch.object(B.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'{"ok":true}', b'')) as run:
            result = B.private_host({'operation': 'deliver', 'handle': HANDLE, 'payload': {'code': '123456'}}, M)
            self.assertTrue(result['ok'])
            arguments = run.call_args
            self.assertNotIn('123456', json.dumps(arguments.args))
            self.assertIn(b'123456', arguments.kwargs['input'])
            self.assertFalse(arguments.kwargs['shell'])
        with mock.patch.dict(os.environ, {'TRELIO_BROWSER_MAIL_MODULE_URL': module.as_uri(),
                                         'TRELIO_LOCAL_FORM_NODE_EXECUTABLE': str(node)}), \
             mock.patch.object(B.subprocess, 'run', side_effect=RuntimeError('private code 123456')):
            with self.assertRaises(M.MailboxError) as caught:
                B.private_host({'operation': 'prepare', 'handle': HANDLE}, M)
        self.assertEqual(str(caught.exception), 'EMAIL_BROWSER_AUTH_HOST_UNAVAILABLE')


if __name__ == '__main__':
    unittest.main()
