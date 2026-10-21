"""Real stdlib IMAP encoding/parsing; synthetic message and socket stream only."""
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
from test_trelio_email import MODULE as M


RAW = (b'From: sender@example.test\r\nTo: receiver@example.test\r\n'
       b'Subject: Synthetic source\r\nMessage-ID: <synthetic@example.test>\r\n'
       b'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'
       + 'Полный текст 👋🏽\r\n'.encode())


def fetched(tag=2, uid=11, raw=RAW, size=None, attrs=None):
    # Attributes may follow the literal; real imaplib splits that response into
    # tuple + trailing bytes. Both legal orders must reach our native validator.
    before = attrs if attrs is not None else f'UID {uid} RFC822.SIZE {len(raw) if size is None else size} '
    return f'* 1 FETCH ({before}BODY[] {{{len(raw)}}}\r\n'.encode() + raw + f')\r\nTEST{tag} OK fetched\r\n'.encode()


class ReferenceRead(unittest.TestCase):
    def setUp(self):
        self.load = self.enterContext(mock.patch.object(M, 'load_account', return_value=ACCOUNT))
        self.enterContext(mock.patch.object(M, 'selected_local_account', return_value=None))
        self.enterContext(mock.patch.dict(os.environ, {'TRELIO_SKILL_COMPANY_ID': 'synthetic-company',
                                                     'TRELIO_SKILL_MEMBER_ID': 'synthetic-member'}))

    def args(self, **changes):
        values = dict(command='read-reference', account='synthetic', folder=None, special_use=None,
                      uid='11', uid_validity='17', expected_revision=M.email_reference_revision(
                          M.email_monitor_scope(ACCOUNT, 'INBOX'), 17, 11))
        return NS(**{**values, **changes})

    def read(self, client, **changes):
        with mock.patch.object(M, 'imap_connection', return_value=contextlib.nullcontext(client)):
            return M.command_read_reference(self.args(**changes))

    def test_exact_native_uid_and_full_literal_are_read_without_seen_history_or_smtp(self):
        client = ScriptedImap(examine(1, next_uid=12) + fetched() + examine(3, next_uid=12))
        value = self.read(client)
        self.assertEqual(client.sent, [b'TEST1 EXAMINE "INBOX"\r\n',
                                      b'TEST2 UID FETCH 11 (UID RFC822.SIZE BODY.PEEK[])\r\n',
                                      b'TEST3 EXAMINE "INBOX"\r\n'])
        self.assertTrue(client.is_readonly)
        self.assertEqual(value['protocol'], 'email-message-read/v1')
        self.assertEqual(value['reference'], {'id': 'uid:17:11', 'revision': self.args().expected_revision,
                                             'uid': '11', 'uidValidity': '17'})
        self.assertEqual(value['originalSha256'], hashlib.sha256(RAW).hexdigest())
        self.assertEqual(value['message']['body'], 'Полный текст 👋🏽')
        self.assertEqual(value['message'], M.public_mail_message(M.email.message_from_bytes(RAW, policy=M.default), '11', 'INBOX'))
        self.assertEqual(value['coverage'], {'textComplete': True, 'attachmentsContentRead': False, 'otherMessagesIncluded': False})
        self.assertEqual(value['readState'], {'marksRead': False, 'readReceiptsSent': False})

    def test_imap_attribute_order_after_literal_is_valid(self):
        response = b'* 1 FETCH (BODY[] {' + str(len(RAW)).encode() + b'}\r\n' + RAW
        response += f' UID 11 RFC822.SIZE {len(RAW)})\r\nTEST2 OK fetched\r\n'.encode()
        value = self.read(ScriptedImap(examine(1, next_uid=12) + response + examine(3, next_uid=12)))
        self.assertEqual(value['originalSha256'], hashlib.sha256(RAW).hexdigest())

    def test_changed_validity_scope_or_revision_refuses_before_fetch(self):
        for changes, validity in (({}, 18), ({'folder': 'Other'}, 17), ({'expected_revision': 'a' * 64}, 17)):
            client = ScriptedImap(examine(1, validity=validity, next_uid=12))
            with self.assertRaises(M.EmailReferenceError) as caught:
                self.read(client, **changes)
            self.assertEqual(caught.exception.code, 'EMAIL_REFERENCE_CHANGED')
            self.assertEqual(len(client.sent), 1)

    def test_validity_change_after_fetch_does_not_deliver_message(self):
        client = ScriptedImap(examine(1, next_uid=12) + fetched() + examine(3, validity=18, next_uid=12))
        with self.assertRaises(M.EmailReferenceError) as caught:
            self.read(client)
        self.assertEqual(caught.exception.code, 'EMAIL_REFERENCE_CHANGED')
        self.assertNotIn('Synthetic source', json.dumps(M.error_payload(caught.exception)))

    def test_wrong_duplicate_missing_uid_size_and_unrequested_fields_refuse(self):
        cases = [fetched(uid=12), fetched(size=len(RAW) + 1), fetched(attrs=''),
                 fetched(attrs=f'UID 11 UID 11 RFC822.SIZE {len(RAW)} '),
                 fetched(attrs=f'UID 11 RFC822.SIZE {len(RAW)} FLAGS (\\Seen) '),
                 fetched(attrs=f'UID 11 RFC822.SIZE {len(RAW)} RFC822.SIZE {len(RAW)} '),
                 b'TEST2 OK no message\r\n']
        for wire in cases:
            client = ScriptedImap(examine(1, next_uid=12) + wire)
            with self.assertRaises(M.EmailReferenceError) as caught:
                self.read(client)
            self.assertEqual(caught.exception.code, 'EMAIL_REFERENCE_UNAVAILABLE')
            self.assertNotIn('Synthetic source', json.dumps(M.error_payload(caught.exception)))
            self.assertEqual(len(client.sent), 2)

    def test_uid_outside_uidnext_never_fetches(self):
        client = ScriptedImap(examine(1, next_uid=11))
        with self.assertRaises(M.EmailReferenceError) as caught:
            self.read(client)
        self.assertEqual(caught.exception.code, 'EMAIL_REFERENCE_UNAVAILABLE')
        self.assertEqual(len(client.sent), 1)

    def test_oversized_projection_is_not_a_partial_success(self):
        client = ScriptedImap(examine(1, next_uid=12) + fetched())
        with mock.patch.object(M, 'message_text', return_value='x' * (256 * 1024)), \
             self.assertRaises(M.EmailReferenceError) as caught:
            self.read(client)
        self.assertEqual(caught.exception.code, 'EMAIL_REFERENCE_INCOMPLETE')
        self.assertEqual(len(client.sent), 2)

    def test_server_oversized_literal_is_rejected_before_read_or_allocation(self):
        declared = M.MAX_MESSAGE_BYTES + 1
        wire = f'* 1 FETCH (UID 11 RFC822.SIZE {declared} BODY[] {{{declared}}}\r\n'.encode()
        client = ScriptedImap(examine(1, next_uid=12) + wire)
        # This is the real stdlib _get_response literal branch. A mock of uid()
        # would miss an allocation occurring before the post-FETCH bound.
        original = client.read
        with mock.patch.object(client, 'read', wraps=original) as observed:
            with self.assertRaises(M.EmailReferenceError) as caught:
                self.read(client)
            self.assertEqual(caught.exception.code, 'EMAIL_REFERENCE_INCOMPLETE')
            observed.assert_not_called()
            self.assertIs(client.read, observed, 'owned reader is restored even on refusal')
            self.assertEqual(client.state, 'LOGOUT')

    def test_refused_literal_cannot_be_consumed_again_by_context_logout(self):
        declared = M.MAX_MESSAGE_BYTES + 1
        wire = examine(1, next_uid=12) + f'* 1 FETCH (UID 11 RFC822.SIZE {declared} BODY[] {{{declared}}}\r\n'.encode()
        client = ScriptedImap(wire)
        # Use the actual stdlib context-manager exit, not nullcontext. It must
        # not issue LOGOUT and consume a rejected stream after guards restore.
        with mock.patch.object(M, 'imap_connection', return_value=client), self.assertRaises(M.EmailReferenceError) as caught:
            M.command_read_reference(self.args())
        self.assertEqual(caught.exception.code, 'EMAIL_REFERENCE_INCOMPLETE')
        self.assertEqual(len(client.sent), 2)
        self.assertFalse(any(b'LOGOUT' in value for value in client.sent))
        self.assertTrue(client.responses.closed)

    def test_abort_cleanup_error_preserves_bound_failure_without_private_output(self):
        declared = M.MAX_MESSAGE_BYTES + 1
        client = ScriptedImap(examine(1, next_uid=12) + f'* 1 FETCH (UID 11 RFC822.SIZE {declared} BODY[] {{{declared}}}\r\n'.encode())
        with mock.patch.object(client, 'shutdown', side_effect=OSError('PRIVATE_ABORT_CANARY')), \
             self.assertRaises(M.EmailReferenceError) as caught:
            self.read(client)
        self.assertEqual(caught.exception.code, 'EMAIL_REFERENCE_INCOMPLETE')
        self.assertNotIn('PRIVATE_ABORT', json.dumps(M.error_payload(caught.exception)))
        self.assertEqual(client.state, 'LOGOUT')
        client.responses.close()

    def test_multiple_literals_share_one_allocation_budget_and_restore_both_readers(self):
        wire = examine(1, next_uid=13)
        wire += b'* 1 FETCH (UID 11 RFC822.SIZE 3 BODY[] {3}\r\nabc)\r\n'
        wire += b'* 2 FETCH (UID 12 RFC822.SIZE 3 BODY[] {3}\r\ndef)\r\nTEST2 OK fetched\r\n'
        client = ScriptedImap(wire)
        M.select_folder(client, 'INBOX')
        original_read, original_line = client.read, client.readline
        with mock.patch.object(client, 'read', wraps=original_read) as reads, \
             mock.patch.object(client, 'readline', wraps=original_line) as lines, \
             mock.patch.object(M, 'MAX_MESSAGE_BYTES', 4):
            with self.assertRaises(M.EmailReferenceError) as caught:
                M.fetch_raw_message(client, '11', verify_reference=True)
            self.assertEqual(caught.exception.code, 'EMAIL_REFERENCE_INCOMPLETE')
            reads.assert_called_once_with(3)
            self.assertIs(client.read, reads)
            self.assertIs(client.readline, lines)

    def test_small_untagged_lines_cannot_accumulate_without_bound(self):
        wire = examine(1, next_uid=12) + (b'* OK ' + b'x' * 40 + b'\r\n') * 20
        client = ScriptedImap(wire)
        M.select_folder(client, 'INBOX')
        with mock.patch.object(client, 'readline', wraps=client.readline) as lines, \
             mock.patch.object(M, 'MAX_REFERENCE_METADATA_BYTES', 128):
            with self.assertRaises(M.EmailReferenceError) as caught:
                M.fetch_raw_message(client, '11', verify_reference=True)
            self.assertEqual(caught.exception.code, 'EMAIL_REFERENCE_INCOMPLETE')
            self.assertLessEqual(lines.call_count, 3)
            self.assertIs(client.readline, lines)

    def test_cleanup_and_server_failures_do_not_deliver_success_or_private_diagnostics(self):
        @contextlib.contextmanager
        def failed_cleanup():
            yield ScriptedImap(examine(1, next_uid=12) + fetched() + examine(3, next_uid=12))
            raise RuntimeError('PRIVATE_NATIVE_CLEANUP_CANARY')
        for connection in (mock.Mock(return_value=failed_cleanup()),
                           mock.Mock(side_effect=OSError('PRIVATE_NATIVE_CONNECTION_CANARY'))):
            with mock.patch.object(M, 'imap_connection', connection), self.assertRaises(M.EmailReferenceError) as caught:
                M.command_read_reference(self.args())
            self.assertEqual(caught.exception.code, 'EMAIL_REFERENCE_UNAVAILABLE')
            self.assertNotIn('PRIVATE_NATIVE', json.dumps(M.error_payload(caught.exception)))

    def test_invalid_input_and_smtp_only_do_not_reach_native_unlock(self):
        with mock.patch.object(M, 'imap_connection') as connection:
            for changes in ({'uid': '1:12'}, {'uid': True}, {'uid_validity': '0'}, {'expected_revision': 'A' * 64}):
                with self.assertRaises(M.EmailReferenceError) as caught:
                    M.command_read_reference(self.args(**changes))
                self.assertEqual(caught.exception.code, 'EMAIL_REFERENCE_INPUT_INVALID')
            self.load.assert_not_called()
            with mock.patch.object(M, 'load_account', return_value=replace(ACCOUNT, connection_mode='smtp_only')):
                with self.assertRaisesRegex(M.MailboxError, 'imap_unavailable_smtp_only'):
                    M.command_read_reference(self.args())
            connection.assert_not_called()
        with mock.patch.object(M, 'native_runtime') as native, mock.patch.object(M, 'load_password') as password, \
             mock.patch.object(M.sys, 'argv', ['trelio-email.py', 'read-reference', '--account', 'synthetic',
                 '--uid', '11', '--uid-validity', '17', '--expected-revision', 'bad']), \
             contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as caught:
                M.main()
            self.assertEqual(caught.exception.code, 2)
        native.assert_not_called()
        password.assert_not_called()

    def test_parser_uses_native_handler_and_retains_ordinary_fetch_contract(self):
        args = M.build_parser().parse_args(['read-reference', '--account', 'synthetic', '--uid', '11',
                                          '--uid-validity', '17', '--expected-revision', self.args().expected_revision])
        self.assertIs(args.handler, M.command_read_reference)
        # Human callers keep the common original-byte reader and existing wire
        # contract. The assistant's stricter identity proof is an explicit mode.
        client = ScriptedImap(examine(1, next_uid=12) + fetched())
        M.select_folder(client, 'INBOX')
        self.assertEqual(M.fetch_raw_message(client, '11'), RAW)
        self.assertEqual(client.sent[1], b'TEST2 UID FETCH 11 (BODY.PEEK[])\r\n')


if __name__ == '__main__':
    unittest.main()
