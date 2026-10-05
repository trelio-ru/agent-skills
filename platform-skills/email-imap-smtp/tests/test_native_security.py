"""Real OS checks use isolated synthetic stores and owned child processes."""

import contextlib
import ctypes
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.parse
from unittest import mock

from test_trelio_email import MODULE

NATIVE = MODULE.native_runtime()
FIXTURE = Path(__file__).with_name("native_fixture.py").resolve()


def alive(pid):
    if sys.platform == "win32":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_uint32()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle(handle)
    # kill(0) also sees a zombie. ps distinguishes a terminated owned child
    # awaiting reaping from a live credential-bearing process on macOS.
    result = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
    return result.returncode == 0 and not result.stdout.lstrip().startswith("Z")


class NativeBoundaryTests(unittest.TestCase):
    def test_protocol_write_rechecks_native_permit_before_any_bytes(self):
        with mock.patch.object(MODULE.imaplib.IMAP4, "_command") as imap, \
             mock.patch.object(MODULE.smtplib.SMTP, "send") as send, \
             mock.patch.object(MODULE.smtplib.SMTP, "putcmd") as command, \
             mock.patch.object(MODULE, "require_credential_lease", side_effect=MODULE.MailboxError("expired")):
            MODULE.install_native_network_barriers()
            for operation in (MODULE.imaplib.IMAP4._command, MODULE.smtplib.SMTP.send, MODULE.smtplib.SMTP.putcmd):
                with self.assertRaisesRegex(MODULE.MailboxError, "expired"):
                    operation(None, "synthetic-protocol-command")
            imap.assert_not_called(); send.assert_not_called(); command.assert_not_called()

    def test_ambient_credentials_and_python_injection_are_not_inherited(self):
        with mock.patch.dict(os.environ, {"TRELIO_EMAIL_PASSWORD_WORK": "synthetic", "PYTHONPATH": "synthetic", "HOME": "/synthetic"}):
            environment = NATIVE.child_environment()
        self.assertNotIn("TRELIO_EMAIL_PASSWORD_WORK", environment)
        self.assertNotIn("PYTHONPATH", environment)
        self.assertEqual(environment["HOME"], "/synthetic")

    def test_unsupported_os_blocks_before_store_or_compiler(self):
        with mock.patch.object(NATIVE.sys, "platform", "linux"), mock.patch.object(NATIVE, "run_private") as run:
            with self.assertRaisesRegex(NATIVE.NativeError, "unsupported_os"):
                NATIVE.native_helper(Path("/unused"))
            run.assert_not_called()

    def test_native_error_never_echoes_password_or_compiler_output(self):
        output = subprocess.CompletedProcess([], 2, b"synthetic-secret", b"synthetic-secret")
        with mock.patch.object(NATIVE.subprocess, "run", return_value=output):
            with self.assertRaisesRegex(NATIVE.NativeError, "^native_email_operation_failed$"):
                NATIVE.run_private("/unused", [], value=b"synthetic-secret")


