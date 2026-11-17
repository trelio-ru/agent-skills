"""The signed Python CLI keeps the browser helper out of the IMAP/SMTP vault."""

import json
import base64
import struct
import zlib
from pathlib import Path
import subprocess
import unittest
from unittest import mock

import test_browser_configure as browser

MODULE = browser.MODULE
BOUND = {"id": "c2c76f17-8413-4a50-ac75-0d230e96ca01", "mailbox_name": "work"}


class WebmailBridgeTests(unittest.TestCase):
    setUp = browser.BrowserConfigureTests.setUp

    def args(self):
        return MODULE.build_parser().parse_args(["webmail", "status", "--account", "work"])

    def test_exact_host_selected_mailbox_is_required_before_any_private_read(self):
        with (
            mock.patch.object(MODULE, "selected_local_account", return_value=None),
            mock.patch.object(MODULE, "load_account", side_effect=AssertionError("unexpected account read")),
            self.assertRaisesRegex(MODULE.MailboxError, "EMAIL_WEBMAIL_SELECTED_ACCOUNT_REQUIRED"),
        ):
            MODULE.command_webmail(self.args())

    def test_selected_account_metadata_goes_only_through_private_stdio(self):
        workbook = {**browser.VALUES, "credential_store": "file"}
        workbook.pop("password")
        MODULE.write_raw_config({"accounts": {"work": workbook}})
        result = {"kind": "trelio.browser-visual/v1", "state": "saved_unverified", "reason": "none"}
        node = str(Path(MODULE.CONFIG_DIR) / "node")
        with (
            mock.patch.object(MODULE, "selected_local_account", return_value=BOUND),
            mock.patch.dict(MODULE.os.environ, {"TRELIO_LOCAL_FORM_NODE_EXECUTABLE": node,
                "TRELIO_VISUAL_SESSION_MODULE_URL": "file:///host/trelio-visual-session.mjs",
                "TRELIO_SECRET_FILE": "synthetic-credential-reference",
                "PYTHONPATH": "untrusted-ambient", "NODE_OPTIONS": "untrusted-ambient"}),
            mock.patch.object(subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, json.dumps(result).encode(), b"")) as child,
        ):
            self.assertEqual(MODULE.command_webmail(self.args()), result)
        call = child.call_args
        self.assertEqual(call.args[0], [node, str(Path(MODULE.__file__).with_name("webmail.mjs"))])
        self.assertEqual(json.loads(call.kwargs["input"]),
                         {"operation": "status", "mailbox": browser.VALUES["email"]})
        self.assertFalse(call.kwargs["shell"])
        for secret in ("TRELIO_SECRET_FILE", "PYTHONPATH", "NODE_OPTIONS"):
            self.assertNotIn(secret, call.kwargs["env"])
        MODULE.load_password.assert_not_called()

    def test_smtp_only_account_can_use_its_own_webmail_without_imap_or_password(self):
        route = {**browser.VALUES, "connection_mode": "smtp_only", "credential_store": "file"}
        route.pop("password")
        MODULE.write_raw_config({"accounts": {"work": route}})
        with (
            mock.patch.object(MODULE, "selected_local_account", return_value=BOUND),
            mock.patch.dict(MODULE.os.environ, {"TRELIO_LOCAL_FORM_NODE_EXECUTABLE": str(Path(MODULE.CONFIG_DIR) / "node"),
                "TRELIO_VISUAL_SESSION_MODULE_URL": "file:///host/trelio-visual-session.mjs"}),
            mock.patch.object(subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, b'{"state":"not_configured"}', b"")) as child,
        ):
            self.assertEqual(MODULE.command_webmail(self.args())["state"], "not_configured")
        self.assertEqual(json.loads(child.call_args.kwargs["input"])["mailbox"], route["email"])
        MODULE.imap_connection.assert_not_called()
        MODULE.load_password.assert_not_called()

    def test_setup_forwards_saved_server_hints_and_public_discovery_arguments(self):
        account = {**browser.VALUES, "credential_store": "file"}
        account.pop("password")
        MODULE.write_raw_config({"accounts": {"work": account}})
        node = str(Path(MODULE.CONFIG_DIR) / "node")
        args = MODULE.build_parser().parse_args([
            "webmail", "setup", "--account", "work", "--url", "https://webmail.example.com/",
            "--auth-origin", "https://sso.example.org", "--auth-origin", "https://example.org",
        ])
        with (
            mock.patch.object(MODULE, "selected_local_account", return_value=BOUND),
            mock.patch.dict(MODULE.os.environ, {"TRELIO_LOCAL_FORM_NODE_EXECUTABLE": node,
                "TRELIO_VISUAL_SESSION_MODULE_URL": "file:///host/trelio-visual-session.mjs"}),
            mock.patch.object(subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, b'{"state":"manual_input_required"}', b"")) as child,
        ):
            MODULE.command_webmail(args)
        self.assertEqual(json.loads(child.call_args.kwargs["input"]), {
            "operation": "setup", "mailbox": browser.VALUES["email"],
            "imapHost": browser.VALUES["imap_host"], "smtpHost": browser.VALUES["smtp_host"],
            "url": "https://webmail.example.com/",
            "authOrigins": ["https://sso.example.org", "https://example.org"],
        })
        MODULE.load_password.assert_not_called()


