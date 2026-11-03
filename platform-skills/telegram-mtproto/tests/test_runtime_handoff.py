"""Exercise the real interpreter handoff without Telegram or private state.

The host starts the signed entrypoint in its trusted system Python. Session
commands then switch to the provider venv. Mocking execve cannot detect Windows
CRT argument splitting or a launcher exiting before the venv child, so this
fixture creates a real venv and drives that boundary through captured pipes.
"""

import json
import ctypes
import importlib.util
import pathlib
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
import venv
from unittest import mock


SCRIPT_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "trelio-telegram.py"
DRIVER = r'''
import importlib.util, pathlib, sys
from unittest import mock
source, root, child, *arguments = sys.argv[1:]
spec = importlib.util.spec_from_file_location("telegram_handoff", source)
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)
root = pathlib.Path(root)
python = root / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
with mock.patch.object(runtime, "runtime_root", return_value=root), mock.patch.object(
    runtime, "runtime_python", return_value=python
), mock.patch.object(runtime, "__file__", child), mock.patch.object(
    sys, "argv", [child, *arguments]
):
    try:
        runtime.reexec_in_runtime_if_needed("dialogs")
    except runtime.TelegramRuntimeError as error:
        print(__import__("json").dumps(error.public_payload()), file=sys.stderr)
        raise SystemExit(2)
raise AssertionError("The launcher continued after the venv command finished")
'''
CHILD = r'''
import ctypes, json, os, sys, time
sys.stdout.reconfigure(encoding="utf-8")
# Delay completion to prove the parent preserves process/pipe supervision.
time.sleep(0.15)
status = int(sys.argv[-1])
if status == 3221225477:
    # Produce the reported NTSTATUS without touching invalid memory, personal
    # sessions or the network. Only the disposable test process exits.
    ctypes.windll.kernel32.ExitProcess(ctypes.c_uint(status))
print(json.dumps({"arguments": sys.argv[1:-1], "isolated": sys.flags.isolated,
                  "noBytecode": sys.dont_write_bytecode}, ensure_ascii=False), flush=True)
raise SystemExit(status)
'''


class TelegramRuntimeHandoffTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="telegram-handoff-")
        cls.root = pathlib.Path(cls.temporary.name) / "runtime with spaces"
        venv.EnvBuilder(with_pip=False).create(cls.root)
        cls.child = pathlib.Path(cls.temporary.name) / "entrypoint with spaces.py"
        cls.child.write_text(CHILD, encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def invoke(self, arguments, status=0):
        return subprocess.run(
            [sys.executable, "-I", "-B", "-c", DRIVER, str(SCRIPT_PATH),
             str(self.root), str(self.child), *arguments, str(status)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=20, check=False,
        )

    def test_search_phrase_quotes_unicode_and_empty_arguments_survive_handoff(self):
        arguments = ["dialogs", "--query", 'Рабочая база 🍕 "внутренняя"', "",
                     "tab\tseparated", "line\nbreak", "C:\\path with spaces\\"]
        completed = self.invoke(arguments)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stderr, b"")
        result = json.loads(completed.stdout.decode("utf-8"))
        self.assertEqual(result["arguments"], arguments)

    def test_child_uses_isolated_startup_and_preserves_nonzero_exit(self):
        completed = self.invoke(["read", "--chat", "synthetic_chat"], status=7)
        self.assertEqual(completed.returncode, 7, completed.stderr)
        result = json.loads(completed.stdout.decode("utf-8"))
        self.assertEqual(result["isolated"], 1)
        self.assertTrue(result["noBytecode"])

    @unittest.skipUnless(sys.platform == "win32", "Windows NTSTATUS process contract")
    def test_windows_native_failure_is_not_reported_as_success(self):
        completed = self.invoke(["read", "--chat", "synthetic_chat"], status=3221225477)
        self.assertEqual(completed.returncode, 2, completed.stderr)
        self.assertEqual(completed.stdout, b"")
        result = json.loads(completed.stderr.decode("utf-8"))
        self.assertEqual(result["code"], "TELEGRAM_WINDOWS_NATIVE_FAILURE")
        self.assertEqual(result["details"], {"stage": "venv_process", "exitCode": 3221225477,
                                            "windowsStatus": "0xC0000005"})
        self.assertNotIn(str(self.root), completed.stderr.decode("utf-8"))


class TelegramFirstLoginPreparationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("telegram_first_login", SCRIPT_PATH)
        cls.runtime = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = cls.runtime
        spec.loader.exec_module(cls.runtime)

    def exercise(self, command, *, present=False, failure=False, prepared=True, scope_failure=False):
        runtime = self.runtime
        # Only dependency preparation is mocked. Drive the production handoff
        # and its exact argument/startup boundary; no pip/network/account exists.
        python = mock.Mock()
        python.exists.return_value = present
        python.is_file.return_value = prepared
        python.__str__ = mock.Mock(return_value="synthetic-python.exe")
        with tempfile.TemporaryDirectory(prefix="telegram-first-login-") as directory, \
                mock.patch.object(runtime, "runtime_root", return_value=pathlib.Path(directory)), \
                mock.patch.object(runtime, "runtime_python", return_value=python), \
                mock.patch.object(runtime.sys, "platform", "win32"), \
                mock.patch.object(runtime, "command_bootstrap") as bootstrap, \
                mock.patch.object(runtime, "install_windows_process_scope", return_value=lambda: None) as scope, \
                mock.patch.object(runtime.subprocess, "run") as child:
            child.return_value.returncode = 0
            if failure:
                bootstrap.side_effect = runtime.TelegramRuntimeError("Synthetic install failure")
            if scope_failure:
                scope.side_effect = runtime.TelegramRuntimeError("Synthetic scope admission refusal")
            try:
                runtime.reexec_in_runtime_if_needed(command)
            except SystemExit as result:
                self.assertEqual(result.code, 0)
            except runtime.TelegramRuntimeError:
                pass
            return bootstrap.call_count, child.call_count, child.call_args

    def test_first_login_prepares_once_then_launches_one_isolated_child(self):
        installs, launches, arguments = self.exercise("login")
        self.assertEqual((installs, launches), (1, 1))
        self.assertEqual(arguments.args[0][:3], ["synthetic-python.exe", "-I", "-B"])
        self.assertIs(arguments.kwargs["shell"], False)

    def test_existing_login_environment_is_never_reinstalled(self):
        self.assertEqual(self.exercise("login", present=True)[:2], (0, 1))

    def test_failed_or_incomplete_preparation_never_starts_authentication(self):
        self.assertEqual(self.exercise("login", failure=True)[:2], (1, 0))
        self.assertEqual(self.exercise("login", prepared=False)[:2], (1, 0))

    def test_missing_read_monitor_ack_environment_never_installs_or_starts(self):
        for command in ["dialogs", "read", "monitor", "ack-reference"]:
            with self.subTest(command=command):
                self.assertEqual(self.exercise(command)[:2], (0, 0))

    def test_scope_failure_has_closed_diagnostic_without_native_prose(self):
        private = "synthetic-private-native-path-and-handle"
        module = SimpleNamespace(install_parent_bound_job=mock.Mock(side_effect=OSError(private)))
        spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda _module: None))
        with mock.patch.object(self.runtime.importlib.util, "spec_from_file_location", return_value=spec), \
                mock.patch.object(self.runtime.importlib.util, "module_from_spec", return_value=module):
            with self.assertRaises(self.runtime.TelegramRuntimeError) as caught:
                self.runtime.install_windows_process_scope()
        result = caught.exception.public_payload()
        self.assertEqual(result["code"], "TELEGRAM_WINDOWS_NATIVE_FAILURE")
        self.assertEqual(result["details"], {"stage": "process_scope"})
        self.assertNotIn(private, json.dumps(result))

    def test_scope_refusal_never_starts_the_venv_provider(self):
        self.assertEqual(self.exercise("monitor", present=True, scope_failure=True)[:2], (0, 0))