@unittest.skipUnless(sys.platform in {"darwin", "win32"}, "native supported OS only")
class NativeLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name).resolve()
        cls.helper = NATIVE.native_helper(cls.root)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def launch(self, mode, duration=1200, **extra):
        pid_file = self.root / ("pid-" + str(time.time_ns()))
        process = subprocess.Popen(
            [str(self.helper), "guard", sys.executable, str(FIXTURE), str(duration)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=NATIVE.child_environment(), start_new_session=sys.platform == "darwin",
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        def cleanup():
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()
        self.addCleanup(cleanup)
        process.stdin.write((json.dumps({"mode": mode, "pidFile": str(pid_file), **extra}) + "\n").encode())
        process.stdin.flush()
        end = time.monotonic() + 5
        while not pid_file.exists() and process.poll() is None and time.monotonic() < end:
            time.sleep(0.02)
        self.assertTrue(pid_file.exists(), process.stderr.read() if process.poll() is not None else "worker did not start")
        return process, int(pid_file.read_text())

    def assert_reaped(self, process, pid, timeout=5):
        process.wait(timeout=timeout)
        end = time.monotonic() + 3
        while alive(pid) and time.monotonic() < end:
            time.sleep(0.03)
        self.assertFalse(alive(pid), "native guardian left its worker alive")

    def test_result_survives_child_cleanup_and_unicode(self):
        process, pid = self.launch("result", 5000)
        packet = json.loads(process.stdout.readline())
        self.assertEqual(packet["op"], "result")
        self.assertEqual(json.loads(packet["value"]), {"ok": True, "synthetic": "пароль не нужен"})
        self.assert_reaped(process, pid)
        self.assertEqual(process.returncode, 0)

    def test_system_opener_is_delegated_to_wrapper_outside_owned_job(self):
        process, pid = self.launch("open", 5000)
        packet = json.loads(process.stdout.readline())
        self.assertEqual(packet["op"], "open")
        process.stdin.write(b'{"ok":true}\n'); process.stdin.flush()
        result = json.loads(process.stdout.readline())
        self.assertEqual(result["op"], "result")
        self.assertNotIn("127.0.0.1", result["value"])
        self.assert_reaped(process, pid)

    def test_native_deadline_kills_hung_or_stopped_worker(self):
        process, pid = self.launch("hang")
        if sys.platform == "darwin":
            os.kill(pid, signal.SIGSTOP)
        self.assert_reaped(process, pid)
        self.assertNotEqual(process.returncode, 0)

    def test_crashed_worker_reaps_guardian(self):
        process, pid = self.launch("crash", 5000)
        self.assert_reaped(process, pid)

    def test_caller_loss_kills_hung_worker(self):
        process, pid = self.launch("hang", 5000)
        process.stdin.close()
        self.assert_reaped(process, pid)

    def test_guardian_loss_closes_healthy_worker(self):
        process, pid = self.launch("healthy", 5000)
        # Windows kernel Job cleanup also works on forced guardian termination.
        process.kill()
        self.assert_reaped(process, pid)

    def test_original_expiry_is_not_restarted_by_native_startup(self):
        now = int(time.time() * 1000)
        # Leave enough time for a loaded Windows runner to start the fixture.
        # The guardian receives a longer nominal duration, so finishing near
        # the original five-second expiry still proves native startup did not
        # restart the lease from twelve seconds.
        process, pid = self.launch("hang", 12000, startedAt=now - NATIVE.MAXIMUM_LEASE_MS + 5000,
                                   expiresAt=now + 5000)
        self.assert_reaped(process, pid, timeout=7)

    def test_refuses_deadline_above_thirty_minutes(self):
        result = subprocess.run([str(self.helper), "guard", sys.executable, str(FIXTURE), "1800001"],
                                input=b'{}\n', capture_output=True, start_new_session=sys.platform == "darwin")
        self.assertNotEqual(result.returncode, 0)

    def test_private_cache_rejects_symlink(self):
        if sys.platform != "darwin":
            self.skipTest("Windows reparse acceptance is covered separately")
        alias = self.root / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(NATIVE.NativeError, "unsafe_storage"):
            NATIVE.native_helper(alias)

    def run_real_worker(self, arguments, opener):
        # Give the actual child its own empty HOME. It cannot inspect the user's
        # real accounts, and all generated native/cache files stay in this test.
        home = self.root / ("home-" + str(time.time_ns()))
        home.mkdir(mode=0o700)
        environment = NATIVE.child_environment()
        environment.update({"HOME": str(home), "USERPROFILE": str(home)})
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(NATIVE, "native_helper", return_value=self.helper), \
             mock.patch.object(NATIVE, "child_environment", return_value=environment), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = NATIVE.supervise(home / ".config/trelio/email", arguments, terminal=False,
                                    started_at=int(time.time() * 1000), opener=opener)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_real_worker_error_is_structured_without_reading_real_accounts(self):
        code, stdout, stderr = self.run_real_worker(["doctor", "--account", "synthetic-missing"], mock.Mock())
        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertFalse(json.loads(stderr)["ok"])
        self.assertIn("not configured", json.loads(stderr)["error"])

    def test_real_browser_cancel_closes_form_and_never_returns_nonce(self):
        opened = []
        def opener(url):
            opened.append(url)
            location = urllib.parse.urlsplit(url)
            client = http.client.HTTPConnection(location.hostname, location.port, timeout=3)
            client.request("GET", location.path)
            response = client.getresponse()
            self.assertEqual(response.status, 200)
            page = response.read().decode()
            self.assertIn("Gmail", page)
            client.close()
            client = http.client.HTTPConnection(location.hostname, location.port, timeout=3)
            client.request("POST", location.path, body="cancel=1", headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": f"http://{location.netloc}",
            })
            response = client.getresponse()
            self.assertEqual(response.status, 200)
            self.assertTrue(json.loads(response.read())["cancelled"])
            client.close()
        code, stdout, stderr = self.run_real_worker(["configure", "--account", "synthetic"], opener)
        self.assertEqual(code, 2)
        self.assertEqual(len(opened), 1)
        self.assertNotIn("127.0.0.1", stdout + stderr)
        self.assertNotIn(urllib.parse.urlsplit(opened[0]).path, stdout + stderr)
        self.assertNotIn("Traceback", stderr)
        location = urllib.parse.urlsplit(opened[0])
        client = http.client.HTTPConnection(location.hostname, location.port, timeout=1)
        with self.assertRaises(OSError):
            client.request("GET", location.path)
        client.close()


@unittest.skipUnless(sys.platform == "win32", "real Windows DPAPI and ACL only")
class WindowsStorageTests(unittest.TestCase):
    def test_real_dpapi_roundtrip_tamper_identity_and_no_plaintext(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            value = " synthetic почта password\n".encode()
            self.assertEqual(NATIVE.windows_password(root, "synthetic", "a@example.invalid", value), b"")
            self.assertEqual(NATIVE.windows_password(root, "synthetic", "a@example.invalid"), value)
            helper = NATIVE.native_helper(root)
            encrypted = next((root / "secrets/encrypted").glob("*.dpapi"))
            self.assertNotIn(value, encrypted.read_bytes())
            NATIVE.run_private(helper, ["verify-file", str(encrypted)])
            with self.assertRaises(NATIVE.NativeError):
                NATIVE.run_private(helper, ["password-read", str(encrypted), "0" * 64])
            data = bytearray(encrypted.read_bytes()); data[len(data) // 2] ^= 1; encrypted.write_bytes(data)
            with self.assertRaises(NATIVE.NativeError):
                NATIVE.windows_password(root, "synthetic", "a@example.invalid")


@unittest.skipUnless(sys.platform == "darwin", "real isolated macOS Keychain only")
class MacKeychainTests(unittest.TestCase):
    def test_isolated_keychain_add_update_read_and_missing_identity(self):
        # SecKeychainCreate returns a private test handle; it does not replace
        # the user's default keychain or modify any real email item/ACL.
        with tempfile.TemporaryDirectory() as temporary:
            security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
            core = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
            pointer = ctypes.c_void_p
            security.SecKeychainCreate.argtypes = [ctypes.c_char_p, ctypes.c_uint32, pointer, ctypes.c_bool, pointer, ctypes.POINTER(pointer)]
            security.SecKeychainCreate.restype = ctypes.c_int32
            security.SecKeychainDelete.argtypes = [pointer]
            security.SecKeychainDelete.restype = ctypes.c_int32
            core.CFRelease.argtypes = [pointer]
            handle = pointer()
            synthetic = b"synthetic-keychain-only"
            path = str(Path(temporary).resolve() / "synthetic.keychain-db").encode()
            self.assertEqual(security.SecKeychainCreate(path, len(synthetic), synthetic, False, None, ctypes.byref(handle)), 0)
            account = MODULE.Account("synthetic", "a@example.invalid", "", "a@example.invalid", "imap.example.invalid", 993,
                                     "smtp.example.invalid", 465, "ssl", "keychain")
            try:
                for value in (" synthetic пароль\n", " updated пароль\n"):
                    MODULE.store_keychain_password(account, value, keychain=handle)
                    self.assertEqual(MODULE.load_keychain_password(account, keychain=handle), value)
                other = MODULE.Account("other", "a@example.invalid", "", "a@example.invalid", "imap.example.invalid", 993,
                                       "smtp.example.invalid", 465, "ssl", "keychain")
                with self.assertRaisesRegex(MODULE.MailboxError, "OSStatus -25300"):
                    MODULE.load_keychain_password(other, keychain=handle)
                self.assertNotIn("updated пароль".encode(), Path(path.decode()).read_bytes())
            finally:
                self.assertEqual(security.SecKeychainDelete(handle), 0)
                core.CFRelease(handle)