class WebmailInputTests(unittest.TestCase):
    setUp = browser.BrowserConfigureTests.setUp
    def test_browser_input_keeps_its_frame_and_public_text_in_private_stdio(self):
        account = {**browser.VALUES, "credential_store": "file"}
        account.pop("password")
        MODULE.write_raw_config({"accounts": {"work": account}})
        node = str(Path(MODULE.CONFIG_DIR) / "node")
        args = MODULE.build_parser().parse_args([
            "webmail", "type", "--account", "work", "--frame-id", "fresh-frame", "--text", "Reviewed letter",
        ])
        with (
            mock.patch.object(MODULE, "selected_local_account", return_value=BOUND),
            mock.patch.dict(MODULE.os.environ, {"TRELIO_LOCAL_FORM_NODE_EXECUTABLE": node,
                "TRELIO_VISUAL_SESSION_MODULE_URL": "file:///host/trelio-visual-session.mjs"}),
            mock.patch.object(MODULE, "load_email_policy", return_value={"sendMode": "confirm"}),
            mock.patch.object(subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, b'{"state":"ready"}', b"")) as child,
        ):
            MODULE.command_webmail(args)
        self.assertEqual(json.loads(child.call_args.kwargs["input"]), {
            "operation": "type", "mailbox": browser.VALUES["email"],
            "input": {"frameId": "fresh-frame", "text": "Reviewed letter"},
        })
        MODULE.load_password.assert_not_called()

    def test_screenshot_transports_a_real_png_larger_than_the_text_budget_despite_native_warning(self):
        # Deterministic RGB pixels, not an encoded text stand-in. The common
        # host owns PNG/MCP validation; this boundary must preserve its bytes.
        width, height = 300, 200
        def chunk(kind, payload):
            return struct.pack("!I", len(payload)) + kind + payload + struct.pack("!I", zlib.crc32(kind + payload))
        pixels = b"".join(b"\0" + bytes((index + row) % 256 for index in range(width * 3)) for row in range(height))
        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!IIBBBBB", width, height, 8, 2, 0, 0, 0))
        png += chunk(b"IDAT", zlib.compress(pixels, level=0)) + chunk(b"IEND", b"")
        result = {"kind": "trelio.browser-visual/v1", "state": "ready", "reason": "none",
                  "image": {"mimeType": "image/png", "data": base64.b64encode(png).decode("ascii")}}
        payload = json.dumps(result).encode()
        self.assertGreater(len(payload), 40000)
        account = {**browser.VALUES, "credential_store": "file"}; account.pop("password")
        MODULE.write_raw_config({"accounts": {"work": account}})
        args = MODULE.build_parser().parse_args(["webmail", "screenshot", "--account", "work"])
        with (
            mock.patch.object(MODULE, "selected_local_account", return_value=BOUND),
            mock.patch.dict(MODULE.os.environ, {"TRELIO_LOCAL_FORM_NODE_EXECUTABLE": str(Path(MODULE.CONFIG_DIR) / "node"),
                "TRELIO_VISUAL_SESSION_MODULE_URL": "file:///host/trelio-visual-session.mjs"}),
            mock.patch.object(subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, payload, b"Synthetic native warning")),
        ):
            self.assertEqual(MODULE.command_webmail(args), result)

    def test_existing_read_only_mailbox_policy_still_blocks_browser_input(self):
        account = {**browser.VALUES, "credential_store": "file"}
        account.pop("password")
        MODULE.write_raw_config({"accounts": {"work": account}})
        args = MODULE.build_parser().parse_args([
            "webmail", "click", "--account", "work", "--frame-id", "frame", "--x", "20", "--y", "30",
        ])
        with (
            mock.patch.object(MODULE, "selected_local_account", return_value=BOUND),
            mock.patch.dict(MODULE.os.environ, {"TRELIO_LOCAL_FORM_NODE_EXECUTABLE": str(Path(MODULE.CONFIG_DIR) / "node"),
                "TRELIO_VISUAL_SESSION_MODULE_URL": "file:///host/trelio-visual-session.mjs"}),
            mock.patch.object(MODULE, "load_email_policy", return_value={"sendMode": "read-only"}),
            mock.patch.object(subprocess, "run", side_effect=AssertionError("unexpected browser input")),
            self.assertRaisesRegex(MODULE.MailboxError, "read-only"),
        ):
            MODULE.command_webmail(args)
