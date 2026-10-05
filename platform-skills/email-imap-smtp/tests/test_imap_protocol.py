"""Exercise the real stdlib encoder and response parser without a mailbox.

MagicMock.select accepts malformed names, which hid the original Gmail bugs.
Only socket I/O is replaced here; imaplib constructs and parses the actual
EXAMINE, LIST, literal continuation and UID SEARCH protocol bytes.
"""

import contextlib
import io
import json
import unittest
from unittest import mock

from test_trelio_email import MODULE


class ScriptedImap(MODULE.imaplib.IMAP4):
    def __init__(self, responses=b"", capabilities=b"IMAP4rev1"):
        self.responses = io.BytesIO(
            b"* PREAUTH synthetic fixture\r\n* CAPABILITY " + capabilities
            + b"\r\nTEST0 OK capabilities\r\n" + responses
        )
        self.sent = []
        with mock.patch.object(MODULE.imaplib, "Int2AP", return_value=b"TEST"):
            super().__init__("fixture.invalid")
        self.sent.clear()

    def open(self, host, port, timeout=None):
        self.host, self.port, self.sock = host, port, None

    def read(self, size):
        return self.responses.read(size)

    def readline(self):
        return self.responses.readline()

    def send(self, data):
        self.sent.append(data)

    def shutdown(self):
        self.responses.close()


