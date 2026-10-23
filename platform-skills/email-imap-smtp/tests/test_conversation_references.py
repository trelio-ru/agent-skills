"""Opaque thread hints from bounded native headers, never sender authority."""
import contextlib
import email
import json
import os
import unittest
from dataclasses import replace
from types import SimpleNamespace as NS
from unittest import mock

from test_assistant_monitor import ACCOUNT, examine
from test_imap_protocol import ScriptedImap
from test_message_reference import fetched
from test_trelio_email import MODULE as M


HEADER = b'Message-ID: <reply@example.test>\r\nReferences: <root@example.test>\r\n\r\n'
RAW = HEADER[:-2] + b'From: fixture@example.test\r\nSubject: PRIVATE_SUBJECT\r\n\r\nFull body\r\n'


def header_fetch(tag=3, uid=11, raw=HEADER, fields=b'MESSAGE-ID IN-REPLY-TO REFERENCES', after=False):
    attributes = b'' if after else f'UID {uid} '.encode()
    end = f' UID {uid})'.encode() if after else b')'
    return (b'* 1 FETCH (' + attributes + b'BODY[HEADER.FIELDS (' + fields + b')] {'
            + str(len(raw)).encode() + b'}\r\n' + raw + end + f'\r\nTEST{tag} OK fetched\r\n'.encode())


