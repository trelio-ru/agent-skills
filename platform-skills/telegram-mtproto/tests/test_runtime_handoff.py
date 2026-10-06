"""Exercise the real interpreter handoff without Telegram or private state.

The host starts the signed entrypoint in its trusted system Python. Session
commands then switch to the provider venv. Mocking execve cannot detect Windows
CRT argument splitting or a launcher exiting before the venv child, so this
fixture creates a real venv and drives that boundary through captured pipes.
"""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
import venv


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
    runtime.reexec_in_runtime_if_needed("dialogs")
raise AssertionError("The launcher continued after the venv command finished")
'''
CHILD = r'''
import ctypes, json, os, sys, time
sys.stdout.reconfigure(encoding="utf-8")
# Delay completion to prove the parent preserves process/pipe supervision.
time.sleep(0.15)
status = int(sys.argv[-1])
print(json.dumps({"arguments": sys.argv[1:-1], "isolated": sys.flags.isolated,
                  "noBytecode": sys.dont_write_bytecode}, ensure_ascii=False), flush=True)
if status == 3221225477:
    # Produce the reported NTSTATUS without touching invalid memory, personal
    # sessions or the network. Only the disposable test process exits.
    ctypes.windll.kernel32.ExitProcess(ctypes.c_uint(status))
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
        self.assertEqual(completed.returncode & 0xFFFFFFFF, 3221225477, completed.stderr)
        self.assertEqual(json.loads(completed.stdout.decode("utf-8"))["arguments"],
                         ["read", "--chat", "synthetic_chat"])


if __name__ == "__main__":
    unittest.main()
