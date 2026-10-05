import email
import hashlib
import http.client
import importlib.util
import pathlib
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest import mock


SCRIPT_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "trelio-email.py"
SPEC = importlib.util.spec_from_file_location("trelio_email", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class TrelioEmailTests(unittest.TestCase):
    def test_message_text_prefers_plain_text(self):
        message = email.message_from_string(
            "Content-Type: multipart/alternative; boundary=x\n\n"
            "--x\nContent-Type: text/plain; charset=utf-8\n\nPlain body\n"
            "--x\nContent-Type: text/html; charset=utf-8\n\n<b>HTML body</b>\n--x--\n",
            policy=MODULE.default,
        )
        self.assertEqual(MODULE.message_text(message), "Plain body")

    def test_save_message_preserves_exact_rfc822_bytes(self):
        raw_message = (
            b"From: Sender <sender@example.com>\r\n"
            b"To: Recipient <recipient@example.com>\r\n"
            b"Date: Mon, 31 Aug 2026 10:59:57 +0300\r\n"
            b"Subject: Exact source\r\n"
            b"Message-ID: <exact-source@example.com>\r\n"
            b"Content-Type: text/plain; charset=utf-8\r\n"
            b"\r\n"
            b"First line\r\nQuoted history stays exact.\r\n"
        )
        args = MODULE.build_parser().parse_args(
            ["save-message", "--account", "work", "--uid", "42", "--output", "/unused"]
        )
        fake_account = MODULE.Account(
            name="work",
            email_address="person@example.com",
            display_name="",
            username="person@example.com",
            imap_host="imap.example.com",
            imap_port=993,
            smtp_host="smtp.example.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        imap_client = mock.MagicMock()
        imap_client.select.return_value = ("OK", [b"1"])
        imap_client.uid.return_value = ("OK", [(b"42 (RFC822)", raw_message)])
        imap_context = mock.MagicMock()
        imap_context.__enter__.return_value = imap_client

        with tempfile.TemporaryDirectory() as output_directory:
            args.output = output_directory
            with (
                mock.patch.object(MODULE, "load_account", return_value=fake_account),
                mock.patch.object(MODULE, "imap_connection", return_value=imap_context),
            ):
                result = MODULE.command_save_message(args)

            saved_path = pathlib.Path(result["saved"])
            self.assertEqual(saved_path.name, "message-42.eml")
            self.assertEqual(saved_path.read_bytes(), raw_message)

        self.assertEqual(result["size"], len(raw_message))
        self.assertEqual(result["sha256"], hashlib.sha256(raw_message).hexdigest())
        self.assertEqual(result["account"], "work")
        self.assertEqual(result["from"], "Sender <sender@example.com>")
        self.assertEqual(result["to"], "Recipient <recipient@example.com>")
        self.assertEqual(result["messageId"], "<exact-source@example.com>")
        self.assertEqual(result["format"], "message/rfc822")

    def test_save_message_requires_eml_filename_and_no_overwrite_by_default(self):
        self.assertEqual(MODULE.message_export_filename("42", None), "message-42.eml")
        self.assertEqual(MODULE.message_export_filename("42", "../source.eml"), "source.eml")
        with self.assertRaisesRegex(MODULE.MailboxError, r"\.eml extension"):
            MODULE.message_export_filename("42", "source.txt")

        with tempfile.TemporaryDirectory() as output_directory:
            output_path = pathlib.Path(output_directory) / "source.eml"
            output_path.write_bytes(b"existing")
            with self.assertRaisesRegex(MODULE.MailboxError, "Refusing to overwrite"):
                MODULE.write_selected_bytes(output_path, b"replacement", overwrite=False)
            self.assertEqual(output_path.read_bytes(), b"existing")

    def test_safe_filename_removes_parent_path(self):
        self.assertEqual(MODULE.safe_filename("../../secret.txt"), "secret.txt")

    def test_send_parser_does_not_confirm_implicitly(self):
        args = MODULE.build_parser().parse_args(
            ["send", "--account", "work", "--to", "a@example.com", "--subject", "Test"]
        )
        self.assertFalse(args.confirm)

    def test_default_policy_requires_confirmation(self):
        with mock.patch.object(MODULE, "email_policy_path", return_value=pathlib.Path("/missing/policy.json")):
            self.assertEqual(MODULE.load_email_policy("work"), {"sendMode": "confirm"})

    def test_read_only_policy_blocks_send_even_when_confirmed(self):
        args = MODULE.build_parser().parse_args(
            [
                "send",
                "--account",
                "work",
                "--to",
                "a@example.com",
                "--subject",
                "Test",
                "--confirm",
            ]
        )
        with mock.patch.object(MODULE, "load_email_policy", return_value={"sendMode": "read-only"}):
            with self.assertRaisesRegex(MODULE.MailboxError, "read-only"):
                MODULE.command_send(args)

    def test_legacy_autonomous_needs_per_invocation_authorization(self):
        args = MODULE.build_parser().parse_args(
            ["send", "--account", "work", "--to", "a@example.com", "--subject", "Test"]
        )
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(MODULE, "POLICIES_DIR", pathlib.Path(directory)):
            path = MODULE.email_policy_path("work")
            path.write_text('{"sendMode":"autonomous"}', encoding="utf-8")
            path.chmod(0o600)
            previous = path.read_bytes()
            self.assertEqual(MODULE.load_email_policy("work"), {"sendMode": "confirm"})
            with mock.patch.object(MODULE, "smtp_connection") as smtp:
                with self.assertRaisesRegex(MODULE.MailboxError, "--confirm"):
                    MODULE.command_send(args)
                smtp.assert_not_called()
            self.assertEqual(path.read_bytes(), previous)
            with self.assertRaises(MODULE.MailboxError):
                MODULE.write_email_policy("work", "autonomous")

    def test_broad_search_is_rejected(self):
        args = MODULE.build_parser().parse_args(["search", "--account", "work"])
        with self.assertRaisesRegex(MODULE.MailboxError, "at least one search filter"):
            MODULE.command_search(args)

    def test_unicode_subject_search_declares_utf8_and_uses_literal(self):
        args = MODULE.build_parser().parse_args(
            [
                "search",
                "--account",
                "work",
                "--subject",
                "Территория по ДКК",
                "--since",
                "2026-09-01",
            ]
        )
        fake_account = MODULE.Account(
            name="work",
            email_address="person@example.com",
            display_name="",
            username="person@example.com",
            imap_host="imap.example.com",
            imap_port=993,
            smtp_host="smtp.example.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        imap_client = mock.MagicMock()
        imap_client.select.return_value = ("OK", [b"0"])
        literal_chunks: list[bytes] = []

        def unicode_search(*_arguments):
            literal_chunks.append(imap_client.literal(b"continue"))
            return "OK", [b""]

        imap_client.uid.side_effect = unicode_search
        imap_context = mock.MagicMock()
        imap_context.__enter__.return_value = imap_client

        with (
            mock.patch.object(MODULE, "load_account", return_value=fake_account),
            mock.patch.object(MODULE, "imap_connection", return_value=imap_context),
        ):
            result = MODULE.command_search(args)

        imap_client.uid.assert_called_once_with(
            "search",
            "CHARSET",
            "UTF-8",
            "SUBJECT",
            "{32}",
        )
        self.assertEqual(literal_chunks, ["Территория по ДКК SINCE 01-Sep-2026".encode("utf-8")])
        self.assertEqual(result["criteria"], ["SUBJECT", '"Территория по ДКК"', "SINCE", "01-Sep-2026"])
        self.assertEqual(result["messages"], [])

    def test_multiple_unicode_filters_share_one_atomic_literal_search(self):
        args = MODULE.build_parser().parse_args(
            [
                "search",
                "--account",
                "work",
                "--from",
                "Николай Малашенко",
                "--subject",
                "Территория по ДКК",
                "--since",
                "2026-09-01",
            ]
        )
        fake_account = MODULE.Account(
            name="work",
            email_address="person@example.com",
            display_name="",
            username="person@example.com",
            imap_host="imap.example.com",
            imap_port=993,
            smtp_host="smtp.example.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        imap_client = mock.MagicMock()
        imap_client.select.return_value = ("OK", [b"0"])
        literal_chunks: list[bytes] = []

        def unicode_search(*_arguments):
            literal_chunks.append(imap_client.literal(b"first"))
            literal_chunks.append(imap_client.literal(b"second"))
            return "OK", [b""]

        imap_client.uid.side_effect = unicode_search
        imap_context = mock.MagicMock()
        imap_context.__enter__.return_value = imap_client

        with (
            mock.patch.object(MODULE, "load_account", return_value=fake_account),
            mock.patch.object(MODULE, "imap_connection", return_value=imap_context),
        ):
            MODULE.command_search(args)

        imap_client.uid.assert_called_once_with("search", "CHARSET", "UTF-8", "FROM", "{33}")
        self.assertEqual(
            literal_chunks,
            [
                "Николай Малашенко SUBJECT {32}".encode("utf-8"),
                "Территория по ДКК SINCE 01-Sep-2026".encode("utf-8"),
            ],
        )

    def test_ascii_search_keeps_legacy_no_charset_request(self):
        args = MODULE.build_parser().parse_args(
            ["search", "--account", "work", "--subject", "Re:"]
        )
        fake_account = MODULE.Account(
            name="work",
            email_address="person@example.com",
            display_name="",
            username="person@example.com",
            imap_host="imap.example.com",
            imap_port=993,
            smtp_host="smtp.example.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        imap_client = mock.MagicMock()
        imap_client.select.return_value = ("OK", [b"0"])
        imap_client.uid.return_value = ("OK", [b""])
        imap_context = mock.MagicMock()
        imap_context.__enter__.return_value = imap_client

        with (
            mock.patch.object(MODULE, "load_account", return_value=fake_account),
            mock.patch.object(MODULE, "imap_connection", return_value=imap_context),
        ):
            MODULE.command_search(args)

        imap_client.uid.assert_called_once_with("search", None, "SUBJECT", '"Re:"')

    def test_search_text_escapes_quoted_specials_and_rejects_line_controls(self):
        self.assertEqual(
            MODULE.quote_imap_search_text('ДКК "Шушары" \\ архив'),
            '"ДКК \\"Шушары\\" \\\\ архив"',
        )
        with self.assertRaisesRegex(MODULE.MailboxError, "NUL, CR, or LF"):
            MODULE.quote_imap_search_text("safe\r\nUID SEARCH ALL")

    def test_gmail_is_detected_by_address_or_transport_host(self):
        self.assertTrue(MODULE.is_gmail_account("person@gmail.com"))
        self.assertTrue(MODULE.is_gmail_account("person@company.example", "imap.gmail.com"))
        self.assertFalse(MODULE.is_gmail_account("person@example.com", "imap.example.com"))

    def test_gmail_app_password_spaces_are_removed_before_storage(self):
        account = MODULE.Account(
            name="gmail",
            email_address="person@gmail.com",
            display_name="Person",
            username="person@gmail.com",
            imap_host="imap.gmail.com",
            imap_port=993,
            smtp_host="smtp.gmail.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        self.assertEqual(
            MODULE.normalize_password_for_account(account, "abcd efgh ijkl mnop"),
            "abcdefghijklmnop",
        )

    def test_gmail_app_password_must_have_sixteen_characters(self):
        account = MODULE.Account(
            name="gmail",
            email_address="person@gmail.com",
            display_name="",
            username="person@gmail.com",
            imap_host="imap.gmail.com",
            imap_port=993,
            smtp_host="smtp.gmail.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        with self.assertRaisesRegex(MODULE.MailboxError, "exactly 16 characters"):
            MODULE.normalize_password_for_account(account, "too short")

    def test_non_gmail_password_whitespace_is_not_rewritten(self):
        account = MODULE.Account(
            name="custom",
            email_address="person@example.com",
            display_name="",
            username="person@example.com",
            imap_host="imap.example.com",
            imap_port=993,
            smtp_host="smtp.example.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        self.assertEqual(MODULE.normalize_password_for_account(account, " secret value "), " secret value ")

    def test_terminal_password_mode_remains_available_for_headless_use(self):
        account = MODULE.Account(
            name="work",
            email_address="person@example.com",
            display_name="",
            username="person@example.com",
            imap_host="imap.example.com",
            imap_port=993,
            smtp_host="smtp.example.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        with (
            mock.patch.object(MODULE.sys.stdin, "isatty", return_value=True),
            mock.patch.object(MODULE.sys.stderr, "isatty", return_value=True),
            mock.patch.object(MODULE.getpass, "getpass", return_value="secret-value") as getpass_mock,
        ):
            self.assertEqual(MODULE.prompt_password(account, "terminal"), "secret-value")
        getpass_mock.assert_called_once()

    def test_terminal_password_mode_requires_visible_tty(self):
        account = MODULE.Account(
            name="work",
            email_address="person@example.com",
            display_name="",
            username="person@example.com",
            imap_host="imap.example.com",
            imap_port=993,
            smtp_host="smtp.example.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        with (
            mock.patch.object(MODULE.sys.stdin, "isatty", return_value=False),
            mock.patch.object(MODULE.sys.stderr, "isatty", return_value=False),
            self.assertRaisesRegex(MODULE.ProtectedPromptUnavailable, "видимый"),
        ):
            MODULE.prompt_password(account, "terminal")

    def test_browser_password_page_is_truthful_about_password_manager(self):
        account = MODULE.Account(
            name="work",
            email_address="person@example.com",
            display_name="",
            username="person@example.com",
            imap_host="imap.example.com",
            imap_port=993,
            smtp_host="smtp.example.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        page = MODULE.browser_password_page(account).decode("utf-8")

        self.assertIn('<form id="password-form" autocomplete="off">', page)
        self.assertIn('type="password" autocomplete="off"', page)
        self.assertIn("Сохранять данные в браузере не нужно", page)
        self.assertIn("подключение будет сохранено отдельно на этом устройстве", page)
        self.assertNotIn("браузер не сохранит", page.lower())

    def test_browser_openers_use_default_browser(self):
        completed = SimpleNamespace(returncode=0)
        with mock.patch.object(MODULE.sys, "platform", "darwin"), mock.patch.object(
            MODULE.subprocess,
            "run",
            return_value=completed,
        ) as run:
            MODULE.open_browser_url("http://127.0.0.1:1234/token/")
        self.assertEqual(
            run.call_args.args[0],
            ["/usr/bin/open", "http://127.0.0.1:1234/token/"],
        )

        startfile = mock.Mock()
        with mock.patch.object(MODULE.sys, "platform", "win32"), mock.patch.object(
            MODULE.os,
            "startfile",
            startfile,
            create=True,
        ):
            MODULE.open_browser_url("http://127.0.0.1:1234/token/")
        startfile.assert_called_once_with("http://127.0.0.1:1234/token/")

    def test_loopback_password_prompt_requires_exact_origin(self):
        account = MODULE.Account(
            name="gmail",
            email_address="person@gmail.com",
            display_name="",
            username="person@gmail.com",
            imap_host="imap.gmail.com",
            imap_port=993,
            smtp_host="smtp.gmail.com",
            smtp_port=465,
            smtp_security="ssl",
            credential_store="file",
        )
        session = MODULE.BrowserPasswordSession(account)
        received: list[str] = []
        try:
            connection = http.client.HTTPConnection("127.0.0.1", session.port, timeout=2)
            connection.request("GET", session.base_path + "/")
            page_response = connection.getresponse()
            page_response.read()
            self.assertEqual(page_response.status, 200)
            self.assertEqual(page_response.getheader("Cache-Control"), "no-store")
            self.assertIn("default-src 'none'", page_response.getheader("Content-Security-Policy"))
            connection.close()

            with mock.patch.object(MODULE, "open_browser_url"):
                worker = threading.Thread(target=lambda: received.append(session.ask()))
                worker.start()

                body = "password=abcd+efgh+ijkl+mnop"
                connection = http.client.HTTPConnection("127.0.0.1", session.port, timeout=2)
                connection.request(
                    "POST",
                    f"{session.base_path}/submit",
                    body=body,
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded",
                        "Origin": "https://attacker.example",
                    },
                )
                rejected = connection.getresponse()
                rejected_body = rejected.read().decode("utf-8")
                self.assertEqual(rejected.status, 403)
                self.assertNotIn("abcdefghijklmnop", rejected_body)
                connection.close()

                connection = http.client.HTTPConnection("127.0.0.1", session.port, timeout=2)
                connection.request(
                    "POST",
                    f"{session.base_path}/submit",
                    body=body,
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded",
                        "Origin": session.origin,
                    },
                )
                accepted = connection.getresponse()
                accepted_body = accepted.read().decode("utf-8")
                self.assertEqual(accepted.status, 200)
                self.assertNotIn("abcdefghijklmnop", accepted_body)
                connection.close()

                worker.join(timeout=2)
                self.assertFalse(worker.is_alive())
                self.assertEqual(received, ["abcdefghijklmnop"])
        finally:
            session.close()

    def test_configure_uses_browser_mode_by_default(self):
        args = MODULE.build_parser().parse_args(["configure", "--account", "work"])
        self.assertEqual(args.password_input, "browser")
        self.assertFalse(args.terminal_prompts)
        self.assertEqual(MODULE.canonical_password_input_mode("auto"), "browser")
        self.assertEqual(MODULE.canonical_password_input_mode("window"), "browser")

    def test_gmail_configure_persists_only_compact_password(self):
        args = MODULE.build_parser().parse_args(["configure", "--account", "gmail", "--terminal-prompts"])
        prompt_values = iter(
            [
                "person@gmail.com",
                "person@gmail.com",
                "Person",
                "",
                "imap.gmail.com",
                "993",
                "smtp.gmail.com",
                "ssl",
                "465",
            ]
        )
        with (
            mock.patch.object(MODULE.sys.stdin, "isatty", return_value=True),
            mock.patch.object(MODULE.sys.stderr, "isatty", return_value=True),
            mock.patch.object(MODULE, "load_raw_config", side_effect=[{"accounts": {}}, {"accounts": {}}]),
            mock.patch.object(MODULE, "prompt", side_effect=lambda *_args: next(prompt_values)),
            mock.patch.object(MODULE, "prompt_password", return_value="abcd efgh ijkl mnop"),
            mock.patch.object(MODULE, "store_password", return_value="keychain") as store_password_mock,
            mock.patch.object(MODULE, "write_raw_config") as write_config_mock,
        ):
            result = MODULE.command_configure(args)

        stored_account, stored_password = store_password_mock.call_args.args
        self.assertEqual(stored_account.email_address, "person@gmail.com")
        self.assertEqual(stored_password, "abcdefghijklmnop")
        self.assertEqual(result["appPasswordUrl"], MODULE.GOOGLE_APP_PASSWORDS_URL)
        write_config_mock.assert_called_once()


if __name__ == "__main__":
    unittest.main()
