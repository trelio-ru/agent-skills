"""Closed monitor failures, including actual cross-process session contention.

Only synthetic identities/directories are used. The contender exercises main,
the real native lock and real UTF-8 pipes; no SDK, account or network is opened.
"""
import asyncio
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace as NS
from unittest import mock

import test_assistant_monitor as base

M = base.M


class MonitorDiagnostics(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.identity = M.Identity('synthetic-company', 'synthetic-member', 'synthetic-connection')
        self.enterContext(mock.patch.object(M, 'connection_root', return_value=self.root))

    def test_native_session_contention_is_coded_before_sdk_and_keeps_owner_lock(self):
        # Use two real processes: an in-process mock or lock-file existence
        # cannot prove native Windows/POSIX locking and stream serialization.
        setup = """
import importlib.util, pathlib, sys
from types import SimpleNamespace as NS
spec = importlib.util.spec_from_file_location('monitor_lock_fixture', sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules[spec.name] = m; spec.loader.exec_module(m)
root = pathlib.Path(sys.argv[2]); m.connection_root = lambda identity: root
identity = m.Identity('synthetic-company','synthetic-member','synthetic-connection')
m.identity_from_args = lambda args: identity
m.reexec_in_runtime_if_needed = lambda command: None
def forbidden(*args, **kwargs): raise AssertionError('SYNTHETIC_PRIVATE_SDK_CANARY')
m.build_client = forbidden
"""
        env = {k: v for k, v in os.environ.items() if not k.startswith(('TRELIO_', 'PYTHON'))}
        owner_code = setup + "\nwith m.session_lock(identity):\n print('locked', flush=True)\n sys.stdin.readline()\n"
        owner = subprocess.Popen([sys.executable, '-I', '-B', '-c', owner_code, str(base.PATH), str(self.root)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, encoding='utf-8', env=env)
        try:
            self.assertEqual(owner.stdout.readline().strip(), 'locked')
            contender_code = setup + "\nsys.argv = ['fixture', 'monitor']\nraise SystemExit(m.main())\n"
            def contend():
                return subprocess.run([sys.executable, '-I', '-B', '-c', contender_code,
                                       str(base.PATH), str(self.root)], capture_output=True,
                                      text=True, encoding='utf-8', env=env, timeout=15)
            first = contend()
            self.assertEqual(first.returncode, 2)
            self.assertEqual(first.stdout, '')
            payload = json.loads(first.stderr)
            self.assertEqual(payload.get('code'), 'TELEGRAM_REQUEST_FAILED')
            self.assertEqual(payload['details']['diagnostic'], {
                'category': 'local_session_busy', 'stage': 'session_lock',
                'nextStep': 'wait_for_session_owner', 'automaticRetry': False})
            self.assertNotIn(str(self.root), first.stderr)
            self.assertNotIn('SYNTHETIC_PRIVATE', first.stderr)
            # A rejected contender must not release the other process's lock.
            self.assertEqual(json.loads(contend().stderr).get('code'), 'TELEGRAM_REQUEST_FAILED')
        finally:
            owner.communicate('\n', timeout=15)
        self.assertEqual(owner.returncode, 0)
        with M.session_lock(self.identity):
            pass

    def test_unauthorized_session_is_explicit_and_disconnects_once(self):
        provider = base.Provider(); provider.authorized = False
        with mock.patch.object(M, 'build_client', return_value=provider):
            with self.assertRaises(M.TelegramRuntimeError) as caught:
                asyncio.run(M.command_monitor_async(NS(command='monitor', limit=100), self.identity))
        self.assertEqual(caught.exception.code, 'TELEGRAM_SESSION_UNAVAILABLE')
        self.assertEqual(provider.calls, [])
        provider.disconnect.assert_awaited_once()

    def test_uncoded_binding_failure_has_fixed_stage_without_error_prose(self):
        provider = base.Provider()
        provider.get_me = mock.AsyncMock(side_effect=M.TelegramRuntimeError('SYNTHETIC_PRIVATE_CANARY'))
        with mock.patch.object(M, 'build_client', return_value=provider), \
             mock.patch.object(M, 'import_telethon_monitor', return_value=(*base.FUNCTIONS, NS(get_peer_id=base.peer_id))):
            with self.assertRaises(M.TelegramRuntimeError) as caught:
                asyncio.run(M.command_monitor_async(NS(command='monitor', limit=100), self.identity))
        payload = caught.exception.public_payload()
        self.assertEqual(payload.get('code'), 'TELEGRAM_MONITOR_UNAVAILABLE')
        self.assertEqual(payload['details']['diagnostic']['stage'], 'account_binding')
        self.assertNotIn('SYNTHETIC_PRIVATE', json.dumps(payload))
        self.assertEqual(provider.calls, [])
        provider.disconnect.assert_awaited_once()

    def test_preparation_failure_is_closed_without_starting_a_client(self):
        with mock.patch.object(M, 'build_client', side_effect=M.TelegramRuntimeError('SYNTHETIC_PRIVATE_CANARY')) as build:
            with self.assertRaises(M.TelegramRuntimeError) as caught:
                asyncio.run(M.command_monitor_async(NS(command='monitor', limit=100), self.identity))
        payload = caught.exception.public_payload()
        self.assertEqual(payload.get('code'), 'TELEGRAM_MONITOR_UNAVAILABLE')
        self.assertEqual(payload['details']['diagnostic']['stage'], 'client_preparation')
        self.assertNotIn('SYNTHETIC_PRIVATE', json.dumps(payload))
        build.assert_called_once()

    def test_existing_gap_keeps_original_code_and_never_yields_a_cursor(self):
        provider = base.Provider()
        expected = M.TelegramRuntimeError('Retain original checkpoint.', code='TELEGRAM_MONITOR_GAP')
        provider.get_me = mock.AsyncMock(side_effect=expected)
        with mock.patch.object(M, 'build_client', return_value=provider), \
             mock.patch.object(M, 'import_telethon_monitor', return_value=(*base.FUNCTIONS, NS(get_peer_id=base.peer_id))):
            with self.assertRaises(M.TelegramRuntimeError) as caught:
                asyncio.run(M.command_monitor_async(NS(command='monitor', limit=100), self.identity))
        self.assertIs(caught.exception, expected)
        self.assertNotIn('nextCursor', caught.exception.public_payload())
        provider.disconnect.assert_awaited_once()

    def test_known_transport_identity_keeps_monitor_code_and_fixed_diagnostic(self):
        error = TimeoutError('SYNTHETIC_PRIVATE_HTTP_CANARY')
        payload = M.monitor_failure(error, stage='native_difference').public_payload()
        self.assertEqual(payload['code'], 'TELEGRAM_MONITOR_UNAVAILABLE')
        self.assertEqual(payload['details']['diagnostic'], {
            'category': 'timeout', 'stage': 'native_difference',
            'nextStep': 'check_connection_then_read', 'automaticRetry': False})
        self.assertNotIn('SYNTHETIC_PRIVATE', json.dumps(payload))
        # A legacy or uncertain write keeps its own code and recovery meaning.
        unknown = M.TelegramRuntimeError('Verify exact result.', code='TELEGRAM_ACTION_OUTCOME_UNKNOWN')
        self.assertIs(M.monitor_failure(unknown, stage='session_preflight'), unknown)

    def test_coded_client_preparation_failure_keeps_identity_without_self_cause(self):
        expected = M.TelegramRuntimeError('Review connection.', code='TELEGRAM_SESSION_UNAVAILABLE')
        with mock.patch.object(M, 'build_client', side_effect=expected):
            with self.assertRaises(M.TelegramRuntimeError) as caught:
                asyncio.run(M.command_monitor_async(NS(command='monitor', limit=100), self.identity))
        self.assertIs(caught.exception, expected)
        self.assertIsNone(expected.__cause__)

    def test_main_preserves_reader_stage_instead_of_reclassifying_as_command(self):
        provider = base.Provider()
        provider.get_me = mock.AsyncMock(side_effect=TimeoutError('SYNTHETIC_PRIVATE_CANARY'))
        stderr, stdout = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, 'argv', ['fixture', 'monitor']), \
             mock.patch.object(sys, 'stderr', stderr), mock.patch.object(sys, 'stdout', stdout), \
             mock.patch.object(M, 'identity_from_args', return_value=self.identity), \
             mock.patch.object(M, 'reexec_in_runtime_if_needed'), \
             mock.patch.object(M, 'build_client', return_value=provider), \
             mock.patch.object(M, 'import_telethon_monitor', return_value=(*base.FUNCTIONS, NS(get_peer_id=base.peer_id))):
            self.assertEqual(M.main(), 2)
        payload = json.loads(stderr.getvalue())
        self.assertEqual(payload['details']['diagnostic']['stage'], 'account_binding')
        self.assertEqual(payload['details']['diagnostic']['category'], 'timeout')
        self.assertNotIn('SYNTHETIC_PRIVATE', stderr.getvalue())
        self.assertEqual(stdout.getvalue(), '')
        provider.disconnect.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
