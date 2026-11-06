"""Real header parser and HTTP boundary, synthetic receiver/network only."""
import contextlib
import email
import hashlib
import importlib.util
import socket
import unittest
from dataclasses import replace
from email.policy import default
from pathlib import Path
from types import SimpleNamespace as NS
from unittest import mock

from test_trelio_email import MODULE as M
from test_assistant_monitor import ACCOUNT, examine
from test_imap_protocol import ScriptedImap
from test_message_reference import fetched

spec = importlib.util.spec_from_file_location("email_unsubscribe_test", Path(M.__file__).with_name("email_unsubscribe.py"))
U = importlib.util.module_from_spec(spec)
spec.loader.exec_module(U)
ACCOUNT = replace(ACCOUNT, imap_host="imap.gmail.com")
RAW = (b"Authentication-Results: mx.google.com; dkim=pass header.i=@example.com header.s=key header.b=YWJj\r\n"
       b"From: Service <news@example.com>\r\nTo: recipient@example.net\r\nSubject: Offer\r\n"
       b"DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=key; h=from:list-unsubscribe:list-unsubscribe-post; b=YWJj; bh=YWJj\r\n"
       b"List-Unsubscribe: <https://news.example.com/unsubscribe?token=PRIVATE_TOKEN>\r\n"
       b"List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nMarketing body\r\n")


