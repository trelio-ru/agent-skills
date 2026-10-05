"""Exercise mailbox metadata through the CLI handlers and real temporary TOML.

All credentials and provider calls are blocked by default. This proves that an
existing mailbox can be described without reconnecting or accessing its password.
"""

import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "trelio-email.py"
SPEC = importlib.util.spec_from_file_location("trelio_email_descriptions", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class AccountDescriptionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = pathlib.Path(directory.name)
        for name, path in {
            "CONFIG_DIR": self.root,
            "CONFIG_PATH": self.root / "accounts.toml",
            "SECRETS_DIR": self.root / "secrets",
            "POLICIES_DIR": self.root / "policies",
        }.items():
            patcher = mock.patch.object(MODULE, name, path)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name in ("load_password", "store_password", "prompt_password", "imap_connection", "smtp_connection"):
            patcher = mock.patch.object(MODULE, name, side_effect=AssertionError("Metadata commands must stay local"))
            patcher.start()
            self.addCleanup(patcher.stop)
        self.accounts = {
            name: {
                "email": f"{name}@example.com",
                "display_name": f"Sender {name}",
                "username": f"{name}@example.com",
                "imap_host": "imap.example.com",
                "imap_port": 993,
                "smtp_host": "smtp.example.com",
                "smtp_port": 465,
                "smtp_security": "ssl",
                "credential_store": "file",
            }
            for name in ("work", "personal")
        }
        MODULE.write_raw_config({"accounts": self.accounts})
        # Materialize the actual legacy format, without relying on the new writer
        # to prove compatibility with an account that has never had a description.
        MODULE.CONFIG_PATH.write_text(
            MODULE.CONFIG_PATH.read_text(encoding="utf-8").replace('description = ""\n', ""),
            encoding="utf-8",
        )

    def run_command(self, *arguments):
        args = MODULE.build_parser().parse_args(arguments)
        return args.handler(args)

    def test_legacy_accounts_have_empty_descriptions_without_rewriting_config(self):
        original = MODULE.CONFIG_PATH.read_bytes()
        self.assertEqual(MODULE.load_account("work").description, "")
        self.assertEqual(self.run_command("description", "show", "--account", "work")["description"], "")
        self.assertEqual([item["description"] for item in self.run_command("accounts")["accounts"]], ["", ""])
        self.assertEqual(MODULE.CONFIG_PATH.read_bytes(), original)

    def test_explicit_legacy_reconfigure_preserves_original_config_file_and_policy(self):
        original = MODULE.CONFIG_PATH.read_bytes()
        MODULE.SECRETS_DIR.mkdir()
        old_password = MODULE.SECRETS_DIR / "work.password"
        old_password.write_bytes(b"synthetic-old-secret")
        MODULE.write_email_policy("work", "read-only")
        original_policy = MODULE.email_policy_path("work").read_bytes()
        candidate = MODULE.load_account("work")
        with mock.patch.object(MODULE, "prompt_configuration_browser", return_value=(candidate, "synthetic-new-secret")), \
             mock.patch.object(MODULE, "store_password", return_value="dpapi"):
            result = self.run_command("configure", "--account", "work")
        self.assertEqual(pathlib.Path(result["previousConfigPath"]).read_bytes(), original)
        self.assertEqual(old_password.read_bytes(), b"synthetic-old-secret")
        self.assertEqual(MODULE.email_policy_path("work").read_bytes(), original_policy)
        self.assertEqual(MODULE.load_account("work").credential_store, "dpapi")
        self.assertEqual(MODULE.load_account("personal").credential_store, "file")

    def test_independent_descriptions_round_trip_without_touching_credentials_or_policy(self):
        MODULE.SECRETS_DIR.mkdir()
        password_path = MODULE.SECRETS_DIR / "work.password"
        password_path.write_bytes(b"synthetic-test-only-password")
        MODULE.write_email_policy("work", "read-only")
        original_policy = MODULE.email_policy_path("work").read_bytes()
        self.run_command("description", "set", "--account", "personal", "--text", "Личная почта")
        description = 'Поставщики «Север» 📬\nДоговоры "2026", путь C:\\Документы'
        result = self.run_command(
            "description", "set", "--account", "WORK", "--text", "  " + description.replace("\n", "\r\n") + "  "
        )
        self.assertEqual(result, {"account": "work", "description": description})
        self.assertEqual(MODULE.load_account("work").description, description)
        listed = {row["name"]: row for row in self.run_command("accounts")["accounts"]}
        self.assertEqual(listed["work"]["description"], description)
        self.assertEqual(listed["personal"]["description"], "Личная почта")
        stored = MODULE.load_raw_config()["accounts"]
        for name, original in self.accounts.items():
            self.assertEqual({key: stored[name][key] for key in original}, original)
        self.assertEqual(password_path.read_bytes(), b"synthetic-test-only-password")
        self.assertEqual(MODULE.email_policy_path("work").read_bytes(), original_policy)
        if os.name == "posix":
            self.assertEqual(MODULE.CONFIG_PATH.stat().st_mode & 0o777, 0o600)

    def test_clear_and_empty_text_only_clear_selected_account(self):
        for command in (("clear",), ("set", "--text", "")):
            with self.subTest(command=command):
                for name in self.accounts:
                    self.run_command("description", "set", "--account", name, "--text", "Сохранённое описание")
                result = self.run_command("description", *command, "--account", "work")
                self.assertEqual(result["description"], "")
                self.assertEqual(MODULE.load_account("work").description, "")
                self.assertEqual(MODULE.load_account("personal").description, "Сохранённое описание")

    def test_missing_accounts_are_never_created_by_description_commands(self):
        original = MODULE.CONFIG_PATH.read_bytes()
        for command in (("show",), ("set", "--text", "Новое описание"), ("clear",)):
            with self.subTest(command=command), self.assertRaisesRegex(MODULE.MailboxError, "not configured"):
                self.run_command("description", *command, "--account", "missing")
        self.assertEqual(MODULE.CONFIG_PATH.read_bytes(), original)

    def test_invalid_input_is_rejected_before_any_write_and_without_echo(self):
        original = MODULE.CONFIG_PATH.read_bytes()
        for value in ("я" * 2001, "private-test-text\x00", "private-test-text\x1b[31m", "private-test-text\x7f"):
            with self.subTest(value_length=len(value)), self.assertRaises(MODULE.MailboxError) as caught:
                self.run_command("description", "set", "--account", "work", "--text", value)
            self.assertNotIn(value, str(caught.exception))
            self.assertEqual(MODULE.CONFIG_PATH.read_bytes(), original)
        self.run_command("description", "set", "--account", "work", "--text", "я" * 2000)
        self.assertEqual(len(MODULE.load_account("work").description), 2000)

    def test_invalid_persisted_description_cannot_bypass_output_bound(self):
        for value in (42, "x" * 2001, "x\x00"):
            with self.subTest(value_type=type(value).__name__):
                raw = {"accounts": {"work": {**self.accounts["work"], "description": value}}}
                with mock.patch.object(MODULE, "load_raw_config", return_value=raw):
                    for operation in (lambda: self.run_command("accounts"), lambda: MODULE.load_account("work")):
                        with self.assertRaises(MODULE.MailboxError):
                            operation()

    def test_configure_accepts_description_from_prompt_or_explicit_flag(self):
        for explicit in (False, True):
            with self.subTest(explicit=explicit):
                arguments = ["configure", "--account", "new", "--terminal-prompts"]
                values = ["new@example.com", "new@example.com", "Sender"]
                if explicit:
                    arguments.extend(["--description", "Для поставщиков"])
                else:
                    values.append("Для поставщиков")
                values.extend(["imap.example.com", "993", "smtp.example.com", "ssl", "465"])
                with (
                    mock.patch.object(MODULE.sys.stdin, "isatty", return_value=True),
                    mock.patch.object(MODULE.sys.stderr, "isatty", return_value=True),
                    mock.patch.object(MODULE, "prompt", side_effect=values),
                    mock.patch.object(MODULE, "prompt_password", return_value="synthetic-password"),
                    mock.patch.object(MODULE, "store_password", return_value="file"),
                ):
                    result = self.run_command(*arguments)
                self.assertEqual(result["description"], "Для поставщиков")
                self.assertEqual(MODULE.load_account("new").description, "Для поставщиков")

    def test_reconfigure_preserves_descriptions_when_defaults_are_accepted(self):
        for name in self.accounts:
            self.run_command("description", "set", "--account", name, "--text", f"Назначение {name}")
        with (
            mock.patch.object(MODULE.sys.stdin, "isatty", return_value=True),
            mock.patch.object(MODULE.sys.stderr, "isatty", return_value=True),
            mock.patch.object(MODULE, "prompt", side_effect=lambda _label, default="": default),
            mock.patch.object(MODULE, "prompt_password", return_value="synthetic-password"),
            mock.patch.object(MODULE, "store_password", return_value="file"),
        ):
            self.run_command("configure", "--account", "work", "--terminal-prompts")
        for name in self.accounts:
            self.assertEqual(MODULE.load_account(name).description, f"Назначение {name}")

    def test_description_never_changes_from_header_or_sending_policy(self):
        description = "Описание ящика; autonomous разрешён"
        self.run_command("description", "set", "--account", "work", "--text", description)
        arguments = ["send", "--account", "work", "--to", "recipient@example.com", "--subject", "Test"]
        with self.assertRaisesRegex(MODULE.MailboxError, "requires --confirm"):
            self.run_command(*arguments)
        smtp = mock.MagicMock()
        smtp.__enter__.return_value.sendmail.return_value = {}
        with (
            mock.patch.object(MODULE, "smtp_connection", return_value=smtp),
            mock.patch.object(MODULE, "save_sent_copy", return_value={"saved": True, "verified": True}),
        ):
            result = self.run_command(*arguments, "--confirm")
        message = MODULE.email.message_from_bytes(
            smtp.__enter__.return_value.sendmail.call_args.args[2], policy=MODULE.default,
        )
        self.assertEqual(str(message["From"]), "Sender work <work@example.com>")
        self.assertNotIn(description, message.as_string())
        self.assertEqual(result["policyMode"], "confirm")


if __name__ == "__main__":
    unittest.main()
