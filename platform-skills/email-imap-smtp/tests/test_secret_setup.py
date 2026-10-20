"""One-use Agent Secret setup stays inside the native-owned OS-vault path."""

import contextlib
import io
import os
from pathlib import Path
import unittest
import uuid
from unittest import mock

import test_browser_configure as browser

MODULE = browser.MODULE
PASSWORD = " synthetic checkout password "
SETUP = ["configure", "--account", "work", "--smtp-only", "--from-agent-secret",
         "--email", "sender@example.com", "--display-name", "Synthetic support",
         "--smtp-host", "smtp.example.com", "--smtp-port", "587", "--smtp-security", "starttls"]


class SecretSetupTests(unittest.TestCase):
    setUp = browser.BrowserConfigureTests.setUp

    def checkout(self, value=PASSWORD.encode()):
        directory = MODULE.CONFIG_DIR / "checkout"
        directory.mkdir(mode=0o700, exist_ok=True)
        # Each delivery is a new bridge-owned file; Windows CreateNew must not
        # be weakened merely to reuse a fixture path across malformed inputs.
        location = directory / f"value-{uuid.uuid4().hex}"
        if MODULE.sys.platform == "win32":
            helper = MODULE.native_runtime()
            native = helper.native_helper(MODULE.CONFIG_DIR)
            helper.run_private(native, ["private-directory", str(directory)])
            helper.run_private(native, ["write-private", str(location)], value=value)
        else:
            location.write_bytes(value)
            location.chmod(0o600)
        return location

    def run_setup(self, location, argv=SETUP):
        args = MODULE.build_parser().parse_args(argv)
        with mock.patch.object(MODULE, "SETUP_SECRET_FILE", str(location)), \
             mock.patch.object(MODULE, "require_credential_lease") as permit:
            result = args.handler(args)
        permit.assert_called()
        return result

    def test_configures_vault_without_browser_and_preserves_exact_password(self):
        location = self.checkout()
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = self.run_setup(location)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(result["passwordInput"], "agent_secret_file")
        self.assertEqual(result["connectionMode"], "smtp_only")
        self.assertEqual(self.store.call_args.args[1], PASSWORD)
        account = MODULE.load_account("work")
        self.assertEqual((account.email_address, account.smtp_host, account.smtp_port),
                         ("sender@example.com", "smtp.example.com", 587))
        self.assertEqual(account.imap_host, "")
        self.assertNotIn(PASSWORD, MODULE.CONFIG_PATH.read_text(encoding="utf-8"))
        # The bridge owns cleanup of its file; the provider must not delete or
        # move an input it does not own, including after successful persistence.
        self.assertTrue(location.is_file())

    def test_permit_precedes_file_access_and_missing_checkout_is_closed(self):
        with mock.patch.object(MODULE, "SETUP_SECRET_FILE", None), \
             mock.patch.object(MODULE, "require_credential_lease", side_effect=MODULE.MailboxError("expired")), \
             mock.patch.object(Path, "open", side_effect=AssertionError("Unexpected file read")):
            with self.assertRaisesRegex(MODULE.MailboxError, "^expired$"):
                MODULE.read_setup_secret_file()
        with mock.patch.object(MODULE, "SETUP_SECRET_FILE", None), mock.patch.object(MODULE, "require_credential_lease"):
            with self.assertRaisesRegex(MODULE.MailboxError, "agent_secret_setup_file_required"):
                MODULE.read_setup_secret_file()
        self.store.assert_not_called()

    def test_bad_metadata_is_rejected_before_secret_read(self):
        location = self.checkout()
        for suffix in (["--email", "bad-address"], ["--smtp-host", "https://bad.invalid/path"], ["--smtp-port", "0"]):
            with self.subTest(suffix=suffix), mock.patch.object(MODULE, "read_setup_secret_file", side_effect=AssertionError("Unexpected secret read")):
                with self.assertRaises(MODULE.MailboxError):
                    self.run_setup(location, [*SETUP, *suffix])
        with self.assertRaisesRegex(MODULE.MailboxError, "requires_smtp_only"):
            self.run_setup(location, [item for item in SETUP if item != "--smtp-only"])
        self.store.assert_not_called()

    def test_bad_files_never_echo_value_or_path_and_never_save(self):
        for raw in (b"", b"\xffprivate", b"private" * 2048, b"private\x00"):
            with self.subTest(size=len(raw)):
                location = self.checkout(raw)
                with self.assertRaises(MODULE.MailboxError) as error:
                    self.run_setup(location)
                self.assertNotIn(str(location), str(error.exception))
                self.assertNotIn("private", str(error.exception))
        self.store.assert_not_called()

    @unittest.skipUnless(os.name == "posix", "POSIX owner/mode and symlink fixture")
    def test_broad_permissions_and_symlinks_fail_closed(self):
        location = self.checkout()
        location.chmod(0o644)
        with self.assertRaisesRegex(MODULE.MailboxError, "file_invalid"):
            self.run_setup(location)
        location.chmod(0o600)
        alias = location.with_name("alias")
        alias.symlink_to(location)
        with self.assertRaisesRegex(MODULE.MailboxError, "file_invalid"):
            self.run_setup(alias)
        self.store.assert_not_called()

    def test_public_cli_passes_only_reference_to_native_owner(self):
        native = MODULE.native_runtime()
        location = self.checkout()
        with mock.patch.dict(MODULE.os.environ, {"TRELIO_SECRET_FILE": str(location)}), \
             mock.patch.object(MODULE.sys, "argv", ["email", *SETUP]), \
             mock.patch.object(native, "supervise", return_value=0) as supervise:
            self.assertEqual(MODULE.main(), 0)
        self.assertEqual(supervise.call_args.kwargs["setup_secret_file"], str(location))
        self.assertNotIn(PASSWORD, repr(supervise.call_args))
        self.store.assert_not_called()


if __name__ == "__main__":
    unittest.main()
