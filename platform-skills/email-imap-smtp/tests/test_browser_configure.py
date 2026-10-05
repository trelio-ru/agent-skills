"""Real loopback/CLI regressions with synthetic credentials and isolated storage.

Only the OS browser opener and credential store are substituted. The actual form,
HTTP validation, command handler and config persistence run together; no real
browser, Keychain, mailbox or user's configuration is accessed by this suite.
"""

import contextlib
import http.client
import importlib.util
import io
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
import urllib.parse
from unittest import mock


SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "trelio-email.py"
SPEC = importlib.util.spec_from_file_location("trelio_email_browser_test", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

VALUES = {
    "email": "person@example.com", "username": "person@example.com",
    "display_name": "Тестовый отправитель", "description": "Поставщики\nРабочая почта",
    "imap_host": "imap.example.com", "imap_port": "993",
    "smtp_host": "smtp.example.com", "smtp_port": "587", "smtp_security": "starttls",
    "password": " synthetic-password ",
}


def request(url, values=None, *, headers=None, path=None, body=None):
    parsed = urllib.parse.urlparse(url)
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=3)
    method = "GET" if values is None and body is None else "POST"
    request_headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": f"http://127.0.0.1:{parsed.port}",
        **(headers or {}),
    }
    try:
        connection.request(
            method, path or parsed.path + ("submit" if method == "POST" else ""),
            body=body if body is not None else (urllib.parse.urlencode(values) if values is not None else None),
            headers=request_headers,
        )
        response = connection.getresponse()
        return response.status, response.read().decode("utf-8"), dict(response.getheaders())
    finally:
        connection.close()


class BrowserConfigureTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = pathlib.Path(directory.name)
        for name, value in {
            "CONFIG_DIR": root, "CONFIG_PATH": root / "accounts.toml", "SECRETS_DIR": root / "secrets",
            "POLICIES_DIR": root / "policies",
        }.items():
            patcher = mock.patch.object(MODULE, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name in ("prompt", "prompt_password", "load_password", "imap_connection", "smtp_connection", "open_browser_url"):
            patcher = mock.patch.object(MODULE, name, side_effect=AssertionError("Unexpected external/terminal access"))
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(MODULE, "store_password", return_value="synthetic-store")
        self.store = patcher.start()
        self.addCleanup(patcher.stop)

    def session(self, existing=None, description=None):
        session = MODULE.BrowserConfigureSession("work", existing or {}, description)
        self.addCleanup(session.close)
        return session

    def configure(self, opener, *extra):
        args = MODULE.build_parser().parse_args(["configure", "--account", "work", *extra])
        with mock.patch.object(MODULE, "open_browser_url", side_effect=opener) as opened:
            result = args.handler(args)
        opened.assert_called_once()
        return result

    def test_loopback_form_binds_without_dns_lookup(self):
        # A stalled resolver must not prevent the local form from opening.
        # The real socket, listener and HTTP handler still run in this test.
        with mock.patch.object(MODULE.socket, "getfqdn", side_effect=AssertionError("Unexpected DNS lookup")) as lookup:
            session = self.session()
            self.assertEqual(session.server.server_name, "127.0.0.1")
            self.assertEqual(session.server.server_port, session.port)
            self.assertEqual(request(session.url)[0], 200)
        lookup.assert_not_called()

    def test_complete_setup_without_stdin_and_preserve_other_account(self):
        other = {**VALUES, "description": "Другой ящик", "credential_store": "file"}
        other.pop("password")
        MODULE.write_raw_config({"accounts": {"personal": other}})
        before = MODULE.load_raw_config()["accounts"]["personal"]
        output = io.StringIO()
        captured = []

        def browser(url):
            captured.append(url)
            status, page, headers = request(url)
            self.assertEqual(status, 200)
            for field in VALUES:
                self.assertIn(f'name="{field}"', page)
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
            self.assertNotIn(VALUES["password"], page)
            self.assertEqual(request(url, VALUES)[:2], (200, '{"ok": true, "cancelled": false}'))

        with mock.patch.object(MODULE.sys, "stdin", io.StringIO("")), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = self.configure(browser)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(result["passwordInput"], "browser")
        self.assertNotIn(VALUES["password"], json.dumps(result))
        self.assertEqual(self.store.call_args.args[1], VALUES["password"])
        raw = MODULE.load_raw_config()
        self.assertEqual(raw["accounts"]["personal"], before)
        account = MODULE.load_account("work")
        self.assertEqual(account.smtp_port, 587)
        self.assertEqual(account.smtp_security, "starttls")
        self.assertEqual(account.description, VALUES["description"])
        # Runtime writes TOML as UTF-8. The leak assertion must inspect those
        # bytes with the same codec, including on Windows with a legacy ACP.
        self.assertNotIn(VALUES["password"], MODULE.CONFIG_PATH.read_text(encoding="utf-8"))
        with self.assertRaises(OSError):
            request(captured[0])

    def test_invalid_fields_retry_same_form_and_replay_is_rejected(self):
        session = self.session()
        request(session.url)
        invalid_values = [
            {"smtp_port": "0"}, {"imap_port": "65536"}, {"imap_port": "wrong"},
            {"email": "missing-address"}, {"username": "bad\r\nlogin"},
            {"smtp_security": "plain"}, {"imap_host": "https://imap.example.com/path"},
            {"description": "я" * 2001}, {"password": ""}, {"password": "x" * 2049},
        ]
        for invalid in invalid_values:
            with self.subTest(fields=list(invalid)):
                status, body, _ = request(session.url, {**VALUES, **invalid})
                self.assertEqual(status, 400)
                self.assertNotIn(VALUES["password"], body)
                self.assertFalse(session.response_ready.is_set())
                self.assertIsNone(session.password)
        self.assertEqual(request(session.url, VALUES)[0], 200)
        self.assertEqual(request(session.url, {**VALUES, "password": "replacement"})[0], 410)
        self.assertEqual(request(session.url)[0], 410)
        self.assertEqual(session.password, VALUES["password"])
        self.store.assert_not_called()

    def test_loopback_guards_and_expiry(self):
        session = self.session()
        self.assertEqual(request(session.url, VALUES)[0], 409)
        self.assertEqual(request(session.url, headers={"Host": "evil.example"})[0], 404)
        self.assertEqual(request(session.url, path="/wrong-token/")[0], 404)
        request(session.url)
        for headers, status in [
            ({"Origin": "https://evil.example"}, 403), ({"Origin": "null"}, 403),
            ({"Host": "evil.example"}, 403), ({"Content-Type": "application/json"}, 415),
            ({"Content-Length": str(MODULE.MAX_PROMPT_BODY_BYTES + 1)}, 413),
        ]:
            self.assertEqual(request(session.url, VALUES, headers=headers)[0], status)
        self.assertEqual(request(session.url, body="password=one&password=two")[0], 400)
        self.assertEqual(request(session.url, {**VALUES, "unknown": "value"})[0], 400)
        self.assertEqual(request(session.url, body=b"\xff")[0], 400)
        session.deadline = MODULE.time.monotonic() - 1
        self.assertEqual(request(session.url, VALUES)[0], 410)
        self.assertIsNone(session.password)
        self.store.assert_not_called()

    def test_gmail_defaults_and_unicode_body_bound(self):
        session = self.session()
        request(session.url)
        values = {**VALUES, "email": "person@gmail.com", "username": "", "imap_host": "", "smtp_host": "",
                  "smtp_port": "", "smtp_security": "ssl", "password": "abcd efgh ijkl mnop",
                  "description": "🧪" * 2000}
        self.assertEqual(request(session.url, values)[0], 200)
        self.assertEqual(session.account.username, "person@gmail.com")
        self.assertEqual(session.account.imap_host, "imap.gmail.com")
        self.assertEqual(session.account.smtp_host, "smtp.gmail.com")
        self.assertEqual(session.account.smtp_port, 465)
        self.assertEqual(session.password, "abcdefghijklmnop")

    def test_mailru_yandex_defaults_do_not_inherit_google_password_rules(self):
        for domain, imap, smtp in [
            ("mail.ru", "imap.mail.ru", "smtp.mail.ru"), ("bk.ru", "imap.mail.ru", "smtp.mail.ru"),
            ("yandex.ru", "imap.yandex.ru", "smtp.yandex.ru"), ("ya.ru", "imap.yandex.ru", "smtp.yandex.ru"),
        ]:
            with self.subTest(domain=domain):
                session = self.session()
                request(session.url)
                values = {**VALUES, "email": f"synthetic@{domain}", "imap_host": "", "smtp_host": ""}
                self.assertEqual(request(session.url, values)[0], 200)
                self.assertEqual((session.account.imap_host, session.account.smtp_host), (imap, smtp))
                self.assertEqual(session.password, VALUES["password"])
        for domain in ("notmail.ru", "mail.ru.evil.example", "notyandex.ru", "yandex.ru.evil.example"):
            with self.subTest(domain=domain), self.assertRaises(MODULE.MailboxError):
                MODULE.configure_account("work", {"email": f"synthetic@{domain}"})

    def test_provider_help_keeps_direct_links_and_distinct_prerequisites(self):
        page = self.session().render_page().decode()
        self.assertIn(f'href="{MODULE.GOOGLE_APP_PASSWORDS_URL}"', page)
        self.assertIn('href="https://account.mail.ru/user/2-step-auth/passwords/"', page)
        self.assertIn('href="https://passport.yandex.ru/security/app-passwords"', page)
        hints = MODULE.EMAIL_SETUP_PROVIDERS
        self.assertIn("двухэтапную", hints["gmail"]["instructions"])
        self.assertIn("телефон", hints["mailru"]["instructions"])
        self.assertIn("IMAP", hints["yandex"]["instructions"])
        for key in ("mailru", "yandex"):
            self.assertNotIn("двухэтапную", hints[key]["instructions"])

    def test_actual_form_script_switches_providers_preserves_edits_and_clears_on_expiry(self):
        # Execute the shipped inline JS, not a second implementation of it. The
        # small DOM fixture supplies only form operations; network is forbidden.
        page = self.session().render_page().decode()
        script = re.search(r"<script>(.*?)</script>", page, re.S).group(1)
        harness = r'''
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync(0, "utf8");
const input = name => ({name, value: "", events: {}, addEventListener(event, fn) { this.events[event] = fn; }});
const elements = Object.fromEntries(["email", "imap_host", "smtp_host", "smtp_security", "smtp_port"].map(name => [name, input(name)]));
elements.namedItem = name => elements[name];
elements.smtp_port.value = "465";
const hints = ["gmail", "mailru", "yandex"].map(provider => ({dataset: {provider}, hidden: true}));
const buttons = [{disabled: false}, {disabled: false}];
const form = {...input("form"), elements, dataset: {}, resets: 0,
  reset() { this.resets++; }, querySelectorAll() { return buttons; }};
const app = {innerHTML: "", textContent: ""};
const error = {};
const cancel = input("cancel");
let expiry;
let requests = 0;
const context = vm.createContext({URLSearchParams, Map,
  document: {getElementById(id) { return {app, "password-form": form, error, cancel}[id]; }, querySelectorAll() { return hints; }},
  setTimeout(fn) { expiry = fn; return 1; }, clearTimeout() {},
  fetch() { requests++; throw Error("Network forbidden"); },
});
vm.runInContext(source, context);
function change(name, value) { elements[name].value = value; elements[name].events.input(); }
function provider() { return hints.filter(item => !item.hidden).map(item => item.dataset.provider); }
change("email", "person@gmail.com");
assert.deepEqual(provider(), ["gmail"]);
assert.equal(elements.imap_host.value, "imap.gmail.com");
change("email", "person@mail.ru");
assert.deepEqual(provider(), ["mailru"]);
assert.equal(elements.imap_host.value, "imap.mail.ru");
change("email", "person@ya.ru");
assert.deepEqual(provider(), ["yandex"]);
change("email", "person@unknown.example");
assert.deepEqual(provider(), []);
assert.equal(elements.imap_host.value, "");
change("imap_host", "imap.ya.ru");
assert.deepEqual(provider(), ["yandex"]);
change("imap_host", "imap.custom.example");
change("email", "person@gmail.com");
assert.equal(elements.imap_host.value, "imap.custom.example");
assert.equal(elements.smtp_host.value, "smtp.gmail.com");
elements.smtp_security.value = "starttls";
elements.smtp_security.events.change();
assert.equal(elements.smtp_port.value, "587");
expiry();
assert.equal(form.resets, 1);
assert.match(app.textContent, /истекло/);
vm.runInContext("submit(new Map())", context);
assert.equal(requests, 0);
'''
        # Node always reads this JavaScript source as UTF-8. Pin the pipe codec
        # as well so a Windows system code page cannot corrupt Russian status
        # text before the browser script is evaluated.
        completed = subprocess.run(
            ["node", "-e", harness], input=script, capture_output=True,
            text=True, encoding="utf-8", timeout=10,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_reconfigure_prefills_escaped_values_and_preserves_description(self):
        existing = {**VALUES, "description": '</textarea><script>alert("synthetic")</script>', "smtp_port": 587}
        existing.pop("password")
        for explicit, expected in [(None, existing["description"]), ("", ""), ("Новое описание", "Новое описание")]:
            with self.subTest(explicit=explicit):
                session = self.session(existing, explicit)
                _, page, _ = request(session.url)
                self.assertNotIn(existing["description"], page)
                self.assertIn('value="587"', page)
                self.assertIn('value="starttls" selected', page)
                self.assertEqual(request(session.url, {**VALUES, "description": ""})[0], 200)
                self.assertEqual(session.account.description, expected)

    def test_cancel_does_not_persist_and_closes_listener(self):
        urls = []
        def browser(url):
            urls.append(url)
            request(url)
            self.assertEqual(request(url, {"cancel": "1"})[0], 200)
        with self.assertRaises(MODULE.PasswordEntryCancelled):
            self.configure(browser)
        self.store.assert_not_called()
        self.assertFalse(MODULE.CONFIG_PATH.exists())
        with self.assertRaises(OSError):
            request(urls[0])

    def test_opener_failure_missing_page_and_input_timeout(self):
        def fail(_url):
            raise MODULE.ProtectedPromptUnavailable("Synthetic opener failure")
        for opener in (fail, lambda _url: None, lambda url: request(url)):
            with self.subTest(opener=opener), mock.patch.object(MODULE, "BROWSER_LOAD_TIMEOUT_SECONDS", 0.02), mock.patch.object(MODULE, "BROWSER_INPUT_TIMEOUT_SECONDS", 0.02):
                with self.assertRaises(MODULE.ProtectedPromptUnavailable):
                    self.configure(opener)
        self.store.assert_not_called()
        self.assertFalse(MODULE.CONFIG_PATH.exists())

    def test_terminal_modes_fail_before_input_when_no_visible_tty(self):
        for extra in (["--terminal-prompts"], ["--password-input", "terminal"]):
            args = MODULE.build_parser().parse_args(["configure", "--account", "work", *extra])
            with mock.patch.object(MODULE.sys, "stdin", io.StringIO("")), self.assertRaisesRegex(MODULE.ProtectedPromptUnavailable, "видимый"):
                args.handler(args)
        self.store.assert_not_called()

    def test_legacy_browser_aliases_use_full_form(self):
        def browser(url):
            self.assertIn('name="email"', request(url)[1])
            request(url, VALUES)
        for mode in ("auto", "window"):
            self.assertEqual(self.configure(browser, "--password-input", mode)["passwordInput"], "browser")

    def test_cli_with_devnull_stdin_never_prints_terminal_prompt_or_form_values(self):
        # A separate process, real main(), DEVNULL stdin, captured stdout/stderr:
        # this is the execution boundary that hid the old input() inside MCP.
        worker = r'''
import faulthandler
# Only synthetic data is used here. A stalled runner must show the exact
# Python stack (without locals), rather than invite timeout/proxy guesses.
faulthandler.dump_traceback_later(5)
import http.client, importlib.util, pathlib, sys, urllib.parse
spec = importlib.util.spec_from_file_location("mail_cli", sys.argv[1])
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)
m.CONFIG_DIR = pathlib.Path(sys.argv[2])
m.CONFIG_PATH = m.CONFIG_DIR / "accounts.toml"
m.store_password = lambda account, password: "synthetic-store"
# This fixture only speaks plain HTTP to the exact loopback form. A direct
# client avoids urllib's unrelated proxy/PAC and HTTPS trust-store setup;
# neither belongs to this isolated CLI/input regression.
def browser(url):
    parsed = urllib.parse.urlparse(url)
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=2)
    try:
        connection.request("GET", parsed.path)
        response = connection.getresponse()
        assert response.status == 200
        assert b'name="email"' in response.read()
    finally:
        connection.close()
    data = urllib.parse.urlencode({"email": "synthetic@gmail.com", "password": "abcdefghijklmnop"}).encode()
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=2)
    try:
        connection.request("POST", parsed.path + "submit", body=data, headers={
            "Origin": "http://" + parsed.netloc,
            "Content-Type": "application/x-www-form-urlencoded",
        })
        response = connection.getresponse()
        assert response.status == 200
        response.read()
    finally:
        connection.close()
m.open_browser_url = browser
sys.argv = [sys.argv[1], "configure", "--account", "work"]
code = m.main(_owned=True)
faulthandler.cancel_dump_traceback_later()
raise SystemExit(code)
'''
        try:
            result = subprocess.run([sys.executable, "-c", worker, str(SCRIPT), str(MODULE.CONFIG_DIR)],
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
        except subprocess.TimeoutExpired as error:
            diagnostic = (error.stderr or b"").decode("utf-8", errors="replace")
            self.fail("Synthetic CLI exceeded 10 seconds; child stack:\n" + diagnostic[-8000:])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["passwordInput"], "browser")
        self.assertEqual(result.stderr, "")
        for value in ("Email address", "synthetic@gmail.com", "abcdefghijklmnop", "127.0.0.1"):
            self.assertNotIn(value, result.stdout)


if __name__ == "__main__":
    unittest.main()
