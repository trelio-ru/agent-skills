"""Per-mailbox signature persistence and exact SMTP content, without real mail."""

import contextlib
import email
import io
import json
import os
import unittest
from unittest import mock

import test_account_descriptions as description_tests

MODULE = description_tests.MODULE


class SignatureTests(unittest.TestCase):
    def setUp(self):
        # Reuse only the synthetic storage/credential barriers, not the older
        # metadata tests themselves. Any accidental password/network call fails.
        description_tests.AccountDescriptionTests.setUp(self)
        # Remove caller bindings without erasing SystemRoot/WINDIR required by
        # the real Windows config-backup helper used on explicit reconnect.
        self.environment = mock.patch.dict(os.environ, {
            key: value for key, value in os.environ.items() if not key.startswith("TRELIO_")
        }, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.signature = "С уважением,\nТестовый отправитель\n+7 (000) 000-00-00"

    def run_command(self, *arguments):
        args = MODULE.build_parser().parse_args(arguments)
        return args.handler(args)

    def set_signature(self, text=None, account="work"):
        return self.run_command("signature", "set", "--account", account,
                                "--text", self.signature if text is None else text)

    def send_arguments(self, *extra):
        return MODULE.build_parser().parse_args([
            "send", "--account", "work", "--to", "recipient@example.com",
            "--subject", "Synthetic letter", "--body", "Текст письма", "--confirm", *extra])

    def test_legacy_default_read_is_empty_without_rewriting(self):
        MODULE.CONFIG_PATH.write_text(MODULE.CONFIG_PATH.read_text(encoding="utf-8").replace(
            'signature = ""\n', ""), encoding="utf-8")
        original = MODULE.CONFIG_PATH.read_bytes()
        shown = self.run_command("signature", "show", "--account", "work")
        self.assertEqual(shown["signature"], "")
        self.assertEqual(MODULE.load_account("work").signature, "")
        self.assertEqual(MODULE.CONFIG_PATH.read_bytes(), original)

    def test_set_clear_and_reconfigure_preserve_other_accounts_credentials_and_policy(self):
        MODULE.SECRETS_DIR.mkdir()
        credential = MODULE.SECRETS_DIR / "work.password"
        credential.write_bytes(b"synthetic-never-read")
        MODULE.write_email_policy("work", "read-only")
        policy = MODULE.email_policy_path("work").read_bytes()
        self.set_signature("Другая подпись", account="personal")
        shown = self.set_signature("\r\n" + self.signature.replace("\n", "\r\n") + "\r\n")
        self.assertEqual(shown["signature"], self.signature)
        self.assertEqual(MODULE.load_account("work").signature, self.signature)
        candidate = MODULE.load_account("work")
        with mock.patch.object(MODULE, "prompt_configuration_browser", return_value=(candidate, "synthetic")), \
             mock.patch.object(MODULE, "store_password", return_value="dpapi"):
            self.run_command("configure", "--account", "work")
        self.assertEqual(MODULE.load_account("work").signature, self.signature)
        self.run_command("description", "set", "--account", "work", "--text", "Назначение")
        self.assertEqual(MODULE.load_account("work").signature, self.signature)
        for action in (("clear",), ("set", "--text", "")):
            self.set_signature()
            self.run_command("signature", *action, "--account", "work")
            self.assertEqual(MODULE.load_account("work").signature, "")
            self.assertEqual(MODULE.load_account("personal").signature, "Другая подпись")
        self.assertEqual(credential.read_bytes(), b"synthetic-never-read")
        self.assertEqual(MODULE.email_policy_path("work").read_bytes(), policy)
        if os.name == "posix":
            self.assertEqual(MODULE.CONFIG_PATH.stat().st_mode & 0o777, 0o600)

    def test_signature_file_and_validation_are_bounded_and_do_not_echo_content(self):
        source = self.root / "signature.txt"
        source.write_bytes(self.signature.replace("\n", "\r\n").encode("utf-8"))
        self.assertEqual(self.run_command("signature", "set", "--account", "work",
                                         "--text-file", str(source))["signature"], self.signature)
        original = MODULE.CONFIG_PATH.read_bytes()
        for raw in (b"x" * (MODULE.MAX_SIGNATURE_BYTES + 1), b"\xff", b"private-contact\x00"):
            source.write_bytes(raw)
            with self.assertRaises(MODULE.MailboxError) as caught:
                self.run_command("signature", "set", "--account", "work", "--text-file", str(source))
            self.assertNotIn("private-contact", str(caught.exception))
            self.assertEqual(MODULE.CONFIG_PATH.read_bytes(), original)
        for value in (42, "private-contact\x1b", "\x0bprivate-contact", "private-contact\x0c",
                      "я" * (MODULE.MAX_SIGNATURE_BYTES // 2 + 1), "\ud800"):
            with self.assertRaises(MODULE.MailboxError):
                MODULE.normalize_signature(value)
        self.assertEqual(len(MODULE.normalize_signature("я" * (MODULE.MAX_SIGNATURE_BYTES // 2)).encode("utf-8")),
                         MODULE.MAX_SIGNATURE_BYTES)
        for value in (42, "private-contact\x00", "я" * MODULE.MAX_SIGNATURE_BYTES):
            with mock.patch.object(MODULE, "load_raw_config", return_value={"accounts": {
                    "work": {**self.accounts["work"], "signature": value}}}):
                with self.assertRaises(MODULE.MailboxError):
                    self.run_command("signature", "show", "--account", "work")
                with self.assertRaises(MODULE.MailboxError):
                    MODULE.load_account("work")

    def test_missing_account_is_not_created(self):
        original = MODULE.CONFIG_PATH.read_bytes()
        for action in (("show",), ("set", "--text", self.signature), ("clear",)):
            with self.assertRaisesRegex(MODULE.MailboxError, "not configured"):
                self.run_command("signature", *action, "--account", "missing")
        self.assertEqual(MODULE.CONFIG_PATH.read_bytes(), original)

    def test_opt_in_terminal_reconnect_preserves_multiline_signature(self):
        self.set_signature()
        with mock.patch.object(MODULE.sys.stdin, "isatty", return_value=True), \
             mock.patch.object(MODULE.sys.stderr, "isatty", return_value=True), \
             mock.patch.object(MODULE, "prompt", side_effect=lambda _label, default="": default), \
             mock.patch.object(MODULE, "prompt_password", return_value="synthetic"), \
             mock.patch.object(MODULE, "store_password", return_value="dpapi"):
            self.run_command("configure", "--account", "work", "--terminal-prompts")
        self.assertEqual(MODULE.load_account("work").signature, self.signature)

    def test_append_exact_paragraph_once_and_preserve_explicit_unsigned_body(self):
        signed = "Текст\n\n" + self.signature
        for body, expected in (("Текст\n\n", signed), ("", self.signature), (signed, signed),
                               (signed + "\n", signed + "\n"), (self.signature, self.signature),
                               ("Упоминание " + self.signature, "Упоминание " + self.signature + "\n\n" + self.signature)):
            with self.subTest(body=body):
                self.assertEqual(MODULE.body_with_signature(body, self.signature), expected)
        self.assertEqual(MODULE.body_with_signature("Текст\r\n\r\n", ""), "Текст\r\n\r\n")

    def test_send_uses_reviewed_signature_and_exact_same_mime_for_sent_copy(self):
        shown = self.set_signature()
        smtp = mock.MagicMock()
        smtp.__enter__.return_value = smtp
        smtp.sendmail.return_value = {}
        with mock.patch.object(MODULE, "smtp_connection", return_value=smtp), \
             mock.patch.object(MODULE, "save_sent_copy", return_value={"verified": True}) as saved:
            MODULE.command_send(self.send_arguments("--expected-signature-sha256", shown["signatureSha256"]))
        wire = smtp.sendmail.call_args.args[2]
        message = email.message_from_bytes(wire, policy=MODULE.default)
        self.assertEqual(message.get_content().replace("\r\n", "\n"), "Текст письма\n\n" + self.signature + "\n")
        self.assertEqual(saved.call_args.args[1], wire)
        self.assertEqual(str(message["From"]), "Sender work <work@example.com>")
        smtp.sendmail.assert_called_once()

    def test_missing_stale_or_cleared_signature_review_blocks_before_network(self):
        shown = self.set_signature()
        with self.assertRaisesRegex(MODULE.MailboxError, "signature_review_required"):
            MODULE.command_send(self.send_arguments())
        for replacement in ("Новая подпись", ""):
            self.set_signature(replacement)
            with self.assertRaisesRegex(MODULE.MailboxError, "signature_changed"):
                MODULE.command_send(self.send_arguments("--expected-signature-sha256", shown["signatureSha256"]))
        with self.assertRaisesRegex(MODULE.MailboxError, "invalid_signature_sha256"):
            MODULE.command_send(self.send_arguments("--expected-signature-sha256", "bad"))
        MODULE.smtp_connection.assert_not_called()

    def test_explicit_opt_out_keeps_body_and_never_overrides_read_only(self):
        self.set_signature()
        with mock.patch.object(MODULE, "send_message", return_value={"sent": True}) as send:
            MODULE.command_send(self.send_arguments("--no-signature"))
        self.assertEqual(send.call_args.args[5], "Текст письма")
        MODULE.write_email_policy("work", "read-only")
        with self.assertRaisesRegex(MODULE.MailboxError, "read-only"):
            MODULE.command_send(self.send_arguments("--no-signature"))

    def test_host_route_exposes_only_selected_account_without_native_session(self):
        binding = {"id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "name": "Mailbox",
                   "providerRef": "work", "companyBinding": "a" * 64, "comment": ""}
        output = io.StringIO()
        with mock.patch.dict(os.environ, {"TRELIO_SKILL_ACCOUNT_JSON": json.dumps(binding)}), \
             mock.patch.object(MODULE.sys, "argv", ["trelio-email", "signature", "set", "--text", self.signature]), \
             mock.patch.object(MODULE, "native_runtime", side_effect=AssertionError("No credential session")), \
             contextlib.redirect_stdout(output):
            self.assertEqual(MODULE.main(), 0)
        self.assertEqual(json.loads(output.getvalue())["account"], binding["id"])
        self.assertEqual(MODULE.load_account("work").signature, self.signature)
        with mock.patch.dict(os.environ, {"TRELIO_SKILL_ACCOUNT_JSON": json.dumps(binding)}), \
             mock.patch.object(MODULE.sys, "argv", ["trelio-email", "signature", "clear", "--account", "personal"]):
            with self.assertRaisesRegex(MODULE.MailboxError, "differs"):
                MODULE.main()

    def test_browser_signature_is_escaped_preserved_when_omitted_and_explicitly_clearable(self):
        self.set_signature('<script>synthetic</script>\nТест')
        account = MODULE.load_account("work")
        page = MODULE.browser_password_page(account, configure=True).decode("utf-8")
        self.assertIn('name="signature"', page)
        self.assertIn('&lt;script&gt;synthetic&lt;/script&gt;', page)
        self.assertNotIn('<script>synthetic</script>', page)
        values = {key: str(value) for key, value in self.accounts["work"].items()
                  if key != "credential_store"}
        values["password"] = "synthetic-password"
        session = MODULE.BrowserConfigureSession("work", {**self.accounts["work"], "signature": self.signature}, None)
        self.addCleanup(session.close)
        session.accept_fields(values)
        self.assertEqual(session.account.signature, self.signature)
        session.accept_fields({**values, "signature": ""})
        self.assertEqual(session.account.signature, "")
        session.accept_fields({**values, "signature": "Новая\r\nподпись"})
        self.assertEqual(session.account.signature, "Новая\nподпись")


if __name__ == "__main__":
    unittest.main()
