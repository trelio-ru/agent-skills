"""SMTP refusal evidence and original attachments survive the public boundary.

All addresses, replies and file contents are synthetic. Transport doubles
capture the actual serialized MIME, never connect to a mailbox or send mail.
"""

import contextlib
import email
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_trelio_email import MODULE
from test_sent_copy import MESSAGE_ID


class SendDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.account = MODULE.Account(
            "work", "sender@example.com", "Sender", "sender@example.com",
            "imap.example.com", 993, "smtp.example.com", 465, "ssl", "file",
        )
        self.smtp = mock.MagicMock()
        self.smtp.__enter__.return_value = self.smtp
        self.smtp.__exit__.return_value = False
        self.smtp.has_extn.return_value = False
        self.smtp.sendmail.return_value = {}
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for name, value in (("load_account", self.account), ("load_email_policy", {"sendMode": "confirm"}),
                            ("smtp_connection", self.smtp), ("make_msgid", MESSAGE_ID)):
            self.stack.enter_context(mock.patch.object(MODULE, name, return_value=value))
        self.saved = self.stack.enter_context(mock.patch.object(MODULE, "save_sent_copy", return_value={"saved": True}))

    def args(self, extra=()):
        return MODULE.build_parser().parse_args([
            "send", "--account", "work", "--to", "recipient@example.com",
            "--subject", "Синтетическая проверка", "--body", "Тестовый текст", "--confirm", *extra,
        ])

    def send(self, extra=()):
        return MODULE.command_send(self.args(extra))

    def failure(self, error):
        self.smtp.sendmail.side_effect = error
        with self.assertRaises(MODULE.SmtpFailure) as caught:
            self.send()
        self.saved.assert_not_called()
        self.smtp.sendmail.assert_called_once()
        result = MODULE.error_payload(caught.exception)
        self.assertFalse(result["ok"])
        self.assertFalse(result["smtp"]["automaticRetryAllowed"])
        self.assertEqual(result["smtp"]["messageId"], MESSAGE_ID)
        self.assertGreater(result["smtp"]["wireBytes"], 0)
        return result

    def test_eml_is_an_exact_download_not_base64_message_container(self):
        # Include signed-looking headers, folding, mixed line endings and
        # non-ASCII bytes: a parse/reserialize "fix" would rewrite this file.
        original = (b"From: original@example.com\r\nSubject: Original\n"
                    b"DKIM-Signature: synthetic;\r\n folded-value\r\n"
                    b"Content-Type: multipart/mixed; boundary=nested\r\n\r\n"
                    b"--nested\r\nContent-Type: application/octet-stream\r\n\r\n"
                    b"\x00\xff\r\n--nested--\r\n")
        with tempfile.TemporaryDirectory() as directory:
            attachment = Path(directory) / "исходное.EML"
            attachment.write_bytes(original)
            result = self.send(["--attach", str(attachment)])
        raw = self.smtp.sendmail.call_args.args[2]
        message = email.message_from_bytes(raw, policy=MODULE.default)
        part = list(message.iter_attachments())[0]
        self.assertEqual(part.get_content_type(), "application/octet-stream")
        self.assertEqual(part.get_filename(), "исходное.EML")
        self.assertEqual(part.get_payload(decode=True), original)
        self.assertEqual(self.saved.call_args.args[1], raw)
        self.assertEqual(result["wireBytes"], len(raw))
        self.assertEqual(result["attachmentCount"], 1)
        self.assertTrue(raw.isascii())

    def test_ordinary_pdf_keeps_mime_and_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            attachment = Path(directory) / "example.pdf"
            attachment.write_bytes(b"%PDF-1.7\nsynthetic\x00\xff")
            self.send(["--attach", str(attachment)])
        message = email.message_from_bytes(self.smtp.sendmail.call_args.args[2], policy=MODULE.default)
        part = list(message.iter_attachments())[0]
        self.assertEqual(part.get_content_type(), "application/pdf")
        self.assertEqual(part.get_payload(decode=True), b"%PDF-1.7\nsynthetic\x00\xff")

    def test_data_rejection_preserves_codes_and_safe_reason(self):
        result = self.failure(MODULE.smtplib.SMTPDataError(
            550, b"5.6.0 malformed MIME private@example.com https://example.com/?token=synthetic-secret"))
        self.assertEqual(result["smtp"]["outcome"], "rejected")
        self.assertEqual(result["smtp"]["stage"], "data")
        self.assertEqual(result["smtp"]["smtpCode"], 550)
        self.assertEqual(result["smtp"]["enhancedStatusCode"], "5.6.0")
        self.assertEqual(result["smtp"]["reasonCode"], "message_format")
        self.assertFalse(result["smtp"]["temporary"])
        for value in ("private@example.com", "example.com/?", "synthetic-secret", "malformed MIME"):
            self.assertNotIn(value, json.dumps(result))

    def test_temporary_data_rejection_does_not_authorize_retry(self):
        result = self.failure(MODULE.smtplib.SMTPDataError(451, b"4.7.1 rate limit"))
        self.assertTrue(result["smtp"]["temporary"])
        self.assertEqual(result["smtp"]["outcome"], "rejected")
        self.assertEqual(result["smtp"]["reasonCode"], "rate_limit")

    def test_disconnect_is_unknown_and_raw_error_is_not_returned(self):
        result = self.failure(MODULE.smtplib.SMTPServerDisconnected("synthetic-private-data"))
        self.assertEqual(result["smtp"]["outcome"], "unknown")
        self.assertEqual(result["smtp"]["stage"], "send")
        self.assertIsNone(result["smtp"]["smtpCode"])
        self.assertNotIn("synthetic-private-data", json.dumps(result))

    def test_failed_quit_cannot_replace_data_rejection(self):
        self.smtp.__exit__.side_effect = MODULE.smtplib.SMTPResponseException(421, b"private cleanup")
        result = self.failure(MODULE.smtplib.SMTPDataError(554, b"5.7.1 spam"))
        self.assertEqual(result["smtp"]["smtpCode"], 554)
        self.assertEqual(result["smtp"]["reasonCode"], "spam_policy")
        self.assertEqual(result["smtp"]["stage"], "data")

    def test_refused_sender_and_all_recipients_are_distinct(self):
        for error, stage in (
            (MODULE.smtplib.SMTPSenderRefused(550, b"5.1.0 no sender", "private@example.com"), "mail_from"),
            (MODULE.smtplib.SMTPRecipientsRefused({"private@example.com": (550, b"private reason")}), "rcpt_to"),
        ):
            with self.subTest(stage=stage):
                self.smtp.sendmail.reset_mock()
                result = self.failure(error)
                self.assertEqual(result["smtp"]["stage"], stage)
                self.assertEqual(result["smtp"]["outcome"], "rejected")
                self.assertNotIn("private", json.dumps(result))

    def test_preflight_failure_does_not_claim_ambiguous_send(self):
        with self.assertRaises(MODULE.SmtpFailure) as caught:
            self.send(["--cc", "почта@example.com"])
        self.smtp.sendmail.assert_not_called()
        self.assertEqual(caught.exception.details["outcome"], "not_attempted")
        self.assertEqual(caught.exception.details["stage"], "preflight")

    def test_unknown_or_malformed_replies_are_bounded_and_omitted(self):
        for raw, enhanced in ((b"5.7.1 " + b"secret-" * 10000, "5.7.1"),
                              (b"secret 5.7.1", None), (b"4.7.1 wrong class", None),
                              (b"5.7.1suffix", None), (b"\xff\x00\r\nprivate", None)):
            with self.subTest(enhanced=enhanced):
                result = MODULE.error_payload(MODULE.smtp_failure(MODULE.smtplib.SMTPDataError(550, raw), stage="send"))
                self.assertEqual(result["smtp"]["enhancedStatusCode"], enhanced)
                self.assertLess(len(json.dumps(result)), 1000)
                self.assertNotIn("secret", json.dumps(result))
                self.assertNotIn("private", json.dumps(result))

    def test_cli_failure_retains_structured_protocol_evidence(self):
        self.smtp.sendmail.side_effect = MODULE.smtplib.SMTPDataError(552, b"5.3.4 message too large")
        stderr = io.StringIO()
        with mock.patch.object(MODULE.sys, "argv", ["trelio-email", "send", "--account", "work", "--to", "a@example.com",
                                                   "--subject", "test", "--body", "test", "--confirm"]), contextlib.redirect_stderr(stderr):
            code = MODULE.main(_owned=True)
        self.assertEqual(code, 2)
        result = json.loads(stderr.getvalue())
        self.assertEqual(result["smtp"]["smtpCode"], 552)
        self.assertEqual(result["smtp"]["reasonCode"], "message_size_limit")

    def test_real_smtplib_data_reply_survives_protocol_and_cleanup(self):
        # Exercise the stdlib DATA/QUIT parser, not a fabricated exception.
        # The socket only captures bytes; the server transcript is in memory.
        client = MODULE.smtplib.SMTP(local_hostname="synthetic.local")
        client.sock = mock.Mock()
        client.file = io.BytesIO(
            b"250-synthetic\r\n250 SIZE 50000\r\n250 sender ok\r\n250 recipient ok\r\n"
            b"354 send data\r\n550 5.6.0 malformed MIME\r\n250 reset ok\r\n221 goodbye\r\n"
        )
        with mock.patch.object(MODULE, "smtp_connection", return_value=client):
            with self.assertRaises(MODULE.SmtpFailure) as caught:
                self.send()
        details = caught.exception.details
        self.assertEqual((details["stage"], details["outcome"], details["smtpCode"]), ("data", "rejected", 550))
        self.assertEqual(details["enhancedStatusCode"], "5.6.0")
        self.saved.assert_not_called()

    def test_partial_acceptance_retains_refusal_codes_without_reply_text(self):
        self.smtp.sendmail.return_value = {"copy@example.com": (450, b"4.2.2 mailbox full synthetic-secret")}
        result = self.send(["--cc", "copy@example.com"])
        self.assertEqual(result["smtpStatus"], "partially_accepted")
        self.assertEqual(result["recipientResponses"]["responses"][0]["smtpCode"], 450)
        self.assertEqual(result["recipientResponses"]["responses"][0]["reasonCode"], "mailbox_quota")
        self.assertNotIn("synthetic-secret", json.dumps(result))
        self.saved.assert_called_once()


if __name__ == "__main__":
    unittest.main()
