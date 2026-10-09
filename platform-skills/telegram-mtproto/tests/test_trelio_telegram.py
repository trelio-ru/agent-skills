import asyncio
import http.client
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import mock


SCRIPT_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "trelio-telegram.py"
SPEC = importlib.util.spec_from_file_location("trelio_telegram", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class TrelioTelegramTests(unittest.TestCase):
    def test_personal_account_keeps_storage_but_scopes_approval(self):
        original = self.identity()
        account = {"id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "companyBinding": "a" * 64,
                   "providerRef": json.dumps({"company_id": original.company_id, "member_id": original.member_id,
                                              "connection_id": original.connection_id})}
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(MODULE, "default_config_home", return_value=pathlib.Path(directory)):
            imported = MODULE.Identity(company_id="44444444-4444-4444-8444-444444444444",
                                       member_id=original.member_id, connection_id=original.connection_id, account=account)
            self.assertEqual(MODULE.connection_root(original), MODULE.connection_root(imported))
            operation = {"chat": "synthetic", "text": "same payload"}
            with mock.patch.dict(os.environ, {"TRELIO_SKILL_ACCOUNT_JSON": json.dumps(account)}):
                first = MODULE.edit_approval_hash(operation)
            for change in ({"id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}, {"companyBinding": "b" * 64}):
                with mock.patch.dict(os.environ, {"TRELIO_SKILL_ACCOUNT_JSON": json.dumps({**account, **change})}):
                    self.assertNotEqual(first, MODULE.edit_approval_hash(operation))

    def test_bootstrap_installs_portable_iana_timezone_data(self):
        """Keep named export timezones available on Windows as well as POSIX."""

        self.assertIn("tzdata>=2025.2,<2027", MODULE.RUNTIME_PYTHON_PACKAGES)

    def identity(self):
        return MODULE.Identity(
            company_id="11111111-1111-1111-1111-111111111111",
            member_id="22222222-2222-2222-2222-222222222222",
            connection_id="33333333-3333-3333-3333-333333333333",
        )

    def export_args(self, **overrides):
        """Build a complete export namespace while keeping each test focused."""

        # Legacy period/output tests do not need a real session/account or
        # archive metadata. The inventory suite exercises those native guards.
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(mock.patch.object(MODULE, "connection_root", return_value=pathlib.Path(directory)))
        self.enterContext(mock.patch.object(MODULE, "overview_binding", new=mock.AsyncMock(return_value="synthetic-binding")))
        self.enterContext(mock.patch.object(MODULE, "live_dialog_metadata", new=mock.AsyncMock(return_value={
            "archived": False, "folderId": 0, "topMessageId": 1})))
        self.enterContext(mock.patch.object(MODULE, "import_telethon_inventory", return_value=(
            None, None, None, None, None, SimpleNamespace(get_peer_id=lambda entity: entity.id))))
        values = {
            "chat": ["work_chat"],
            "all_dialogs": False,
            "since": "2026-07-27",
            "until": "2026-08-03",
            "timezone": "Europe/Moscow",
            "chat_type": "any",
            "dialog_limit": 500,
            "per_chat_limit": 2_000,
            "scan_limit": 10_000,
            "total_message_limit": 10_000,
            "max_output_bytes": 1_048_576,
            "chronological": False,
            "include_links": False,
            "json": True,
        }
        values.update(overrides)
        return SimpleNamespace(**values)

    def telegram_message(self, message_id, date, text="Сообщение"):
        """Return the allowlisted message shape used by export regressions."""

        return SimpleNamespace(
            id=message_id,
            date=date,
            out=False,
            sender=None,
            message=text,
            entities=[],
            media=None,
            file=None,
            reply_to_msg_id=None,
            reply_to=None,
        )

    def editable_message(
        self,
        message_id=42,
        *,
        text="Старый текст",
        outgoing=True,
        media=None,
        entities=None,
        edit_date=None,
    ):
        """Return one complete message double for mutation regressions."""

        return SimpleNamespace(
            id=message_id,
            date=datetime(2026, 8, 27, 12, 0, tzinfo=timezone.utc),
            edit_date=edit_date,
            out=outgoing,
            sender=None,
            message=text,
            entities=entities or [],
            media=media,
            file=None,
            reply_to_msg_id=None,
            reply_to=None,
            action=None,
        )

    def telegram_cli_prefix(self):
        """Keep parser regressions tied to one valid local identity."""

        return [
            "--company-id",
            self.identity().company_id,
            "--member-id",
            self.identity().member_id,
            "--connection-id",
            self.identity().connection_id,
        ]

    def host_runtime_environment(self, *, allow_autonomous=True):
        """Mirror the identity and connection fields injected by the generic host."""

        return {
            MODULE.HOST_COMPANY_ID_ENV: self.identity().company_id,
            MODULE.HOST_MEMBER_ID_ENV: self.identity().member_id,
            MODULE.HOST_CONNECTION_ID_ENV: self.identity().connection_id,
            MODULE.HOST_CONNECTION_CONFIG_ENV: json.dumps(
                {"allowAutonomous": allow_autonomous}
            ),
        }

    def test_direct_host_invocation_resolves_identity(self):
        """The exact runtimeExecution command must not need agent-authored identity flags."""

        args = MODULE.build_parser().parse_args(["doctor"])
        with mock.patch.dict(
            MODULE.os.environ,
            self.host_runtime_environment(allow_autonomous=False),
            clear=True,
        ):
            self.assertEqual(MODULE.identity_from_args(args), self.identity())

    def test_host_identity_cannot_be_overridden_by_cli(self):
        """Legacy flags are compatible only when they repeat host-owned context."""

        mismatched_identity = MODULE.build_parser().parse_args(
            ["--company-id", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "doctor"]
        )
        with mock.patch.dict(
            MODULE.os.environ,
            self.host_runtime_environment(allow_autonomous=False),
            clear=True,
        ):
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "host identity"):
                MODULE.identity_from_args(mismatched_identity)

    def test_default_policy_requires_confirmation(self):
        with mock.patch.object(MODULE, "policy_path", return_value=pathlib.Path("/missing/policy.json")):
            self.assertEqual(MODULE.load_policy(self.identity()), {"sendMode": "confirm"})
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "--confirm"):
                MODULE.assert_send_allowed(
                    self.identity(),
                    confirmed=False,
                )

    def test_read_only_policy_blocks_confirmed_send(self):
        with mock.patch.object(MODULE, "load_policy", return_value={"sendMode": "read-only"}):
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "read-only"):
                MODULE.assert_send_allowed(
                    self.identity(),
                    confirmed=True,
                )

    def test_legacy_autonomous_is_not_conversation_authorization(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(
            MODULE.os.environ, {"TRELIO_CONFIG_HOME": directory}
        ):
            path = MODULE.policy_path(self.identity())
            MODULE.write_private_json(path, {"sendMode": "autonomous"})
            previous = path.read_bytes()
            self.assertEqual(MODULE.load_policy(self.identity()), {"sendMode": "confirm"})
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "--confirm"):
                MODULE.assert_send_allowed(self.identity(), confirmed=False)
            self.assertEqual(MODULE.assert_send_allowed(self.identity(), confirmed=True), "confirm")
            # A successful attestation does not grant the following invocation.
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "--confirm"):
                MODULE.assert_send_allowed(self.identity(), confirmed=False)
            self.assertEqual(path.read_bytes(), previous)
            with self.assertRaises(SystemExit):
                MODULE.build_parser().parse_args(["policy", "set", "--send-mode", "autonomous"])

    def test_send_explicitly_uses_telegram_markdown(self):
        """Do not let a Telethon default silently change formatted output."""

        chat = SimpleNamespace(id=77, title="Финруководство", username=None)

        class FakeClient:
            def __init__(self):
                self.send_message = mock.AsyncMock(return_value=SimpleNamespace(id=5399))
                self.disconnect = mock.AsyncMock()

            async def get_entity(self, reference):
                self.reference = reference
                return chat

        client = FakeClient()
        args = SimpleNamespace(
            chat="Финруководство",
            message="[Задача](https://trelio.ru/task)",
            message_file=None,
            file=None,
            confirm=True,
        )
        with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ), mock.patch.object(
            MODULE,
            "load_policy",
            return_value={"sendMode": "confirm"},
        ):
            result = asyncio.run(MODULE.command_send_async(args, self.identity()))

        client.send_message.assert_awaited_once_with(
            chat,
            "[Задача](https://trelio.ru/task)",
            file=None,
            parse_mode="md",
        )
        self.assertEqual(result["parseMode"], "telegram-markdown")
        client.disconnect.assert_awaited_once()

    def test_schedule_time_requires_an_explicit_zone_and_safe_future_lead(self):
        """Never guess a timezone or let Telegram turn a schedule into an immediate send."""

        now = datetime(2026, 9, 5, 6, 0, tzinfo=timezone.utc)
        scheduled_at = MODULE.parse_schedule_at(
            "2026-09-05T10:30:00+03:00",
            now=now,
        )

        self.assertEqual(scheduled_at, datetime(2026, 9, 5, 7, 30, tzinfo=timezone.utc))
        self.assertEqual(MODULE.format_utc_datetime(scheduled_at), "2026-09-05T07:30:00Z")
        with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "explicit UTC offset"):
            MODULE.parse_schedule_at("2026-09-05T10:30:00", now=now)
        with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "at least 60 seconds"):
            MODULE.parse_schedule_at("2026-09-05T06:00:59Z", now=now)

    def test_send_can_create_and_verify_one_scheduled_message(self):
        """Pass one normalized delivery time through the existing local send policy."""

        Chat = type("Chat", (), {})
        chat = Chat()
        chat.id = 77
        chat.title = "Финруководство"
        chat.username = None
        now = datetime(2026, 9, 5, 6, 0, tzinfo=timezone.utc)
        scheduled_at = datetime(2026, 9, 5, 7, 30, tzinfo=timezone.utc)
        scheduled_message = self.editable_message(
            message_id=5399,
            text="Напомнить про отчёт",
        )
        scheduled_message.date = scheduled_at

        class FakeClient:
            def __init__(self):
                self.send_message = mock.AsyncMock(return_value=scheduled_message)
                self.disconnect = mock.AsyncMock()

            async def get_entity(self, reference):
                self.reference = reference
                return chat

        client = FakeClient()
        args = MODULE.build_parser().parse_args(
            self.telegram_cli_prefix()
            + [
                "send",
                "--chat",
                "Финруководство",
                "--message",
                "Напомнить про отчёт",
                "--schedule-at",
                "2026-09-05T10:30:00+03:00",
                "--confirm",
            ]
        )
        with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ), mock.patch.object(
            MODULE,
            "load_policy",
            return_value={"sendMode": "confirm"},
        ), mock.patch.object(MODULE, "utc_now", return_value=now):
            result = asyncio.run(MODULE.command_send_async(args, self.identity()))

        client.send_message.assert_awaited_once_with(
            chat,
            "Напомнить про отчёт",
            file=None,
            parse_mode="md",
            schedule=scheduled_at,
        )
        self.assertFalse(result["sent"])
        self.assertTrue(result["scheduled"])
        self.assertEqual(result["scheduledAt"], "2026-09-05T07:30:00Z")
        self.assertEqual(result["message"]["id"], 5399)
        self.assertEqual(result["message"]["text"], "Напомнить про отчёт")
        client.disconnect.assert_awaited_once()

    def test_scheduled_send_rechecks_lead_time_after_peer_resolution(self):
        """Stop before the RPC when setup latency consumed the one-minute safety margin."""

        chat = SimpleNamespace(id=77, title="Финруководство", username=None)
        initial_now = datetime(2026, 9, 5, 6, 0, tzinfo=timezone.utc)

        class FakeClient:
            def __init__(self):
                self.send_message = mock.AsyncMock()
                self.disconnect = mock.AsyncMock()

            async def get_entity(self, reference):
                self.reference = reference
                return chat

        client = FakeClient()
        args = MODULE.build_parser().parse_args(
            self.telegram_cli_prefix()
            + [
                "send",
                "--chat",
                "Финруководство",
                "--message",
                "Напомнить про отчёт",
                "--schedule-at",
                "2026-09-05T06:01:30Z",
                "--confirm",
            ]
        )
        with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ), mock.patch.object(
            MODULE,
            "load_policy",
            return_value={"sendMode": "confirm"},
        ), mock.patch.object(
            MODULE,
            "utc_now",
            side_effect=[initial_now, initial_now.replace(second=31)],
        ):
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "at least 60 seconds"):
                asyncio.run(MODULE.command_send_async(args, self.identity()))

        client.send_message.assert_not_awaited()
        client.disconnect.assert_awaited_once()

    def test_scheduled_reads_one_exact_queue_in_upcoming_order_with_coverage(self):
        """Cap agent-visible output after reading Telegram's one-response schedule queue."""

        Chat = type("Chat", (), {})
        chat = Chat()
        chat.id = 77
        chat.title = "Финруководство"
        chat.username = None
        rows = [
            self.telegram_message(
                12,
                datetime(2026, 9, 7, 7, 0, tzinfo=timezone.utc),
                "Третье",
            ),
            self.telegram_message(
                10,
                datetime(2026, 9, 5, 7, 0, tzinfo=timezone.utc),
                "Первое",
            ),
            self.telegram_message(
                11,
                datetime(2026, 9, 6, 7, 0, tzinfo=timezone.utc),
                "Второе",
            ),
        ]
        for row in rows:
            row.out = True
        rows[1].schedule_repeat_period = 86_400

        class ProviderPage(list):
            total = 3

        class FakeClient:
            def __init__(self):
                self.get_messages = mock.AsyncMock(return_value=ProviderPage(rows))
                self.disconnect = mock.AsyncMock()

            async def get_entity(self, reference):
                self.reference = reference
                return chat

        client = FakeClient()
        args = MODULE.build_parser().parse_args(
            self.telegram_cli_prefix()
            + ["scheduled", "--chat", "Финруководство", "--limit", "2"]
        )
        with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ):
            result = asyncio.run(MODULE.command_scheduled_async(args, self.identity()))

        client.get_messages.assert_awaited_once_with(
            chat,
            limit=None,
            scheduled=True,
        )
        self.assertEqual([message["id"] for message in result["messages"]], [10, 11])
        self.assertEqual(
            [message["scheduledAt"] for message in result["messages"]],
            ["2026-09-05T07:00:00Z", "2026-09-06T07:00:00Z"],
        )
        self.assertTrue(all(message["scheduled"] for message in result["messages"]))
        self.assertEqual(result["messages"][0]["repeatPeriodSeconds"], 86_400)
        self.assertIsNone(result["messages"][1]["repeatPeriodSeconds"])
        self.assertEqual(result["coverage"]["reportedTotal"], 3)
        self.assertTrue(result["coverage"]["hasMore"])
        self.assertFalse(result["coverage"]["complete"])
        self.assertEqual(result["coverage"]["incompleteReason"], "result_limit_reached")
        self.assertFalse(result["readState"]["marksIncomingRead"])
        client.disconnect.assert_awaited_once()

    def test_scheduled_reports_provider_incompleteness_separately_from_local_limit(self):
        """Do not blame the caller's cap when Telegram returned fewer rows than reported."""

        chat = SimpleNamespace(id=77, title="Финруководство", username=None)
        rows = [
            self.telegram_message(
                message_id,
                datetime(2026, 9, 5 + message_id, 7, 0, tzinfo=timezone.utc),
                f"Сообщение {message_id}",
            )
            for message_id in (1, 2)
        ]

        class ProviderPage(list):
            total = 5

        class FakeClient:
            def __init__(self):
                self.get_messages = mock.AsyncMock(return_value=ProviderPage(rows))
                self.disconnect = mock.AsyncMock()

            async def get_entity(self, reference):
                self.reference = reference
                return chat

        client = FakeClient()
        args = MODULE.build_parser().parse_args(
            self.telegram_cli_prefix()
            + ["scheduled", "--chat", "Финруководство", "--limit", "3"]
        )
        with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ):
            result = asyncio.run(MODULE.command_scheduled_async(args, self.identity()))

        self.assertEqual(result["coverage"]["returned"], 2)
        self.assertEqual(result["coverage"]["reportedTotal"], 5)
        self.assertTrue(result["coverage"]["hasMore"])
        self.assertFalse(result["coverage"]["limitReached"])
        self.assertFalse(result["coverage"]["complete"])
        self.assertEqual(
            result["coverage"]["incompleteReason"],
            "provider_result_incomplete",
        )
        client.disconnect.assert_awaited_once()

    def test_scheduled_parser_bounds_one_exact_chat_queue(self):
        args = MODULE.build_parser().parse_args(
            self.telegram_cli_prefix()
            + ["scheduled", "--chat", "work_group", "--limit", "100"]
        )

        self.assertEqual(args.command, "scheduled")
        self.assertEqual(args.chat, "work_group")
        self.assertEqual(args.limit, 100)
        with self.assertRaises(SystemExit):
            MODULE.build_parser().parse_args(
                self.telegram_cli_prefix()
                + ["scheduled", "--chat", "work_group", "--limit", "101"]
            )

    def test_edit_dry_run_binds_live_outgoing_message_and_markdown_body(self):
        """The approval hash covers the exact live target and replacement."""

        Chat = type("Chat", (), {})
        chat = Chat()
        chat.id = 77
        chat.title = "Финруководство"
        chat.username = None
        target = self.editable_message(
            text='<a href="https://trelio.ru/task">Задача</a>',
            edit_date=datetime(2026, 8, 27, 12, 5, tzinfo=timezone.utc),
        )

        class FakeClient:
            def __init__(self):
                self.get_messages = mock.AsyncMock(return_value=target)
                self.disconnect = mock.AsyncMock()

            async def get_entity(self, reference):
                self.reference = reference
                return chat

        client = FakeClient()
        args = MODULE.build_parser().parse_args(
            self.telegram_cli_prefix()
            + [
                "edit",
                "--chat",
                "Финруководство",
                "--message-id",
                "42",
                "--message",
                "[Задача](https://trelio.ru/task)",
                "--dry-run",
            ]
        )
        with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ), mock.patch.object(
            MODULE,
            "load_policy",
            return_value={"sendMode": "confirm"},
        ):
            result = asyncio.run(
                MODULE.command_edit_preview_async(args, self.identity())
            )

        self.assertTrue(result["dryRun"])
        self.assertTrue(result["confirmationRequired"])
        self.assertEqual(result["policyMode"], "confirm")
        self.assertRegex(result["approvalHash"], r"^[0-9a-f]{64}$")
        self.assertEqual(result["operation"]["chatId"], 77)
        self.assertEqual(result["operation"]["messageId"], 42)
        self.assertEqual(
            result["operation"]["currentText"],
            '<a href="https://trelio.ru/task">Задача</a>',
        )
        self.assertEqual(
            result["operation"]["newText"],
            "[Задача](https://trelio.ru/task)",
        )
        self.assertEqual(result["operation"]["parseMode"], "telegram-markdown")
        client.disconnect.assert_awaited_once()

    def test_edit_requires_unchanged_hash_and_edits_only_own_message(self):
        """Execute exactly one approved edit and reject incoming targets."""

        Chat = type("Chat", (), {})
        chat = Chat()
        chat.id = 77
        chat.title = "Финруководство"
        chat.username = None
        replacement = "[Задача](https://trelio.ru/task)"
        target = self.editable_message(text="Старый текст")
        preview_args = MODULE.build_parser().parse_args(
            self.telegram_cli_prefix()
            + [
                "edit",
                "--chat",
                "Финруководство",
                "--message-id",
                "42",
                "--message",
                replacement,
                "--dry-run",
            ]
        )
        approval_hash = MODULE.edit_approval_hash(
            MODULE.edit_operation(preview_args, chat, target, replacement)
        )
        execute_args = MODULE.build_parser().parse_args(
            self.telegram_cli_prefix()
            + [
                "edit",
                "--chat",
                "Финруководство",
                "--message-id",
                "42",
                "--message",
                replacement,
                "--confirm",
                "--approval-hash",
                approval_hash,
            ]
        )
        TextUrl = type("MessageEntityTextUrl", (), {})
        link = TextUrl()
        link.offset = 0
        link.length = 6
        link.url = "https://trelio.ru/task"
        edited = self.editable_message(text="Задача", entities=[link])

        class FakeClient:
            def __init__(self, selected):
                self.get_messages = mock.AsyncMock(return_value=selected)
                self.edit_message = mock.AsyncMock(return_value=edited)
                self.disconnect = mock.AsyncMock()

            async def get_entity(self, reference):
                self.reference = reference
                return chat

        client = FakeClient(target)
        with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ), mock.patch.object(
            MODULE,
            "load_policy",
            return_value={"sendMode": "confirm"},
        ):
            result = asyncio.run(MODULE.command_edit_async(execute_args, self.identity()))

        client.edit_message.assert_awaited_once_with(
            chat,
            target,
            replacement,
            parse_mode="md",
        )
        self.assertTrue(result["edited"])
        self.assertEqual(result["message"]["id"], 42)
        self.assertEqual(result["message"]["text"], "Задача")
        self.assertEqual(
            result["message"]["linkEntities"][0]["url"],
            "https://trelio.ru/task",
        )
        self.assertEqual(result["parseMode"], "telegram-markdown")

        changed_args = MODULE.build_parser().parse_args(
            self.telegram_cli_prefix()
            + [
                "edit",
                "--chat",
                "Финруководство",
                "--message-id",
                "42",
                "--message",
                "Другой текст",
                "--confirm",
                "--approval-hash",
                approval_hash,
            ]
        )
        changed_client = FakeClient(target)
        with mock.patch.object(
            MODULE, "build_client", return_value=changed_client
        ), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ), mock.patch.object(
            MODULE,
            "load_policy",
            return_value={"sendMode": "confirm"},
        ):
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "changed after"):
                asyncio.run(
                    MODULE.command_edit_async(changed_args, self.identity())
                )
        changed_client.edit_message.assert_not_awaited()

        incoming_client = FakeClient(
            self.editable_message(text="Чужой текст", outgoing=False)
        )
        with mock.patch.object(
            MODULE, "build_client", return_value=incoming_client
        ), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ), mock.patch.object(
            MODULE,
            "load_policy",
            return_value={"sendMode": "confirm"},
        ):
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "own outgoing"):
                asyncio.run(
                    MODULE.command_edit_async(execute_args, self.identity())
                )
        incoming_client.edit_message.assert_not_awaited()

    def test_edit_parser_requires_positive_target_body_and_approval_step(self):
        base = self.telegram_cli_prefix() + [
            "edit",
            "--chat",
            "Финруководство",
            "--message-id",
            "42",
        ]
        for invalid in (
            base + ["--message", "Текст"],
            base + ["--dry-run"],
            self.telegram_cli_prefix()
            + [
                "edit",
                "--chat",
                "Финруководство",
                "--message-id",
                "0",
                "--message",
                "Текст",
                "--dry-run",
            ],
            base
            + [
                "--message",
                "Текст",
                "--message-file",
                "/tmp/message.txt",
                "--dry-run",
            ],
        ):
            with self.assertRaises(SystemExit):
                MODULE.build_parser().parse_args(invalid)

    def test_local_root_uses_stable_identity_and_not_workspace(self):
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.dict(MODULE.os.environ, {"TRELIO_CONFIG_HOME": temporary}):
                root = MODULE.connection_root(self.identity())
        self.assertIn("telegram-mtproto", str(root))
        self.assertIn(self.identity().company_id, str(root))
        self.assertNotIn(".trelio", str(root))

    def test_bundled_app_credentials_remove_legacy_cache_without_user_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            credential_path = pathlib.Path(temporary) / "telegram-app-credentials.json"
            credential_path.write_text(
                json.dumps({"api_id": "12345", "api_hash": "A" * 32}),
                encoding="utf-8",
            )
            with mock.patch.dict(
                MODULE.os.environ,
                {"TRELIO_CONFIG_HOME": temporary},
                clear=True,
            ):
                legacy_path = MODULE.legacy_api_hash_path(self.identity())
                MODULE.write_private_text(legacy_path, ("b" * 32) + "\n")

            with mock.patch.object(MODULE, "APP_CREDENTIAL_FILE", credential_path), mock.patch.dict(
                MODULE.os.environ, {"TRELIO_CONFIG_HOME": temporary}, clear=True
            ):
                self.assertEqual(
                    MODULE.require_app_credentials(self.identity()),
                    (12345, "a" * 32, True),
                )
                self.assertFalse(legacy_path.exists())

    def test_bundled_app_credentials_require_exact_file_without_cache_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            credential_path = pathlib.Path(temporary) / "telegram-app-credentials.json"
            credential_path.write_text(
                json.dumps({"api_id": "12345"}),
                encoding="utf-8",
            )
            with mock.patch.dict(
                MODULE.os.environ,
                {
                    "TRELIO_CONFIG_HOME": temporary,
                },
                clear=True,
            ):
                legacy_path = MODULE.legacy_api_hash_path(self.identity())
                MODULE.write_private_text(legacy_path, ("b" * 32) + "\n")
            with mock.patch.object(MODULE, "APP_CREDENTIAL_FILE", credential_path), mock.patch.dict(
                MODULE.os.environ, {"TRELIO_CONFIG_HOME": temporary}, clear=True
            ):
                with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "package is invalid"):
                    MODULE.require_app_credentials(self.identity())
                self.assertTrue(legacy_path.exists())

    @unittest.skipUnless(os.name == "posix", "POSIX permission regression")
    def test_legacy_api_hash_cleanup_rejects_group_or_world_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            credential_path = pathlib.Path(temporary) / "telegram-app-credentials.json"
            credential_path.write_text(
                json.dumps({"api_id": "12345", "api_hash": "a" * 32}),
                encoding="utf-8",
            )
            with mock.patch.dict(
                MODULE.os.environ,
                {
                    "TRELIO_CONFIG_HOME": temporary,
                },
                clear=True,
            ):
                legacy_path = MODULE.legacy_api_hash_path(self.identity())
                MODULE.write_private_text(legacy_path, ("b" * 32) + "\n")
                legacy_path.chmod(0o644)
            with mock.patch.object(MODULE, "APP_CREDENTIAL_FILE", credential_path), mock.patch.dict(
                MODULE.os.environ, {"TRELIO_CONFIG_HOME": temporary}, clear=True
            ):
                with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "expected 600"):
                    MODULE.require_app_credentials(self.identity())

    def test_doctor_reports_bundled_credentials_without_revealing_values(self):
        args = MODULE.build_parser().parse_args(
            [
                "--company-id",
                self.identity().company_id,
                "--member-id",
                self.identity().member_id,
                "--connection-id",
                self.identity().connection_id,
                "doctor",
            ]
        )
        with tempfile.TemporaryDirectory() as temporary:
            credential_path = pathlib.Path(temporary) / "telegram-app-credentials.json"
            credential_path.write_text(
                json.dumps({"api_id": "12345", "api_hash": "a" * 32}),
                encoding="utf-8",
            )
            with mock.patch.object(MODULE, "APP_CREDENTIAL_FILE", credential_path), mock.patch.dict(
                MODULE.os.environ,
                {
                    "TRELIO_CONFIG_HOME": temporary,
                    "TRELIO_CACHE_HOME": temporary,
                },
                clear=True,
            ):
                result = MODULE.command_doctor(args)
                self.assertTrue(result["appCredentialsBundled"])
                self.assertEqual(result["appCredentialBoundary"], "signed-runtime-package")
                self.assertFalse(result["appCredentialsUserConfigRequired"])
                self.assertFalse(result["legacyApiHashCacheRemoved"])
                self.assertNotIn("12345", json.dumps(result))
                self.assertNotIn("a" * 32, json.dumps(result))

            credential_path.unlink()
            with mock.patch.object(MODULE, "APP_CREDENTIAL_FILE", credential_path), mock.patch.dict(
                MODULE.os.environ,
                {
                    "TRELIO_CONFIG_HOME": temporary,
                    "TRELIO_CACHE_HOME": temporary,
                },
                clear=True,
            ):
                with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "missing or invalid"):
                    MODULE.command_doctor(args)

    def test_login_defaults_to_browser_method_choice(self):
        args = MODULE.build_parser().parse_args(
            [
                "--company-id",
                self.identity().company_id,
                "--member-id",
                self.identity().member_id,
                "--connection-id",
                self.identity().connection_id,
                "login",
            ]
        )
        with mock.patch.object(
            MODULE,
            "prompt_choice",
            return_value=MODULE.LOGIN_METHOD_QR,
        ) as prompt:
            method = MODULE.login_method_for_args(args)

        self.assertEqual(method, MODULE.LOGIN_METHOD_QR)
        prompt.assert_called_once()
        self.assertFalse(prompt.call_args.kwargs["terminal_prompts"])

    def test_browser_prompt_page_contains_same_page_qr_and_security_copy(self):
        page = MODULE.browser_prompt_app_page().decode("utf-8")

        self.assertIn("Trelio Telegram", page)
        self.assertIn('data.status === "qr"', page)
        self.assertIn("Подсказка Telegram:", page)
        self.assertIn("escapeHtml(data.hint)", page)
        self.assertIn("Telegram: Настройки", page)
        self.assertIn("Сканируйте QR только из приложения Telegram", page)
        self.assertIn('type="button" data-cancel="1"', page)
        self.assertIn('<form id="prompt-form" autocomplete="off">', page)
        self.assertIn('type="${inputType}" autocomplete="off"', page)
        self.assertIn("Сохранять данные в браузере не нужно", page)
        self.assertIn("подключение будет сохранено отдельно на этом устройстве", page)
        self.assertNotIn('autocomplete="one-time-code"', page)
        self.assertNotIn('autocomplete="tel"', page)
        self.assertNotIn("Vkus Telegram", page)

    def test_password_hint_is_normalized_and_bounded_for_local_display(self):
        hint = "  первая\n\tвторая  " + ("я" * 400)

        normalized = MODULE.normalize_telegram_password_hint(hint)

        self.assertTrue(normalized.startswith("первая вторая "))
        self.assertNotIn("\n", normalized)
        self.assertNotIn("\t", normalized)
        self.assertEqual(len(normalized), MODULE.MAX_PASSWORD_HINT_CHARS)
        self.assertEqual(MODULE.normalize_telegram_password_hint(None), "")

    def test_password_hint_read_failure_does_not_block_login(self):
        class GetPasswordRequest:
            pass

        client = mock.AsyncMock(side_effect=RuntimeError("raw Telegram diagnostic"))

        hint = asyncio.run(MODULE.telegram_password_hint(client, GetPasswordRequest))

        self.assertEqual(hint, "")
        client.assert_awaited_once()

    def test_password_hint_is_read_from_telegram_password_state(self):
        class GetPasswordRequest:
            pass

        client = mock.AsyncMock(
            return_value=SimpleNamespace(hint="  первая\n\tвторая  "),
        )

        hint = asyncio.run(MODULE.telegram_password_hint(client, GetPasswordRequest))

        self.assertEqual(hint, "первая вторая")
        self.assertIsInstance(client.await_args.args[0], GetPasswordRequest)

    def test_browser_hint_is_not_forwarded_to_terminal_fallback(self):
        with mock.patch.object(
            MODULE,
            "ensure_browser_prompt_session",
            side_effect=MODULE.BrowserPromptUnavailable("no browser"),
        ), mock.patch.object(
            MODULE,
            "prompt_value_terminal",
            return_value="password",
        ) as terminal_prompt:
            value = MODULE.prompt_value(
                "Пароль 2FA Telegram",
                hidden=True,
                browser_hint="локальная подсказка",
            )

        self.assertEqual(value, "password")
        self.assertNotIn("browser_hint", terminal_prompt.call_args.kwargs)
        self.assertNotIn("локальная подсказка", str(terminal_prompt.call_args))

    def test_code_login_passes_telegram_hint_only_to_browser_prompt(self):
        class SessionPasswordNeededError(Exception):
            pass

        class GetPasswordRequest:
            pass

        client = SimpleNamespace(
            send_code_request=mock.AsyncMock(
                return_value=SimpleNamespace(phone_code_hash="phone-code-hash"),
            ),
            sign_in=mock.AsyncMock(side_effect=[SessionPasswordNeededError(), None]),
        )
        args = SimpleNamespace(terminal_prompts=False)
        with mock.patch.object(
            MODULE,
            "prompt_value",
            side_effect=["+79990000000", "12345", "correct horse"],
        ) as prompt, mock.patch.object(
            MODULE,
            "telegram_password_hint",
            new=mock.AsyncMock(return_value="девичья фамилия"),
        ):
            asyncio.run(
                MODULE.authorize_with_code_login(
                    client,
                    args,
                    SessionPasswordNeededError,
                    GetPasswordRequest,
                )
            )

        password_prompt = prompt.call_args_list[2]
        self.assertEqual(password_prompt.args, ("Пароль 2FA Telegram",))
        self.assertEqual(password_prompt.kwargs["browser_hint"], "девичья фамилия")
        self.assertEqual(client.sign_in.await_count, 2)

    def test_qr_login_passes_telegram_hint_only_to_browser_prompt(self):
        class SessionPasswordNeededError(Exception):
            pass

        class GetPasswordRequest:
            pass

        qr_login = SimpleNamespace(
            expires=datetime.now(timezone.utc).replace(year=2099),
            url="tg://login?token=private",
            wait=mock.AsyncMock(side_effect=SessionPasswordNeededError()),
            recreate=mock.AsyncMock(),
        )
        client = SimpleNamespace(
            qr_login=mock.AsyncMock(return_value=qr_login),
            sign_in=mock.AsyncMock(),
        )
        args = SimpleNamespace(
            terminal_prompts=False,
            qr_timeout=30,
            qr_refresh_seconds=25,
            qr=False,
        )
        browser_session = SimpleNamespace(
            show_qr=mock.Mock(),
            clear_qr=mock.Mock(),
        )
        with mock.patch.object(MODULE, "import_qrcode", return_value=object()), mock.patch.object(
            MODULE,
            "qr_image_data_url",
            return_value="data:image/png;base64,private",
        ), mock.patch.object(
            MODULE,
            "ensure_browser_prompt_session",
            return_value=browser_session,
        ), mock.patch.object(
            MODULE,
            "BROWSER_PROMPT_SESSION",
            browser_session,
        ), mock.patch.object(
            MODULE,
            "prompt_value",
            return_value="correct horse",
        ) as prompt, mock.patch.object(
            MODULE,
            "telegram_password_hint",
            new=mock.AsyncMock(return_value="девичья фамилия"),
        ):
            asyncio.run(
                MODULE.authorize_with_qr_login(
                    client,
                    args,
                    SessionPasswordNeededError,
                    GetPasswordRequest,
                )
            )

        self.assertEqual(prompt.call_args.args, ("Пароль 2FA Telegram",))
        self.assertEqual(prompt.call_args.kwargs["browser_hint"], "девичья фамилия")
        client.sign_in.assert_awaited_once_with(password="correct horse")

    def test_macos_opener_uses_the_default_browser(self):
        completed = SimpleNamespace(returncode=0)
        with mock.patch.object(MODULE.sys, "platform", "darwin"), mock.patch.object(
            MODULE.subprocess,
            "run",
            return_value=completed,
        ) as run:
            MODULE.open_browser_url("http://127.0.0.1:1234/token/")

        self.assertEqual(
            run.call_args_list[0].args[0],
            ["/usr/bin/open", "http://127.0.0.1:1234/token/"],
        )

    def test_windows_opener_uses_the_default_browser(self):
        startfile = mock.Mock()
        with mock.patch.object(MODULE.sys, "platform", "win32"), mock.patch.object(
            MODULE.os,
            "startfile",
            startfile,
            create=True,
        ):
            MODULE.open_browser_url("http://127.0.0.1:1234/token/")
        startfile.assert_called_once_with("http://127.0.0.1:1234/token/")

    def test_loopback_prompt_requires_exact_origin_and_never_exposes_value_in_state(self):
        session = MODULE.BrowserPromptSession()
        session.opened = True
        received = []
        errors = []

        def ask():
            try:
                received.append(
                    session.ask(
                        "Код входа Telegram",
                        hidden=True,
                        hint="подсказка <локальная>",
                    )
                )
            except Exception as error:  # pragma: no cover - surfaced below.
                errors.append(error)

        worker = threading.Thread(target=ask)
        worker.start()
        try:
            with session.condition:
                ready = session.condition.wait_for(
                    lambda: session.current_prompt is not None,
                    timeout=2,
                )
                self.assertTrue(ready)
                prompt_id = session.current_prompt["id"]

            connection = http.client.HTTPConnection("127.0.0.1", session.port, timeout=2)
            connection.request("GET", f"{session.base_path}/state")
            state_response = connection.getresponse()
            state_payload = state_response.read().decode("utf-8")
            self.assertEqual(state_response.status, 200)
            self.assertNotIn("12345", state_payload)
            self.assertIn('"hidden": true', state_payload)
            self.assertIn("подсказка <локальная>", state_payload)
            connection.close()

            body = f"id={prompt_id}&value=12345"
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
            rejected.read()
            self.assertEqual(rejected.status, 403)
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
            accepted.read()
            self.assertEqual(accepted.status, 200)
            connection.close()

            worker.join(timeout=2)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(received, ["12345"])
            self.assertIsNone(session.response)
            self.assertIsNone(session.current_prompt)
        finally:
            session.close()

    def test_loopback_page_uses_no_store_csp_and_tokenized_path(self):
        session = MODULE.BrowserPromptSession()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", session.port, timeout=2)
            connection.request("GET", f"{session.base_path}/")
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Cache-Control"), "no-store")
            self.assertEqual(response.getheader("Referrer-Policy"), "no-referrer")
            self.assertIn("default-src 'none'", response.getheader("Content-Security-Policy"))
            connection.close()

            connection = http.client.HTTPConnection("127.0.0.1", session.port, timeout=2)
            connection.request("GET", "/state")
            rejected = connection.getresponse()
            rejected.read()
            self.assertEqual(rejected.status, 404)
            connection.close()
        finally:
            session.close()

    def test_login_hides_raw_telegram_rpc_diagnostics(self):
        client = SimpleNamespace(
            connect=mock.AsyncMock(),
            is_user_authorized=mock.AsyncMock(return_value=False),
            disconnect=mock.AsyncMock(),
        )
        args = SimpleNamespace(qr=False, code=True)
        with mock.patch.object(
            MODULE,
            "import_telethon",
            return_value=(object(), RuntimeError, object()),
        ), mock.patch.object(
            MODULE,
            "build_client",
            return_value=client,
        ), mock.patch.object(
            MODULE,
            "authorize_with_code_login",
            new=mock.AsyncMock(side_effect=RuntimeError("sensitive raw RPC detail")),
        ):
            with self.assertRaises(MODULE.TelegramRuntimeError) as raised:
                asyncio.run(MODULE.command_login_async(args, self.identity()))

        self.assertNotIn("sensitive raw RPC detail", str(raised.exception))
        self.assertIn("login", str(raised.exception))
        client.disconnect.assert_awaited_once()

    def test_chat_resolution_error_tells_the_agent_how_to_recover(self):
        """A raw peer id failure must not invite speculative prefix rewrites."""

        provider_error_type = type(
            "ChatIdInvalidError",
            (Exception,),
            {"__module__": "telethon.errors.rpcerrorlist"},
        )
        client = SimpleNamespace(
            get_entity=mock.AsyncMock(
                side_effect=provider_error_type("access_hash=secret phone=+79990000000")
            )
        )

        with self.assertRaises(MODULE.TelegramRuntimeError) as raised:
            asyncio.run(MODULE.resolve_entity(client, "405862470"))

        payload = raised.exception.public_payload()
        serialized = json.dumps(payload)
        self.assertEqual(payload["code"], "TELEGRAM_CHAT_RESOLUTION_FAILED")
        self.assertEqual(payload["details"]["reference"], "405862470")
        self.assertEqual(
            payload["details"]["acceptedReferenceFormats"],
            ["exact dialogs[].id", "@username"],
        )
        self.assertEqual(payload["details"]["notProven"], ["chat_absent", "access_denied"])
        self.assertTrue(payload["details"]["doNotGuessPeerPrefix"])
        self.assertEqual(payload["nextAction"]["operation"], "dialogs")
        self.assertIn("--query", payload["nextAction"]["arguments"])
        self.assertIn("Do not add or remove", payload["nextAction"]["instruction"])
        self.assertNotIn("access_hash", serialized)
        self.assertNotIn("+79990000000", serialized)
        client.get_entity.assert_awaited_once_with(405862470)

    def test_chat_resolution_does_not_relabel_transport_failures(self):
        """Transient provider errors retain their original retry semantics."""

        client = SimpleNamespace(
            get_entity=mock.AsyncMock(side_effect=ConnectionError("temporary reset"))
        )

        with self.assertRaisesRegex(ConnectionError, "temporary reset"):
            asyncio.run(MODULE.resolve_entity(client, "@work_chat"))

    def test_main_serializes_structured_chat_resolution_error(self):
        """Expected peer errors exit as one JSON object without a traceback."""

        runtime_error = MODULE.unresolved_chat_error("405862470")
        argv = [
            "trelio-telegram.py",
            "read",
            "--chat",
            "405862470",
            "--limit",
            "10",
        ]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(
            MODULE,
            "reexec_in_runtime_if_needed",
        ), mock.patch.object(
            MODULE,
            "run_async_command",
            side_effect=runtime_error,
        ), mock.patch.object(
            sys,
            "stderr",
            new_callable=io.StringIO,
        ) as stderr:
            exit_code = MODULE.main()

        payload = json.loads(stderr.getvalue())
        self.assertEqual(exit_code, 2)
        self.assertEqual(payload["code"], "TELEGRAM_CHAT_RESOLUTION_FAILED")
        self.assertEqual(payload["nextAction"]["operation"], "dialogs")
        self.assertNotIn("Traceback", stderr.getvalue())

    def test_public_entity_never_serializes_private_mtproto_fields(self):
        entity = SimpleNamespace(
            id=42017729,
            title="Рабочий чат",
            username="work_chat",
            phone="+79990000000",
            access_hash=123456789,
            peer=SimpleNamespace(user_id=42017729, access_hash=123456789),
            session="forbidden-session",
            api_hash="forbidden-api-hash",
        )

        payload = MODULE.public_entity(entity)
        serialized = json.dumps(payload)

        self.assertEqual(
            payload,
            {"id": 42017729, "title": "Рабочий чат", "username": "work_chat"},
        )
        for forbidden in ("phone", "access_hash", "peer", "session", "api_hash", "forbidden"):
            self.assertNotIn(forbidden, serialized)

    def test_public_entity_serializes_exact_and_coarse_last_activity_without_guessing(self):
        UserStatusOffline = type("UserStatusOffline", (), {})
        offline = UserStatusOffline()
        offline.was_online = datetime(2026, 8, 20, 12, 30, tzinfo=timezone.utc)
        exact = MODULE.public_entity(
            SimpleNamespace(
                id=17,
                first_name="Илья",
                last_name="Крылов",
                username="ilya",
                status=offline,
            )
        )
        self.assertEqual(
            exact["lastActivity"],
            {
                "kind": "offline",
                "exact": True,
                "lastSeenAt": "2026-08-20T12:30:00Z",
            },
        )

        for telegram_type, expected_kind in (
            ("UserStatusRecently", "recently"),
            ("UserStatusLastWeek", "last_week"),
            ("UserStatusLastMonth", "last_month"),
        ):
            status = type(telegram_type, (), {})()
            # Telegram may expose a by_me privacy hint on coarse statuses. It
            # must not be promoted to a guessed date or leaked as raw state.
            status.by_me = True
            payload = MODULE.public_entity(
                SimpleNamespace(
                    id=18,
                    first_name="Мария",
                    last_name=None,
                    username=None,
                    status=status,
                )
            )
            self.assertEqual(
                payload["lastActivity"],
                {"kind": expected_kind, "exact": False},
            )
            self.assertNotIn("by_me", json.dumps(payload))

    def test_public_entity_keeps_online_expiry_and_fails_closed_for_unknown_status(self):
        UserStatusOnline = type("UserStatusOnline", (), {})
        online = UserStatusOnline()
        online.expires = 1_777_777_777
        payload = MODULE.public_entity(
            SimpleNamespace(
                id=19,
                first_name="Олег",
                last_name=None,
                username="oleg",
                status=online,
            )
        )
        self.assertEqual(payload["lastActivity"]["kind"], "online")
        self.assertTrue(payload["lastActivity"]["exact"])
        self.assertRegex(payload["lastActivity"]["expiresAt"], r"Z$")

        unknown = MODULE.public_entity(
            SimpleNamespace(
                id=20,
                first_name="Новая версия",
                last_name=None,
                username=None,
                status=type("UserStatusFuture", (), {"raw": "private"})(),
            )
        )
        self.assertNotIn("lastActivity", unknown)
        self.assertNotIn("private", json.dumps(unknown))

    def test_phone_lookup_requires_one_normalized_international_number(self):
        self.assertEqual(
            MODULE.normalize_phone_lookup("＋7 (999) 000-00-00"),
            "79990000000",
        )
        for invalid in (
            "89990000000",
            "+01234",
            "+7 999 000 00 00 доб. 5",
            "+1234",
            "+1234567890123456",
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(MODULE.TelegramRuntimeError) as raised:
                    MODULE.normalize_phone_lookup(invalid)
                self.assertNotIn(invalid, str(raised.exception))

    def test_phone_lookup_rate_limit_persists_only_a_timestamp(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(
            MODULE.os.environ,
            {"TRELIO_CONFIG_HOME": temporary},
            clear=True,
        ), mock.patch.object(
            MODULE.time,
            "time",
            side_effect=[100.0, 101.0, 103.0],
        ), mock.patch.object(MODULE.time, "sleep") as sleep:
            self.assertEqual(MODULE.reserve_resolve_phone_slot(self.identity()), 0.0)
            self.assertEqual(MODULE.reserve_resolve_phone_slot(self.identity()), 2.0)
            state_path = MODULE.resolve_phone_rate_state_path(self.identity())
            state = json.loads(state_path.read_text(encoding="utf-8"))

        sleep.assert_called_once()
        self.assertAlmostEqual(sleep.call_args.args[0], 2.0)
        self.assertEqual(
            state,
            {
                "schemaVersion": MODULE.RESOLVE_PHONE_RATE_STATE_VERSION,
                "lastAttemptAt": 103.0,
            },
        )
        self.assertNotIn("phone", json.dumps(state).lower())

    def test_resolve_phone_returns_only_allowlisted_user_and_last_activity(self):
        class ResolvePhoneRequest:
            def __init__(self, phone):
                self.phone = phone

        class PhoneNotOccupiedError(Exception):
            pass

        UserStatusOffline = type("UserStatusOffline", (), {})
        status = UserStatusOffline()
        status.was_online = datetime(2026, 8, 20, 15, 45, tzinfo=timezone.utc)
        user = SimpleNamespace(
            id=42,
            first_name="Анна",
            last_name="Иванова",
            username="anna",
            phone="+79990000000",
            access_hash=987654321,
            status=status,
        )
        response = SimpleNamespace(
            peer=SimpleNamespace(user_id=42, access_hash=987654321),
            users=[user],
            chats=[],
        )

        class FakeClient:
            def __init__(self):
                self.requests = []
                self.disconnect = mock.AsyncMock()

            async def __call__(self, request):
                self.requests.append(request)
                return response

        client = FakeClient()
        args = SimpleNamespace(phone="+7 (999) 000-00-00")
        with mock.patch.object(
            MODULE,
            "import_telethon_phone_resolver",
            return_value=(ResolvePhoneRequest, PhoneNotOccupiedError),
        ), mock.patch.object(
            MODULE,
            "build_client",
            return_value=client,
        ), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ), mock.patch.object(MODULE, "reserve_resolve_phone_slot", return_value=0.0):
            result = asyncio.run(
                MODULE.command_resolve_phone_async(args, self.identity())
            )

        self.assertEqual(client.requests[0].phone, "79990000000")
        self.assertEqual(
            result,
            {
                "found": True,
                "user": {
                    "id": 42,
                    "title": "Анна Иванова",
                    "username": "anna",
                    "lastActivity": {
                        "kind": "offline",
                        "exact": True,
                        "lastSeenAt": "2026-08-20T15:45:00Z",
                    },
                },
                "securityBoundary": "chat-only",
            },
        )
        serialized = json.dumps(result)
        for forbidden in ("79990000000", "phone", "access_hash", "987654321"):
            self.assertNotIn(forbidden, serialized)
        client.disconnect.assert_awaited_once()

    def test_resolve_phone_reports_private_or_missing_without_raw_rpc_details(self):
        class ResolvePhoneRequest:
            def __init__(self, phone):
                self.phone = phone

        class PhoneNotOccupiedError(Exception):
            pass

        class FakeClient:
            def __init__(self, error):
                self.error = error
                self.disconnect = mock.AsyncMock()

            async def __call__(self, _request):
                raise self.error

        common_patches = (
            mock.patch.object(
                MODULE,
                "import_telethon_phone_resolver",
                return_value=(ResolvePhoneRequest, PhoneNotOccupiedError),
            ),
            mock.patch.object(
                MODULE,
                "ensure_authorized",
                new=mock.AsyncMock(),
            ),
            mock.patch.object(MODULE, "reserve_resolve_phone_slot", return_value=0.0),
        )

        private_client = FakeClient(PhoneNotOccupiedError())
        with common_patches[0], common_patches[1], common_patches[2], mock.patch.object(
            MODULE,
            "build_client",
            return_value=private_client,
        ):
            result = asyncio.run(
                MODULE.command_resolve_phone_async(
                    SimpleNamespace(phone="+79990000000"),
                    self.identity(),
                )
            )
        self.assertEqual(result["reason"], "not_found_or_private")
        self.assertFalse(result["found"])
        self.assertNotIn("79990000000", json.dumps(result))

        ambiguous_client = FakeClient(
            RuntimeError("raw RPC failure for +79990000000 access_hash=secret")
        )
        with mock.patch.object(
            MODULE,
            "import_telethon_phone_resolver",
            return_value=(ResolvePhoneRequest, PhoneNotOccupiedError),
        ), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ), mock.patch.object(
            MODULE,
            "reserve_resolve_phone_slot",
            return_value=0.0,
        ), mock.patch.object(MODULE, "build_client", return_value=ambiguous_client):
            with self.assertRaises(MODULE.TelegramRuntimeError) as raised:
                asyncio.run(
                    MODULE.command_resolve_phone_async(
                        SimpleNamespace(phone="+79990000000"),
                        self.identity(),
                    )
                )
        self.assertNotIn("79990000000", str(raised.exception))
        self.assertNotIn("access_hash", str(raised.exception))

    def test_resolve_phone_parser_accepts_exactly_one_phone_argument(self):
        args = MODULE.build_parser().parse_args(
            [
                "--company-id",
                self.identity().company_id,
                "--member-id",
                self.identity().member_id,
                "--connection-id",
                self.identity().connection_id,
                "resolve-phone",
                "--phone",
                "+79990000000",
            ]
        )
        self.assertEqual(args.command, "resolve-phone")
        self.assertEqual(args.phone, "+79990000000")

    def test_members_parser_supports_bounded_name_or_username_search(self):
        args = MODULE.build_parser().parse_args(
            [
                "--company-id",
                self.identity().company_id,
                "--member-id",
                self.identity().member_id,
                "--connection-id",
                self.identity().connection_id,
                "members",
                "--chat",
                "work_group",
                "--query",
                "@anna",
                "--limit",
                "25",
            ]
        )

        self.assertEqual(args.command, "members")
        self.assertEqual(args.chat, "work_group")
        self.assertEqual(args.query, "@anna")
        self.assertEqual(args.limit, 25)
        self.assertEqual(MODULE.normalize_member_query("  Ａнна  "), "Aнна")
        with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "cannot be empty"):
            MODULE.normalize_member_query("   ")
        with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "exceeds"):
            MODULE.normalize_member_query("я" * (MODULE.MAX_MEMBER_QUERY_CHARS + 1))

    def test_message_search_parser_requires_exactly_one_bounded_scope(self):
        base = [
            "--company-id",
            self.identity().company_id,
            "--member-id",
            self.identity().member_id,
            "--connection-id",
            self.identity().connection_id,
            "search",
            "--query",
            "  Ａльфа   план  ",
        ]

        exact_chat = MODULE.build_parser().parse_args(base + ["--chat", "work_group"])
        global_search = MODULE.build_parser().parse_args(
            base + ["--global", "--limit", "10", "--context", "10"]
        )

        self.assertEqual(exact_chat.chat, ["work_group"])
        self.assertFalse(exact_chat.global_search)
        self.assertIsNone(global_search.chat)
        self.assertTrue(global_search.global_search)
        self.assertEqual(global_search.context, 10)
        self.assertEqual(MODULE.search_context_radius(global_search), 10)
        self.assertEqual(
            MODULE.normalize_message_search_query(global_search.query),
            "Aльфа план",
        )
        with self.assertRaises(SystemExit):
            MODULE.build_parser().parse_args(base)
        with self.assertRaises(SystemExit):
            MODULE.build_parser().parse_args(
                base + ["--chat", "work_group", "--global"]
            )
        with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "cannot be empty"):
            MODULE.normalize_message_search_query("   ")
        with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "exceeds"):
            MODULE.normalize_message_search_query(
                "я" * (MODULE.MAX_SEARCH_QUERY_CHARS + 1)
            )
        with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "--limit 1..10"):
            MODULE.search_context_radius(
                SimpleNamespace(context=1, limit=11)
            )

    def test_global_message_search_returns_safe_per_chat_results_and_coverage(self):
        chats = [
            SimpleNamespace(
                id=41,
                title="Финансы",
                username="finance",
                access_hash=111,
            ),
            SimpleNamespace(
                id=42,
                title="Юристы",
                username=None,
                access_hash=222,
            ),
            SimpleNamespace(
                id=43,
                title="Архив",
                username=None,
                access_hash=333,
            ),
        ]
        messages = []
        for index, chat in enumerate(chats, start=1):
            sender = SimpleNamespace(
                id=100 + index,
                first_name=f"Автор {index}",
                last_name=None,
                username=f"author{index}",
                phone=f"+7999000000{index}",
                access_hash=900 + index,
            )
            messages.append(
                SimpleNamespace(
                    id=index,
                    date=datetime(2026, 8, 22, 12, index, tzinfo=timezone.utc),
                    out=False,
                    sender=sender,
                    chat=chat,
                    message=f"План {index}",
                    entities=[],
                    media=None,
                    file=None,
                    reply_to_msg_id=None,
                    reply_to=None,
                    peer_id=-1000000000000 - chat.id,
                    input_chat=f"input-{chat.id}",
                )
            )

        class SearchGlobalRequest:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

        class InputMessagesFilterEmpty:
            pass

        class InputPeerEmpty:
            pass

        class MessageEmpty:
            pass

        class Utils:
            @staticmethod
            def get_peer_id(value):
                if isinstance(value, int):
                    return value
                return value.id

        response = SimpleNamespace(
            count=3,
            next_rate=77,
            messages=messages[:2],
            users=[],
            chats=chats[:2],
        )

        class FakeClient:
            def __init__(self):
                self.disconnect = mock.AsyncMock()
                self.requests = []

            async def __call__(self, request):
                self.requests.append(request)
                return response

            async def get_input_entity(self, peer_id):
                return f"resolved-{peer_id}"

        client = FakeClient()
        args = SimpleNamespace(
            query="  план  ",
            limit=2,
            global_search=True,
            cursor=None,
        )
        with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ), mock.patch.object(
            MODULE,
            "import_telethon_global_search",
            return_value=(
                SearchGlobalRequest,
                InputMessagesFilterEmpty,
                InputPeerEmpty,
                MessageEmpty,
                Utils,
            ),
        ):
            result = asyncio.run(MODULE.command_search_async(args, self.identity()))

        self.assertEqual(len(client.requests), 1)
        self.assertEqual(client.requests[0].kwargs["q"], "план")
        self.assertEqual(client.requests[0].kwargs["limit"], 2)
        self.assertIsInstance(client.requests[0].kwargs["offset_peer"], InputPeerEmpty)
        self.assertEqual(result["scope"], "global")
        self.assertEqual(result["query"], "план")
        self.assertEqual([item["chat"]["id"] for item in result["messages"]], [41, 42])
        self.assertEqual(result["coverage"]["reportedTotal"], 3)
        self.assertEqual(result["coverage"]["seenBefore"], 0)
        self.assertEqual(result["coverage"]["seenThrough"], 2)
        self.assertTrue(result["coverage"]["hasMore"])
        self.assertTrue(result["coverage"]["limitReached"])
        self.assertFalse(result["coverage"]["complete"])
        self.assertEqual(
            result["coverage"]["incompleteReason"],
            "result_limit_reached",
        )
        self.assertIsInstance(result["coverage"]["nextCursor"], str)
        cursor = MODULE.decode_global_search_cursor(
            "план",
            result["coverage"]["nextCursor"],
        )
        self.assertEqual(cursor.seen, 2)
        self.assertEqual(cursor.offset_rate, 77)
        self.assertEqual(cursor.offset_peer_id, messages[1].peer_id)
        self.assertEqual(cursor.offset_id, 2)
        serialized = json.dumps(result)
        self.assertNotIn("phone", serialized)
        self.assertNotIn("access_hash", serialized)
        client.disconnect.assert_awaited_once()

    def test_search_context_reads_a_chronological_window_around_the_exact_hit(self):
        chat = SimpleNamespace(
            id=41,
            title="Финансы",
            username="finance",
            access_hash=111,
        )

        def message(message_id):
            return SimpleNamespace(
                id=message_id,
                date=datetime(2026, 8, 22, 12, message_id, tzinfo=timezone.utc),
                out=False,
                sender=None,
                chat=chat,
                message=f"Сообщение {message_id}",
                entities=[],
                media=None,
                file=None,
                reply_to_msg_id=None,
                reply_to=None,
            )

        match = message(10)

        class FakeClient:
            def __init__(self):
                self.calls = []

            async def iter_messages(self, entity, **kwargs):
                self.calls.append((entity, kwargs))
                rows = [message(9), message(8)] if "offset_id" in kwargs else [
                    message(11),
                    message(12),
                ]
                for row in rows:
                    yield row

        client = FakeClient()
        context = asyncio.run(MODULE.public_search_context(client, match, 2))

        self.assertTrue(context["available"])
        self.assertEqual(
            [item["id"] for item in context["messages"]],
            [8, 9, 10, 11, 12],
        )
        self.assertEqual(context["matchIndex"], 2)
        self.assertEqual(
            [item["isMatch"] for item in context["messages"]],
            [False, False, True, False, False],
        )
        self.assertEqual(
            client.calls,
            [
                (chat, {"limit": 2, "offset_id": 10}),
                (chat, {"limit": 2, "min_id": 10, "reverse": True}),
            ],
        )
        self.assertEqual(
            context["coverage"],
            {
                "requestedBefore": 2,
                "returnedBefore": 2,
                "requestedAfter": 2,
                "returnedAfter": 2,
                "historyStartReached": False,
                "historyEndReached": False,
                "complete": True,
                "incompleteReasons": [],
            },
        )

    def test_global_search_cursor_resumes_exact_provider_offsets_and_binds_query(self):
        cursor = MODULE.encode_global_search_cursor(
            "план",
            MODULE.GlobalSearchCursor(
                seen=200,
                offset_rate=17,
                offset_peer_id=-1000000000042,
                offset_id=88,
            ),
        )
        self.assertEqual(
            MODULE.decode_global_search_cursor("план", cursor),
            MODULE.GlobalSearchCursor(
                seen=200,
                offset_rate=17,
                offset_peer_id=-1000000000042,
                offset_id=88,
            ),
        )
        with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "does not belong"):
            MODULE.decode_global_search_cursor("другая тема", cursor)

        class SearchGlobalRequest:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

        class InputMessagesFilterEmpty:
            pass

        class InputPeerEmpty:
            pass

        class MessageEmpty:
            pass

        class Utils:
            @staticmethod
            def get_peer_id(value):
                return value if isinstance(value, int) else value.id

        class FakeClient:
            def __init__(self):
                self.resolved = []
                self.requests = []

            async def get_input_entity(self, peer_id):
                self.resolved.append(peer_id)
                return f"input-{peer_id}"

            async def __call__(self, request):
                self.requests.append(request)
                return SimpleNamespace(
                    count=200,
                    next_rate=None,
                    messages=[],
                    users=[],
                    chats=[],
                )

        client = FakeClient()
        with mock.patch.object(
            MODULE,
            "import_telethon_global_search",
            return_value=(
                SearchGlobalRequest,
                InputMessagesFilterEmpty,
                InputPeerEmpty,
                MessageEmpty,
                Utils,
            ),
        ):
            page = asyncio.run(
                MODULE.fetch_global_search_page(client, "план", 20, cursor)
            )

        self.assertEqual(client.resolved, [-1000000000042])
        self.assertEqual(client.requests[0].kwargs["offset_rate"], 17)
        self.assertEqual(client.requests[0].kwargs["offset_peer"], "input--1000000000042")
        self.assertEqual(client.requests[0].kwargs["offset_id"], 88)
        self.assertEqual(page["seenBefore"], 200)
        self.assertEqual(page["seenThrough"], 200)
        self.assertFalse(page["hasMore"])
        self.assertIsNone(page["nextCursor"])

        repeated_message = SimpleNamespace(
            id=88,
            peer_id=-1000000000042,
            input_chat="input--1000000000042",
        )

        class RepeatingClient(FakeClient):
            async def __call__(self, request):
                self.requests.append(request)
                return SimpleNamespace(
                    count=500,
                    next_rate=17,
                    messages=[repeated_message],
                    users=[],
                    chats=[],
                )

        repeating_client = RepeatingClient()
        with mock.patch.object(
            MODULE,
            "import_telethon_global_search",
            return_value=(
                SearchGlobalRequest,
                InputMessagesFilterEmpty,
                InputPeerEmpty,
                MessageEmpty,
                Utils,
            ),
        ):
            stalled = asyncio.run(
                MODULE.fetch_global_search_page(
                    repeating_client,
                    "план",
                    20,
                    cursor,
                )
            )

        self.assertEqual(stalled["messages"], [repeated_message])
        self.assertFalse(stalled["cursorAvailable"])
        self.assertFalse(stalled["providerExhausted"])
        self.assertFalse(stalled["hasMore"])
        self.assertIsNone(stalled["nextCursor"])

    def test_search_context_keeps_partial_history_without_provider_diagnostics(self):
        chat = SimpleNamespace(id=41, title="Финансы", username=None)
        match = SimpleNamespace(
            id=10,
            date=datetime(2026, 8, 22, 12, 10, tzinfo=timezone.utc),
            out=False,
            sender=None,
            chat=chat,
            message="Совпадение",
            entities=[],
            media=None,
            file=None,
            reply_to_msg_id=None,
            reply_to=None,
        )

        class FakeClient:
            async def iter_messages(self, _entity, **kwargs):
                if "offset_id" in kwargs:
                    raise RuntimeError("secret provider diagnostic")
                if False:
                    yield None

        context = asyncio.run(MODULE.public_search_context(FakeClient(), match, 3))

        self.assertTrue(context["available"])
        self.assertEqual([item["id"] for item in context["messages"]], [10])
        self.assertFalse(context["coverage"]["complete"])
        self.assertEqual(
            context["coverage"]["incompleteReasons"],
            ["before_unavailable"],
        )
        self.assertNotIn("secret provider diagnostic", json.dumps(context))

    def test_members_returns_allowlisted_group_participants_and_coverage(self):
        class Channel:
            id = 700
            title = "Рабочая группа"
            username = "work_group"
            megagroup = True
            broadcast = False
            participants_count = 500

        entity = Channel()
        owner_participant = type("ChannelParticipantCreator", (), {})()
        admin_participant = type("ChannelParticipantAdmin", (), {})()
        regular_participant = type(
            "ChannelParticipant",
            (),
            {"inviter_id": 999, "date": 1_700_000_000},
        )()
        users = [
            SimpleNamespace(
                id=1,
                first_name="Владислав",
                last_name=None,
                username="vladislav",
                bot=False,
                phone="+70000000001",
                access_hash=101,
                participant=owner_participant,
                status=None,
            ),
            SimpleNamespace(
                id=2,
                first_name="Анна",
                last_name="Иванова",
                username="anna",
                bot=False,
                phone="+70000000002",
                access_hash=102,
                participant=admin_participant,
                status=None,
            ),
            SimpleNamespace(
                id=3,
                first_name="Помощник",
                last_name=None,
                username="helper_bot",
                bot=True,
                phone="+70000000003",
                access_hash=103,
                participant=regular_participant,
                status=None,
            ),
        ]

        class ParticipantPage(list):
            # Telethon may expose the whole channel count here even though the
            # server-side search returned only the matching rows.
            total = 162

        class FakeClient:
            def __init__(self):
                self.disconnect = mock.AsyncMock()
                self.get_participants = mock.AsyncMock(
                    return_value=ParticipantPage(users)
                )

            async def get_entity(self, reference):
                self.reference = reference
                return entity

        client = FakeClient()
        args = SimpleNamespace(chat="work_group", query="  Анна  ", limit=200)
        with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ):
            result = asyncio.run(
                MODULE.command_members_async(args, self.identity())
            )

        self.assertTrue(result["available"])
        self.assertEqual(result["chatType"], "group")
        self.assertEqual(result["audience"], "members")
        self.assertEqual(result["query"], "Анна")
        self.assertEqual(
            [participant["role"] for participant in result["participants"]],
            ["owner", "admin", "member"],
        )
        self.assertTrue(result["participants"][2]["isBot"])
        self.assertEqual(
            MODULE.public_participant(users[2], "subscribers")["role"],
            "subscriber",
        )
        self.assertEqual(
            result["coverage"],
            {
                "returned": 3,
                "reportedTotal": None,
                "limit": 200,
                "hasMore": None,
                "limitReached": False,
                "providerMayLimitResults": True,
            },
        )
        client.get_participants.assert_awaited_once_with(
            entity,
            limit=200,
            search="Анна",
        )
        client.disconnect.assert_awaited_once()
        serialized = json.dumps(result)
        for forbidden in (
            "+70000000001",
            "+70000000002",
            "+70000000003",
            "phone",
            "access_hash",
            "inviter_id",
            "1700000000",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_members_marks_matching_unfiltered_channel_count_as_exhaustive(self):
        class Channel:
            id = 701
            title = "Закрытый канал"
            username = None
            megagroup = False
            broadcast = True
            participants_count = 162

        users = [
            SimpleNamespace(
                id=index + 1,
                first_name=f"Subscriber {index + 1}",
                last_name=None,
                username=None,
                bot=False,
                participant=type("ChannelParticipant", (), {})(),
                status=None,
            )
            for index in range(162)
        ]

        class ParticipantPage(list):
            total = 162

        class FakeClient:
            def __init__(self):
                self.disconnect = mock.AsyncMock()
                self.get_participants = mock.AsyncMock(
                    return_value=ParticipantPage(users)
                )

            async def get_entity(self, _reference):
                return Channel()

        client = FakeClient()
        with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ):
            result = asyncio.run(
                MODULE.command_members_async(
                    SimpleNamespace(chat="-100701", query=None, limit=200),
                    self.identity(),
                )
            )

        self.assertTrue(result["available"])
        self.assertEqual(
            result["coverage"],
            {
                "returned": 162,
                "reportedTotal": 162,
                "limit": 200,
                "hasMore": False,
                "limitReached": False,
                "providerMayLimitResults": False,
            },
        )
        client.disconnect.assert_awaited_once()

    def test_members_reports_hidden_channel_subscribers_without_rpc_details(self):
        class Channel:
            id = 800
            title = "Новости"
            username = "news"
            megagroup = False
            broadcast = True
            participants_count = 50_000

        class ChatAdminRequiredError(Exception):
            pass

        entity = Channel()

        class FakeClient:
            def __init__(self):
                self.disconnect = mock.AsyncMock()

            async def get_entity(self, _reference):
                return entity

            async def get_participants(self, _entity, **_kwargs):
                raise ChatAdminRequiredError(
                    "raw access_hash=secret subscriber_phone=+79990000000"
                )

        client = FakeClient()
        with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ):
            result = asyncio.run(
                MODULE.command_members_async(
                    SimpleNamespace(chat="news", query=None, limit=100),
                    self.identity(),
                )
            )

        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "hidden_or_admin_required")
        self.assertEqual(result["chatType"], "channel")
        self.assertEqual(result["audience"], "subscribers")
        self.assertEqual(result["coverage"]["reportedTotal"], 50_000)
        self.assertTrue(result["coverage"]["providerMayLimitResults"])
        self.assertEqual(result["participants"], [])
        serialized = json.dumps(result)
        for forbidden in ("access_hash", "+79990000000", "subscriber_phone"):
            self.assertNotIn(forbidden, serialized)
        client.disconnect.assert_awaited_once()

    def test_members_rejects_direct_dialogs_and_sanitizes_unknown_failures(self):
        class User:
            id = 9
            first_name = "Анна"
            last_name = None
            username = "anna"

        class FakeClient:
            def __init__(self, entity, failure=None):
                self.entity = entity
                self.failure = failure
                self.disconnect = mock.AsyncMock()

            async def get_entity(self, _reference):
                return self.entity

            async def get_participants(self, _entity, **_kwargs):
                raise self.failure

        direct_client = FakeClient(User())
        common_args = SimpleNamespace(chat="anna", query=None, limit=10)
        with mock.patch.object(MODULE, "build_client", return_value=direct_client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ):
            with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "group"):
                asyncio.run(
                    MODULE.command_members_async(common_args, self.identity())
                )
        direct_client.disconnect.assert_awaited_once()

        class Channel:
            id = 10
            title = "Новости"
            username = "news"
            megagroup = False
            broadcast = True

        failed_client = FakeClient(
            Channel(),
            RuntimeError("raw access_hash=secret phone=+79990000000"),
        )
        with mock.patch.object(MODULE, "build_client", return_value=failed_client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ):
            with self.assertRaises(MODULE.TelegramRuntimeError) as raised:
                asyncio.run(
                    MODULE.command_members_async(common_args, self.identity())
                )
        self.assertNotIn("access_hash", str(raised.exception))
        self.assertNotIn("79990000000", str(raised.exception))
        failed_client.disconnect.assert_awaited_once()

    def test_link_entities_allowlist_and_utf16_offsets(self):
        class MessageEntityUrl:
            def __init__(self, offset, length):
                self.offset = offset
                self.length = length

        class MessageEntityTextUrl:
            def __init__(self, offset, length, url):
                self.offset = offset
                self.length = length
                self.url = url

        class MessageEntityBold:
            def __init__(self, offset, length):
                self.offset = offset
                self.length = length
                self.document_id = "must-not-leak"

        # Telegram offsets use UTF-16 code units, so the leading emoji counts
        # as two units and the URL begins at offset three.
        text = "😀 https://example.com источник"
        entities, truncated = MODULE.public_link_entities(
            text,
            [
                MessageEntityUrl(3, len("https://example.com")),
                MessageEntityTextUrl(23, len("источник"), "https://docs.example/source"),
                MessageEntityBold(23, len("источник")),
            ],
        )

        self.assertFalse(truncated)
        self.assertEqual(
            entities,
            [
                {
                    "type": "url",
                    "offset": 3,
                    "length": len("https://example.com"),
                    "text": "https://example.com",
                    "url": "https://example.com",
                    "textTruncated": False,
                    "urlTruncated": False,
                },
                {
                    "type": "text_url",
                    "offset": 23,
                    "length": len("источник"),
                    "text": "источник",
                    "url": "https://docs.example/source",
                    "textTruncated": False,
                    "urlTruncated": False,
                },
            ],
        )
        self.assertNotIn("document_id", json.dumps(entities))

    def test_link_entities_are_count_and_length_bounded(self):
        class MessageEntityTextUrl:
            def __init__(self, url):
                self.offset = 0
                self.length = 1
                self.url = url

        entities, truncated = MODULE.public_link_entities(
            "x",
            [
                MessageEntityTextUrl("https://example.com/" + ("a" * 5_000))
                for _ in range(MODULE.MAX_LINK_ENTITIES + 5)
            ],
        )

        self.assertTrue(truncated)
        self.assertEqual(len(entities), MODULE.MAX_LINK_ENTITIES)
        self.assertEqual(len(entities[0]["url"]), MODULE.MAX_LINK_URL_CHARS)
        self.assertTrue(entities[0]["urlTruncated"])

    def test_available_reply_context_includes_safe_quote_and_links_without_recursion(self):
        class MessageEntityTextUrl:
            def __init__(self, offset, length, url):
                self.offset = offset
                self.length = length
                self.url = url

        reply_sender = SimpleNamespace(
            id=17,
            first_name="Илья",
            last_name="Крылов",
            username="ilya",
            phone="+79990000000",
            access_hash=987654321,
        )
        reply_chat = SimpleNamespace(
            id=42017729,
            title="Рабочий чат",
            username=None,
            access_hash=111,
        )
        reply_message = SimpleNamespace(
            id=101,
            sender=reply_sender,
            chat=reply_chat,
            message="Штатный источник",
            entities=[
                MessageEntityTextUrl(
                    0,
                    len("Штатный источник"),
                    "https://docs.example/official",
                )
            ],
            # The quoted message itself has a reply, but public_reply_context
            # must serialize exactly one level and never call it.
            reply_to_msg_id=99,
            get_reply_message=mock.AsyncMock(
                side_effect=AssertionError("nested reply must not be resolved")
            ),
        )
        message = SimpleNamespace(
            id=102,
            date=datetime(2026, 7, 24, 12, 0, tzinfo=timezone.utc),
            out=False,
            sender=reply_sender,
            message="Вот штатный источник, пробовал?",
            entities=[],
            media=None,
            file=None,
            reply_to_msg_id=101,
            reply_to=SimpleNamespace(
                reply_to_msg_id=101,
                reply_to_peer_id=None,
                quote_text="Штатный источник",
                quote_entities=[
                    MessageEntityTextUrl(
                        0,
                        len("Штатный источник"),
                        "https://docs.example/official",
                    )
                ],
            ),
            get_reply_message=mock.AsyncMock(return_value=reply_message),
        )

        payload = asyncio.run(MODULE.public_messages([message], reply_chat))[0]
        reply = payload["replyContext"]

        self.assertEqual(reply["messageId"], 101)
        self.assertFalse(reply["unavailable"])
        self.assertEqual(reply["author"]["title"], "Илья Крылов")
        self.assertEqual(reply["chat"]["id"], 42017729)
        self.assertEqual(reply["text"], "Штатный источник")
        self.assertEqual(reply["quoteText"], "Штатный источник")
        self.assertEqual(
            reply["linkEntities"][0]["url"],
            "https://docs.example/official",
        )
        self.assertEqual(
            reply["quoteLinkEntities"][0]["url"],
            "https://docs.example/official",
        )
        self.assertEqual(
            payload["replyContext"]["linkEntities"][0]["type"],
            "text_url",
        )
        reply_message.get_reply_message.assert_not_called()
        serialized = json.dumps(payload)
        for forbidden in ("phone", "access_hash", "session", "api_hash"):
            self.assertNotIn(forbidden, serialized)

    def test_deleted_or_unavailable_reply_keeps_header_quote_safely(self):
        class MessageEntityUrl:
            def __init__(self, offset, length):
                self.offset = offset
                self.length = length

        current_chat = SimpleNamespace(
            id=42017729,
            title="Рабочий чат",
            username=None,
        )
        quote = "https://docs.example/deleted"
        message = SimpleNamespace(
            id=103,
            reply_to_msg_id=88,
            reply_to=SimpleNamespace(
                reply_to_msg_id=88,
                reply_to_peer_id=None,
                quote_text=quote,
                quote_entities=[MessageEntityUrl(0, len(quote))],
            ),
            get_reply_message=mock.AsyncMock(return_value=None),
        )

        reply = asyncio.run(MODULE.public_reply_context(message, current_chat))

        self.assertIsNotNone(reply)
        self.assertEqual(reply["messageId"], 88)
        self.assertTrue(reply["unavailable"])
        self.assertIsNone(reply["author"])
        self.assertEqual(reply["chat"]["id"], 42017729)
        self.assertEqual(reply["text"], quote)
        self.assertEqual(reply["linkEntities"][0]["url"], quote)
        self.assertEqual(reply["quoteLinkEntities"][0]["url"], quote)

    def test_cross_chat_unavailable_reply_does_not_guess_raw_peer(self):
        current_chat = SimpleNamespace(
            id=42017729,
            title="Рабочий чат",
            username=None,
        )
        message = SimpleNamespace(
            id=104,
            reply_to_msg_id=77,
            reply_to=SimpleNamespace(
                reply_to_msg_id=77,
                reply_to_peer_id=SimpleNamespace(
                    channel_id=123,
                    access_hash=456,
                ),
                quote_text=None,
                quote_entities=[],
            ),
            get_reply_message=mock.AsyncMock(
                side_effect=RuntimeError("raw RPC details must stay private")
            ),
        )

        reply = asyncio.run(MODULE.public_reply_context(message, current_chat))

        self.assertTrue(reply["unavailable"])
        self.assertIsNone(reply["chat"])
        self.assertNotIn("peer", json.dumps(reply))
        self.assertNotIn("RPC", json.dumps(reply))

    def test_export_parser_supports_alias_and_requires_one_selection_mode(self):
        base = [
            "--company-id",
            self.identity().company_id,
            "--member-id",
            self.identity().member_id,
            "--connection-id",
            self.identity().connection_id,
        ]
        for command in ("export", "daily-export"):
            args = MODULE.build_parser().parse_args(
                base
                + [
                    command,
                    "--chat",
                    "finance",
                    "--chat",
                    "legal",
                    "--since",
                    "2026-07-27",
                    "--until",
                    "2026-08-03",
                    "--chronological",
                    "--json",
                ]
            )
            self.assertEqual(args.command, command)
            self.assertEqual(args.chat, ["finance", "legal"])
            self.assertTrue(args.chronological)

        with self.assertRaises(SystemExit):
            MODULE.build_parser().parse_args(
                base
                + [
                    "export",
                    "--since",
                    "2026-07-27",
                    "--until",
                    "2026-08-03",
                ]
            )

    def test_export_period_uses_moscow_for_naive_boundaries(self):
        zone, since, until = MODULE.export_period(self.export_args())

        self.assertEqual(str(zone), "Europe/Moscow")
        self.assertEqual(since.isoformat(), "2026-07-26T21:00:00+00:00")
        self.assertEqual(until.isoformat(), "2026-08-02T21:00:00+00:00")
        with self.assertRaisesRegex(MODULE.TelegramRuntimeError, "earlier"):
            MODULE.export_period(
                self.export_args(since="2026-08-03", until="2026-08-03")
            )

    def test_export_is_half_open_uses_until_cursor_and_can_be_chronological(self):
        class Channel:
            id = 42
            title = "Финансы"
            username = "finance"
            megagroup = True
            broadcast = False

        entity = Channel()
        messages = [
            self.telegram_message(4, datetime(2026, 8, 2, 21, 0, tzinfo=timezone.utc)),
            self.telegram_message(3, datetime(2026, 8, 2, 12, 0, tzinfo=timezone.utc), "Позже"),
            self.telegram_message(
                2,
                datetime(2026, 7, 26, 21, 0, tzinfo=timezone.utc),
                "На границе",
            ),
            self.telegram_message(1, datetime(2026, 7, 26, 20, 59, tzinfo=timezone.utc)),
        ]

        class FakeClient:
            def __init__(self):
                self.disconnect = mock.AsyncMock()
                self.iter_messages_kwargs = None

            async def get_entity(self, reference):
                self.reference = reference
                return entity

            def iter_messages(self, selected, **kwargs):
                self.iter_messages_kwargs = kwargs

                async def iterate():
                    for message in messages:
                        yield message

                return iterate()

        client = FakeClient()
        args = self.export_args(chronological=True)
        with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
            MODULE,
            "ensure_authorized",
            new=mock.AsyncMock(),
        ):
            result = asyncio.run(MODULE.command_export_async(args, self.identity()))

        self.assertEqual(
            client.iter_messages_kwargs["offset_date"].isoformat(),
            "2026-08-02T21:00:00+00:00",
        )
        self.assertEqual(client.iter_messages_kwargs["limit"], args.scan_limit + 1)
        self.assertEqual(client.iter_messages_kwargs["offset_id"], 0)
        self.assertEqual([item["id"] for item in result["chats"][0]["messages"]], [2, 3])
        self.assertEqual(result["message_count"], 2)
        self.assertEqual(result["scanned_count"], 4)
        self.assertTrue(result["chats"][0]["stopped_older_than_since"])
        self.assertFalse(result["chats"][0]["incomplete"])
        self.assertEqual(
            result["period"]["semantics"],
            "since <= message.date < until",
        )
        client.disconnect.assert_awaited_once()

    def test_export_reports_per_chat_and_scan_limits_as_incomplete(self):
        class Chat:
            id = 77
            title = "Юристы"
            username = None

        entity = Chat()
        messages = [
            self.telegram_message(
                message_id,
                datetime(2026, 7, 30, 12, message_id, tzinfo=timezone.utc),
            )
            for message_id in (3, 2, 1)
        ]

        class FakeClient:
            disconnect = mock.AsyncMock()

            async def get_entity(self, _reference):
                return entity

            def iter_messages(self, _selected, **_kwargs):
                async def iterate():
                    for message in messages:
                        yield message

                return iterate()

        for limit_name, expected_reason in (
            ("per_chat_limit", "per_chat_limit"),
            ("scan_limit", "scan_limit"),
        ):
            client = FakeClient()
            overrides = {limit_name: 2}
            with mock.patch.object(MODULE, "build_client", return_value=client), mock.patch.object(
                MODULE,
                "ensure_authorized",
                new=mock.AsyncMock(),
            ):
                result = asyncio.run(
                    MODULE.command_export_async(
                        self.export_args(**overrides),
                        self.identity(),
                    )
                )

            chat = result["chats"][0]
            self.assertTrue(chat["incomplete"])
            self.assertIn(expected_reason, chat["incomplete_reasons"])
            self.assertEqual(chat["message_count"], 2)
            self.assertEqual(len(result["incomplete_chats"]), 1)

    def test_export_has_global_message_and_output_byte_caps(self):
        class Channel:
            def __init__(self, entity_id, title):
                self.id = entity_id
                self.title = title
                self.username = None
                self.megagroup = True
                self.broadcast = False

        first = Channel(1, "Первый")
        second = Channel(2, "Второй")
        large_messages = [self.telegram_message(message_id,
            datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc), "я" * MODULE.MAX_READ_TEXT_CHARS)
            for message_id in range(44, 0, -1)]

        class FakeClient:
            disconnect = mock.AsyncMock()

            async def get_entity(self, reference):
                return first if reference == "first" else second

            def iter_messages(self, entity, **_kwargs):
                async def iterate():
                    for message in large_messages if entity is first else []:
                        yield message
                return iterate()

        for limit, byte_cap, total_hit, byte_hit in (
            (10, 16_777_216, True, False),
            (40, 1_048_576, False, True),
        ):
            args = self.export_args(chat=["first", "second"], total_message_limit=limit,
                                    max_output_bytes=byte_cap)
            with mock.patch.object(MODULE, "build_client", return_value=FakeClient()), mock.patch.object(
                MODULE, "ensure_authorized", new=mock.AsyncMock()):
                result = asyncio.run(MODULE.command_export_async(args, self.identity()))
            self.assertEqual(result["hit_total_message_limit"], total_hit)
            self.assertEqual(result["hit_output_byte_limit"], byte_hit)
            self.assertLessEqual(result["message_count"], limit)
            self.assertLessEqual(MODULE.compact_json_bytes({"ok": True, **result}), byte_cap)
            self.assertNotIn("linkEntities", result["chats"][0]["messages"][0])
            self.assertTrue(result["coverage"]["nextCursor"])
            self.assertFalse(result["coverage"]["complete"])

    def test_export_strips_only_structured_links_when_not_requested(self):
        payload = {
            "text": "https://example.com",
            "linkEntities": [{"url": "https://example.com"}],
            "linkEntitiesTruncated": False,
            "replyContext": {
                "text": "источник",
                "linkEntities": [{"url": "https://docs.example"}],
                "linkEntitiesTruncated": False,
                "quoteLinkEntities": [{"url": "https://docs.example"}],
                "quoteLinkEntitiesTruncated": False,
            },
        }

        stripped = MODULE.export_message_without_links(payload)

        self.assertEqual(stripped["text"], "https://example.com")
        self.assertEqual(stripped["replyContext"]["text"], "источник")
        self.assertNotIn("linkEntities", stripped)
        self.assertNotIn("quoteLinkEntities", stripped["replyContext"])


if __name__ == "__main__":
    unittest.main()