class ConversationReferences(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch.object(M, 'load_account', return_value=ACCOUNT))
        self.enterContext(mock.patch.object(M, 'selected_local_account', return_value=None))
        self.enterContext(mock.patch.dict(os.environ, {'TRELIO_SKILL_COMPANY_ID': 'synthetic-company',
                                                     'TRELIO_SKILL_MEMBER_ID': 'synthetic-member'}))
        self.scope = M.email_monitor_scope(ACCOUNT, 'INBOX')

    def monitor(self, client, **overrides):
        args = NS(command='monitor', account='synthetic', folder=None, special_use=None, limit=100,
                  cursor=M.email_monitor_cursor(self.scope, 17, 10), conversation_references=True)
        vars(args).update(overrides)
        with mock.patch.object(M, 'imap_connection', return_value=contextlib.nullcontext(client)):
            return M.command_monitor(args)

    def test_outgoing_hint_matches_future_inbox_reply_and_never_uses_sent_uid_or_body(self):
        message = email.message_from_bytes(b'Message-ID: <new-root@example.test>\r\n\r\n', policy=M.default)
        client = ScriptedImap(examine(1, next_uid=12) + examine(2, next_uid=13))
        with mock.patch.object(M, 'imap_connection', return_value=contextlib.nullcontext(client)):
            result = M.outgoing_email_conversation_reference(ACCOUNT, message)
        reply = email.message_from_bytes(b'Message-ID: <reply@example.test>\r\nReferences: <new-root@example.test>\r\n\r\n', policy=M.default)
        self.assertEqual(result, {'available': True, 'conversationKey': M.email_conversation_key(self.scope, 17, 999, reply)})
        self.assertEqual(client.sent, [b'TEST1 EXAMINE "INBOX"\r\n', b'TEST2 EXAMINE "INBOX"\r\n'])
        for responses in [examine(1, next_uid=12) + examine(2, next_uid=13, validity=18), b'TEST1 NO PRIVATE_IMAP_ERROR\r\n']:
            with mock.patch.object(M, 'imap_connection', return_value=contextlib.nullcontext(ScriptedImap(responses))):
                self.assertEqual(M.outgoing_email_conversation_reference(ACCOUNT, message),
                                 {'available': False, 'code': 'EMAIL_CONVERSATION_REFERENCE_UNAVAILABLE'})

    def test_monitor_reads_only_exact_identity_headers_then_rechecks_native_namespace(self):
        client = ScriptedImap(examine(1, next_uid=12) + b'* SEARCH 11\r\nTEST2 OK searched\r\n'
                              + header_fetch() + examine(4, next_uid=12))
        value = self.monitor(client)
        self.assertEqual(client.sent, [b'TEST1 EXAMINE "INBOX"\r\n', b'TEST2 UID SEARCH UID 11:11\r\n',
                         b'TEST3 UID FETCH 11 (UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)])\r\n',
                         b'TEST4 EXAMINE "INBOX"\r\n'])
        self.assertEqual(value['events'][0]['conversationKey'], M.email_conversation_key(
            self.scope, 17, 11, email.message_from_bytes(HEADER, policy=M.default)))
        self.assertFalse(value['coverage']['bodyContentRead'])
        self.assertTrue(value['coverage']['conversationHeadersRead'])
        self.assertNotIn('example.test', json.dumps(value))
        self.assertEqual(value['readState'], {'readReceiptsSent': False})

    def test_initial_unread_reuses_the_same_bounded_headers_and_final_namespace_check(self):
        seed=M.email_monitor_cursor(self.scope,17,0,backfill_through=10)
        for validity in [17,18]:
            client=ScriptedImap(examine(1,next_uid=12)+b'* SEARCH 5\r\nTEST2 OK searched\r\n'
                                +header_fetch(uid=5)+examine(4,next_uid=20,validity=validity))
            if validity!=17:
                with self.assertRaises(M.EmailMonitorError):
                    self.monitor(client,cursor=seed,unread_backfill=True)
                continue
            value=self.monitor(client,cursor=seed,unread_backfill=True)
            self.assertEqual(client.sent[1],b'TEST2 UID SEARCH UID 1:10 UNSEEN\r\n')
            self.assertEqual(client.sent[2],b'TEST3 UID FETCH 5 (UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)])\r\n')
            self.assertEqual(value['events'][0]['conversationKey'],M.email_conversation_key(
                self.scope,17,5,email.message_from_bytes(HEADER,policy=M.default)))
            self.assertFalse(value['hasMore']);self.assertFalse(value['coverage']['bodyContentRead'])
            self.assertTrue(value['coverage']['conversationHeadersRead'])
            self.assertNotIn('example.test',json.dumps(value))

    def test_header_field_order_and_uid_after_literal_are_legal_but_extra_fields_are_not(self):
        for fields in [b'MESSAGE-ID IN-REPLY-TO REFERENCES', b'REFERENCES MESSAGE-ID IN-REPLY-TO']:
            client = ScriptedImap(examine(1, next_uid=12) + b'* SEARCH 11\r\nTEST2 OK searched\r\n'
                                  + header_fetch(fields=fields, after=True) + examine(4, next_uid=12))
            self.assertEqual(len(self.monitor(client)['events']), 1)
        for raw, fields in [(b'From: PRIVATE_CANARY\r\n\r\n', b'MESSAGE-ID IN-REPLY-TO REFERENCES'),
                            (HEADER, b'MESSAGE-ID IN-REPLY-TO SUBJECT'), (HEADER, b'MESSAGE-ID MESSAGE-ID REFERENCES')]:
            client = ScriptedImap(examine(1, next_uid=12) + b'* SEARCH 11\r\nTEST2 OK searched\r\n'
                                  + header_fetch(raw=raw, fields=fields))
            with self.assertRaises(M.EmailMonitorError) as caught:
                self.monitor(client)
            self.assertNotIn('PRIVATE_CANARY', json.dumps(M.error_payload(caught.exception)))

    def test_oversized_header_literal_is_rejected_before_allocation_and_reader_is_restored(self):
        wire = f'* 1 FETCH (UID 11 BODY[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)] {{{M.MAX_REPLY_HEADER_CHARS + 1}}}\r\n'.encode()
        client = ScriptedImap(examine(1, next_uid=12) + b'* SEARCH 11\r\nTEST2 OK searched\r\n' + wire)
        with mock.patch.object(client, 'read', wraps=client.read) as observed:
            with self.assertRaises(M.EmailMonitorError):
                self.monitor(client)
            observed.assert_not_called()
            self.assertIs(client.read, observed)
            self.assertEqual(client.state, 'LOGOUT')

    def test_foreign_uid_or_changed_namespace_never_returns_a_page_or_new_cursor(self):
        for response, final in [(header_fetch(uid=12), examine(4, next_uid=12)),
                                (header_fetch(), examine(4, validity=18, next_uid=12))]:
            client = ScriptedImap(examine(1, next_uid=12) + b'* SEARCH 11\r\nTEST2 OK searched\r\n' + response + final)
            with self.assertRaises(M.EmailMonitorError):
                self.monitor(client)

    def test_thread_root_is_stable_but_other_accounts_folders_validity_and_singletons_do_not_merge(self):
        parsed = lambda raw: email.message_from_bytes(raw, policy=M.default)
        root = M.email_conversation_key(self.scope, 17, 1, parsed(b'Message-ID: <root@example.test>\r\n\r\n'))
        self.assertEqual(root, M.email_conversation_key(self.scope, 17, 11, parsed(HEADER)))
        for scope, validity in [(M.email_monitor_scope(ACCOUNT, 'Other'), 17), (self.scope, 18),
                                (M.email_monitor_scope(replace(ACCOUNT, username='other@example.test'), 'INBOX'), 17)]:
            self.assertNotEqual(root, M.email_conversation_key(scope, validity, 11, parsed(HEADER)))
        self.assertNotEqual(M.email_conversation_key(self.scope, 17, 1, parsed(b'\r\n')),
                            M.email_conversation_key(self.scope, 17, 2, parsed(b'\r\n')))
        for raw in [b'Message-ID: <a@test> <b@test>\r\n\r\n',
                    b'References: PRIVATE_CANARY\r\n\r\n', b'Message-ID: <a@test>\r\nMessage-ID: <b@test>\r\n\r\n']:
            with self.assertRaises(M.MailboxError):
                M.email_conversation_key(self.scope, 17, 11, parsed(raw))

    def test_reference_read_verifies_the_same_hint_before_returning_full_content(self):
        expected = M.email_conversation_key(self.scope, 17, 11, email.message_from_bytes(HEADER, policy=M.default))
        args = NS(command='read-reference', account='synthetic', folder=None, special_use=None, uid='11', uid_validity='17',
                  expected_revision=M.email_reference_revision(self.scope, 17, 11), expected_conversation_key=expected)
        for changed in [False, True]:
            client = ScriptedImap(examine(1, next_uid=12) + fetched(raw=RAW) + examine(3, next_uid=12))
            with mock.patch.object(M, 'imap_connection', return_value=contextlib.nullcontext(client)):
                if changed:
                    with self.assertRaises(M.EmailReferenceError) as caught:
                        M.command_read_reference(NS(**{**vars(args), 'expected_conversation_key': 'email-conversation/v1.' + '0' * 64}))
                    self.assertEqual(caught.exception.code, 'EMAIL_REFERENCE_CHANGED')
                else:
                    value = M.command_read_reference(args)
                    self.assertEqual(value['reference']['conversationKey'], expected)
                    self.assertEqual(value['message']['body'], 'Full body')
        with mock.patch.object(M, 'load_account') as load:
            with self.assertRaises(M.EmailReferenceError):
                M.command_read_reference(NS(**{**vars(args), 'expected_conversation_key': 'PRIVATE_CANARY'}))
            load.assert_not_called()