@unittest.skipUnless(sys.platform == "win32", "Native Windows job/handle/session-lock contract")
class TelegramWindowsLifetimeTests(unittest.TestCase):
    """Real parent death/launcher timeout, without Telegram or private state.

    The negative control disables ONLY the newly added scope in the real
    production handoff. It must reproduce a surviving child holding a native
    lock. The fixed path must release that same lock after either ancestor
    dies, while a separate Python fixture survives. No PID inventory or global
    taskkill is used; cleanup owns bound handles to these disposable children.
    """

    LAUNCHER = r'''
import importlib.util, pathlib, sys
from unittest import mock
source, root, child, mode, lock = sys.argv[1:]
# HOST releases this gate only after publishing launcher identity. Direct
# launcher fixtures use DEVNULL and continue immediately on EOF.
sys.stdin.readline()
spec = importlib.util.spec_from_file_location("telegram_lifetime", source)
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)
if mode == "legacy":
    runtime.install_windows_process_scope = lambda: (lambda: None)
with mock.patch.object(runtime, "runtime_root", return_value=pathlib.Path(root)), \
     mock.patch.object(runtime, "runtime_python", return_value=pathlib.Path(root)/"Scripts/python.exe"), \
     mock.patch.object(runtime, "__file__", child), mock.patch.object(sys, "argv", [child, lock]):
    runtime.reexec_in_runtime_if_needed("monitor")
'''
    HOST = r'''
import json, subprocess, sys
p = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE)
print(json.dumps({"launcher": p.pid}), flush=True)
p.stdin.write(b"start\n")
p.stdin.close()
raise SystemExit(p.wait())
'''
    LOCK_CHILD = r'''
import json, msvcrt, os, sys, time
with open(sys.argv[1], "a+b") as lock:
    lock.seek(0)
    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    print(json.dumps({"child": os.getpid(), "parent": os.getppid()}), flush=True)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline: time.sleep(0.05)
'''

    def setUp(self):
        from ctypes import wintypes
        self.kernel = ctypes.WinDLL("kernel32.dll", use_last_error=True, winmode=0x800)
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel.WaitForSingleObject.restype = wintypes.DWORD
        self.kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]

    def handle(self, pid):
        result = self.kernel.OpenProcess(0x1000 | 0x00100000 | 1, False, pid)
        self.assertTrue(result, "The fixture process must still exist at readiness")
        return result

    def assert_lock_free(self, lock):
        import msvcrt
        with lock.open("r+b") as stream:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)

    def exercise(self, *, legacy=False, kill_host=False):
        with tempfile.TemporaryDirectory(prefix="telegram-job-") as directory:
            root = pathlib.Path(directory)
            venv_root, child, lock = root/"venv with spaces", root/"child with spaces.py", root/"owned.lock"
            venv.EnvBuilder(with_pip=False).create(venv_root)
            child.write_text(self.LOCK_CHILD, encoding="utf-8")
            lock.write_bytes(b"0")
            command = [sys.executable, "-I", "-B", "-c", self.LAUNCHER,
                       str(SCRIPT_PATH), str(venv_root), str(child), "legacy" if legacy else "fixed", str(lock)]
            if kill_host:
                command = [sys.executable, "-I", "-B", "-c", self.HOST, *command]
            owner = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            unrelated = subprocess.Popen([sys.executable, "-I", "-B", "-c", "import time; time.sleep(60)"],
                                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            handles = []
            try:
                # A blocked readiness pipe fails the bounded fixture instead of
                # hanging a hosted runner. Timer owns only this test parent.
                import threading
                watchdog = threading.Timer(20, owner.kill)
                watchdog.start()
                try:
                    launcher = json.loads(owner.stdout.readline())["launcher"] if kill_host else owner.pid
                    ready = json.loads(owner.stdout.readline())
                finally:
                    watchdog.cancel()
                # Windows venv redirectors may add another intermediary PID.
                # The private fixture pipe establishes the child; do not assume
                # a single-hop process tree and accidentally miss that case.
                self.assertGreater(ready["parent"], 0)
                self.assertNotEqual(ready["child"], launcher)
                child_handle = self.handle(ready["child"])
                handles.append(child_handle)
                launcher_handle = self.handle(launcher)
                handles.append(launcher_handle)
                owner.kill()  # Real process death; no Python finally/atexit.
                owner.wait(timeout=5)
                if legacy:
                    self.assertEqual(self.kernel.WaitForSingleObject(child_handle, 200), 258,
                                     "Negative control must reproduce the orphan")
                    import msvcrt
                    with lock.open("r+b") as stream:
                        with self.assertRaises(OSError):
                            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    self.assertEqual(self.kernel.WaitForSingleObject(child_handle, 5000), 0,
                                     "Venv child survived the supervised owner")
                    self.assertEqual(self.kernel.WaitForSingleObject(launcher_handle, 5000), 0)
                    self.assert_lock_free(lock)
                self.assertIsNone(unrelated.poll(), "Another Python invocation must not be touched")
            finally:
                # Only handles obtained from our own readiness pipe. The legacy
                # control intentionally leaks a child, so reap that fixture.
                for handle in handles:
                    if self.kernel.WaitForSingleObject(handle, 0) == 258:
                        self.kernel.TerminateProcess(handle, 1)
                        self.kernel.WaitForSingleObject(handle, 5000)
                    self.kernel.CloseHandle(handle)
                if owner.poll() is None:
                    owner.kill()
                owner.communicate(timeout=5)
                unrelated.terminate()
                unrelated.wait(timeout=5)

    def test_legacy_handoff_reproduces_orphan_and_native_lock(self):
        self.exercise(legacy=True)

    def test_launcher_timeout_reaps_child_and_releases_lock(self):
        self.exercise()

    def test_abrupt_host_death_reaps_launcher_child_and_releases_lock(self):
        self.exercise(kill_host=True)


if __name__ == "__main__":
    unittest.main()