class Unsubscribe(unittest.TestCase):
    def target(self, raw=RAW, account=ACCOUNT):
        return U.target(account, email.message_from_bytes(raw, policy=default))

    def test_receiver_owned_aligned_signed_headers_are_required(self):
        self.assertEqual(self.target(), "https://news.example.com/unsubscribe?token=PRIVATE_TOKEN")
        self.assertEqual(self.target(RAW.replace(b"bh=YWJj\r\n", b"bh=YWJj;\r\n")), self.target())
        changes = [(b"mx.google.com;", b"attacker.example;"), (b"dkim=pass", b"dkim=fail"),
                   (b"header.i=@example.com", b"header.i=@attacker.example"),
                   (b"h=from:list-unsubscribe:list-unsubscribe-post", b"h=from:subject"),
                   (b"header.s=key", b"header.s=other"), (b"header.b=YWJj", b"header.b=b3RoZXI="),
                   (b"List-Unsubscribe=One-Click", b"List-Unsubscribe=Other")]
        for old, new in changes:
            with self.subTest(old=old):
                self.assertIsNone(self.target(RAW.replace(old, new)))
        self.assertIsNone(self.target(account=replace(ACCOUNT, imap_host="imap.gmail.com.attacker.example")))
        self.assertIsNone(self.target(account=replace(ACCOUNT, imap_host="custom.example")))

    def test_duplicate_auth_or_list_headers_and_cross_domain_endpoints_refuse(self):
        for prefix in (b"Authentication-Results: mx.google.com; dkim=pass header.d=example.com\r\n",
                       b"Authentication-Results: attacker.example; dkim=pass header.d=example.com\r\n",
                       b"List-Unsubscribe: <https://example.com/other>\r\n",
                       b"List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n"):
            self.assertIsNone(self.target(prefix + RAW))
        for target in (b"http://example.com/u", b"https://attacker.example/u", b"https://example.com:8443/u",
                       b"https://user@example.com/u", b"https://example.com/u#fragment", b"https://127.0.0.1/u"):
            self.assertIsNone(self.target(RAW.replace(b"https://news.example.com/unsubscribe?token=PRIVATE_TOKEN", target)))

    def test_private_mixed_and_rebinding_addresses_never_connect(self):
        for ips in (("127.0.0.1",), ("169.254.169.254",), ("::1",), ("64:ff9b::a9fe:a9fe",),
                    ("2002:7f00:1::",), ("93.184.216.34", "10.0.0.1")):
            with mock.patch.object(U.socket, "getaddrinfo", return_value=[
                    (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ips]), \
                    mock.patch.object(U.socket, "create_connection") as connect:
                result = U.post_once("https://example.com/u", lambda: None)
                self.assertEqual(result, {"outcome": "skipped", "writeAttempted": False})
                connect.assert_not_called()

    def test_exact_post_pins_public_address_never_redirects_or_retries(self):
        for status in (204, 302, 500):
            sock = mock.Mock()
            tls = mock.Mock()
            ctx = mock.Mock()
            ctx.wrap_socket.return_value = tls
            with mock.patch.object(U.socket, "getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]), \
                    mock.patch.object(U.socket, "create_connection", return_value=sock) as connect, \
                    mock.patch.object(U.ssl, "create_default_context", return_value=ctx), \
                    mock.patch.object(U.http.client.HTTPSConnection, "request") as request, \
                    mock.patch.object(U.http.client.HTTPSConnection, "getresponse", return_value=NS(status=status)):
                result = U.post_once("https://example.com/u?token=PRIVATE_TOKEN", lambda: None)
                connect.assert_called_once_with(("93.184.216.34", 443), timeout=15)
                ctx.wrap_socket.assert_called_once_with(sock, server_hostname="example.com")
                self.assertEqual(request.call_count, 1)
                self.assertEqual(request.call_args.args, ("POST", "/u?token=PRIVATE_TOKEN"))
                self.assertEqual(request.call_args.kwargs["body"], b"List-Unsubscribe=One-Click")
                self.assertEqual(set(request.call_args.kwargs["headers"]), {"Content-Type", "Connection"})
                self.assertEqual(result["outcome"], "requested" if status == 204 else "unknown")
                self.assertNotIn("PRIVATE_TOKEN", str(result))

    def test_real_http_encoder_sends_only_the_fixed_one_click_request(self):
        tls = mock.Mock()
        ctx = mock.Mock()
        ctx.wrap_socket.return_value = tls
        with mock.patch.object(U.socket, "getaddrinfo", return_value=[
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]), \
                mock.patch.object(U.socket, "create_connection"), \
                mock.patch.object(U.ssl, "create_default_context", return_value=ctx), \
                mock.patch.object(U.http.client.HTTPSConnection, "getresponse", return_value=NS(status=204)):
            self.assertEqual(U.post_once("https://example.com/u?token=PRIVATE_TOKEN", lambda: None)["outcome"], "requested")
        wire = b"".join(call.args[0] for call in tls.sendall.call_args_list)
        self.assertTrue(wire.startswith(b"POST /u?token=PRIVATE_TOKEN HTTP/1.1\r\n"))
        self.assertTrue(wire.endswith(b"\r\n\r\nList-Unsubscribe=One-Click"))
        self.assertIn(b"Host: example.com\r\n", wire)
        for header in (b"Authorization:", b"Cookie:", b"Referer:"):
            self.assertNotIn(header, wire)

    def test_post_exception_is_one_unknown_attempt_without_provider_diagnostics(self):
        with mock.patch.object(U.socket, "getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]), \
                mock.patch.object(U.socket, "create_connection"), mock.patch.object(U.ssl, "create_default_context"), \
                mock.patch.object(U.http.client.HTTPSConnection, "request", side_effect=OSError("PRIVATE_TOKEN")) as request:
            self.assertEqual(U.post_once("https://example.com/u", lambda: None), {"outcome": "unknown", "writeAttempted": True})
            self.assertEqual(request.call_count, 1)

    def test_real_imap_reference_hash_read_and_no_imap_or_smtp_write(self):
        args = NS(account="fixture", folder=None, special_use=None, uid="11", uid_validity="17", confirm=True,
                  expected_revision=M.email_reference_revision(M.email_monitor_scope(ACCOUNT, "INBOX"), 17, 11),
                  expected_original_sha256=hashlib.sha256(RAW).hexdigest())
        client = ScriptedImap(examine(1, next_uid=12) + fetched(raw=RAW) + examine(3, next_uid=12))
        with mock.patch.object(M, "load_account", return_value=ACCOUNT), \
                mock.patch.object(M, "load_email_policy", return_value={"sendMode": "confirm"}), \
                mock.patch.object(M, "selected_local_account", return_value=None), \
                mock.patch.object(M, "imap_connection", return_value=contextlib.nullcontext(client)), \
                mock.patch.object(M, "require_credential_lease"), \
                mock.patch.object(U, "post_once", return_value={"outcome": "requested", "writeAttempted": True}) as post, \
                mock.patch.object(M, "unsubscribe_runtime", return_value=U):
            result = M.command_unsubscribe_reference(args)
            self.assertEqual(result["outcome"], "requested")
            self.assertFalse(result["automaticRetryAllowed"])
            self.assertEqual(post.call_count, 1)
            self.assertFalse(any(b" STORE " in command or b" SELECT " in command for command in client.sent))
            self.assertNotIn("PRIVATE_TOKEN", str(result))


if __name__ == "__main__":
    unittest.main()
