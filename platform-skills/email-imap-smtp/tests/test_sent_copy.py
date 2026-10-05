"""Prove SMTP acceptance and Sent-copy state remain independent.

The real imaplib encoder consumes a scripted server transcript. These tests
therefore catch mailbox quoting, APPEND literal and MIME serialization defects
that a mocked append() alone would miss. No real mail is sent.
"""

import contextlib
import email
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_imap_protocol import ScriptedImap
from test_trelio_email import MODULE


MESSAGE_ID = "<sent-copy-test-01@example.com>"
WIRE_FOLDER = b"&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-"
HEADER = f"Message-ID: {MESSAGE_ID}\r\n\r\n".encode()
LIST_AND_SELECT = (
    b'* LIST (\\Sent) "/" "' + WIRE_FOLDER + b'"\r\nTEST1 OK listed\r\n'
    b'* 0 EXISTS\r\nTEST2 OK examined\r\n'
)


def fetched_header(tag, uid=b"42", header=HEADER):
    return (
        b'* 1 FETCH (UID ' + uid + b' BODY[HEADER.FIELDS (MESSAGE-ID)] {'
        + str(len(header)).encode() + b'}\r\n' + header + b')\r\n'
        + tag + b' OK fetched\r\n'
    )


class SentCopyTests(unittest.TestCase):
    def setUp(self):
        self.account = MODULE.Account(
            name="work", email_address="person@example.com", display_name="Отправитель",
            username="person@example.com", imap_host="imap.example.com", imap_port=993,
            smtp_host="smtp.example.com", smtp_port=465, smtp_security="ssl", credential_store="file",
        )
        self.smtp = mock.MagicMock()
        self.smtp.sendmail.return_value = {}
        self.smtp.has_extn.return_value = False
        self.smtp.__enter__.return_value = self.smtp
        self.smtp.__exit__.return_value = False
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for name, value in (
            ("load_account", self.account), ("load_email_policy", {"sendMode": "confirm"}),
            ("smtp_connection", self.smtp), ("make_msgid", MESSAGE_ID),
        ):
            self.stack.enter_context(mock.patch.object(MODULE, name, return_value=value))

    def send(self, extra=()):
        args = MODULE.build_parser().parse_args([
            "send", "--account", "work", "--to", "a@example.com", "--subject", "Проверка копии",
            "--body", "Тестовое письмо\nВторая строка", "--confirm", *extra,
        ])
        return MODULE.command_send(args)

    def use_imap(self, responses):
        client = ScriptedImap(responses)
        self.stack.enter_context(mock.patch.object(MODULE, "imap_connection", return_value=contextlib.nullcontext(client)))
        return client

    def test_sent_copy_contains_exact_smtp_mime_bytes_and_is_read_back(self):
        client = self.use_imap(
            LIST_AND_SELECT + b'* SEARCH\r\nTEST3 OK searched\r\n'
            b'+ ready for literal\r\nTEST4 OK [APPENDUID 55 42] stored\r\n'
            b'* 1 EXISTS\r\nTEST5 OK examined\r\n* SEARCH 42\r\nTEST6 OK searched\r\n'
            + fetched_header(b"TEST7")
        )
        with tempfile.TemporaryDirectory() as directory:
            attachment = Path(directory) / "данные.txt"
            attachment.write_bytes(b"exact attachment\r\n")
            result = self.send(["--cc", "copy@example.com", "--bcc", "hidden@example.com", "--attach", str(attachment)])
        self.smtp.sendmail.assert_called_once()
        sender, recipients, raw = self.smtp.sendmail.call_args.args
        self.assertEqual(sender, "person@example.com")
        self.assertEqual(recipients, ["a@example.com", "copy@example.com", "hidden@example.com"])
        message = email.message_from_bytes(raw, policy=MODULE.default)
        self.assertEqual(message["Message-ID"], MESSAGE_ID)
        self.assertIsNotNone(email.utils.parsedate_to_datetime(message["Date"]).tzinfo)
        self.assertIsNone(message["Bcc"])
        self.assertNotIn(b"hidden@example.com", raw)
        self.assertEqual(list(message.iter_attachments())[0].get_payload(decode=True), b"exact attachment\r\n")
        self.assertIn(raw, client.sent)
        append_command = next(value for value in client.sent if value.startswith(b"TEST4 APPEND"))
        self.assertIn(b'APPEND "' + WIRE_FOLDER + b'" (\\Seen) ', append_command)
        self.assertTrue(append_command.endswith(b" {" + str(len(raw)).encode() + b"}\r\n"))
        self.assertTrue(result["sent"])
        self.assertEqual(result["sentCopy"], {
            "saved": True, "verified": True, "status": "verified", "folder": "Отправленные",
            "uid": "42", "appendAttempted": True,
        })
        self.assertNotIn(b" SELECT ", b"".join(client.sent))

    def test_server_saved_copy_is_verified_without_append(self):
        client = self.use_imap(LIST_AND_SELECT + b'* SEARCH 42\r\nTEST3 OK searched\r\n' + fetched_header(b"TEST4"))
        result = self.send()
        self.assertEqual(result["sentCopy"]["status"], "already_present")
        self.assertFalse(result["sentCopy"]["appendAttempted"])
        self.assertFalse(any(b" APPEND " in command for command in client.sent))

    def test_missing_or_ambiguous_sent_role_does_not_undo_smtp(self):
        for listing in (
            b'* LIST () "/" "INBOX"\r\n',
            b'* LIST (\\Sent) "/" "A"\r\n* LIST (\\Sent) "/" "B"\r\n',
        ):
            with self.subTest(listing=listing):
                client = self.use_imap(listing + b'TEST1 OK listed\r\n')
                result = self.send()
                self.assertTrue(result["sent"])
                self.assertEqual(result["sentCopy"]["errorCode"], "sent_copy_folder_failed")
                self.assertFalse(result["sentCopy"]["appendAttempted"])
                self.assertFalse(any(b" APPEND " in command for command in client.sent))

    def test_failed_lookup_is_not_treated_as_missing_copy(self):
        client = self.use_imap(LIST_AND_SELECT + b'TEST3 NO unavailable\r\n')
        result = self.send()
        self.assertTrue(result["sent"])
        self.assertEqual(result["sentCopy"]["errorCode"], "sent_copy_lookup_failed")
        self.assertFalse(result["sentCopy"]["appendAttempted"])
        self.assertFalse(any(b" APPEND " in command for command in client.sent))

    def test_append_rejection_and_disconnect_never_repeat_smtp_or_append(self):
        for reply, expected_saved, expected_status in (
            (b'TEST4 NO quota exceeded\r\n', False, "not_saved"),
            (b'+ ready\r\n', None, "unknown"),
        ):
            with self.subTest(reply=reply):
                self.smtp.sendmail.reset_mock()
                client = self.use_imap(LIST_AND_SELECT + b'* SEARCH\r\nTEST3 OK searched\r\n' + reply)
                result = self.send()
                self.smtp.sendmail.assert_called_once()
                self.assertTrue(result["sent"])
                self.assertIs(result["sentCopy"]["saved"], expected_saved)
                self.assertEqual(result["sentCopy"]["status"], expected_status)
                self.assertEqual(sum(b" APPEND " in command for command in client.sent), 1)

    def test_positive_append_remains_saved_when_readback_fails_or_is_delayed(self):
        for reply in (b'TEST6 NO unavailable\r\n', b'* SEARCH\r\nTEST6 OK searched\r\n'):
            with self.subTest(reply=reply):
                self.use_imap(
                    LIST_AND_SELECT + b'* SEARCH\r\nTEST3 OK searched\r\n'
                    b'+ ready\r\nTEST4 OK stored\r\n* 1 EXISTS\r\nTEST5 OK examined\r\n' + reply
                )
                result = self.send()
                self.assertTrue(result["sent"])
                self.assertTrue(result["sentCopy"]["saved"])
                self.assertFalse(result["sentCopy"]["verified"])
                self.assertEqual(result["sentCopy"]["status"], "saved_unverified")

    def test_successful_smtp_with_failed_quit_still_saves_copy(self):
        self.smtp.__exit__.side_effect = MODULE.smtplib.SMTPServerDisconnected("disconnected")
        self.use_imap(LIST_AND_SELECT + b'* SEARCH 42\r\nTEST3 OK searched\r\n' + fetched_header(b"TEST4"))
        result = self.send()
        self.assertTrue(result["sent"])
        self.assertTrue(result["smtpCleanupWarning"])
        self.assertTrue(result["sentCopy"]["verified"])

    def test_verified_copy_survives_failed_imap_logout(self):
        client = ScriptedImap(LIST_AND_SELECT + b'* SEARCH 42\r\nTEST3 OK searched\r\n' + fetched_header(b"TEST4"))
        context = mock.MagicMock()
        context.__enter__.return_value = client
        context.__exit__.side_effect = OSError("logout failed")
        self.stack.enter_context(mock.patch.object(MODULE, "imap_connection", return_value=context))
        result = self.send()
        self.assertTrue(result["sentCopy"]["verified"])
        self.assertEqual(result["sentCopy"]["errorCode"], "sent_copy_logout_failed")

    def test_partial_delivery_saves_copy_but_does_not_claim_all_recipients_accepted(self):
        self.smtp.sendmail.return_value = {"copy@example.com": (550, b"rejected")}
        self.use_imap(LIST_AND_SELECT + b'* SEARCH 42\r\nTEST3 OK searched\r\n' + fetched_header(b"TEST4"))
        result = self.send(["--cc", "copy@example.com"])
        self.assertFalse(result["sent"])
        self.assertEqual(result["smtpStatus"], "partially_accepted")
        self.assertEqual(result["refusedRecipients"], ["copy@example.com"])
        self.assertTrue(result["sentCopy"]["saved"])

    def test_ambiguous_smtp_failure_has_message_id_and_never_creates_sent_copy(self):
        self.smtp.sendmail.side_effect = MODULE.smtplib.SMTPServerDisconnected("private provider text")
        with mock.patch.object(MODULE, "imap_connection") as connection:
            with self.assertRaises(MODULE.MailboxError) as raised:
                self.send()
        self.assertIn(MESSAGE_ID, str(raised.exception))
        self.assertNotIn("private provider text", str(raised.exception))
        self.smtp.sendmail.assert_called_once()
        connection.assert_not_called()

    def test_international_envelope_preserves_smtputf8_contract(self):
        with mock.patch.object(MODULE, "save_sent_copy", return_value={"saved": True}) as saved:
            with self.assertRaises(MODULE.MailboxError):
                self.send(["--cc", "почта@example.com"])
            self.smtp.sendmail.assert_not_called()
            saved.assert_not_called()
            self.smtp.has_extn.return_value = True
            result = self.send(["--cc", "почта@example.com"])
        self.assertTrue(result["sent"])
        self.assertEqual(self.smtp.sendmail.call_args.kwargs["mail_options"], ("SMTPUTF8", "BODY=8BITMIME"))
        self.assertEqual(saved.call_args.args[1], self.smtp.sendmail.call_args.args[2])

    def test_similar_message_id_is_not_accepted_as_exact_copy(self):
        client = ScriptedImap(
            b'* SEARCH 42\r\nTEST1 OK searched\r\n'
            + fetched_header(b"TEST2", header=f"Message-ID: prefix-{MESSAGE_ID}\r\n\r\n".encode())
        )
        client.state = "SELECTED"
        self.assertIsNone(MODULE.find_sent_message(client, MESSAGE_ID))


if __name__ == "__main__":
    unittest.main()
