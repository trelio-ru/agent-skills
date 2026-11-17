"""Exercise provider-independent SMTP recovery through the real CLI and SMTP connection code."""

import errno
import smtplib
import ssl
import subprocess
import sys
import unittest
from unittest import mock

import test_browser_configure as browser

MODULE = browser.MODULE
REAL_SMTP_CONNECTION = MODULE.smtp_connection


class SmtpRecoveryTests(unittest.TestCase):
    def configure_pair(self, port=465, security="ssl", host="smtp.company.example", mode="imap_smtp"):
        fields = {**browser.VALUES, "smtp_host": host, "smtp_port": port,
                  "smtp_security": security, "connection_mode": mode}
        fields.pop("password")
        fields["credential_store"] = "keychain"
        MODULE.write_raw_config({"accounts": {"work": fields, "second": dict(fields)}})

    def check_mailbox(self, *arguments):
        args = MODULE.build_parser().parse_args([*(arguments or ["doctor"]), "--account", "work"])
        return args.handler(args)

    def setUp(self):
        browser.BrowserConfigureTests.setUp(self)
        self.imap = mock.MagicMock()
        self.imap.__enter__.return_value = self.imap
        self.imap.noop.return_value = ("OK", [])
        self.smtp = mock.MagicMock()
        self.smtp.__enter__.return_value = self.smtp
        self.smtp.noop.return_value = (250, b"OK")
        self.imap_connection = self.enterContext(mock.patch.object(MODULE, "imap_connection", return_value=self.imap))
        self.enterContext(mock.patch.object(MODULE, "load_password", return_value="synthetic"))
        self.enterContext(mock.patch.object(MODULE, "smtp_connection", REAL_SMTP_CONNECTION))
        self.enterContext(mock.patch.object(MODULE, "require_credential_lease"))
        self.ssl_smtp = self.enterContext(mock.patch.object(MODULE.smtplib, "SMTP_SSL", return_value=self.smtp))
        self.starttls_smtp = self.enterContext(mock.patch.object(MODULE.smtplib, "SMTP", return_value=self.smtp))

    def test_transport_failure_saves_verified_standard_pair_without_sending(self):
        self.configure_pair()
        before = MODULE.load_raw_config()
        self.ssl_smtp.side_effect = ConnectionRefusedError(errno.ECONNREFUSED, "synthetic")
        result = self.check_mailbox("configure", "--repair-smtp")

        self.assertEqual(result["smtpRepaired"], {"port": 587, "security": "starttls"})
        self.assertEqual((result["imap"], result["smtp"], result["messageAcceptanceChecked"]), (True, True, False))
        self.assertEqual(self.ssl_smtp.call_args.args, ("smtp.company.example", 465))
        self.assertEqual(self.starttls_smtp.call_args.args, ("smtp.company.example", 587))
        self.imap_connection.assert_called_once()
        self.smtp.starttls.assert_called_once()
        self.smtp.login.assert_called_once()
        self.smtp.assert_has_calls([
            mock.call.starttls(context=mock.ANY), mock.call.ehlo(),
            mock.call.login(MODULE.load_account("work").username, "synthetic"),
            mock.call.__enter__(), mock.call.noop(),
        ])
        self.smtp.sendmail.assert_not_called()
        before["accounts"]["work"].update(smtp_port=587, smtp_security="starttls")
        self.assertEqual(MODULE.load_raw_config(), before)
        self.assertTrue(self.check_mailbox()["smtp"])
        self.ssl_smtp.assert_called_once()
        self.assertEqual(self.starttls_smtp.call_count, 2)

    def test_unsupported_starttls_repairs_smtp_only_without_imap(self):
        self.configure_pair(587, "starttls", host="smtp.yandex.ru", mode="smtp_only")
        failed_tls = mock.Mock()
        failed_tls.starttls.side_effect = smtplib.SMTPNotSupportedError("synthetic")
        self.starttls_smtp.return_value = failed_tls
        result = self.check_mailbox("configure", "--repair-smtp")
        self.assertEqual(result["smtpRepaired"], {"port": 465, "security": "ssl"})
        self.assertEqual(self.ssl_smtp.call_args.args, ("smtp.yandex.ru", 465))
        self.assertEqual(result["imapStatus"], "disabled")
        self.imap_connection.assert_not_called()
        failed_tls.close.assert_called_once()
        failed_tls.login.assert_not_called()

    def test_mismatched_standard_pair_repairs_mode_on_same_port(self):
        self.configure_pair(465, "starttls", host="smtp.gmail.com")
        self.starttls_smtp.side_effect = TimeoutError()
        result = self.check_mailbox("configure", "--repair-smtp")
        self.assertEqual(result["smtpRepaired"], {"port": 465, "security": "ssl"})
        self.assertEqual(self.ssl_smtp.call_args.args, ("smtp.gmail.com", 465))

    def test_regular_diagnostics_and_nonstandard_endpoint_never_try_alternative(self):
        self.ssl_smtp.side_effect = TimeoutError()
        for host, port, arguments in [("smtp.gmail.com", 465, ("doctor",)),
                                      ("smtp.company.example", 2525, ("configure", "--repair-smtp"))]:
            with self.subTest(host=host, port=port, arguments=arguments):
                self.configure_pair(port=port, host=host)
                with self.assertRaises(MODULE.SmtpFailure):
                    self.check_mailbox(*arguments)
                self.starttls_smtp.assert_not_called()
                self.assertEqual(MODULE.load_account("work").smtp_port, port)

    def test_refused_login_and_certificate_errors_do_not_trigger_repair(self):
        self.configure_pair()
        self.ssl_smtp.side_effect = ssl.SSLCertVerificationError("synthetic private cert")
        with self.assertRaises(MODULE.SmtpFailure) as cert_error:
            self.check_mailbox("configure", "--repair-smtp")
        self.assertEqual(cert_error.exception.details["reasonCode"], "certificate_verification_failed")
        self.assertNotIn("synthetic private cert", str(cert_error.exception))
        self.ssl_smtp.side_effect = None
        self.smtp.login.side_effect = smtplib.SMTPAuthenticationError(535, b"synthetic private auth")
        with self.assertRaises(MODULE.SmtpFailure) as auth_error:
            self.check_mailbox("configure", "--repair-smtp")
        self.assertEqual(auth_error.exception.details["stage"], "authentication")
        self.assertNotIn("synthetic private auth", str(auth_error.exception))
        self.starttls_smtp.assert_not_called()

    def test_alternative_has_to_authenticate_and_pass_noop_before_persisting(self):
        self.configure_pair()
        before = MODULE.CONFIG_PATH.read_bytes()
        self.ssl_smtp.side_effect = TimeoutError()
        self.smtp.noop.return_value = (451, b"synthetic")
        with self.assertRaisesRegex(MODULE.MailboxError, "email_smtp_repair_noop_failed"):
            self.check_mailbox("configure", "--repair-smtp")
        self.assertEqual(MODULE.CONFIG_PATH.read_bytes(), before)
        self.starttls_smtp.assert_called_once()

    def test_no_repair_when_imap_failed_or_selected_mailbox_changed(self):
        self.configure_pair()
        self.imap.noop.return_value = ("NO", [])
        self.ssl_smtp.side_effect = TimeoutError()
        with self.assertRaises(MODULE.SmtpFailure):
            self.check_mailbox("configure", "--repair-smtp")
        self.imap.noop.return_value = ("OK", [])

        def concurrently_configured(*_args, **_kwargs):
            self.configure_pair(2525, "ssl")
            raise TimeoutError()

        self.ssl_smtp.side_effect = concurrently_configured
        with self.assertRaisesRegex(MODULE.MailboxError, "email_config_changed"):
            self.check_mailbox("configure", "--repair-smtp")
        self.starttls_smtp.assert_not_called()
        self.assertEqual(MODULE.load_account("work").smtp_port, 2525)

    def test_repair_rejects_new_setup_options_and_uses_no_browser(self):
        self.configure_pair()
        for option in ("--terminal-prompts", "--from-agent-secret", "--smtp-only", "--smtp-port=587"):
            with self.subTest(option=option):
                with self.assertRaisesRegex(MODULE.MailboxError, "email_smtp_repair_requires_saved_configuration"):
                    self.check_mailbox("configure", "--repair-smtp", option)
        self.ssl_smtp.assert_not_called()
        self.starttls_smtp.assert_not_called()
        MODULE.open_browser_url.assert_not_called()

    def test_other_process_cannot_rewrite_signature_while_repair_holds_config_lock(self):
        self.configure_pair()
        argv = [sys.executable, "-I", "-c", """
import pathlib
import runpy
import sys

namespace = runpy.run_path(sys.argv[1])
main = namespace["main"]
main.__globals__["CONFIG_DIR"] = pathlib.Path(sys.argv[2])
main.__globals__["CONFIG_PATH"] = pathlib.Path(sys.argv[2]) / "accounts.toml"
sys.argv = [sys.argv[1], "signature", "set", "--account", "work", "--text", "Synthetic"]
raise SystemExit(main(_owned=True))
""", MODULE.__file__, str(MODULE.CONFIG_DIR)]
        with MODULE.account_config_lock():
            blocked = subprocess.run(argv, capture_output=True, text=True, timeout=10, check=False)
            self.assertEqual(blocked.returncode, 2, blocked.stderr)
            self.assertIn("email_config_lock_unavailable", blocked.stderr)
        saved = subprocess.run(argv, capture_output=True, text=True, timeout=10, check=False)
        self.assertEqual(saved.returncode, 0, saved.stderr)
        self.assertEqual(MODULE.load_account("work").signature, "Synthetic")
