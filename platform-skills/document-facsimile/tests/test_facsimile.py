"""Synthetic signatures only: storage, human form and real UTF-8 CLI pipes."""

import base64
import binascii
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit
import uuid
import xml.etree.ElementTree as ET
import zipfile
import zlib

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/trelio-facsimile.py"
SPEC = importlib.util.spec_from_file_location("facsimile", SCRIPT)
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)
NAME = "Тестов Тест Безличный"
OTHER = "Примеров Пример Синтетический"
ACCOUNT = "11111111-1111-4111-8111-111111111111"
COMPANY = "22222222-2222-4222-8222-222222222222"
MEMBER = "33333333-3333-4333-8333-333333333333"


def chunk(kind, data):
    return (struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", binascii.crc32(kind + data) & 0xffffffff))


def synthetic_png(alpha=True, ancillary=False, filter_type=0):
    # Two obvious rectangular pixels, deliberately not a person's signature.
    pixels = bytes((10, 20, 30, 255, 0, 0, 0, 0 if alpha else 255))
    if filter_type == 1:
        encoded = pixels[:4] + bytes((pixels[i] - pixels[i - 4]) & 255 for i in range(4, 8))
    else:
        encoded = pixels
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 1, 8, 6, 0, 0, 0))
            + (chunk(b"tEXt", b"SyntheticMetadata\x00MustDisappear") if ancillary else b"")
            + chunk(b"IDAT", zlib.compress(bytes([filter_type]) + encoded)) + chunk(b"IEND", b""))


def docx(path, paragraphs=None, extra=None, extensions=False):
    w = runtime.NS["w"]
    r = runtime.NS["r"]
    declarations = f'xmlns:w="{w}" xmlns:r="{r}"'
    if extensions:
        declarations += ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14"'
    paragraphs = paragraphs or ['<w:p><w:r><w:t>Before {{SIGNATURE}} after</w:t></w:r></w:p>']
    files = {
        "[Content_Types].xml": b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "_rels/.rels": b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/document.xml": ('<w:document ' + declarations + '><w:body>' + ''.join(paragraphs)
                              + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>').encode(),
        "word/_rels/document.xml.rels": b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdFacsimile" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        "word/styles.xml": f'<w:styles xmlns:w="{w}"/>'.encode(),
    }
    files.update(extra or {})
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return files


class FacsimileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name).resolve()
        self.env = {**os.environ, "TRELIO_CONFIG_HOME": str(self.home),
                    "TRELIO_SKILL_COMPANY_ID": COMPANY, "TRELIO_SKILL_MEMBER_ID": MEMBER,
                    "TRELIO_SKILL_ID": "document-facsimile",
                    "TRELIO_SKILL_ACCOUNT_JSON": json.dumps({"id": ACCOUNT, "providerRef": None,
                                                              "companyBinding": "a" * 64,
                                                              "name": "Synthetic", "comment": "Only fixture documents"})}
        self.environment = patch.dict(os.environ, self.env, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.root = runtime.storage_root(ACCOUNT)

    def save(self, name=NAME, png=None, revision=0):
        return runtime.save_bundle(self.root, name, png or synthetic_png(), 34, revision)

    def cli(self, *args, env=None, expected=0):
        result = subprocess.run([sys.executable, "-I", str(SCRIPT), *args], env=env or self.env,
                                capture_output=True, timeout=45)
        self.assertEqual(result.returncode, expected, result.stdout.decode("utf-8"))
        self.assertEqual(result.stderr, b"")
        return json.loads(result.stdout.decode("utf-8"))

    def failure(self, code, action):
        with self.assertRaisesRegex(runtime.Failure, "^" + code + "$"):
            action()

    def test_import_is_empty_without_account_and_does_not_read_private_material(self):
        env = {k: v for k, v in self.env.items() if not k.startswith("TRELIO_")}
        self.assertEqual(self.cli("__trelio_accounts_import", env=env), {"schemaVersion": 1, "accounts": []})
        self.assertFalse((self.root / "facsimile.json").exists())

    def test_cli_requires_verified_account_and_live_identity(self):
        for key in ("TRELIO_SKILL_ACCOUNT_JSON", "TRELIO_SKILL_COMPANY_ID", "TRELIO_SKILL_MEMBER_ID"):
            env = {k: v for k, v in self.env.items() if k != key}
            self.assertEqual(self.cli("doctor", env=env, expected=2)["code"], "account_required")
        env = {**self.env, "TRELIO_SKILL_ACCOUNT_JSON": json.dumps({"id": "../../escape"})}
        self.assertEqual(self.cli("doctor", env=env, expected=2)["code"], "account_required")

    def test_required_name_and_proportions(self):
        for name in ("", "Тестов", "Тестов\nТест", "Тестов\u202e Тест", "11 22"):
            self.failure("invalid_full_name", lambda: self.save(name=name))
        self.assertEqual(runtime.full_name("  Тестов  Тест  "), "Тестов Тест")
        for value in (0, 101, float("nan"), float("inf"), True):
            self.failure("invalid_width", lambda: runtime.width_mm(value))
        self.assertFalse((self.root / "facsimile.json").exists())

    def test_png_validates_crc_transparency_decompression_and_strips_metadata(self):
        clean, width, height = runtime.png_info(synthetic_png(ancillary=True, filter_type=1))
        self.assertEqual((width, height), (2, 1))
        self.assertNotIn(b"MustDisappear", clean)
        runtime.png_info(clean)
        self.failure("transparent_png_required", lambda: runtime.png_info(synthetic_png(alpha=False)))
        bad = bytearray(synthetic_png())
        bad[29] ^= 1
        self.failure("invalid_png", lambda: runtime.png_info(bytes(bad)))
        self.failure("invalid_png", lambda: runtime.png_info(synthetic_png() + b"extra"))
        header = chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 1, 8, 6, 0, 0, 0))
        bomb = b"\x89PNG\r\n\x1a\n" + header + chunk(b"IDAT", zlib.compress(b"x" * 100000)) + chunk(b"IEND", b"")
        self.failure("invalid_png", lambda: runtime.png_info(bomb))
        animated = b"\x89PNG\r\n\x1a\n" + header + chunk(b"acTL", b"12345678") + chunk(b"IEND", b"")
        self.failure("unsupported_png", lambda: runtime.png_info(animated))

    def test_account_storage_isolation_cas_and_metadata_only_stdout(self):
        self.save()
        result = self.cli("show")
        self.assertEqual(result["ownerFullName"], NAME)
        self.assertEqual(result["revision"], 1)
        self.assertNotIn("pngBase64", result)
        self.assertNotIn(str(self.root), json.dumps(result))
        other_root = runtime.storage_root(str(uuid.uuid4()))
        runtime.save_bundle(other_root, OTHER, synthetic_png(), 38, 0)
        self.assertEqual(runtime.read_bundle(self.root)["ownerFullName"], NAME)
        self.failure("revision_conflict", lambda: self.save(name=OTHER))
        self.assertEqual(runtime.read_bundle(self.root)["ownerFullName"], NAME)
        self.save(name=OTHER, revision=1)
        self.assertEqual(runtime.read_bundle(self.root)["revision"], 2)

    def test_lock_does_not_reuse_or_remove_another_mutation_lock(self):
        with runtime.storage_lock(self.root):
            self.failure("storage_busy", lambda: self.save())
            self.assertTrue((self.root / ".mutation-lock").is_dir())
        self.assertFalse((self.root / ".mutation-lock").exists())

    def test_unsafe_storage_never_repairs_existing_permissions_or_symlinks(self):
        if os.name != "nt":
            self.root.chmod(0o777)
            self.failure("private_storage_permissions", lambda: runtime.private_directory(self.root))
            self.assertEqual(self.root.stat().st_mode & 0o777, 0o777)
            self.root.chmod(0o700)
        outside = self.home / "outside"
        outside.write_text("untouched")
        target = self.root / "facsimile.json"
        try:
            target.symlink_to(outside)
        except OSError:
            self.skipTest("OS disallows unprivileged symlink fixture")
        self.failure("unsafe_path", lambda: runtime.read_bundle(self.root))
        self.assertEqual(outside.read_text(), "untouched")

    def test_hardlink_and_tampered_bundle_fail_closed(self):
        self.save()
        target = self.root / "facsimile.json"
        linked = self.root / "linked"
        os.link(target, linked)
        self.failure("unsafe_storage", lambda: runtime.read_bundle(self.root))
        linked.unlink()
        bundle = json.loads(target.read_bytes())
        bundle["ownerFullName"] = "Invalid"
        target.write_text(json.dumps(bundle), encoding="utf-8")
        self.failure("invalid_full_name", lambda: runtime.read_bundle(self.root))

    def test_authorization_and_exact_owner_are_required_before_output(self):
        self.save()
        output = self.home / "output.png"
        for args, code in ((["--author", NAME], "signing_authority_required"),
                           (["--author", OTHER, "--authorized"], "author_mismatch")):
            self.assertEqual(self.cli("image", "--output", str(output), *args, expected=2)["code"], code)
            self.assertFalse(output.exists())
        result = self.cli("image", "--output", str(output), "--author", "  тестов тест безличный ", "--authorized")
        self.assertEqual(result["state"], "prepared")
        self.assertTrue(result["visualReviewRequired"])
        self.assertEqual(result["sha256"], hashlib.sha256(output.read_bytes()).hexdigest())
        runtime.private_check(output)
        self.assertEqual(self.cli("image", "--output", str(output), "--author", NAME,
                                  "--authorized", expected=2)["code"], "output_exists")

    def test_clear_needs_exact_command_and_keeps_aba_tombstone(self):
        self.save()
        self.assertEqual(self.cli("clear", "--expected-revision", "1", expected=2)["code"], "clear_confirmation_required")
        result = self.cli("clear", "--expected-revision", "1", "--confirm")
        self.assertEqual((result["state"], result["revision"]), ("not_configured", 2))
        private = (self.root / "facsimile.json").read_bytes()
        self.assertNotIn(NAME.encode(), private)
        self.assertNotIn(b"pngBase64", private)
        self.failure("revision_conflict", lambda: self.save(revision=1))
        self.save(name=OTHER, revision=2)
        self.assertEqual(self.cli("show")["revision"], 3)

    def test_docx_split_marker_relationships_namespace_bindings_and_original_preserved(self):
        self.save()
        source, output = self.home / "source.docx", self.home / "result.docx"
        originals = docx(source, ['<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Before {{SIG</w:t></w:r><w:r><w:t>NATURE}} after</w:t></w:r></w:p>'], extensions=True)
        digest = hashlib.sha256(source.read_bytes()).digest()
        result = self.cli("insert-docx", "--input", str(source), "--output", str(output), "--author", NAME, "--authorized")
        self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), digest)
        self.assertEqual(result["state"], "prepared")
        with zipfile.ZipFile(output) as archive:
            raw = archive.read("word/document.xml")
            document = ET.fromstring(raw)
            self.assertEqual(''.join(t.text or '' for t in document.iter(f"{{{runtime.NS['w']}}}t")), "Before  after")
            self.assertIn(b'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"', raw)
            self.assertIn(b'Ignorable="w14"', raw)
            self.assertEqual(len(list(document.iter(f"{{{runtime.NS['w']}}}drawing"))), 1)
            extent = next(document.iter(f"{{{runtime.NS['wp']}}}extent"))
            self.assertEqual((extent.get("cx"), extent.get("cy")), ("1224000", "612000"))
            relations = ET.fromstring(archive.read("word/_rels/document.xml.rels"))
            self.assertIn(b'<Relationships xmlns="', archive.read("word/_rels/document.xml.rels"))
            self.assertIn(b'<Types xmlns="', archive.read("[Content_Types].xml"))
            self.assertEqual([r.get("Id") for r in relations], ["rIdFacsimile", "rIdFacsimilex"])
            self.assertEqual(archive.read("word/styles.xml"), originals["word/styles.xml"])
            media = [n for n in archive.namelist() if n.startswith("word/media/")]
            self.assertEqual(len(media), 1)
            self.assertEqual(archive.read(media[0]), synthetic_png())
        self.assertEqual(self.cli("insert-docx", "--input", str(source), "--output", str(source), "--author", NAME,
                                  "--authorized", expected=2)["code"], "output_exists")

    def test_docx_marker_same_run_retains_tail_and_table_paragraph_is_supported(self):
        self.save()
        source = self.home / "table.docx"
        docx(source, ['<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Before {{SIGNATURE}} after</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'])
        result = runtime.insert_docx(source, runtime.read_bundle(self.root))
        with zipfile.ZipFile(io.BytesIO(result)) as archive:
            document = ET.fromstring(archive.read("word/document.xml"))
        run = document.find(".//w:r", runtime.NS)
        self.assertEqual([node.tag.rsplit("}", 1)[-1] for node in run], ["t", "drawing", "t"])
        self.assertEqual(run[-1].text, " after")

    def test_docx_unsupported_marker_and_containers_fail_before_writing(self):
        self.save()
        bundle = runtime.read_bundle(self.root)
        source = self.home / "bad.docx"
        for paragraphs in (["<w:p><w:r><w:t>No marker</w:t></w:r></w:p>"],
                           ["<w:p><w:r><w:t>{{SIGNATURE}} {{SIGNATURE}}</w:t></w:r></w:p>"],
                           ['<w:p><w:hyperlink><w:r><w:t>{{SIGNATURE}}</w:t></w:r></w:hyperlink></w:p>']):
            docx(source, paragraphs)
            self.failure("one_signature_marker_required", lambda: runtime.insert_docx(source, bundle))
        for extra in ({"../evil": b"bad"}, {"_xmlsignatures/test.xml": b"x"}, {"word/vbaProject.bin": b"x"}):
            docx(source, extra=extra)
            self.failure("unsafe_docx" if "../evil" in extra else "unsupported_docx",
                         lambda: runtime.insert_docx(source, bundle))
        self.failure("unsafe_docx", lambda: runtime.xml(b'<!DOCTYPE x [<!ENTITY a "x">]><x>&a;</x>'))
        self.failure("unsafe_docx", lambda: runtime.xml('<!DOCTYPE x [<!ENTITY a "x">]><x>&a;</x>'.encode("utf-16")))

    def start_form(self):
        ready, done = threading.Event(), threading.Event()
        data = {}
        def on_ready(url, nonce):
            data.update(url=url, nonce=nonce)
            ready.set()
        def worker():
            try:
                data["result"] = runtime.local_form(self.root, timeout=8, open_browser=False, ready=on_ready)
            except Exception as error:
                data["error"] = error
            finally:
                done.set()
        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        self.assertTrue(ready.wait(30), repr(data.get("error")))
        return data, thread, done

    def request(self, data, body=None, origin=True, nonce=True, host=None):
        url = urlsplit(data["url"])
        connection = http.client.HTTPConnection(url.hostname, url.port, timeout=10)
        headers = {"Host": host or url.netloc}
        if body is not None:
            headers.update({"Content-Type": "application/json", "Origin": "http://" + url.netloc if origin else "https://example.invalid",
                            "X-Facsimile-Nonce": data["nonce"] if nonce else "wrong"})
        connection.request("POST" if body is not None else "GET", url.path,
                           body=json.dumps(body).encode() if body is not None else None, headers=headers)
        result = connection.getresponse()
        status, payload, response_headers = result.status, result.read(), dict(result.getheaders())
        connection.close()
        return status, payload, response_headers

    def test_form_rejects_cross_origin_then_saves_and_closes_without_chat_ack(self):
        data, thread, done = self.start_form()
        status, html, headers = self.request(data)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertIn('ФИО владельца'.encode(), html)
        body = {"ownerFullName": NAME, "widthMm": 34, "pngBase64": base64.b64encode(synthetic_png()).decode()}
        for kwargs in ({"origin": False}, {"nonce": False}, {"host": "evil.invalid"}):
            self.assertEqual(self.request(data, body, **kwargs)[0], 403)
            self.assertIsNone(runtime.read_bundle(self.root))
        self.assertEqual(self.request(data, body)[0], 200)
        self.assertTrue(done.wait(30))
        thread.join()
        self.assertNotIn("error", data)
        self.assertEqual(data["result"]["state"], "configured")
        url = urlsplit(data["url"])
        with self.assertRaises(OSError):
            socket.create_connection((url.hostname, url.port), timeout=1)

    def test_form_cancel_timeout_and_stale_save_preserve_prior_signature(self):
        self.save()
        data, thread, done = self.start_form()
        self.assertEqual(self.request(data, {"cancel": True})[0], 200)
        self.assertTrue(done.wait(15))
        thread.join()
        self.assertEqual(data["result"]["state"], "cancelled")
        self.assertEqual(runtime.read_bundle(self.root)["revision"], 1)
        self.failure("setup_timeout", lambda: runtime.local_form(self.root, timeout=0.01, open_browser=False))
        data, thread, done = self.start_form()
        self.save(name=OTHER, revision=1)
        body = {"ownerFullName": NAME, "widthMm": 34, "pngBase64": base64.b64encode(synthetic_png()).decode()}
        status, payload, _ = self.request(data, body)
        self.assertEqual((status, json.loads(payload)["code"]), (400, "revision_conflict"))
        self.assertEqual(runtime.read_bundle(self.root)["ownerFullName"], OTHER)
        self.request(data, {"cancel": True})
        self.assertTrue(done.wait(15))
        thread.join()

    def test_form_startup_does_not_require_dns(self):
        with patch("socket.getfqdn", side_effect=AssertionError("loopback DNS must not be used")):
            self.failure("setup_timeout", lambda: runtime.local_form(self.root, timeout=0.01, open_browser=False))

    @unittest.skipUnless(os.name == "nt", "native Windows contract")
    def test_windows_restricted_parent_filtered_policy_and_persistent_readback(self):
        executable = str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe")
        def policy():
            # Hosted CI starts from PowerShell Core and can inherit its module
            # search path into Windows PowerShell. The read-only test probe
            # loads the security module from this executable's own fixed
            # vendor directory; production ACL checks require no module.
            command = ("Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; "
                       "[Console]::Out.WriteLine(((Get-ExecutionPolicy -List | ForEach-Object { "
                       "$_.Scope.ToString() + ':' + $_.ExecutionPolicy.ToString() }) -join ','))")
            result = subprocess.run([executable, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                                     "-Command", command], capture_output=True, check=True, timeout=15)
            return result.stdout.decode("ascii").strip()
        before = policy()
        # This is process-only Restricted in the parent. The actual signed
        # helper must still bootstrap through its explicit child Bypass argv.
        root = self.home / "restricted-first-start"
        root.mkdir()
        env = {**self.env, "TRELIO_CONFIG_HOME": str(root), "FACSIMILE_TEST_PYTHON": sys.executable,
               "FACSIMILE_TEST_SCRIPT": str(SCRIPT), "PSModulePath": str(root / "absent-modules")}
        env.pop("PSExecutionPolicyPreference", None)
        result = subprocess.run([executable, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted",
                                 "-Command", "& $env:FACSIMILE_TEST_PYTHON -I $env:FACSIMILE_TEST_SCRIPT doctor; exit $LASTEXITCODE"],
                                env=env, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout.decode("utf-8", "replace"))
        self.assertEqual(json.loads(result.stdout)["state"], "not_configured")
        self.assertEqual(policy(), before)


if __name__ == "__main__":
    unittest.main()