class ImapProtocolTests(unittest.TestCase):
    def test_modified_utf7_known_vectors_roundtrip(self):
        # The last example is the RFC 3501 mailbox naming example. Expected
        # bytes are independent of our encoder and include modified ',' base64.
        for name, wire in (
            ("INBOX", b"INBOX"),
            ("[Gmail]/Sent Mail", b"[Gmail]/Sent Mail"),
            ("[Gmail]/Отправленные", b"[Gmail]/&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-"),
            ("A&B", b"A&-B"),
            ("~peter/mail/台北/日本語", b"~peter/mail/&U,BTFw-/&ZeVnLIqe-"),
            ("📨", b"&2D3c6A-"),
            (" leading and trailing ", b" leading and trailing "),
        ):
            with self.subTest(name=name):
                self.assertEqual(MODULE.encode_imap_folder(name), wire)
                self.assertEqual(MODULE.decode_imap_folder(wire), name)

    def test_select_uses_encoded_and_quoted_wire_names(self):
        for name, argument in (
            ("INBOX", b'"INBOX"'),
            ("[Gmail]/Sent Mail", b'"[Gmail]/Sent Mail"'),
            ("[Gmail]/Отправленные", b'"[Gmail]/&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-"'),
            ('Quotes " and \\ slash', b'"Quotes \\" and \\\\ slash"'),
            ('"literal quotes"', b'"\\"literal quotes\\""'),
            ("A&B", b'"A&-B"'),
        ):
            with self.subTest(name=name):
                client = ScriptedImap(b"* 0 EXISTS\r\nTEST1 OK examined\r\n")
                self.assertEqual(MODULE.select_folder(client, name), name)
                self.assertEqual(client.sent, [b"TEST1 EXAMINE " + argument + b"\r\n"])
                self.assertTrue(client.is_readonly)

    def test_utf8_capability_alone_does_not_change_mailbox_encoding(self):
        client = ScriptedImap(b"* 0 EXISTS\r\nTEST1 OK examined\r\n", b"IMAP4rev1 UTF8=ACCEPT")
        MODULE.select_folder(client, "Почта")
        self.assertTrue(b"&" in client.sent[0])
        self.assertTrue(client.sent[0].isascii())

    def test_enabled_utf8_uses_utf8_names(self):
        client = ScriptedImap(b"* 0 EXISTS\r\nTEST1 OK examined\r\n")
        client._mode_utf8()
        MODULE.select_folder(client, "Почта & archive")
        self.assertEqual(client.sent, ['TEST1 EXAMINE "Почта & archive"\r\n'.encode()])

    def test_invalid_folder_controls_never_reach_wire(self):
        for name in ("", "abc\r\nUID SEARCH ALL", "a\x00b", "a\nb"):
            with self.subTest(name=name):
                client = ScriptedImap()
                with self.assertRaises(MODULE.MailboxError):
                    MODULE.select_folder(client, name)
                self.assertEqual(client.sent, [])

    def test_bad_and_no_select_are_expected_errors(self):
        for status in (b"BAD", b"NO"):
            with self.subTest(status=status):
                client = ScriptedImap(b"TEST1 " + status + b" cannot select\r\n")
                with self.assertRaisesRegex(MODULE.MailboxError, "Cannot select IMAP folder"):
                    MODULE.select_folder(client, "Sent Mail")

    def test_list_parses_quoted_atom_and_literal_from_real_imaplib(self):
        literal = b"[Gmail]/&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-"
        client = ScriptedImap(
            b'* LIST (\\HasNoChildren) "/" INBOX\r\n'
            b'* LIST (\\NoSelect) NIL "[Gmail]"\r\n'
            b'* LIST (\\Archive) "/" "A&-B \\"quotes\\" \\\\ end"\r\n'
            b'* LIST (\\HasNoChildren \\Sent) "/" {' + str(len(literal)).encode() + b'}\r\n'
            + literal + b'\r\nTEST1 OK listed\r\n'
        )
        rows = MODULE.list_folders(client)
        self.assertEqual(client.sent, [b'TEST1 LIST "" "*"\r\n'])
        self.assertEqual([row.name for row in rows], ["INBOX", "[Gmail]", 'A&B "quotes" \\ end', "[Gmail]/Отправленные"])
        self.assertFalse(rows[1].selectable)
        self.assertIsNone(rows[1].delimiter)
        self.assertEqual(rows[-1].as_dict()["specialUse"], ["sent"])
        self.assertEqual(rows[-1].wire_name, literal)

    def test_special_use_resolves_localized_name_without_gmail_alias(self):
        client = ScriptedImap(
            b'* LIST (\\NoSelect \\Sent) "/" "Not selectable"\r\n'
            b'* LIST (\\HasNoChildren \\sEnT) "/" "[Gmail]/&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-"\r\n'
            b'TEST1 OK listed\r\n* 0 EXISTS\r\nTEST2 OK examined\r\n'
        )
        folder = MODULE.select_folder(client, None, special_use="sent")
        self.assertEqual(folder, "[Gmail]/Отправленные")
        self.assertEqual(client.sent[-1], b'TEST2 EXAMINE "[Gmail]/&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-"\r\n')

    def test_special_use_requested_for_servers_that_advertise_extension(self):
        client = ScriptedImap(
            b'* LIST (\\Sent) "/" "Sent Items"\r\nTEST1 OK listed\r\n',
            b"IMAP4rev1 LIST-EXTENDED SPECIAL-USE",
        )
        self.assertEqual(MODULE.list_folders(client)[0].name, "Sent Items")
        self.assertEqual(client.sent, [b'TEST1 LIST "" "*" RETURN (SPECIAL-USE)\r\n'])

    def test_missing_ambiguous_or_nonselectable_role_never_guesses(self):
        for listing, count in (
            (b'* LIST () "/" "Sent Mail"\r\n', 0),
            (b'* LIST (\\NonExistent \\Sent) "/" "Sent"\r\n', 0),
            (b'* LIST (\\Sent) "/" "Sent A"\r\n* LIST (\\Sent) "/" "Sent B"\r\n', 2),
        ):
            with self.subTest(listing=listing):
                client = ScriptedImap(listing + b"TEST1 OK listed\r\n")
                with self.assertRaisesRegex(MODULE.MailboxError, f"found {count}"):
                    MODULE.select_folder(client, None, special_use="sent")
                self.assertEqual(len(client.sent), 1)

    def test_empty_list_and_utf8_list(self):
        self.assertEqual(MODULE.list_folders(ScriptedImap(b"TEST1 OK no folders\r\n")), [])
        client = ScriptedImap('* LIST (\\Sent) "/" "Отправленные & копии"\r\nTEST1 OK listed\r\n'.encode())
        client._mode_utf8()
        self.assertEqual(MODULE.list_folders(client)[0].name, "Отправленные & копии")

    def test_malformed_list_fails_closed(self):
        for data in (
            [b'() "/" "unterminated'],
            [b'() "/" "bad\\q"'],
            [b'() "/" has spaces'],
            [b'() "/" "&invalid"'],
            [b'() "/" "&A-"'],
            [b'() "/" "&AAo-"'],
            [(b'() "/" {4}', b'abc'), b''],
            [(b'() "/" {3}', b'abc')],
            [(b'() "/" {3}', b'abc'), b'junk'],
        ):
            with self.subTest(data=data), self.assertRaises(MODULE.MailboxError):
                MODULE.parse_imap_list(data)

    def test_list_limit_does_not_return_partial_success(self):
        with mock.patch.object(MODULE, "MAX_FOLDERS", 1):
            with self.assertRaisesRegex(MODULE.MailboxError, "folder safety limit"):
                MODULE.parse_imap_list([b'() "/" a', b'() "/" b'])

    def test_all_mailbox_commands_accept_role_and_preserve_exact_names(self):
        for command, extra in (
            ("search", ["--subject", "test"]),
            ("read", ["--uid", "1"]),
            ("attachments", ["--uid", "1"]),
            ("save-message", ["--uid", "1", "--output", "."]),
            ("save-attachment", ["--uid", "1", "--output", ".", "--index", "1"]),
        ):
            with self.subTest(command=command):
                parser = MODULE.build_parser()
                args = parser.parse_args([command, "--account", "work", "--special-use", "sent", *extra])
                self.assertIsNone(args.folder)
                self.assertEqual(args.special_use, "sent")
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    parser.parse_args([command, "--account", "work", "--folder", "Sent", "--special-use", "sent", *extra])

    def test_search_returns_resolved_folder_for_followup_uid_commands(self):
        client = ScriptedImap(
            b'* LIST (\\Sent) "/" "Sent Items"\r\nTEST1 OK listed\r\n'
            b'* 0 EXISTS\r\nTEST2 OK examined\r\n* SEARCH\r\nTEST3 OK searched\r\n'
        )
        args = MODULE.build_parser().parse_args(["search", "--account", "work", "--special-use", "sent", "--subject", "test"])
        with (
            mock.patch.object(MODULE, "load_account", return_value=mock.Mock(name="work")),
            mock.patch.object(MODULE, "imap_connection", return_value=contextlib.nullcontext(client)),
        ):
            result = MODULE.command_search(args)
        self.assertEqual(result["folder"], "Sent Items")
        self.assertEqual(result["messages"], [])
        self.assertEqual(client.sent[-1], b'TEST3 UID SEARCH SUBJECT "test"\r\n')
        self.assertEqual(result["coverage"], {"matched": 0, "returned": 0, "limitReached": False, "unavailable": 0, "complete": True})

    def test_search_coverage_distinguishes_limit_and_unavailable_headers(self):
        raw = b"Subject: synthetic\r\n\r\n"
        client = ScriptedImap(
            b'* 3 EXISTS\r\nTEST1 OK examined\r\n* SEARCH 10 20 30\r\nTEST2 OK searched\r\n'
            b'TEST3 OK message disappeared\r\n* 9 FETCH (FLAGS (\\Seen))\r\n'
            b'* 2 FETCH (BODY[HEADER.FIELDS (SUBJECT)] {' + str(len(raw)).encode()
            + b'}\r\n' + raw + b')\r\nTEST4 OK header\r\n'
        )
        args = MODULE.build_parser().parse_args(["search", "--account", "work", "--subject", "test", "--limit", "2"])
        with (
            mock.patch.object(MODULE, "load_account", return_value=mock.Mock()),
            mock.patch.object(MODULE, "imap_connection", return_value=contextlib.nullcontext(client)),
        ):
            result = MODULE.command_search(args)
        self.assertEqual([row["uid"] for row in result["messages"]], ["20"])
        self.assertEqual(result["folder"], "INBOX")
        self.assertEqual(result["coverage"], {"matched": 3, "returned": 1, "limitReached": True, "unavailable": 1, "complete": False})

    def test_unicode_search_uses_real_multiple_literal_continuations(self):
        client = ScriptedImap(b"+ first\r\n+ second\r\n* SEARCH 42\r\nTEST1 OK searched\r\n")
        client.state = "SELECTED"
        self.assertEqual(MODULE.imap_uid_search(client, ["FROM", "Я".encode(), "SUBJECT", "Тема".encode(), "SINCE", "01-Sep-2026"]), ("OK", [b"42"]))
        self.assertEqual(b"".join(client.sent), b"TEST1 UID SEARCH CHARSET UTF-8 FROM {2}\r\n" + "Я SUBJECT {8}\r\nТема SINCE 01-Sep-2026\r\n".encode())
        self.assertIsNone(client.literal)

    def test_enabled_utf8_search_omits_charset(self):
        client = ScriptedImap(b"+ continue\r\n* SEARCH\r\nTEST1 OK searched\r\n")
        client.state = "SELECTED"
        client._mode_utf8()
        MODULE.imap_uid_search(client, ["SUBJECT", "Тема".encode()])
        self.assertEqual(b"".join(client.sent), b"TEST1 UID SEARCH SUBJECT {8}\r\n" + "Тема\r\n".encode())

    def test_rejected_search_literal_is_cleared_before_next_command(self):
        client = ScriptedImap(b"TEST1 NO [BADCHARSET] unsupported\r\nTEST2 OK noop\r\n")
        client.state = "SELECTED"
        status, _ = MODULE.imap_uid_search(client, ["SUBJECT", "Тема".encode()])
        self.assertEqual(status, "NO")
        self.assertIsNone(client.literal)
        self.assertNotIn("Тема".encode(), b"".join(client.sent))
        client.noop()
        self.assertEqual(client.sent[-1], b"TEST2 NOOP\r\n")

    def test_imap_error_is_json_without_traceback(self):
        stderr = io.StringIO()
        with (
            mock.patch.object(MODULE.sys, "argv", ["trelio-email", "folders", "--account", "work"]),
            mock.patch.object(MODULE, "command_folders", side_effect=MODULE.imaplib.IMAP4.error("LIST BAD")),
            contextlib.redirect_stderr(stderr),
        ):
            self.assertEqual(MODULE.main(_owned=True), 2)
        self.assertEqual(json.loads(stderr.getvalue()), {"ok": False, "error": "LIST BAD"})

    def test_exact_uid_rejects_ranges_wildcards_and_command_injection(self):
        for value in ("0", "01", "1:100", "*", "1,2", "-1", "4294967296", "1\r\nLOGOUT", "１２"):
            with self.subTest(value=value):
                client = ScriptedImap()
                with self.assertRaises(MODULE.MailboxError):
                    MODULE.fetch_raw_message(client, value)
                self.assertEqual(client.sent, [])
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    MODULE.build_parser().parse_args(["read", "--account", "work", "--uid", value])
        self.assertEqual(MODULE.validate_message_uid("4294967295"), "4294967295")

    def test_fetch_uses_peek_and_ignores_unsolicited_flag_updates(self):
        raw = b"Subject: exact\r\n\r\nBody\r\n"
        client = ScriptedImap(
            b'* 9 FETCH (FLAGS (\\Seen))\r\n* 2 FETCH (BODY[] {' + str(len(raw)).encode()
            + b'}\r\n' + raw + b' UID 42)\r\nTEST1 OK fetched\r\n'
        )
        client.state = "SELECTED"
        self.assertEqual(MODULE.fetch_raw_message(client, "42"), raw)
        self.assertEqual(client.sent, [b"TEST1 UID FETCH 42 (BODY.PEEK[])\r\n"])

    def test_fetch_rejects_multiple_messages_instead_of_exporting_first(self):
        client = mock.Mock()
        client.uid.return_value = ("OK", [(b"one", b"a"), (b"two", b"b")])
        with self.assertRaisesRegex(MODULE.MailboxError, "exactly one"):
            MODULE.fetch_raw_message(client, "42")

    def test_unknown_header_and_body_charsets_do_not_crash_read(self):
        self.assertEqual(MODULE.decode_header_value("=?x-invalid-charset?b?SGVsbG8=?="), "Hello")
        message = MODULE.email.message_from_bytes(
            b"Content-Type: text/plain; charset=x-invalid-charset\r\n\r\nHello \xff",
            policy=MODULE.default,
        )
        self.assertEqual(MODULE.message_text(message), "Hello \ufffd")

    def test_imap_date_does_not_use_localized_strftime(self):
        class NonEnglishDate(MODULE.dt.date):
            def strftime(self, _format):
                raise AssertionError("Locale-dependent IMAP month")

        with mock.patch.object(MODULE.dt, "date", NonEnglishDate):
            self.assertEqual(MODULE.imap_date("2026-09-05"), "05-Sep-2026")


if __name__ == "__main__":
    unittest.main()
