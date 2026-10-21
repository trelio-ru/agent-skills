"""The actual IMAP parser/encoder, with an owned synthetic socket only."""
import contextlib
import hashlib
import io
import json
import os
import unittest
from dataclasses import replace
from types import SimpleNamespace as NS
from unittest import mock

from test_assistant_monitor import ACCOUNT, examine
from test_imap_protocol import ScriptedImap
from test_message_reference import RAW, fetched
from test_trelio_email import MODULE as M


def flags(tag, value=b'', uid=11):
    return b'* 1 FETCH (UID ' + str(uid).encode() + b' FLAGS (' + value + b'))\r\nTEST' + str(tag).encode() + b' OK flags\r\n'


def writable(tag=4, validity=17):
    return examine(tag, validity=validity, next_uid=12).replace(b'READ-ONLY', b'READ-WRITE')


class ReferenceAcknowledgement(unittest.TestCase):
    def setUp(self):
        self.load = self.enterContext(mock.patch.object(M, 'load_account', return_value=ACCOUNT))
        self.policy = self.enterContext(mock.patch.object(M, 'load_email_policy', return_value={'sendMode': 'confirm'}))
        self.enterContext(mock.patch.object(M, 'selected_local_account', return_value=None))
        self.enterContext(mock.patch.dict(os.environ, {'TRELIO_SKILL_COMPANY_ID': 'synthetic-company',
                                                     'TRELIO_SKILL_MEMBER_ID': 'synthetic-member'}))

    def args(self, **overrides):
        values = dict(command='ack-reference', account='synthetic', folder=None, special_use=None, uid='11',
                      uid_validity='17', expected_revision=M.email_reference_revision(M.email_monitor_scope(ACCOUNT, 'INBOX'), 17, 11),
                      expected_original_sha256=hashlib.sha256(RAW).hexdigest(), confirm=True, verify_only=False)
        return NS(**{**values, **overrides})

    def ack(self, client, **changes):
        with mock.patch.object(M, 'imap_connection', return_value=contextlib.nullcontext(client)):
            return M.command_ack_reference(self.args(**changes))

    def initial(self, seen=b''):
        return examine(1, next_uid=12) + fetched() + flags(3, seen)

    def test_exact_uid_hash_readback_and_additive_seen_do_not_touch_siblings_or_send_receipts(self):
        client = ScriptedImap(self.initial() + writable() + b'TEST5 OK stored\r\n' + flags(6, b'\\Seen \\Flagged') + examine(7, next_uid=12))
        result = self.ack(client)
        self.assertEqual(client.sent, [b'TEST1 EXAMINE "INBOX"\r\n', b'TEST2 UID FETCH 11 (UID RFC822.SIZE BODY.PEEK[])\r\n',
                                      b'TEST3 UID FETCH 11 (UID FLAGS)\r\n', b'TEST4 SELECT "INBOX"\r\n',
                                      b'TEST5 UID STORE 11 +FLAGS.SILENT (\\Seen)\r\n', b'TEST6 UID FETCH 11 (UID FLAGS)\r\n',
                                      b'TEST7 EXAMINE "INBOX"\r\n'])
        self.assertEqual(result['protocol'], 'email-read-state/v1')
        self.assertEqual(result['readState'], {'verified': True, 'seen': True, 'writeAttempted': True,
                                               'automaticRetryAllowed': False, 'readReceiptsSent': False})
        self.assertTrue(client.is_readonly)
        self.assertNotIn('Полный текст', json.dumps(result, ensure_ascii=False))
        self.assertNotIn('sender@example', json.dumps(result))

    def test_already_seen_and_verify_only_never_open_a_writable_folder(self):
        for seen in (True, False):
            client = ScriptedImap(self.initial(b'\\Seen' if seen else b'') + examine(4, next_uid=12))
            result = self.ack(client, confirm=False, verify_only=True)
            self.assertEqual(result['readState']['seen'], seen)
            self.assertFalse(result['readState']['writeAttempted'])
            self.assertTrue(client.is_readonly)
            self.assertFalse(any(b' STORE ' in row or b' SELECT ' in row for row in client.sent))
        client = ScriptedImap(self.initial(b'\\seen') + examine(4, next_uid=12))
        self.assertFalse(self.ack(client)['readState']['writeAttempted'])
        self.assertEqual(len(client.sent), 4, 'a positive preflight read-back needs no duplicate STORE')

    def test_changed_scope_validity_or_full_original_bytes_never_store(self):
        cases = [({}, examine(1, validity=18, next_uid=12)), ({'folder': 'Other'}, examine(1, next_uid=12)),
                 ({'expected_original_sha256': 'a' * 64}, examine(1, next_uid=12) + fetched())]
        for changes, wire in cases:
            client = ScriptedImap(wire)
            with self.assertRaises(M.EmailAckError) as caught:
                self.ack(client, **changes)
            self.assertEqual(caught.exception.code, 'EMAIL_ACK_CHANGED')
            self.assertFalse(caught.exception.attempted)
            self.assertFalse(any(b'STORE' in row for row in client.sent))

    def test_writable_reselect_and_policy_are_rechecked_before_store(self):
        for changed_policy in (False, True):
            client = ScriptedImap(self.initial() + writable(validity=17 if changed_policy else 18))
            if changed_policy:
                self.policy.side_effect = [{'sendMode': 'confirm'}, {'sendMode': 'read-only'}]
            with self.assertRaises(M.EmailAckError) as caught:
                self.ack(client)
            self.assertEqual(caught.exception.code, 'EMAIL_ACK_POLICY_DENIED' if changed_policy else 'EMAIL_ACK_CHANGED')
            self.assertFalse(caught.exception.attempted)
            self.assertFalse(any(b'STORE' in row for row in client.sent))

    def test_unknown_store_or_failed_readback_retains_the_crossed_write_boundary(self):
        cases = [b'', b'TEST5 NO PRIVATE_PROVIDER_CANARY\r\n' + flags(6),
                 b'TEST5 OK stored\r\n' + flags(6, b'\\Seen', uid=12)]
        for after in cases:
            client = ScriptedImap(self.initial() + writable() + after)
            with self.assertRaises(M.EmailAckError) as caught:
                self.ack(client)
            payload = M.error_payload(caught.exception)
            self.assertEqual(payload['readState']['writeOutcome'], 'unknown')
            self.assertTrue(payload['readState']['writeAttempted'])
            self.assertFalse(payload['readState']['automaticRetryAllowed'])
            self.assertNotIn('PRIVATE_PROVIDER', json.dumps(payload))
            self.assertEqual(sum(b'STORE' in row for row in client.sent), 1)

    def test_lost_response_can_be_reconciled_with_read_only_native_state(self):
        # Simulate restart after an accepted STORE whose result never arrived.
        # A fresh invocation verifies identity, original bytes and Seen; no
        # caller-controlled "processed" or approval boolean is evidence here.
        client = ScriptedImap(self.initial(b'\\Seen') + examine(4, next_uid=12))
        result = self.ack(client, confirm=False, verify_only=True)
        self.assertTrue(result['readState']['verified']); self.assertTrue(result['readState']['seen'])
        self.assertFalse(any(b'STORE' in row for row in client.sent))

    def test_unrequested_literal_during_store_is_refused_before_allocation_and_not_reparsed(self):
        client = ScriptedImap(self.initial() + writable() + b'* 1 FETCH (BODY[] {999999999}\r\n')
        with mock.patch.object(client, 'read', wraps=client.read) as reader:
            with self.assertRaises(M.EmailAckError) as caught:
                self.ack(client)
            self.assertTrue(caught.exception.attempted)
            reader.assert_called_once_with(len(RAW),)
            self.assertEqual(client.state, 'LOGOUT'); self.assertTrue(client.responses.closed)

    def test_foreign_duplicate_and_oversized_flags_do_not_authorize_store(self):
        wires = [flags(3, b'\\Seen', uid=12), b'* 1 FETCH (UID 11 FLAGS () UID 11)\r\nTEST3 OK flags\r\n',
                 b'* 1 FETCH (UID 11 FLAGS ())\r\n* 2 FETCH (UID 12 FLAGS ())\r\nTEST3 OK flags\r\n',
                 flags(3, b'x' * 5000)]
        for response in wires:
            client = ScriptedImap(examine(1, next_uid=12) + fetched() + response)
            with self.assertRaises(M.EmailAckError):
                self.ack(client)
            self.assertFalse(any(b'STORE' in row for row in client.sent))

    def test_native_flag_order_and_keywords_do_not_change_other_flags(self):
        response = b'* 1 FETCH (FLAGS (\\Seen custom:flag $Label1 \\Flagged) UID 11)\r\nTEST3 OK flags\r\n'
        client = ScriptedImap(examine(1, next_uid=12) + fetched() + response + examine(4, next_uid=12))
        self.assertTrue(self.ack(client)['readState']['seen'])
        self.assertFalse(any(b'STORE' in row for row in client.sent))

    def test_post_store_identity_and_cleanup_failures_are_not_success(self):
        client = ScriptedImap(self.initial() + writable() + b'TEST5 OK stored\r\n' + flags(6, b'\\Seen') + examine(7, validity=18, next_uid=12))
        with self.assertRaises(M.EmailAckError) as caught:
            self.ack(client)
        self.assertTrue(caught.exception.attempted); self.assertEqual(caught.exception.code, 'EMAIL_ACK_CHANGED')
        @contextlib.contextmanager
        def cleanup_failure():
            yield ScriptedImap(self.initial() + writable() + b'TEST5 OK stored\r\n' + flags(6, b'\\Seen') + examine(7, next_uid=12))
            raise OSError('PRIVATE_CLEANUP_CANARY')
        with mock.patch.object(M, 'imap_connection', return_value=cleanup_failure()):
            with self.assertRaises(M.EmailAckError) as caught:
                M.command_ack_reference(self.args())
            self.assertTrue(caught.exception.attempted)
            self.assertNotIn('PRIVATE_CLEANUP', json.dumps(M.error_payload(caught.exception)))

    def test_oversized_store_metadata_closes_stream_without_success_or_replay(self):
        client = ScriptedImap(self.initial() + writable() + (b'* OK ' + b'x' * 800 + b'\r\n') * 30)
        with self.assertRaises(M.EmailAckError) as caught:
            self.ack(client)
        self.assertTrue(caught.exception.attempted)
        self.assertTrue(client.responses.closed); self.assertEqual(client.state, 'LOGOUT')
        self.assertEqual(sum(b'STORE' in row for row in client.sent), 1)

    def test_public_policy_preflight_refuses_before_guardian_and_credential_start(self):
        self.policy.return_value = {'sendMode': 'read-only'}
        arguments = ['trelio-email.py', 'ack-reference', '--account', 'synthetic', '--uid', '11', '--uid-validity', '17',
                     '--expected-revision', self.args().expected_revision, '--expected-original-sha256', hashlib.sha256(RAW).hexdigest(), '--confirm']
        with mock.patch.object(M, 'native_runtime') as native, mock.patch.object(M.sys, 'argv', arguments), contextlib.redirect_stderr(io.StringIO()) as errors:
            value = M.main()
        self.assertEqual(value, 2); native.assert_not_called()
        self.assertEqual(json.loads(errors.getvalue())['code'], 'EMAIL_ACK_POLICY_DENIED')

    def test_confirmation_syntax_smtp_only_and_read_only_policy_fail_before_native_io(self):
        with mock.patch.object(M, 'imap_connection') as connection:
            for changes in ({'confirm': False}, {'confirm': True, 'verify_only': True}, {'uid': '1:12'},
                            {'uid_validity': '0'}, {'expected_original_sha256': 'A' * 64}):
                with self.assertRaises(M.EmailAckError) as caught:
                    M.command_ack_reference(self.args(**changes))
                self.assertEqual(caught.exception.code, 'EMAIL_ACK_INPUT_INVALID')
            self.load.assert_not_called()
            self.load.return_value = replace(ACCOUNT, connection_mode='smtp_only')
            with self.assertRaisesRegex(M.MailboxError, 'imap_unavailable_smtp_only'):
                M.command_ack_reference(self.args())
            self.load.return_value = ACCOUNT; self.policy.return_value = {'sendMode': 'read-only'}
            with self.assertRaises(M.EmailAckError) as caught:
                M.command_ack_reference(self.args())
            self.assertEqual(caught.exception.code, 'EMAIL_ACK_POLICY_DENIED'); connection.assert_not_called()


if __name__ == '__main__':
    unittest.main()
