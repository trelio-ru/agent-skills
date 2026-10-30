"""Local erasure uses the original session lock and never opens the SDK."""
import pathlib
import os
import subprocess
from types import SimpleNamespace
import tempfile
import unittest
from unittest import mock
import test_message_workflows as base

M = base.M

class AccountRemovalTests(unittest.TestCase):
    def setUp(self):
        self.directory = self.enterContext(tempfile.TemporaryDirectory())
        self.root = pathlib.Path(self.directory).resolve() / 'selected'
        self.sibling = pathlib.Path(self.directory).resolve() / 'sibling'
        M.ensure_private_directory(self.root)
        M.ensure_private_directory(self.sibling)
        self.identity = M.Identity('company', 'member', 'connection', account={
            'id':'12345678-1234-4234-8234-123456789abc', 'providerRef':None, 'companyBinding':'a'*64})
        self.enterContext(mock.patch.object(M, 'connection_root', return_value=self.root))
        self.sdk = self.enterContext(mock.patch.object(M, 'build_client', side_effect=AssertionError('No SDK during removal')))
        self.file = self.root / 'state' / 'telegram.session'
        M.write_private_text(self.file, 'SYNTHETIC_SESSION')
        M.write_private_json(self.root / 'config' / 'policy.json', {'sendMode':'confirm'})
        M.write_private_text(self.sibling / 'keep', 'SYNTHETIC_SIBLING')

    def test_erases_login_policy_and_cursor_but_keeps_only_lock_and_tombstone(self):
        M.write_private_text(self.root / 'overview-cursor-key.json', 'SYNTHETIC_KEY')
        result = M.remove_local_account(self.identity)
        self.assertEqual(result, {'schemaVersion':1, 'removed':True, 'accountId':self.identity.account['id']})
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ['locks','removed.json'])
        self.assertEqual((self.sibling / 'keep').read_text(), 'SYNTHETIC_SIBLING')
        with self.assertRaises(M.TelegramRuntimeError) as caught:
            with M.session_lock(self.identity): pass
        self.assertEqual(caught.exception.code, 'TELEGRAM_ACCOUNT_REMOVED')
        self.assertEqual(M.remove_local_account(self.identity), result, 'exact local erasure is idempotent')
        self.sdk.assert_not_called()

    def test_busy_session_refuses_before_erasure(self):
        with M.session_lock(self.identity):
            with self.assertRaises(M.TelegramRuntimeError): M.remove_local_account(self.identity)
        self.assertTrue(self.file.exists())
        self.assertFalse((self.root / 'removed.json').exists())

    def test_symlink_is_rejected_before_any_session_deletion(self):
        try: (self.root / 'foreign').symlink_to(self.sibling, target_is_directory=True)
        except OSError: self.skipTest('This OS user cannot create a symlink')
        with self.assertRaises(M.TelegramRuntimeError): M.remove_local_account(self.identity)
        self.assertTrue(self.file.exists()); self.assertTrue((self.sibling / 'keep').exists())

    def test_partial_failure_retains_block_and_resumes_only_exact_local_cleanup(self):
        original = pathlib.Path.unlink
        def fail(path, *args, **kwargs):
            if path == self.file: raise PermissionError('SYNTHETIC_PRIVATE_PATH')
            return original(path, *args, **kwargs)
        with mock.patch.object(pathlib.Path, 'unlink', fail):
            with self.assertRaises(PermissionError): M.remove_local_account(self.identity)
        self.assertTrue((self.root / 'removed.json').exists())
        with self.assertRaises(M.TelegramRuntimeError):
            with M.session_lock(self.identity): pass
        self.assertTrue(M.remove_local_account(self.identity)['removed'])

    def test_reparse_ancestor_is_refused_before_lock_or_erasure_on_every_platform(self):
        original = pathlib.Path.lstat
        def reparse(path, *args, **kwargs):
            metadata = original(path, *args, **kwargs)
            return SimpleNamespace(st_mode=metadata.st_mode, st_file_attributes=0x400) if path == self.root else metadata
        with mock.patch.object(pathlib.Path, 'lstat', reparse):
            with self.assertRaises(M.TelegramRuntimeError): M.remove_local_account(self.identity)
        self.assertFalse((self.root / 'locks').exists())
        self.assertTrue(self.file.exists()); self.assertTrue((self.sibling / 'keep').exists())

    @unittest.skipUnless(os.name == 'nt', 'Native NTFS junction fixture')
    def test_native_windows_junction_and_junction_ancestor_do_not_touch_target(self):
        link = self.root / 'junction'
        made = subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', str(link), str(self.sibling)],
                              capture_output=True, timeout=10)
        self.assertEqual(made.returncode, 0, 'Native junction fixture failed')
        with self.assertRaises(M.TelegramRuntimeError): M.remove_local_account(self.identity)
        self.assertTrue(self.file.exists()); self.assertTrue((self.sibling / 'keep').exists())
        with mock.patch.object(M, 'connection_root', return_value=link / 'uncreated-account'):
            with self.assertRaises(M.TelegramRuntimeError): M.remove_local_account(self.identity)
        self.assertFalse((self.sibling / 'uncreated-account').exists())
        self.assertFalse((self.root / 'removed.json').exists())
