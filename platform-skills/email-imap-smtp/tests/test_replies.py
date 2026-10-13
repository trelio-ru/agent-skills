"""Reply review/dispatch invariants using synthetic mail and no real servers."""

import contextlib
import email
import hashlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_imap_protocol import ScriptedImap
from test_trelio_email import MODULE


SOURCE = (
    b'From: "Author, One" <author@example.com>\r\n'
    b'To: person@example.com, other@example.com\r\n'
    b'Cc: other@EXAMPLE.COM, copy@example.com\r\n'
    b'Bcc: private@example.com\r\n'
    b'Subject: Re: Re: Invoice\r\n'
    b'Message-ID: <parent@example.com>\r\n'
    b'References: <root@example.com> (old thread) <older@example.com>\r\n'
    b'\r\nOriginal private text\r\n'
)


class ReplyTests(unittest.TestCase):
    def setUp(self):
        self.account = MODULE.Account(name="work", email_address="person@example.com", display_name="Sender",
            username="person@example.com", imap_host="imap.example.com", imap_port=993,
            smtp_host="smtp.example.com", smtp_port=465, smtp_security="ssl", credential_store="file")
        self.imap = mock.MagicMock()
        self.imap.__enter__.return_value = self.imap
        self.imap.select.return_value = ("OK", [b"1"])
        self.imap.response.return_value = ("UIDVALIDITY", [b"123"])
        self.raw = SOURCE
        self.smtp = mock.MagicMock()
        self.smtp.__enter__.return_value = self.smtp
        self.smtp.sendmail.return_value = {}
        self.stack = contextlib.ExitStack()
        self.original_fetch = MODULE.fetch_raw_message
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.dict(os.environ, {}, clear=True))
        for name, value in (("load_account", self.account), ("load_email_policy", {"sendMode": "confirm"}),
                            ("imap_connection", self.imap), ("smtp_connection", self.smtp),
                            ("make_msgid", "<new@example.com>"), ("save_sent_copy", {"verified": True})):
            self.stack.enter_context(mock.patch.object(MODULE, name, return_value=value))
        self.stack.enter_context(mock.patch.object(MODULE, "fetch_raw_message", side_effect=lambda *_: self.raw))

    def arguments(self, *extra):
        return MODULE.build_parser().parse_args([
            "reply", "--account", "work", "--folder", "INBOX", "--uid", "42", "--body", "Ответ", *extra])

    def preview(self, *extra):
        return MODULE.command_reply(self.arguments(*extra))

    def send(self, preview, *extra):
        return MODULE.command_reply(self.arguments(*extra, "--confirm", "--expected-plan-sha256", preview["planSha256"]))

    def test_preview_is_complete_but_does_not_send_or_quote_source_body(self):
        result = self.preview()
        self.assertTrue(result["prepared"])
        self.assertFalse(result["sent"])
        self.assertEqual(result["plan"]["to"], ["author@example.com"])
        self.assertEqual(result["plan"]["cc"], [])
        self.assertEqual(result["plan"]["body"], "Ответ")
        self.assertEqual(result["plan"]["subject"], "Re: Invoice")
        self.assertNotIn("Original private text", json.dumps(result))
        self.assertNotIn("private@example.com", json.dumps(result))
        self.smtp.sendmail.assert_not_called()
        MODULE.save_sent_copy.assert_not_called()

    def test_signature_is_in_preview_and_mime_once_and_changes_invalidate_review(self):
        self.account = MODULE.replace(self.account, signature="С уважением,\nТестовый отправитель")
        MODULE.load_account.return_value = self.account
        preview = self.preview()
        self.assertEqual(preview["plan"]["body"], "Ответ\n\n" + self.account.signature)
        self.send(preview)
        message = email.message_from_bytes(self.smtp.sendmail.call_args.args[2], policy=MODULE.default)
        self.assertEqual(message.get_content().replace("\r\n", "\n"), preview["plan"]["body"] + "\n")
        self.smtp.sendmail.reset_mock()
        for signature in ("Новая подпись", ""):
            MODULE.load_account.return_value = MODULE.replace(self.account, signature=signature)
            with self.assertRaisesRegex(MODULE.MailboxError, "reply_preview_changed"):
                self.send(preview)
        self.smtp.sendmail.assert_not_called()

    def test_signature_opt_out_is_reviewed_and_does_not_remove_existing_user_text(self):
        self.account = MODULE.replace(self.account, signature="С уважением,\nТестовый отправитель")
        MODULE.load_account.return_value = self.account
        preview = self.preview("--no-signature")
        self.assertEqual(preview["plan"]["body"], "Ответ")
        with self.assertRaisesRegex(MODULE.MailboxError, "reply_preview_changed"):
            self.send(preview)
        self.send(preview, "--no-signature")
        self.assertEqual(email.message_from_bytes(self.smtp.sendmail.call_args.args[2], policy=MODULE.default).get_content().strip(), "Ответ")

    def test_reply_all_deduplicates_domains_and_excludes_sender_and_bcc(self):
        result = self.preview("--reply-all")
        self.assertEqual(result["plan"]["to"], ["author@example.com"])
        self.assertEqual(result["plan"]["cc"], ["other@example.com", "copy@example.com"])

    def test_reply_to_is_used_instead_of_from(self):
        self.raw = b'Reply-To: "Reply, Team" <team@example.com>\r\n' + SOURCE
        self.assertEqual(self.preview()["plan"]["to"], ["team@example.com"])

    def test_follow_up_to_own_sent_message_uses_original_recipients(self):
        self.raw = SOURCE.replace(b'"Author, One" <author@example.com>', b'person@example.com')
        preview = self.preview("--reply-all")
        self.assertEqual(preview["plan"]["to"], ["other@example.com"])
        self.assertEqual(preview["plan"]["cc"], ["copy@example.com"])

    def test_local_part_case_and_aliases_are_not_guessed(self):
        self.raw = SOURCE.replace(b'copy@example.com', b'Other@example.com, person+alias@example.com')
        self.assertEqual(self.preview("--reply-all")["plan"]["cc"],
                         ["other@example.com", "Other@example.com", "person+alias@example.com"])

    def test_confirmed_send_contains_new_identity_parent_and_exact_reviewed_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            attachment = Path(directory) / "source.eml"
            attachment.write_bytes(b"Subject: exact\r\n\r\nbytes\r\n")
            extra = ["--reply-all", "--attach", str(attachment)]
            preview = self.preview(*extra)
            result = self.send(preview, *extra)
            wire = self.smtp.sendmail.call_args.args[2]
            sent = email.message_from_bytes(wire, policy=MODULE.default)
            self.assertEqual(sent["Message-ID"], "<new@example.com>")
            self.assertEqual(sent["In-Reply-To"], "<parent@example.com>")
            self.assertEqual(sent["References"], "<root@example.com> <older@example.com> <parent@example.com>")
            self.assertEqual(sent["Subject"], "Re: Invoice")
            self.assertIsNone(sent["Bcc"])
            part = list(sent.iter_attachments())[0]
            self.assertEqual(part.get_content_type(), "application/octet-stream")
            self.assertEqual(part.get_payload(decode=True), attachment.read_bytes())
            self.assertEqual(MODULE.save_sent_copy.call_args.args[1], wire)
            self.assertEqual(result["replyToMessageId"], "<parent@example.com>")
            self.smtp.sendmail.assert_called_once()

    def test_first_reply_and_single_in_reply_to_fallback(self):
        self.raw = SOURCE.replace(b'References: <root@example.com> (old thread) <older@example.com>\r\n', b'')
        self.assertEqual(self.preview()["plan"]["headers"]["References"], "<parent@example.com>")
        self.raw = b'In-Reply-To: <root@example.com>\r\n' + self.raw
        self.assertEqual(self.preview()["plan"]["headers"]["References"], "<root@example.com> <parent@example.com>")

    def test_reference_order_duplicates_and_folded_comments(self):
        self.raw = SOURCE.replace(b'<root@example.com> (old thread) <older@example.com>',
                                 b'<root@example.com> (old (nested))\r\n\t<root@example.com> <parent@example.com>')
        self.assertEqual(self.preview()["plan"]["headers"]["References"], "<root@example.com> <parent@example.com>")

    def test_domain_literal_parentheses_are_identity_bytes_not_comments(self):
        self.raw = SOURCE.replace(b'<parent@example.com>', b'<parent@[a(b)c]>')
        result = self.preview()
        self.assertEqual(result["plan"]["headers"]["In-Reply-To"], "<parent@[a(b)c]>")
        self.assertTrue(result["plan"]["headers"]["References"].endswith("<parent@[a(b)c]>"))

    def test_invalid_sources_are_rejected_without_smtp_or_source_text_in_error(self):
        cases = [
            SOURCE.replace(b'Message-ID: <parent@example.com>\r\n', b''),
            SOURCE.replace(b'<parent@example.com>', b'private-invalid-id'),
            b'Message-ID: <second@example.com>\r\n' + SOURCE,
            SOURCE.replace(b'<parent@example.com>', b'<one@example.com> <two@example.com>'),
            SOURCE.replace(b' (old thread)', b' (unclosed-private-comment'),
            SOURCE.replace(b'Subject: Re: Re: Invoice', b'Subject: private\x00text'),
            b'Reply-To: broken-private-address\r\n' + SOURCE,
            b'Reply-To: \r\n' + SOURCE,
            SOURCE.replace(b'"Author, One" <author@example.com>', b''),
            b'From: another@example.com\r\n' + SOURCE,
        ]
        for source in cases:
            with self.subTest(source_hash=hashlib.sha256(source).hexdigest()):
                self.raw = source
                with self.assertRaises(MODULE.MailboxError) as caught:
                    self.preview()
                self.assertNotIn("private", str(caught.exception))
                self.smtp.sendmail.assert_not_called()

    def test_header_and_reference_limits(self):
        for references in (" ".join(f"<m{i}@example.com>" for i in range(101)), "x" * 16385):
            self.raw = SOURCE.replace(b'<root@example.com> (old thread) <older@example.com>', references.encode())
            with self.assertRaises(MODULE.MailboxError):
                self.preview()

    def test_missing_or_invalid_uidvalidity_blocks_reply(self):
        for validity in ([], [None], [b"0"], [b"private"], [b"1", b"2"]):
            self.imap.response.return_value = ("UIDVALIDITY", validity)
            with self.assertRaises(MODULE.MailboxError):
                self.preview()

    def test_confirmation_requires_exact_preview_before_any_mail_access(self):
        for extra in (["--confirm"], ["--confirm", "--expected-plan-sha256", "bad"],
                      ["--expected-plan-sha256", "a" * 64]):
            MODULE.imap_connection.reset_mock()
            with self.assertRaises(MODULE.MailboxError):
                self.preview(*extra)
            MODULE.imap_connection.assert_not_called()

    def test_source_changes_and_uid_reuse_in_another_validity_block_dispatch(self):
        preview = self.preview()
        self.raw += b"changed"
        with self.assertRaisesRegex(MODULE.MailboxError, "reply_preview_changed"):
            self.send(preview)
        self.raw = SOURCE
        self.imap.response.return_value = ("UIDVALIDITY", [b"124"])
        with self.assertRaisesRegex(MODULE.MailboxError, "reply_preview_changed"):
            self.send(preview)
        self.smtp.sendmail.assert_not_called()

    def test_body_attachment_and_account_changes_block_dispatch(self):
        preview = self.preview()
        args = self.arguments("--confirm", "--expected-plan-sha256", preview["planSha256"])
        args.body = "Changed body"
        with self.assertRaisesRegex(MODULE.MailboxError, "reply_preview_changed"):
            MODULE.command_reply(args)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "file.txt"
            path.write_bytes(b"old")
            preview = self.preview("--attach", str(path))
            path.write_bytes(b"new")
            with self.assertRaisesRegex(MODULE.MailboxError, "reply_preview_changed"):
                self.send(preview, "--attach", str(path))
        preview = self.preview()
        self.account = MODULE.replace(self.account, display_name="Different sender")
        MODULE.load_account.return_value = self.account
        with self.assertRaisesRegex(MODULE.MailboxError, "reply_preview_changed"):
            self.send(preview)
        self.smtp.sendmail.assert_not_called()

    def test_company_binding_change_blocks_dispatch(self):
        binding = {"id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "providerRef": "work", "companyBinding": "a" * 64}
        os.environ["TRELIO_SKILL_ACCOUNT_JSON"] = json.dumps(binding)
        preview = self.preview()
        binding["companyBinding"] = "b" * 64
        os.environ["TRELIO_SKILL_ACCOUNT_JSON"] = json.dumps(binding)
        with self.assertRaisesRegex(MODULE.MailboxError, "reply_preview_changed"):
            self.send(preview)
        self.smtp.sendmail.assert_not_called()

    def test_read_only_allows_preview_but_blocks_confirmation_and_new_policy(self):
        preview = self.preview()
        MODULE.load_email_policy.return_value = {"sendMode": "read-only"}
        self.assertTrue(self.preview()["prepared"])
        with self.assertRaises(MODULE.MailboxError):
            self.send(preview)
        MODULE.load_email_policy.side_effect = [{"sendMode": "confirm"}, {"sendMode": "read-only"}]
        with self.assertRaises(MODULE.MailboxError):
            self.send(preview)
        self.smtp.sendmail.assert_not_called()

    def test_body_file_and_no_implicit_recipient_overrides(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reply.txt"
            path.write_text("From file", encoding="utf-8")
            args = MODULE.build_parser().parse_args(["reply", "--account", "work", "--uid", "42", "--body-file", str(path)])
            self.assertEqual(MODULE.command_reply(args)["plan"]["body"], "From file")
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.arguments("--to", "unapproved@example.com")

    def test_ambiguous_smtp_does_not_retry_or_save_false_sent_copy(self):
        preview = self.preview()
        self.smtp.sendmail.side_effect = MODULE.smtplib.SMTPServerDisconnected("private provider text")
        with self.assertRaises(MODULE.SmtpFailure) as caught:
            self.send(preview)
        self.assertEqual(caught.exception.details["outcome"], "unknown")
        self.assertFalse(caught.exception.details["automaticRetryAllowed"])
        self.smtp.sendmail.assert_called_once()
        MODULE.save_sent_copy.assert_not_called()

    def test_imap_transcript_preserves_read_state_and_uses_exact_uidvalidity(self):
        # Use stdlib imaplib against a transcript, not a mocked select/fetch:
        # this catches UIDVALIDITY handling and PEEK command regressions.
        transcript = (b'* 1 EXISTS\r\n* OK [UIDVALIDITY 999] stable\r\nTEST1 OK examined\r\n'
                      b'* 1 FETCH (UID 42 BODY[] {' + str(len(SOURCE)).encode() + b'}\r\n' + SOURCE +
                      b')\r\nTEST2 OK fetched\r\n')
        client = ScriptedImap(transcript)
        MODULE.imap_connection.return_value = contextlib.nullcontext(client)
        with mock.patch.object(MODULE, "fetch_raw_message", wraps=self.original_fetch):
            result = self.preview()
        self.assertEqual(result["plan"]["source"]["uidValidity"], "999")
        self.assertEqual(result["plan"]["source"]["sha256"], hashlib.sha256(SOURCE).hexdigest())
        self.assertIn(b'EXAMINE "INBOX"', b"".join(client.sent))
        self.assertIn(b'UID FETCH 42 (BODY.PEEK[])', b"".join(client.sent))
        self.assertNotIn(b'STORE', b"".join(client.sent))


if __name__ == "__main__":
    unittest.main()
