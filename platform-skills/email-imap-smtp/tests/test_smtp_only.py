"""Explicit forward-only senders never open IMAP or create a fallback archive.

Exercise the real loopback form, TOML round-trip, CLI admission and SMTP dispatch
with synthetic accounts; no user's credentials, mailbox or network is accessed.
"""

import contextlib
import io
import json
import smtplib
import unittest
from unittest import mock

import test_browser_configure as browser

MODULE = browser.MODULE
REAL_IMAP_CONNECTION = MODULE.imap_connection


class SmtpOnlyTests(unittest.TestCase):
    setUp = browser.BrowserConfigureTests.setUp
    configure = browser.BrowserConfigureTests.configure

    def configure_sender(self):
        def opened(url):
            status, page, _ = browser.request(url)
            self.assertEqual(status, 200)
            self.assertIn('value="smtp_only" selected', page)
            values = {key: value for key, value in browser.VALUES.items() if not key.startswith("imap_")}
            values["connection_mode"] = "smtp_only"
            self.assertEqual(browser.request(url, values)[0], 200)
        result = self.configure(opened, "--smtp-only")
        self.assertEqual(result["connectionMode"], "smtp_only")
        return MODULE.load_account("work")

    def test_loopback_setup_persists_mode_without_imap_and_keeps_other_mailbox(self):
        other = {**browser.VALUES, "credential_store": "file"}
        other.pop("password")
        MODULE.write_raw_config({"accounts": {"personal": other}})
        previous = MODULE.load_raw_config()["accounts"]["personal"]
        account = self.configure_sender()
        self.assertEqual(account.imap_host, "")
        self.assertEqual(account.connection_mode, "smtp_only")
        self.assertEqual(MODULE.load_raw_config()["accounts"]["personal"], previous)
        self.assertEqual(MODULE.load_account("personal").connection_mode, "imap_smtp")
        self.assertNotIn(browser.VALUES["password"], MODULE.CONFIG_PATH.read_text(encoding="utf-8"))
        # Reproduce an actual pre-feature TOML, rather than only testing a new
        # writer's explicit default. Reading must not migrate/reset the account.
        raw = MODULE.CONFIG_PATH.read_text(encoding="utf-8")
        MODULE.CONFIG_PATH.write_text(raw.replace('connection_mode = "imap_smtp"\n', ''), encoding="utf-8")
        self.assertEqual(MODULE.load_account("personal").connection_mode, "imap_smtp")

    def test_reconnect_keeps_mode_and_switch_to_full_requires_imap(self):
        self.configure_sender()
        def opened(url):
            self.assertIn('value="smtp_only" selected', browser.request(url)[1])
            fields = {key: value for key, value in browser.VALUES.items() if not key.startswith("imap_")}
            # A stale caller omitting the additive mode must preserve the saved
            # choice, while an explicit switch validates the full mailbox.
            self.assertEqual(browser.request(url, {**fields, "connection_mode": "imap_smtp"})[0], 400)
            self.assertEqual(browser.request(url, fields)[0], 200)
        self.assertEqual(self.configure(opened)["connectionMode"], "smtp_only")
        self.assertEqual(MODULE.load_account("work").imap_host, "")

    def test_legacy_mode_is_full_mailbox_and_invalid_mode_never_downgrades(self):
        values = {**browser.VALUES, "connection_mode": "smtp_only", "imap_host": "imap.stale.example"}
        candidate = MODULE.configure_account("work", values)
        self.assertEqual(candidate.imap_host, "")
        for mode in ("", "smtp", "SMTP_ONLY", False, None):
            with self.subTest(mode=mode), self.assertRaisesRegex(MODULE.MailboxError, "invalid_email_connection_mode"):
                MODULE.configure_account("work", {**values, "connection_mode": mode})
        with self.assertRaises(MODULE.MailboxError):
            MODULE.configure_account("work", {**browser.VALUES, "imap_host": ""})

    def test_doctor_only_probes_smtp_and_does_not_claim_message_acceptance(self):
        self.configure_sender()
        smtp = mock.MagicMock()
        smtp.__enter__.return_value = smtp
        smtp.noop.return_value = (250, b"synthetic")
        with mock.patch.object(MODULE, "smtp_connection", return_value=smtp):
            result = MODULE.command_doctor(MODULE.build_parser().parse_args(["doctor", "--account", "work"]))
        self.assertIsNone(result["imap"])
        self.assertEqual(result["imapStatus"], "disabled")
        self.assertTrue(result["smtp"])
        self.assertFalse(result["messageAcceptanceChecked"])
        smtp.noop.assert_called_once()

    def test_all_imap_commands_fail_before_native_unlock_or_network(self):
        self.configure_sender()
        tails = {"folders": [], "search": [], "read": ["--uid", "1"],
                 "save-message": ["--uid", "1", "--output", "unused"], "attachments": ["--uid", "1"],
                 "save-attachment": ["--uid", "1", "--index", "1", "--output", "unused"],
                 "reply": ["--uid", "1", "--body", "synthetic"]}
        with mock.patch.object(MODULE, "native_runtime", side_effect=AssertionError("Unexpected vault access")):
            for command, tail in tails.items():
                with self.subTest(command=command), mock.patch.object(MODULE.sys, "argv", ["email", command, "--account", "work", *tail]):
                    error = io.StringIO()
                    with contextlib.redirect_stderr(error):
                        self.assertEqual(MODULE.main(), 2)
                    self.assertIn("imap_unavailable_smtp_only", json.loads(error.getvalue())["error"])
        # The internal entrypoint is fenced too, independently of CLI parsing.
        with self.assertRaisesRegex(MODULE.MailboxError, "imap_unavailable_smtp_only"):
            REAL_IMAP_CONNECTION(MODULE.load_account("work"))

    def test_send_keeps_confirmation_read_only_signature_and_no_sent_archive(self):
        self.configure_sender()
        smtp = mock.MagicMock()
        smtp.__enter__.return_value = smtp
        smtp.__exit__.return_value = False
        smtp.sendmail.return_value = {}
        argv = ["send", "--account", "work", "--to", "recipient@example.com", "--subject", "synthetic", "--body", "Text"]
        with mock.patch.object(MODULE, "smtp_connection", return_value=smtp):
            with self.assertRaisesRegex(MODULE.MailboxError, "requires --confirm"):
                MODULE.command_send(MODULE.build_parser().parse_args(argv))
            MODULE.write_email_policy("work", "read-only")
            with self.assertRaisesRegex(MODULE.MailboxError, "read-only"):
                MODULE.command_send(MODULE.build_parser().parse_args([*argv, "--confirm"]))
            smtp.sendmail.assert_not_called()
            MODULE.write_email_policy("work", "confirm")
            result = MODULE.command_send(MODULE.build_parser().parse_args([*argv, "--confirm"]))
        smtp.sendmail.assert_called_once()
        self.assertTrue(result["sent"])
        self.assertEqual(result["smtpStatus"], "accepted")
        self.assertEqual(result["sentCopy"], {"saved": False, "verified": False, "status": "disabled",
                         "reasonCode": "smtp_only_account", "folder": None, "uid": None, "appendAttempted": False})
        data = MODULE.load_raw_config()
        data["accounts"]["work"]["signature"] = "Synthetic closing"
        MODULE.write_raw_config(data)
        with self.assertRaisesRegex(MODULE.MailboxError, "signature_review_required"):
            MODULE.command_send(MODULE.build_parser().parse_args([*argv, "--confirm"]))

    def test_unknown_smtp_result_never_retries_or_attempts_imap(self):
        account = self.configure_sender()
        smtp = mock.MagicMock()
        smtp.__enter__.return_value = smtp
        smtp.__exit__.return_value = False
        smtp.sendmail.side_effect = smtplib.SMTPServerDisconnected("synthetic private reply")
        with mock.patch.object(MODULE, "smtp_connection", return_value=smtp), self.assertRaises(MODULE.SmtpFailure) as raised:
            MODULE.send_message(account, ["recipient@example.com"], [], [], "synthetic", "body", [])
        smtp.sendmail.assert_called_once()
        self.assertEqual(raised.exception.details["outcome"], "unknown")
        self.assertFalse(raised.exception.details["automaticRetryAllowed"])
        self.assertNotIn("synthetic private reply", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
