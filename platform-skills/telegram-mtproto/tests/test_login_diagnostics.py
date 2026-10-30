"""Real loopback login recovery with synthetic SDK refusals, never an account."""
import asyncio
import contextlib
import http.client
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import mock

SOURCE = pathlib.Path(__file__).parents[1] / "scripts" / "trelio-telegram.py"
SPEC = importlib.util.spec_from_file_location("telegram_login_diagnostics", SOURCE)
M = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = M
SPEC.loader.exec_module(M)


def rpc(name, **attributes):
    kind = type(name, (Exception,), {"__module__": "telethon.errors.rpcerrorlist"})
    error = kind("PRIVATE_FACTOR phone=PRIVATE_PHONE request=PRIVATE_REQUEST")
    for key, value in attributes.items():
        setattr(error, key, value)
    return error


class PasswordNeeded(Exception):
    pass


class LoginDiagnosticsTests(unittest.TestCase):
    def test_known_rpc_failures_have_closed_codes_and_no_provider_text(self):
        for name, (code, category, message, next_step) in M.LOGIN_ERROR_SPECS.items():
            with self.subTest(name=name):
                failure = M.telegram_login_error(rpc(name, seconds=17), stage="password_check")
                payload = failure.public_payload()
                self.assertEqual(payload["code"], code)
                self.assertEqual(payload["details"]["diagnostic"]["category"], category)
                self.assertFalse(payload["details"]["diagnostic"]["automaticRetry"])
                self.assertIn(message, payload["error"])
                self.assertNotIn("PRIVATE_", json.dumps(payload))
                if code == "TELEGRAM_RATE_LIMITED":
                    self.assertEqual(payload["details"]["diagnostic"]["retryAfterSeconds"], 17)

    def test_unknown_text_and_foreign_error_names_never_become_password_rejection(self):
        foreign = type("PasswordHashInvalidError", (Exception,), {})
        for error in (RuntimeError("PASSWORD_HASH_INVALID PRIVATE_FACTOR"), foreign("PRIVATE_FACTOR")):
            payload = M.telegram_login_error(error).public_payload()
            self.assertEqual(payload["code"], "TELEGRAM_REQUEST_FAILED")
            self.assertNotIn("PRIVATE_FACTOR", json.dumps(payload))
        self.assertEqual(M.telegram_login_error(ConnectionError("PRIVATE" )).code, "TELEGRAM_NETWORK_UNAVAILABLE")
        self.assertEqual(M.telegram_login_error(TimeoutError("PRIVATE")).code, "TELEGRAM_NETWORK_UNAVAILABLE")

    def test_wait_evidence_rejects_wrong_types_and_unbounded_numbers(self):
        for seconds in (True, "17", -1, 10**20):
            payload = M.telegram_login_error(rpc("FloodWaitError", seconds=seconds)).public_payload()
            self.assertNotIn("retryAfterSeconds", payload["details"]["diagnostic"])

    def request(self, session, method, fields=None):
        connection = http.client.HTTPConnection("127.0.0.1", session.port, timeout=3)
        try:
            connection.request(method, session.base_path + ("/submit" if fields else "/state"),
                body=urllib.parse.urlencode(fields) if fields else None,
                headers={"Origin": session.origin, "Content-Type": "application/x-www-form-urlencoded"})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def prompt(self, session, after=0):
        with session.condition:
            ready = session.condition.wait_for(lambda: session.current_prompt and session.current_prompt["id"] > after,
                                               timeout=3)
            self.assertTrue(ready, "No next protected input step")
        status, state = self.request(session, "GET")
        self.assertEqual(status, 200)
        self.assertEqual(state["status"], "prompt")
        self.assertNotIn("PRIVATE_", json.dumps(state))
        return state

    def submit(self, session, prompt, value=None, **fields):
        self.assertEqual(self.request(session, "POST", {"id": prompt["id"], **({"value": value} if value else {}), **fields})[0], 200)

    @contextlib.contextmanager
    def login(self, method, *, sign_in, send_code=None, qr_wait=None):
        # The real token/Origin/prompt-ID loopback handler executes. Only the
        # SDK, package identity, browser opener and session filesystem are fake.
        session = M.BrowserPromptSession()
        client = SimpleNamespace(connect=mock.AsyncMock(), disconnect=mock.AsyncMock(),
            is_user_authorized=mock.AsyncMock(side_effect=[False, True]),
            get_me=mock.AsyncMock(return_value=SimpleNamespace(id=1, username="synthetic")),
            send_code_request=mock.AsyncMock(side_effect=send_code, return_value=SimpleNamespace(phone_code_hash="synthetic")),
            sign_in=mock.AsyncMock(side_effect=sign_in))
        qr = SimpleNamespace(expires=datetime(2099, 1, 1, tzinfo=timezone.utc), url="synthetic",
            wait=mock.AsyncMock(side_effect=qr_wait if qr_wait is not None else PasswordNeeded()), recreate=mock.AsyncMock())
        client.qr_login = mock.AsyncMock(return_value=qr)
        result, failures = [], []
        def run():
            try:
                result.append(asyncio.run(M.command_login_async(M.build_parser().parse_args(["login", "--" + method]), object())))
            except Exception as error:
                failures.append(error)
        with tempfile.TemporaryDirectory() as root, contextlib.ExitStack() as stack:
            for name, value in (("BROWSER_PROMPT_SESSION", session), ("build_client", mock.Mock(return_value=client)),
                ("import_telethon", mock.Mock(return_value=(object(), PasswordNeeded, object()))),
                ("telegram_password_hint", mock.AsyncMock(return_value="synthetic hint")),
                ("session_path", mock.Mock(return_value=pathlib.Path(root) / "session")),
                ("import_qrcode", mock.Mock(return_value=object())), ("qr_image_data_url", mock.Mock(return_value="synthetic"))):
                stack.enter_context(mock.patch.object(M, name, value))
            stack.enter_context(mock.patch.object(session, "open"))
            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            try:
                yield session, client, qr, result, failures
            finally:
                if thread.is_alive():
                    with session.condition:
                        session.response = {"cancelled": True}
                        session.condition.notify_all()
                thread.join(timeout=4)
                session.close()
                self.assertFalse(thread.is_alive(), "Login worker did not stop")

    def test_wrong_password_can_be_corrected_on_same_page_for_code_and_qr(self):
        for method in ("code", "qr"):
            with self.subTest(method=method), self.login(method, sign_in=(
                [PasswordNeeded(), rpc("PasswordHashInvalidError"), None] if method == "code"
                else [rpc("PasswordHashInvalidError"), None])) as (session, client, qr, result, errors):
                if method == "code":
                    phone = self.prompt(session)
                    self.submit(session, phone, "synthetic phone")
                    code = self.prompt(session, phone["id"])
                    self.submit(session, code, "synthetic code")
                password = self.prompt(session, code["id"] if method == "code" else 0)
                self.submit(session, password, "PRIVATE_BAD_PASSWORD")
                corrected = self.prompt(session, password["id"])
                self.assertIn("Неверный пароль", corrected["error"])
                self.assertEqual(corrected["hint"], "synthetic hint")
                self.assertNotIn("value", corrected)
                self.assertEqual(self.request(session, "POST", {"id": password["id"], "value": "PRIVATE_REPLAY"})[0], 409)
                self.submit(session, corrected, " PRIVATE_CORRECT_PASSWORD ")
                with session.condition:
                    self.assertTrue(session.condition.wait_for(lambda: session.finished, timeout=3))
                self.assertEqual(session.finished["title"], "Telegram подключён")
                self.assertEqual(qr.recreate.await_count, 0)
                self.assertEqual(client.qr_login.await_count, int(method == "qr"))
                self.assertEqual(client.send_code_request.await_count, int(method == "code"))
                self.assertEqual(client.sign_in.await_count, 3 if method == "code" else 2)
                self.assertEqual(client.sign_in.await_args.kwargs["password"], " PRIVATE_CORRECT_PASSWORD ")
                self.assertFalse(errors)

    def test_rejected_or_expired_qr_is_replaced_only_by_native_button(self):
        for name in ("AuthTokenExpiredError", "AuthTokenInvalidError"):
            with self.subTest(name=name), self.login("qr", sign_in=[None],
                qr_wait=[rpc(name), PasswordNeeded()]) as (session, client, qr, result, errors):
                review = self.prompt(session)
                self.assertIn("Показать новый QR", review["prompt"])
                self.assertEqual(qr.recreate.await_count, 0)
                self.submit(session, review, choice="refresh")
                password = self.prompt(session, review["id"])
                self.assertEqual(qr.recreate.await_count, 1)
                self.submit(session, password, "PRIVATE_PASSWORD")
                with session.condition:
                    self.assertTrue(session.condition.wait_for(lambda: session.finished, timeout=3))
                self.assertEqual(client.qr_login.await_count, 1)

    def test_terminal_secret_input_keeps_password_whitespace(self):
        with mock.patch.object(M.sys.stdin, "isatty", return_value=True), \
             mock.patch.object(M.getpass, "getpass", return_value=" password "):
            self.assertEqual(M.prompt_value_terminal("Пароль", hidden=True), " password ")

    def test_wrong_phone_and_code_are_corrected_without_automatic_code_resend(self):
        with self.login("code", send_code=[rpc("PhoneNumberInvalidError"), SimpleNamespace(phone_code_hash="same-hash")],
                        sign_in=[rpc("PhoneCodeInvalidError"), None]) as (session, client, _, result, errors):
            phone = self.prompt(session)
            self.submit(session, phone, "PRIVATE_BAD_PHONE")
            next_phone = self.prompt(session, phone["id"])
            self.assertIn("Некорректный номер", next_phone["error"])
            self.submit(session, next_phone, "PRIVATE_PHONE")
            code = self.prompt(session, next_phone["id"])
            self.submit(session, code, "PRIVATE_BAD_CODE")
            next_code = self.prompt(session, code["id"])
            self.assertIn("Неверный код", next_code["error"])
            self.assertEqual(client.send_code_request.await_count, 2)
            self.submit(session, next_code, "PRIVATE_CODE")
            with session.condition:
                self.assertTrue(session.condition.wait_for(lambda: session.finished, timeout=3))
            self.assertEqual(client.send_code_request.await_count, 2)

    def test_expired_code_requires_native_button_before_one_new_code_request(self):
        with self.login("code", sign_in=[rpc("PhoneCodeExpiredError"), None]) as (session, client, _, result, errors):
            phone = self.prompt(session)
            self.submit(session, phone, "PRIVATE_PHONE")
            code = self.prompt(session, phone["id"])
            self.submit(session, code, "PRIVATE_CODE")
            review = self.prompt(session, code["id"])
            self.assertIn("истёк", review["prompt"])
            self.assertEqual(client.send_code_request.await_count, 1)
            self.submit(session, review, choice="resend")
            new_code = self.prompt(session, review["id"])
            self.assertEqual(client.send_code_request.await_count, 2)
            self.submit(session, new_code, "PRIVATE_NEW_CODE")
            with session.condition:
                self.assertTrue(session.condition.wait_for(lambda: session.finished, timeout=3))

    def test_password_failure_cancellation_rate_limit_and_unknown_do_not_retry(self):
        args = SimpleNamespace(terminal_prompts=False)
        for error in (rpc("FloodWaitError", seconds=45), TimeoutError("PRIVATE"), RuntimeError("PRIVATE"), M.PromptCancelled("PRIVATE")):
            client = SimpleNamespace(sign_in=mock.AsyncMock(side_effect=error))
            with mock.patch.object(M, "prompt_value", return_value="PRIVATE_PASSWORD") as prompt, \
                 mock.patch.object(M, "telegram_password_hint", new=mock.AsyncMock(return_value="")):
                with self.assertRaises(M.TelegramRuntimeError):
                    asyncio.run(M.authorize_with_password(client, args, object(), deadline=time.monotonic()+10, cancel_label="Отмена"))
                self.assertEqual(prompt.call_count, 1)
                self.assertEqual(client.sign_in.await_count, 1)
        client = SimpleNamespace(sign_in=mock.AsyncMock(side_effect=rpc("PasswordHashInvalidError")))
        with mock.patch.object(M, "prompt_value", return_value="PRIVATE_PASSWORD") as prompt, \
             mock.patch.object(M, "telegram_password_hint", new=mock.AsyncMock(return_value="")):
            with self.assertRaises(M.TelegramRuntimeError) as caught:
                asyncio.run(M.authorize_with_password(client, args, object(), deadline=time.monotonic()+10, cancel_label="Отмена"))
            self.assertEqual(caught.exception.code, "TELEGRAM_PASSWORD_INVALID")
            self.assertEqual(prompt.call_count, 3)

    def test_expired_original_deadline_never_accepts_a_new_factor(self):
        client = SimpleNamespace(sign_in=mock.AsyncMock())
        with mock.patch.object(M, "telegram_password_hint", new=mock.AsyncMock(return_value="")), \
             mock.patch.object(M, "prompt_value") as prompt:
            with self.assertRaises(M.TelegramRuntimeError) as caught:
                asyncio.run(M.authorize_with_password(client, SimpleNamespace(terminal_prompts=False), object(),
                    deadline=time.monotonic()-1, cancel_label="Отмена"))
            self.assertEqual(caught.exception.code, "TELEGRAM_LOGIN_EXPIRED")
            prompt.assert_not_called()
            client.sign_in.assert_not_awaited()
        session = M.BrowserPromptSession()
        try:
            with mock.patch.object(session, "open"):
                with self.assertRaises(M.TelegramRuntimeError):
                    session.ask("Пароль", hidden=True, deadline=time.monotonic()-1)
            self.assertIsNone(session.current_prompt)
        finally:
            session.close()

    def test_terminal_page_shows_checked_error_before_process_exit(self):
        session = SimpleNamespace(finish=mock.Mock(), finished_seen=mock.Mock(wait=mock.Mock()))
        failure = M.telegram_login_error(rpc("PhoneNumberBannedError"))
        with mock.patch.object(sys, "argv", [str(SOURCE), "login", "--qr"]), \
             mock.patch.object(M, "reexec_in_runtime_if_needed"), \
             mock.patch.object(M, "run_async_command", side_effect=failure), \
             mock.patch.object(M, "shutdown_browser_prompt_session"), \
             mock.patch.object(M, "BROWSER_PROMPT_SESSION", session), contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(M.main(), 2)
        self.assertEqual(session.finish.call_args.kwargs["message"], str(failure))
        self.assertEqual(json.loads(stderr.getvalue())["code"], "TELEGRAM_PHONE_BANNED")
        self.assertNotIn("PRIVATE_", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
