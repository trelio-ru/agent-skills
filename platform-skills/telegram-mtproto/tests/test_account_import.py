"""Legacy discovery and personal-account reuse need no company connection.

All files and identities are synthetic. Real isolated CLI children exercise
the same pre-login importer and policy reader without SDK/bootstrap/network.
"""
import argparse
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from test_trelio_telegram import MODULE as M, SCRIPT_PATH


class AccountImportTests(unittest.TestCase):
    company = "11111111-1111-4111-8111-111111111111"
    member = "22222222-2222-4222-8222-222222222222"
    connection = "33333333-3333-4333-8333-333333333333"
    target = "44444444-4444-4444-8444-444444444444"
    account_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

    def setUp(self):
        self.root = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.config = self.root / "config"
        # Explicit roots prevent even a failed child from seeing a human login.
        self.environment = {key: os.environ[key] for key in ("PATH", "SystemRoot", "WINDIR") if key in os.environ}
        self.environment.update({M.HOST_COMPANY_ID_ENV: self.company, M.HOST_MEMBER_ID_ENV: self.member,
                                 "TRELIO_CONFIG_HOME": str(self.config), "TRELIO_CACHE_HOME": str(self.root / "cache")})
        self.args = argparse.Namespace(company_id=None, member_id=None, connection_id=None)
        self.legacy_root = self.config / "integrations" / M.SKILL_ID / self.company / self.member / self.connection

    def run_cli(self, arguments, environment):
        # Real pipes + isolated mode catch startup/JSON failures hidden behind
        # the generic host's ACCOUNT_IMPORT_FAILED, on every hosted OS.
        return subprocess.run([sys.executable, "-I", "-B", str(SCRIPT_PATH), *arguments],
                              env=environment, cwd=self.root, stdin=subprocess.DEVNULL,
                              capture_output=True, encoding="utf-8", timeout=20, check=False)

    def importer(self, environment):
        with mock.patch.dict(os.environ, environment, clear=True):
            return M.import_existing_account()

    def selected(self, provider_ref):
        return {"id": self.account_id, "companyBinding": "b" * 64,
                "providerRef": provider_ref, "name": "Существующий", "comment": ""}

    def test_absent_legacy_connection_returns_empty_before_storage_or_sdk(self):
        with mock.patch.object(M, "default_config_home", side_effect=AssertionError("No legacy storage to inspect")), \
             mock.patch.object(M, "build_client", side_effect=AssertionError("No Telegram during import")):
            self.assertEqual(self.importer(self.environment), {"schemaVersion": 1, "accounts": []})
        self.assertEqual(list(self.root.iterdir()), [])

    def test_real_isolated_importer_succeeds_without_old_connection_or_creating_storage(self):
        result = self.run_cli(["__trelio_accounts_import"], self.environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(json.loads(result.stdout), {"schemaVersion": 1, "accounts": []})
        self.assertEqual(list(self.root.iterdir()), [])

    def test_existing_other_scope_is_neither_scanned_nor_changed(self):
        self.legacy_root.mkdir(parents=True)
        sentinel = self.legacy_root / "synthetic-state"
        sentinel.write_bytes(b"SYNTHETIC_UNCHANGED")
        environment = {**self.environment, M.HOST_COMPANY_ID_ENV: self.target}
        with mock.patch.object(M, "default_config_home", side_effect=AssertionError("No cross-company discovery")):
            self.assertEqual(self.importer(environment)["accounts"], [])
        self.assertEqual(sentinel.read_bytes(), b"SYNTHETIC_UNCHANGED")

    def test_present_legacy_connection_preserves_exact_reference_and_files(self):
        self.legacy_root.mkdir(parents=True)
        sentinel = self.legacy_root / "synthetic-state"
        sentinel.write_bytes(b"SYNTHETIC_UNCHANGED")
        result = self.run_cli(["__trelio_accounts_import"], {**self.environment, M.HOST_CONNECTION_ID_ENV: self.connection})
        self.assertEqual(result.returncode, 0, result.stderr)
        account, = json.loads(result.stdout)["accounts"]
        self.assertEqual(account["sourceKey"], self.connection)
        self.assertEqual(account["scope"], "company")
        self.assertEqual(account["name"], "Основной аккаунт")
        self.assertEqual(json.loads(account["providerRef"]),
                         {"company_id": self.company, "member_id": self.member, "connection_id": self.connection})
        self.assertEqual(list(self.legacy_root.iterdir()), [sentinel])
        self.assertEqual(sentinel.read_bytes(), b"SYNTHETIC_UNCHANGED")

    def test_missing_or_removed_legacy_directory_remains_empty(self):
        environment = {**self.environment, M.HOST_CONNECTION_ID_ENV: self.connection}
        self.assertEqual(self.importer(environment)["accounts"], [])
        self.legacy_root.mkdir(parents=True)
        (self.legacy_root / "removed.json").write_text('{"removed":true}', encoding="utf-8")
        self.assertEqual(self.importer(environment)["accounts"], [])

    def test_existing_storage_error_cannot_become_successful_empty_import(self):
        environment = {**self.environment, M.HOST_CONNECTION_ID_ENV: self.connection}
        with mock.patch.object(pathlib.Path, "lstat", side_effect=PermissionError("SYNTHETIC_IO_FAILURE")):
            with self.assertRaises(PermissionError):
                self.importer(environment)

    def test_missing_or_invalid_live_identity_is_not_absence_of_legacy_data(self):
        for key in (M.HOST_COMPANY_ID_ENV, M.HOST_MEMBER_ID_ENV):
            for value in (None, "../invalid"):
                with self.subTest(key=key, value=value):
                    environment = dict(self.environment)
                    if value is None:
                        environment.pop(key)
                    else:
                        environment[key] = value
                    with self.assertRaises(M.TelegramRuntimeError):
                        self.importer(environment)
        for value in ("", "../invalid"):
            with self.subTest(connection=value), self.assertRaises(M.TelegramRuntimeError):
                self.importer({**self.environment, M.HOST_CONNECTION_ID_ENV: value})

    def test_selected_account_cannot_be_used_as_legacy_import_context(self):
        with self.assertRaises(M.TelegramRuntimeError):
            self.importer({**self.environment, "TRELIO_SKILL_ACCOUNT_JSON": json.dumps(self.selected(None))})

    def test_unselected_ordinary_command_still_requires_legacy_connection(self):
        with mock.patch.dict(os.environ, self.environment, clear=True), self.assertRaises(M.TelegramRuntimeError):
            M.identity_from_args(self.args)
        with self.assertRaises(M.TelegramRuntimeError):
            M.connection_root(M.Identity(self.company, self.member, None))

    def test_selected_imported_account_keeps_original_storage_and_live_target_identity(self):
        reference = json.dumps({"company_id": self.company, "member_id": self.member, "connection_id": self.connection})
        environment = {**self.environment, M.HOST_COMPANY_ID_ENV: self.target,
                       "TRELIO_SKILL_ACCOUNT_JSON": json.dumps(self.selected(reference))}
        with mock.patch.dict(os.environ, environment, clear=True):
            identity = M.identity_from_args(self.args)
            self.assertEqual((identity.company_id, identity.member_id, identity.connection_id), (self.target, self.member, None))
            self.assertEqual(M.connection_root(identity), self.legacy_root)
        # Read the existing local policy through the real post-selection CLI.
        # A successful bind must not immediately fail on the same missing ID,
        # open the SDK, or create a replacement target-company namespace.
        M.write_private_json(self.legacy_root / "config" / "policy.json", {"sendMode": "read-only"})
        result = self.run_cli(["policy", "show"], environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["policy"]["sendMode"], "read-only")
        self.assertFalse((self.config / "integrations" / M.SKILL_ID / self.target).exists())

    def test_new_selected_account_uses_uuid_storage_without_legacy_connection(self):
        environment = {**self.environment, "TRELIO_SKILL_ACCOUNT_JSON": json.dumps(self.selected(None))}
        with mock.patch.dict(os.environ, environment, clear=True):
            identity = M.identity_from_args(self.args)
            self.assertIsNone(identity.connection_id)
            self.assertEqual(M.connection_root(identity), self.config / "integrations" / M.SKILL_ID / "accounts" / self.account_id)

    def test_selected_account_does_not_waive_supplied_identity_or_binding_validation(self):
        environment = {**self.environment, "TRELIO_SKILL_ACCOUNT_JSON": json.dumps(self.selected(None))}
        for changes in ({M.HOST_CONNECTION_ID_ENV: "../invalid"},
                        {M.HOST_MEMBER_ID_ENV: "../invalid"},
                        {"TRELIO_SKILL_ACCOUNT_JSON": json.dumps({**self.selected(None), "companyBinding": "invalid"})}):
            with self.subTest(changes=changes), mock.patch.dict(os.environ, {**environment, **changes}, clear=True):
                with self.assertRaises(M.TelegramRuntimeError):
                    M.identity_from_args(self.args)
        with mock.patch.dict(os.environ, {**environment, M.HOST_CONNECTION_ID_ENV: self.connection}, clear=True):
            with self.assertRaises(M.TelegramRuntimeError):
                M.identity_from_args(argparse.Namespace(company_id=None, member_id=None, connection_id=self.target))
