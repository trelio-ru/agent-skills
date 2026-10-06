"""Exercise real CLI pipes without a Telegram account, session or network."""

import json
import os
import pathlib
import subprocess
import sys
import unittest


SCRIPT_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "trelio-telegram.py"
UNICODE_TEXT = "Рабочий чат 🧑‍💻 – 東京"
# A subprocess is essential here: StringIO cannot expose a Windows code-page
# failure, and decoding captured output with the same legacy encoding would
# hide corruption at the generic host's UTF-8 boundary. Only provider execution
# and venv reexec are replaced; the actual parser, main and serializers run.
CHILD_CODE = r'''
import codecs
import importlib.util
import sys
from unittest import mock

script_path, scenario, initial_encoding = sys.argv[1:]
assert codecs.lookup(sys.stdout.encoding).name == codecs.lookup(initial_encoding).name
stdin_encoding = sys.stdin.encoding
spec = importlib.util.spec_from_file_location("telegram_cli_output", script_path)
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)
text = "Рабочий чат 🧑‍💻 – 東京"
result = {
    "dialogs": [{"id": -10012345, "title": text}],
    "messages": [{"id": 42, "text": text}],
}
arguments = ["dialogs"]
if scenario in {"export", "daily-export"}:
    arguments = [scenario, "--chat", "synthetic_chat", "--since", "2026-10-01", "--until", "2026-10-02"]
elif scenario == "parser-error":
    arguments = [text]
error = runtime.TelegramRuntimeError(text, code="SYNTHETIC_TELEGRAM_ERROR")
with mock.patch.object(sys, "argv", [script_path, *arguments]), mock.patch.object(
    runtime, "reexec_in_runtime_if_needed"
), mock.patch.object(
    runtime, "run_async_command", return_value=result,
    side_effect=error if scenario == "runtime-error" else None
):
    try:
        exit_code = runtime.main()
    except SystemExit as caught:
        exit_code = caught.code
assert sys.stdin.encoding == stdin_encoding
raise SystemExit(exit_code)
'''


class TelegramCliOutputTests(unittest.TestCase):
    def run_cli(self, scenario, encoding):
        # PYTHONIOENCODING forces the same narrow pipe encoding on every OS,
        # even when CI's default locale/UTF-8 mode would otherwise mask the bug.
        environment = {
            **os.environ,
            "PYTHONIOENCODING": f"{encoding}:strict",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        return subprocess.run(
            [sys.executable, "-c", CHILD_CODE, str(SCRIPT_PATH), scenario, encoding],
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            check=False,
        )

    def test_chat_titles_and_message_text_are_lossless_utf8(self):
        for encoding in ("cp1251", "cp1252", "ascii"):
            with self.subTest(encoding=encoding):
                completed = self.run_cli("dialogs", encoding)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(completed.stderr, b"")
                payload = json.loads(completed.stdout.decode("utf-8"))
                self.assertTrue(payload["ok"])
                self.assertEqual(payload["dialogs"][0]["title"], UNICODE_TEXT)
                self.assertEqual(payload["messages"][0]["text"], UNICODE_TEXT)
                self.assertIn(UNICODE_TEXT.encode("utf-8"), completed.stdout)

    def test_export_preserves_compact_utf8_byte_contract(self):
        for command in ("export", "daily-export"):
            with self.subTest(command=command):
                completed = self.run_cli(command, "cp1251")
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(completed.stderr, b"")
                payload = json.loads(completed.stdout.decode("utf-8"))
                # Escaping Unicode to ASCII would change the byte accounting
                # used by --max-output-bytes; preserve the exact compact body.
                expected = json.dumps(
                    payload, ensure_ascii=False, separators=(",", ":")
                ).encode("utf-8")
                self.assertEqual(completed.stdout.rstrip(b"\r\n"), expected)
                self.assertEqual(payload["messages"][0]["text"], UNICODE_TEXT)

    def test_expected_error_is_utf8_json_without_a_traceback(self):
        for encoding in ("cp1251", "cp1252", "ascii"):
            with self.subTest(encoding=encoding):
                completed = self.run_cli("runtime-error", encoding)
                self.assertEqual(completed.returncode, 2)
                self.assertEqual(completed.stdout, b"")
                payload = json.loads(completed.stderr.decode("utf-8"))
                self.assertEqual(payload, {
                    "ok": False,
                    "error": UNICODE_TEXT,
                    "code": "SYNTHETIC_TELEGRAM_ERROR",
                })
                self.assertIn(UNICODE_TEXT.encode("utf-8"), completed.stderr)
                self.assertNotIn(b"Traceback", completed.stderr)

    def test_parser_error_uses_utf8_before_provider_execution(self):
        completed = self.run_cli("parser-error", "cp1251")
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout, b"")
        # argparse quotes invalid choices with repr(), so a non-printable ZWJ
        # is intentionally escaped even though emoji/Cyrillic still need UTF-8.
        self.assertIn(repr(UNICODE_TEXT), completed.stderr.decode("utf-8"))
        self.assertNotIn(b"Traceback", completed.stderr)


if __name__ == "__main__":
    unittest.main()
