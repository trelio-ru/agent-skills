"""Exercise the real interpreter handoff without Telegram or private state.

The host starts the signed entrypoint in its trusted system Python. Session
commands then switch to the provider venv. Mocking execve cannot detect Windows
CRT argument splitting or a launcher exiting before the venv child, so this
fixture creates a real venv and drives that boundary through captured pipes.
"""

import json
import importlib.util
import pathlib
import subprocess
import sys
import tempfile
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

    def exercise(self, command, *, present=False, failure=False, prepared=True):
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
                mock.patch.object(runtime.subprocess, "run") as child:
            child.return_value.returncode = 0
            if failure:
                bootstrap.side_effect = runtime.TelegramRuntimeError("Synthetic install failure")
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


if __name__ == "__main__":
    unittest.main()
