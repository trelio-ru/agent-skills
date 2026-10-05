"""Synthetic credential regressions; never read or modify the user's Keychain."""

import os
import pathlib
import tempfile
import unittest
from unittest import mock

from test_trelio_email import MODULE


class CredentialTests(unittest.TestCase):
    def setUp(self):
        lease = mock.patch.object(MODULE, "require_credential_lease")
        self.permit = lease.start()
        self.addCleanup(lease.stop)

    def account(self):
        return MODULE.Account("work", "a@example.com", "", "a@example.com", "imap.example.com", 993,
                              "smtp.example.com", 465, "ssl", "file")

    def test_keychain_add_and_update_keep_secret_out_of_subprocess(self):
        for exists in (False, True):
            with self.subTest(exists=exists):
                security, core = mock.Mock(), mock.Mock()
                captured = []

                def set_item(reference):
                    MODULE.ctypes.cast(reference, MODULE.ctypes.POINTER(MODULE.ctypes.c_void_p))[0] = 123

                def find(*args):
                    self.assertEqual(args[1:5], (17, b"trelio-email:work", 13, b"a@example.com"))
                    self.assertEqual(args[5:7], (None, None))
                    if exists:
                        set_item(args[7])
                        return 0
                    return -25300

                def add(*args):
                    captured.append(MODULE.ctypes.string_at(args[6], args[5]))
                    set_item(args[7])
                    return 0

                def update(*args):
                    self.assertEqual(args[0].value, 123)
                    captured.append(MODULE.ctypes.string_at(args[3], args[2]))
                    return 0

                security.SecKeychainFindGenericPassword.side_effect = find
                security.SecKeychainAddGenericPassword.side_effect = add
                security.SecKeychainItemModifyAttributesAndData.side_effect = update
                with (
                    mock.patch.object(MODULE.sys, "platform", "darwin"),
                    mock.patch.object(MODULE.ctypes, "CDLL", side_effect=[security, core]),
                    mock.patch.object(MODULE.subprocess, "run") as run,
                ):
                    self.assertEqual(MODULE.store_password(self.account(), ' synthetic "pass"\n'), "keychain")
                self.assertEqual(captured, [b' synthetic "pass"\n'])
                run.assert_not_called()
                core.CFRelease.assert_called_once()
                self.assertEqual(security.SecKeychainAddGenericPassword.call_count, int(not exists))
                self.assertEqual(security.SecKeychainItemModifyAttributesAndData.call_count, int(exists))

    def test_keychain_failure_is_redacted_and_does_not_fall_back(self):
        security, core = mock.Mock(), mock.Mock()
        security.SecKeychainFindGenericPassword.return_value = -25293
        with (
            mock.patch.object(MODULE.sys, "platform", "darwin"),
            mock.patch.object(MODULE.ctypes, "CDLL", side_effect=[security, core]),
            mock.patch.object(MODULE.os, "open") as open_file,
            self.assertRaises(MODULE.MailboxError) as caught,
        ):
            MODULE.store_password(self.account(), "synthetic-secret-never-log")
        self.assertIn("-25293", str(caught.exception))
        self.assertNotIn("synthetic-secret", str(caught.exception))
        security.SecKeychainAddGenericPassword.assert_not_called()
        open_file.assert_not_called()

    def test_plaintext_and_environment_are_never_read_or_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            secret_path = pathlib.Path(directory) / "work.password"
            secret_path.write_bytes(b"legacy-synthetic-password")
            with (
                mock.patch.object(MODULE.sys, "platform", "linux"),
                mock.patch.object(MODULE, "SECRETS_DIR", pathlib.Path(directory)),
                mock.patch.dict(MODULE.os.environ, {"TRELIO_EMAIL_PASSWORD_WORK": "ambient-synthetic-password"}),
                mock.patch.object(pathlib.Path, "read_text", side_effect=AssertionError("must not read legacy secret")),
            ):
                with self.assertRaisesRegex(MODULE.MailboxError, "unsupported_os"):
                    MODULE.store_password(self.account(), "new synthetic password")
                with self.assertRaisesRegex(MODULE.MailboxError, "requires_explicit_configure"):
                    MODULE.load_password(self.account())
            self.assertEqual(secret_path.read_bytes(), b"legacy-synthetic-password")

    def test_no_credential_access_after_native_permit_failure(self):
        self.permit.side_effect = MODULE.MailboxError("native_email_session_required")
        with mock.patch.object(MODULE, "store_keychain_password") as store:
            with self.assertRaisesRegex(MODULE.MailboxError, "session_required"):
                MODULE.store_password(self.account(), "synthetic")
            store.assert_not_called()

    def test_windows_uses_process_only_encrypted_adapter(self):
        native = mock.Mock()
        native.NativeError = RuntimeError
        native.windows_password.return_value = b" password\n"
        account = MODULE.Account("work", "a@example.com", "", "a@example.com", "imap.example.com", 993,
                                 "smtp.example.com", 465, "ssl", "dpapi")
        with mock.patch.object(MODULE.sys, "platform", "win32"), mock.patch.object(MODULE, "native_runtime", return_value=native):
            self.assertEqual(MODULE.store_password(account, " password\n"), "dpapi")
            native.windows_password.assert_called_with(MODULE.CONFIG_DIR, "work", "a@example.com", b" password\n")
            self.assertEqual(MODULE.load_password(account), " password\n")
            native.windows_password.assert_called_with(MODULE.CONFIG_DIR, "work", "a@example.com")

    def test_authentication_errors_cannot_echo_password_into_output(self):
        synthetic = "synthetic-auth-secret"
        for protocol in ("imap", "smtp"):
            client = mock.Mock()
            client.login.side_effect = (MODULE.imaplib.IMAP4.error(synthetic) if protocol == "imap" else
                                       MODULE.smtplib.SMTPAuthenticationError(535, synthetic.encode()))
            factory = mock.patch.object(MODULE.imaplib, "IMAP4_SSL", return_value=client) if protocol == "imap" else \
                      mock.patch.object(MODULE.smtplib, "SMTP_SSL", return_value=client)
            with factory, mock.patch.object(MODULE, "load_password", return_value=synthetic):
                with self.assertRaises(MODULE.MailboxError) as caught:
                    (MODULE.imap_connection if protocol == "imap" else MODULE.smtp_connection)(self.account())
            self.assertNotIn(synthetic, str(caught.exception))
            self.assertIn("authentication", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
