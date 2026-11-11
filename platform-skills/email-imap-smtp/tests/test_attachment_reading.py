import contextlib
import email.policy
import hashlib
import io
import json
import os
from email.message import EmailMessage
from pathlib import Path
import stat
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

from test_trelio_email import MODULE as M


def invoice_pdf():
    # A real one-page PDF lets a local document reader verify this fixture
    # without needing a PDF-writing library or a binary fixture in Git.
    content = b"BT /F1 14 Tf 30 120 Td (Amount: 1250 RUB. Due: 2026-11-20.) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 160] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    document = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, value in enumerate(objects, start=1):
        offsets.append(len(document))
        document.extend(b"%d 0 obj\n" % index + value + b"\nendobj\n")
    xref = len(document)
    document.extend(b"xref\n0 %d\n0000000000 65535 f \n" % (len(offsets) + 1))
    for offset in offsets:
        document.extend(b"%010d 00000 n \n" % offset)
    document.extend(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(offsets) + 1, xref))
    return bytes(document)


class AttachmentReading(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temp = cls.enterClassContext(tempfile.TemporaryDirectory())
        # On macOS the system temp alias can itself be a symlink. Use the
        # actual isolated directory, like an ordinary resolved user home.
        cls.config = Path(temp).resolve() / "config"
        cls.config.mkdir(mode=0o700)

    def setUp(self):
        self.enterContext(mock.patch.object(M, "CONFIG_DIR", self.config))
        mailbox = hashlib.sha256(self._testMethodName.encode()).hexdigest()[:16]
        self.binding = {"id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                        "providerRef": mailbox, "companyBinding": "a" * 64}
        self.enterContext(mock.patch.dict(os.environ, {
            "TRELIO_SKILL_ACCOUNT_JSON": json.dumps(self.binding),
            "TRELIO_SKILL_COMPANY_ID": "company-a", "TRELIO_SKILL_MEMBER_ID": "member-a"}))
        account = SimpleNamespace(connection_mode="imap_smtp", name=mailbox)
        self.enterContext(mock.patch.object(M, "load_account", return_value=account))
        self.client = mock.MagicMock()
        self.client.select.return_value = ("OK", [b"1"])
        connection = self.enterContext(mock.patch.object(M, "imap_connection"))
        connection.return_value.__enter__.return_value = self.client
        self.message = EmailMessage(policy=email.policy.SMTP)
        self.message["Subject"] = "Invoice attached"
        self.message.set_content("The invoice is attached.")
        self.pdf = invoice_pdf()
        self.message.add_attachment(self.pdf, maintype="application", subtype="pdf",
                                    filename="../../Счёт.pdf")
        self.message.add_attachment(b"logo", maintype="image", subtype="png",
                                    filename="logo.png", disposition="inline")
        self.set_mailbox_bytes(self.message.as_bytes())

    def set_mailbox_bytes(self, raw, uid=42):
        envelope = f"1 (UID {uid} RFC822.SIZE {len(raw)} BODY[] {{{len(raw)}}}".encode()
        self.client.uid.return_value = ("OK", [(envelope, raw), b")"])

    def invoke(self, *args, expected_code=0):
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", ["trelio-email.py", *args]), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(M.main(_owned=True), expected_code, stderr.getvalue())
        return json.loads(stdout.getvalue() if expected_code == 0 else stderr.getvalue())

    def read(self):
        return self.invoke("read", "--folder", "INBOX", "--uid", "42")

    def stage(self, message, index=1, *, expected_code=0):
        return self.invoke("read-attachment", "--folder", message["folder"], "--uid", message["uid"],
                           "--index", str(index), "--expected-message-sha256", message["originalSha256"],
                           expected_code=expected_code)

    def release(self, staged):
        return self.invoke("release-attachment", "--id", staged["temporaryAttachmentId"])

    def test_read_invoice_stages_exact_bytes_in_private_folder_and_releases_without_imap(self):
        mail = self.read()
        self.assertIn("invoice is attached", mail["body"])
        self.assertEqual([item["disposition"] for item in mail["attachments"]], ["attachment", "inline"])
        self.client.select.assert_called_with(b'"INBOX"', readonly=True)
        self.client.uid.assert_called_with("fetch", "42", "(BODY.PEEK[])")
        staged = self.stage(mail, mail["attachments"][0]["index"])
        self.client.uid.assert_called_with("fetch", "42", "(UID RFC822.SIZE BODY.PEEK[])")
        self.assertEqual(staged["filename"], "../../Счёт.pdf")
        path = Path(staged["path"])
        self.assertTrue(path.is_relative_to(self.config / "temporary-attachments"))
        self.assertEqual(path.name, "attachment.pdf")
        self.assertEqual(path.read_bytes(), self.pdf)
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        elif sys.platform == "win32":
            native = M.native_runtime()
            helper = native.native_helper(self.config)
            native.run_private(helper, ["verify-file", str(path)])
            native.run_private(helper, ["verify-directory", str(path.parent)])
        self.client.reset_mock()
        self.assertTrue(self.release(staged)["removed"])
        self.assertFalse(path.parent.exists())
        self.assertFalse(self.release(staged)["removed"])
        self.assertEqual(self.client.mock_calls, [])

    def test_changed_message_or_wrong_native_uid_cannot_stage_file(self):
        mail = self.read()
        self.set_mailbox_bytes(self.message.as_bytes(), uid=43)
        self.assertEqual(self.stage(mail, expected_code=2)["error"], "EMAIL_REFERENCE_UNAVAILABLE")
        self.message.replace_header("Subject", "Different invoice")
        self.set_mailbox_bytes(self.message.as_bytes())
        self.assertEqual(self.stage(mail, expected_code=2)["error"], "EMAIL_ATTACHMENT_MESSAGE_CHANGED")
        self.assertEqual(list(self.config.glob("temporary-attachments/*/*/*")), [])

    def test_attachments_listing_uses_same_indexes_and_expiry_removes_only_stale_lease(self):
        mail = self.invoke("attachments", "--uid", "42")
        self.assertEqual(mail["attachments"], self.read()["attachments"])
        stale = self.stage(mail, 2)
        active = self.stage(mail)
        stale_path = Path(stale["path"])
        expired = time.time() - M.TEMPORARY_ATTACHMENT_TTL_SECONDS - 5
        os.utime(stale_path.parent, (expired, expired))
        new = self.stage(mail)
        self.assertFalse(stale_path.parent.exists())
        self.assertTrue(Path(active["path"]).is_file())
        self.assertTrue(Path(new["path"]).is_file())
        self.release(active)
        self.release(new)

    def test_release_rejects_paths_and_does_not_delete_in_another_company(self):
        staged = self.stage(self.read())
        path = Path(staged["path"])
        self.assertEqual(self.invoke("release-attachment", "--id", "../" + path.parent.name,
                                     expected_code=2)["error"], "EMAIL_ATTACHMENT_ID_INVALID")
        with mock.patch.dict(os.environ, {"TRELIO_SKILL_COMPANY_ID": "company-b"}):
            self.assertFalse(self.release(staged)["removed"])
        self.assertTrue(path.is_file())
        self.assertTrue(self.release(staged)["removed"])

    def test_permanent_save_still_uses_the_requested_folder_and_original_basename(self):
        with tempfile.TemporaryDirectory() as output:
            saved = self.invoke("save-attachment", "--uid", "42", "--index", "1", "--output", output)
            path = Path(saved["saved"])
            self.assertEqual(path, Path(output).resolve() / "Счёт.pdf")
            self.assertEqual(path.read_bytes(), self.pdf)

    @unittest.skipUnless(os.name == "posix", "symlink fixture does not need Windows elevation")
    def test_expiry_and_release_never_traverse_a_symlink(self):
        staged = self.stage(self.read())
        path = Path(staged["path"])
        path.unlink()
        path.parent.rmdir()
        with tempfile.TemporaryDirectory() as outside:
            protected = Path(outside) / path.name
            protected.write_bytes(b"unrelated")
            path.parent.symlink_to(outside, target_is_directory=True)
            result = self.invoke("release-attachment", "--id", staged["temporaryAttachmentId"], expected_code=2)
            self.assertEqual(result["error"], "EMAIL_ATTACHMENT_STORAGE_UNAVAILABLE")
            self.assertEqual(protected.read_bytes(), b"unrelated")
            path.parent.unlink()
