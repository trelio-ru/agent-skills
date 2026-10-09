#!/usr/bin/env python3
"""Local facsimile storage and deterministic DOCX insertion; no cloud transport."""

import argparse
import base64
import binascii
import contextlib
import hashlib
import http.server
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import stat
import struct
import subprocess
import sys
import time
import unicodedata
import uuid
import webbrowser
import xml.etree.ElementTree as ET
import zipfile
import zlib

VERSION = "1.0.0"
MAX_PNG = 8 * 1024 * 1024
MAX_BUNDLE = MAX_PNG * 2
MAX_DOCX = 64 * 1024 * 1024
NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
}
for _prefix, _uri in NS.items():
    ET.register_namespace(_prefix, _uri)


class Failure(Exception):
    """Only fixed error codes cross the CLI/form boundary, never private input."""


def require(condition, code):
    if not condition:
        raise Failure(code)


def full_name(value):
    require(isinstance(value, str), "full_name_required")
    require(not any(unicodedata.category(c).startswith("C") for c in value), "invalid_full_name")
    result = " ".join(unicodedata.normalize("NFC", value).split())
    # Patronymics are not universal. Require a full surname/given-name entry,
    # not exactly three tokens, and retain the person's explicit spelling.
    require(2 <= len(result.split()) and len(result) <= 240
            and all(any(c.isalpha() for c in part) for part in result.split()), "invalid_full_name")
    return result


def width_mm(value):
    require(not isinstance(value, bool), "invalid_width")
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise Failure("invalid_width") from None
    require(math.isfinite(result) and 10 <= result <= 100, "invalid_width")
    return result


def account():
    try:
        data = json.loads(os.environ.get("TRELIO_SKILL_ACCOUNT_JSON", ""))
        require(isinstance(data, dict), "account_required")
        selected = str(uuid.UUID(data.get("id", "")))
        require(selected == data.get("id") and data.get("providerRef") is None, "invalid_account")
        binding = data.get("companyBinding", "")
        require(isinstance(binding, str) and len(binding) == 64
                and all(c in "0123456789abcdef" for c in binding), "invalid_account")
        # Live scope remains a host assertion; account comments and owner names
        # cannot replace a company/member binding or authorize document signing.
        uuid.UUID(os.environ.get("TRELIO_SKILL_COMPANY_ID", ""))
        uuid.UUID(os.environ.get("TRELIO_SKILL_MEMBER_ID", ""))
        require(os.environ.get("TRELIO_SKILL_ID") == "document-facsimile", "invalid_skill")
        return selected
    except (ValueError, TypeError, AttributeError):
        raise Failure("account_required") from None


def no_links(path):
    """Inspect existing ancestors without resolving away attacker-made links."""
    for part in reversed((path, *path.parents)):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        require(not stat.S_ISLNK(info.st_mode)
                and not (getattr(info, "st_file_attributes", 0) & 0x400), "unsafe_path")


def windows_acl(path, create=False, protect_file=False):
    # Fixed signed helper and a system executable; all paths remain argv data.
    # GPO/ACL errors are blockers, with no persistent execution-policy changes.
    executable = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    require(executable.is_absolute() and executable.is_file(), "windows_acl_unavailable")
    args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
            str(Path(__file__).with_name("private-storage.ps1")), "-Target", str(path)]
    if create:
        args.append("-CreateDirectory")
    if protect_file:
        args.append("-ProtectNewFile")
    result = subprocess.run([str(executable), *args], capture_output=True, timeout=20,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False)
    require(result.returncode == 0, "private_storage_acl")


def private_check(path, directory=False):
    no_links(path)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), "unsafe_storage")
    if os.name == "nt":
        windows_acl(path)
    else:
        require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, "private_storage_permissions")
    if not directory:
        require(info.st_nlink == 1, "unsafe_storage")


def private_directory(path):
    no_links(path)
    if not path.exists():
        if os.name == "nt":
            windows_acl(path, create=True)
        else:
            path.mkdir(mode=0o700)
    private_check(path, directory=True)


def storage_root(selected):
    override = os.environ.get("TRELIO_CONFIG_HOME")
    if override:
        home = Path(override).expanduser().absolute()
    elif os.name == "nt":
        require(bool(os.environ.get("LOCALAPPDATA")), "config_home_required")
        home = Path(os.environ["LOCALAPPDATA"]) / "Trelio"
    else:
        home = Path.home() / ".config/trelio"
    no_links(home)
    # The generic host owns the existing config root. Only provider descendants
    # are created here: no permission repair of unrelated folders or second
    # account catalogue. The UUID is the sole on-disk identity.
    require(home.is_dir(), "config_home_required")
    if os.name != "nt":
        info = home.stat()
        require(info.st_uid == os.getuid() and info.st_mode & 0o022 == 0, "unsafe_config_home")
    cursor = home
    for segment in ("facsimiles", "accounts", selected):
        cursor /= segment
        private_directory(cursor)
    return cursor


def png_info(data):
    """Bounded decode checks CRC, pixel shape and transparency; strips metadata."""
    require(isinstance(data, bytes) and 0 < len(data) <= MAX_PNG
            and data.startswith(b"\x89PNG\r\n\x1a\n"), "invalid_png")
    offset, chunks, compressed = 8, [], bytearray()
    dimensions = None
    ended = False
    while offset < len(data):
        require(offset + 12 <= len(data), "invalid_png")
        length, kind = struct.unpack(">I4s", data[offset:offset + 8])
        require(length <= MAX_PNG and offset + 12 + length <= len(data), "invalid_png")
        payload = data[offset + 8:offset + 8 + length]
        crc = struct.unpack(">I", data[offset + 8 + length:offset + 12 + length])[0]
        require(binascii.crc32(kind + payload) & 0xffffffff == crc, "invalid_png")
        if dimensions is None:
            require(kind == b"IHDR" and length == 13, "invalid_png")
            w, h, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            require(0 < w <= 4096 and 0 < h <= 4096 and w * h <= 4_000_000
                    and depth == 8 and color in (4, 6)
                    and (compression, filtering, interlace) == (0, 0, 0), "unsupported_png")
            dimensions = (w, h, 2 if color == 4 else 4)
            chunks.append((kind, payload))
        elif kind == b"IDAT":
            require(not ended and len(compressed) + length <= MAX_PNG, "invalid_png")
            compressed.extend(payload)
        elif kind == b"IEND":
            require(length == 0 and offset + 12 == len(data), "invalid_png")
            ended = True
        else:
            # Unknown critical chunks, APNG, duplicate headers and palette data
            # cannot masquerade as one static transparent signature. Ancillary
            # text/location/profile metadata is deliberately omitted on save.
            require(kind[0] & 32 and kind not in (b"acTL", b"fcTL", b"fdAT"), "unsupported_png")
        offset += 12 + length
    require(ended and dimensions and compressed, "invalid_png")
    w, h, channels = dimensions
    expected = h * (1 + w * channels)
    decoder = zlib.decompressobj()
    try:
        decoded = decoder.decompress(bytes(compressed), expected + 1)
    except zlib.error:
        raise Failure("invalid_png") from None
    require(len(decoded) == expected and decoder.eof and not decoder.unused_data
            and not decoder.unconsumed_tail, "invalid_png")
    # Unfilter to prove there is both visible ink and at least one transparent
    # pixel. An alpha channel filled with 255 would hide text below a rectangle.
    stride = w * channels
    prior = bytearray(stride)
    transparent, visible = False, False
    for row in range(h):
        start = row * (stride + 1)
        method, current = decoded[start], bytearray(decoded[start + 1:start + 1 + stride])
        require(method <= 4, "invalid_png")
        for col in range(stride):
            left = current[col - channels] if col >= channels else 0
            up = prior[col]
            corner = prior[col - channels] if col >= channels else 0
            if method == 1:
                predictor = left
            elif method == 2:
                predictor = up
            elif method == 3:
                predictor = (left + up) // 2
            elif method == 4:
                p = left + up - corner
                distances = (abs(p - left), abs(p - up), abs(p - corner))
                predictor = (left, up, corner)[distances.index(min(distances))]
            else:
                predictor = 0
            current[col] = (current[col] + predictor) & 255
        alpha = current[channels - 1::channels]
        transparent |= any(a < 255 for a in alpha)
        visible |= any(a > 0 for a in alpha)
        prior = current
    require(transparent and visible, "transparent_png_required")
    chunks.extend(((b"IDAT", bytes(compressed)), (b"IEND", b"")))
    cleaned = bytearray(b"\x89PNG\r\n\x1a\n")
    for kind, payload in chunks:
        cleaned.extend(struct.pack(">I", len(payload)) + kind + payload
                       + struct.pack(">I", binascii.crc32(kind + payload) & 0xffffffff))
    return bytes(cleaned), w, h


def read_bundle(root):
    path = root / "facsimile.json"
    no_links(path)
    if not path.exists():
        return None
    private_check(path)
    require(path.stat().st_size <= MAX_BUNDLE, "invalid_storage")
    try:
        result = json.loads(path.read_bytes())
        require(result["schemaVersion"] == 1 and type(result["revision"]) is int
                and result["revision"] > 0, "invalid_storage")
        if result.get("state") == "not_configured":
            require(set(result) == {"schemaVersion", "revision", "state"}, "invalid_storage")
            return result
        require(result.get("state") == "configured", "invalid_storage")
        full_name(result["ownerFullName"])
        width_mm(result["widthMm"])
        data, w, h = png_info(base64.b64decode(result["pngBase64"], validate=True))
        require(result["sha256"] == hashlib.sha256(data).hexdigest()
                and (result["pixelWidth"], result["pixelHeight"]) == (w, h), "invalid_storage")
        return result
    except (ValueError, KeyError, TypeError, binascii.Error):
        raise Failure("invalid_storage") from None


def safe_metadata(bundle):
    if bundle is None:
        return {"state": "not_configured", "revision": 0}
    if bundle["state"] == "not_configured":
        return {"state": "not_configured", "revision": bundle["revision"]}
    return {"state": "configured", **{key: bundle[key] for key in
            ("revision", "ownerFullName", "widthMm", "pixelWidth", "pixelHeight", "sha256")}}


@contextlib.contextmanager
def storage_lock(root):
    lock = root / ".mutation-lock"
    try:
        if os.name == "nt":
            windows_acl(lock, create=True)
        else:
            lock.mkdir(mode=0o700)
        private_check(lock, directory=True)
    except FileExistsError:
        raise Failure("storage_busy") from None
    except Failure:
        if lock.exists():
            raise Failure("storage_busy") from None
        raise
    try:
        yield
    finally:
        lock.rmdir()


def save_bundle(root, owner, png, width, expected_revision):
    owner = full_name(owner)
    width = width_mm(width)
    cleaned, w, h = png_info(png)
    with storage_lock(root):
        current = read_bundle(root)
        require((current["revision"] if current else 0) == expected_revision, "revision_conflict")
        bundle = {"schemaVersion": 1, "state": "configured", "revision": expected_revision + 1, "ownerFullName": owner,
                  "widthMm": width, "pixelWidth": w, "pixelHeight": h,
                  "sha256": hashlib.sha256(cleaned).hexdigest(),
                  "pngBase64": base64.b64encode(cleaned).decode("ascii")}
        staging = root / (".save-" + secrets.token_hex(16))
        try:
            with staging.open("xb") as output:
                if os.name != "nt":
                    os.fchmod(output.fileno(), 0o600)
                else:
                    windows_acl(staging, protect_file=True)
                private_check(staging)
                output.write(json.dumps(bundle, ensure_ascii=False).encode("utf-8"))
                output.flush()
                os.fsync(output.fileno())
            # Single-file replacement means a crashed save cannot pair one
            # person's metadata with another PNG. CAS is under the same lock.
            os.replace(staging, root / "facsimile.json")
            private_check(root / "facsimile.json")
        finally:
            staging.unlink(missing_ok=True)
    return safe_metadata(bundle)


def authorized_bundle(root, author, authorized):
    require(authorized, "signing_authority_required")
    bundle = read_bundle(root)
    require(bundle is not None and bundle["state"] == "configured", "not_configured")
    require(full_name(author).casefold() == bundle["ownerFullName"].casefold(), "author_mismatch")
    return bundle


def write_new(path, data):
    path = Path(path).expanduser().absolute()
    no_links(path)
    require(path.parent.is_dir(), "output_directory_required")
    require(not path.exists(), "output_exists")
    created = False
    try:
        with path.open("xb") as output:
            created = True
            if os.name != "nt":
                os.fchmod(output.fileno(), 0o600)
            else:
                # Documents may inherit a shared output directory, but raw
                # signature exports must still be owner-only on this device.
                windows_acl(path, protect_file=True)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
    except Exception:
        if created:
            path.unlink(missing_ok=True)
        raise
    return str(path)


def xml(data):
    require(b"\0" not in data and b"<!DOCTYPE" not in data.upper()
            and b"<!ENTITY" not in data.upper(), "unsafe_docx")
    try:
        root = ET.fromstring(data)
        # ElementTree otherwise drops unused xmlns declarations even when
        # mc:Ignorable or other QName-valued attributes still reference them.
        # Preserve these Word extension bindings in the rewritten document.
        bindings = {}
        for _, binding in ET.iterparse(io.BytesIO(data), events=("start-ns",)):
            prefix, uri = binding
            require(prefix not in bindings or bindings[prefix] == uri, "unsupported_xml_namespace")
            require(prefix not in NS or NS[prefix] == uri, "unsupported_xml_namespace")
            bindings[prefix] = uri
            if prefix and not re.fullmatch(r"ns\d+", prefix):
                ET.register_namespace(prefix, uri)
        for prefix, uri in bindings.items():
            if prefix:
                root.set("xmlns:" + prefix, uri)
        return root
    except ET.ParseError:
        raise Failure("invalid_docx") from None


def xml_bytes(node):
    # OPC readers (including LibreOffice's package recognizer) require the
    # conventional default namespace in [Content_Types] and relationships.
    # ElementTree's ns0 prefix is XML-equivalent but not interoperable here.
    for uri in ("http://schemas.openxmlformats.org/package/2006/content-types",
                "http://schemas.openxmlformats.org/package/2006/relationships"):
        if node.tag.startswith("{" + uri + "}"):
            ET.register_namespace("", uri)
    declarations = {key: value for key, value in node.attrib.items() if key.startswith("xmlns:")}
    for key in declarations:
        del node.attrib[key]
    serialized = ET.tostring(node, encoding="utf-8")
    for key, value in declarations.items():
        if (key + "=").encode() not in serialized:
            node.set(key, value)
    return ET.tostring(node, encoding="utf-8", xml_declaration=True)


def drawing(bundle, relationship, doc_id):
    cx = round(bundle["widthMm"] * 36000)
    cy = round(cx * bundle["pixelHeight"] / bundle["pixelWidth"])
    # XML is built from validated integers/IDs, never interpolated document or
    # account text. A proportional inline drawing inherits paragraph placement.
    return ET.fromstring(f'''<w:drawing xmlns:w="{NS['w']}" xmlns:wp="{NS['wp']}"
      xmlns:a="{NS['a']}" xmlns:pic="{NS['pic']}" xmlns:r="{NS['r']}">
      <wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/>
      <wp:docPr id="{doc_id}" name="Signature"/><wp:cNvGraphicFramePr>
      <a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic>
      <a:graphicData uri="{NS['pic']}"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Signature.png"/>
      <pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{relationship}"/>
      <a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/>
      <a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>''')


def insert_docx(source, bundle):
    source = Path(source).expanduser().absolute()
    no_links(source)
    require(source.is_file() and source.stat().st_size <= MAX_DOCX, "invalid_docx")
    try:
        with zipfile.ZipFile(source) as archive:
            infos = archive.infolist()
            names = [i.filename for i in infos]
            require(len(names) <= 2048 and len(set(names)) == len(names)
                    and sum(i.file_size for i in infos) <= MAX_DOCX, "unsafe_docx")
            require(all(not n.startswith("/") and "\\" not in n and ".." not in n.split("/")
                        for n in names), "unsafe_docx")
            # A package signature is invalidated by any edit. Macro/encrypted
            # containers are outside this tool's deterministic DOCX contract.
            require(not any(n.startswith("_xmlsignatures/") or n.lower().endswith("vbaproject.bin")
                            for n in names), "unsupported_docx")
            files = {i.filename: archive.read(i) for i in infos}
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError):
        raise Failure("invalid_docx") from None
    require("word/document.xml" in files and "[Content_Types].xml" in files, "invalid_docx")
    document = xml(files["word/document.xml"])
    # Match split runs, but only ordinary direct paragraph runs: tracked changes,
    # fields and hyperlinks have semantic boundaries we must not silently edit.
    matches = []
    marker = "{{SIGNATURE}}"
    total = "".join(t.text or "" for t in document.iter(f"{{{NS['w']}}}t")).count(marker)
    for paragraph in document.iter(f"{{{NS['w']}}}p"):
        nodes = [t for r in paragraph.findall("w:r", NS) for t in r.findall("w:t", NS)]
        text = "".join(t.text or "" for t in nodes)
        if marker in text:
            matches.append((paragraph, nodes, text.index(marker)))
    require(total == 1 and len(matches) == 1, "one_signature_marker_required")
    paragraph, nodes, start = matches[0]
    offset, start_node, start_run = 0, None, None
    tail = ""
    for node in nodes:
        value = node.text or ""
        end = offset + len(value)
        if offset <= start < end:
            start_node = node
            start_run = next(r for r in paragraph.findall("w:r", NS) if node in list(r))
        if end > start and offset < start + len(marker):
            left, right = max(0, start - offset), min(len(value), start + len(marker) - offset)
            if node is start_node:
                tail = value[right:]
                node.text = value[:left]
            else:
                node.text = value[:left] + value[right:]
            node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        offset = end
    require(start_run is not None and start_node is list(start_run)[-1], "unsupported_marker_layout")
    require(all(r.find("w:fldChar", NS) is None and r.find("w:instrText", NS) is None
                for r in paragraph.findall("w:r", NS)), "unsupported_marker_layout")
    relation_uri = "http://schemas.openxmlformats.org/package/2006/relationships"
    rel_path = "word/_rels/document.xml.rels"
    relations = xml(files[rel_path]) if rel_path in files else ET.Element(f"{{{relation_uri}}}Relationships")
    ids = {r.get("Id") for r in relations}
    relation = "rIdFacsimile"
    while relation in ids:
        relation += "x"
    media = "signature-" + bundle["sha256"] + ".png"
    media_path = "word/media/" + media
    require(media_path not in files, "signature_media_exists")
    ET.SubElement(relations, f"{{{relation_uri}}}Relationship", {
        "Id": relation, "Type": NS["r"] + "/image", "Target": "media/" + media})
    doc_id = 1 + max([0] + [int(p.get("id", "0")) for p in document.iter(f"{{{NS['wp']}}}docPr")])
    start_run.append(drawing(bundle, relation, doc_id))
    if tail:
        after = ET.SubElement(start_run, f"{{{NS['w']}}}t", {"{http://www.w3.org/XML/1998/namespace}space": "preserve"})
        after.text = tail
    content_uri = "http://schemas.openxmlformats.org/package/2006/content-types"
    types = xml(files["[Content_Types].xml"])
    png_types = [t for t in types if t.get("Extension", "").lower() == "png"]
    require(all(t.get("ContentType") == "image/png" for t in png_types), "invalid_docx")
    if not png_types:
        ET.SubElement(types, f"{{{content_uri}}}Default", {"Extension": "png", "ContentType": "image/png"})
    files.update({"word/document.xml": xml_bytes(document), rel_path: xml_bytes(relations),
                  "[Content_Types].xml": xml_bytes(types), media_path: base64.b64decode(bundle["pngBase64"])})
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return output.getvalue()


def local_form(root, timeout=110, open_browser=True, ready=None):
    baseline = safe_metadata(read_bundle(root))
    token, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    state = {"result": None, "failure": None}
    # Secrets/images stay on loopback. Host/Origin, a per-operation token and
    # strict CSP reject drive-by pages, DNS rebinding and cross-origin submits.
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def respond(self, status, content, kind="application/json"):
            self.send_response(status)
            self.send_header("Content-Type", kind + "; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(content)

        def do_GET(self):
            if self.path != "/" + token or self.headers.get("Host") != authority:
                self.respond(404, b'{}')
                return
            initial = json.dumps({"owner": baseline.get("ownerFullName", ""), "width": baseline.get("widthMm", 34)}, ensure_ascii=True).replace("<", "\\u003c")
            html = '''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Настройка факсимиле</title>
            <style nonce="NONCE">body{font:16px system-ui;max-width:580px;margin:48px auto;padding:24px}label{display:block;margin:20px 0}input{display:block;margin-top:8px;padding:8px;min-height:44px;font:inherit;max-width:100%;box-sizing:border-box}input[type=text]{width:100%}button{min-height:44px;padding:10px 18px;margin-right:12px;font:inherit}p{line-height:1.5}</style>
            <h1>Настройка факсимиле</h1><p>PNG и ФИО сохранятся только на этом устройстве. Название и условия использования меняются в комментарии аккаунта навыка.</p>
            <form id="form"><label>ФИО владельца подписи<input id="owner" type="text" maxlength="240" required autocomplete="off"></label>
            <label>Подпись – PNG с прозрачным фоном<input id="file" type="file" accept="image/png" required></label>
            <label>Ширина в документе, мм<input id="width" type="number" min="10" max="100" step="0.1" required></label>
            <button id="save" type="submit">Сохранить</button><button id="cancel" type="button">Отмена</button></form><p id="status" role="alert" tabindex="-1"></p>
            <script nonce="NONCE">const initial=INITIAL;const form=document.getElementById('form'),owner=document.getElementById('owner'),width=document.getElementById('width'),file=document.getElementById('file'),save=document.getElementById('save'),cancel=document.getElementById('cancel'),status=document.getElementById('status');owner.value=initial.owner;width.value=initial.width;
            const messages={invalid_full_name:'Укажите полные имя и фамилию; отчество, если есть',full_name_required:'Укажите ФИО владельца',invalid_width:'Ширина должна быть от 10 до 100 мм',invalid_png:'Не удалось прочитать PNG. Выберите корректный файл',unsupported_png:'Нужен обычный 8-bit PNG с прозрачным фоном без анимации',transparent_png_required:'В PNG должны быть видимые и прозрачные пиксели',revision_conflict:'Настройка уже изменилась. Закройте окно и откройте настройку заново',storage_busy:'Настройка занята другим процессом. Проверьте статус навыка'};
            function feedback(message){status.textContent=message;status.focus()}
            async function send(body){const response=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json','X-Facsimile-Nonce':'NONCE'},body:JSON.stringify(body)});return response.json()}
            form.onsubmit=async(event)=>{event.preventDefault();save.disabled=true;feedback('Сохраняем…');try{const f=file.files[0];if(!f||f.size>8388608){feedback('Выберите PNG размером до 8 МБ');save.disabled=false;file.focus();return}const bytes=new Uint8Array(await f.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));const result=await send({ownerFullName:owner.value,widthMm:width.value,pngBase64:btoa(binary)});feedback(result.ok?'Сохранено. Можно закрыть окно':(messages[result.code]||'Не удалось сохранить. Проверьте статус навыка'));if(result.ok)form.hidden=true;else{save.disabled=false;if(['invalid_full_name','full_name_required'].includes(result.code))owner.focus();if(result.code==='invalid_width')width.focus();if(['invalid_png','unsupported_png','transparent_png_required'].includes(result.code))file.focus();}}catch{feedback('Не удалось подтвердить сохранение. Проверьте статус навыка');save.disabled=false;}};
            cancel.onclick=async()=>{cancel.disabled=true;try{const result=await send({cancel:true});if(!result.ok)throw Error();form.hidden=true;feedback('Настройка отменена')}catch{feedback('Окно настройки уже недоступно. Проверьте статус навыка');cancel.disabled=false}};</script></html>'''
            html = html.replace("INITIAL", initial).replace("NONCE", nonce)
            self.respond(200, html.encode("utf-8"), "text/html")

        def do_POST(self):
            if (self.path != "/" + token or self.headers.get("Host") != authority
                    or self.headers.get("Origin") != origin
                    or self.headers.get("X-Facsimile-Nonce") != nonce
                    or self.headers.get("Content-Type") != "application/json"):
                self.respond(403, b'{"ok":false,"code":"invalid_form_request"}')
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                require(0 < length <= MAX_BUNDLE, "invalid_form_request")
                self.connection.settimeout(5)
                raw = self.rfile.read(length)
                require(len(raw) == length, "invalid_form_request")
                request = json.loads(raw)
                require(isinstance(request, dict), "invalid_form_request")
                if request == {"cancel": True}:
                    state["result"] = {"state": "cancelled"}
                else:
                    require(set(request) == {"ownerFullName", "widthMm", "pngBase64"}, "invalid_form_request")
                    png = base64.b64decode(request["pngBase64"], validate=True)
                    state["result"] = save_bundle(root, request["ownerFullName"], png, request["widthMm"], baseline["revision"])
                self.respond(200, b'{"ok":true}')
            except Failure as error:
                self.respond(400, json.dumps({"ok": False, "code": str(error)}).encode("utf-8"))
            except (ValueError, TypeError, binascii.Error):
                self.respond(400, b'{"ok":false,"code":"invalid_form_request"}')
            except (OSError, subprocess.SubprocessError):
                self.respond(500, b'{"ok":false,"code":"local_operation_failed"}')

    class Server(http.server.HTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(5)
            return connection, address

        def handle_error(self, *_):
            # Default socketserver prints tracebacks. A disconnect may happen
            # after atomic save; retain that result and let doctor read it back.
            if state["result"] is None:
                state["failure"] = "local_form_failed"

    with Server(("127.0.0.1", 0), Handler) as server:
        server.timeout = 0.25
        authority = f"127.0.0.1:{server.server_port}"
        origin = "http://" + authority
        url = origin + "/" + token
        if ready:
            ready(url, nonce)
        if open_browser:
            require(webbrowser.open(url, new=1), "local_browser_unavailable")
        deadline = time.monotonic() + timeout
        while state["result"] is None and state["failure"] is None and time.monotonic() < deadline:
            server.handle_request()
        require(state["failure"] is None, state["failure"])
        require(state["result"] is not None, "setup_timeout")
        return state["result"]


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default diagnostics can echo arbitrary supplied arguments.
        raise Failure("invalid_arguments")


def main(argv=None):
    parser = Parser(description="Local document facsimile", allow_abbrev=False)
    commands = parser.add_subparsers(dest="command", required=True, parser_class=Parser)
    commands.add_parser("__trelio_accounts_import")
    commands.add_parser("doctor")
    commands.add_parser("show")
    commands.add_parser("configure")
    for command in ("image", "insert-docx"):
        child = commands.add_parser(command)
        child.add_argument("--author", required=True)
        child.add_argument("--authorized", action="store_true")
        child.add_argument("--output", required=True)
        if command == "insert-docx":
            child.add_argument("--input", required=True)
    child = commands.add_parser("clear")
    child.add_argument("--expected-revision", type=int, required=True)
    child.add_argument("--confirm", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "__trelio_accounts_import":
        # No legacy facsimiles exist. Import is metadata-only and never scans
        # Workspaces, arbitrary folders, images or business documents.
        return {"schemaVersion": 1, "accounts": []}
    selected = account()
    root = storage_root(selected)
    if args.command in ("doctor", "show"):
        result = safe_metadata(read_bundle(root))
    elif args.command == "configure":
        result = local_form(root)
    elif args.command == "clear":
        require(args.confirm, "clear_confirmation_required")
        with storage_lock(root):
            current = read_bundle(root)
            require(current is not None and current["state"] == "configured"
                    and current["revision"] == args.expected_revision, "revision_conflict")
            # Retain a revision tombstone: a configure form opened before clear
            # must not resurrect the signature through an ABA revision reset.
            tombstone = {"schemaVersion": 1, "state": "not_configured", "revision": current["revision"] + 1}
            staging = root / (".clear-" + secrets.token_hex(16))
            try:
                with staging.open("xb") as output:
                    if os.name != "nt":
                        os.fchmod(output.fileno(), 0o600)
                    else:
                        windows_acl(staging, protect_file=True)
                    private_check(staging)
                    output.write(json.dumps(tombstone).encode("utf-8"))
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(staging, root / "facsimile.json")
            finally:
                staging.unlink(missing_ok=True)
        result = safe_metadata(tombstone)
    else:
        bundle = authorized_bundle(root, args.author, args.authorized)
        data = (base64.b64decode(bundle["pngBase64"]) if args.command == "image"
                else insert_docx(args.input, bundle))
        output = write_new(args.output, data)
        result = {"state": "prepared", "outputPath": output, "sha256": hashlib.sha256(data).hexdigest(),
                  "ownerFullName": bundle["ownerFullName"], "visualReviewRequired": True}
    return {"schemaVersion": 1, "runtimeVersion": VERSION, "accountId": selected, **result}


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="strict")
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except Failure as error:
        print(json.dumps({"ok": False, "code": str(error)}))
        sys.exit(2)
    except (OSError, ValueError, TypeError, subprocess.SubprocessError, OverflowError):
        print(json.dumps({"ok": False, "code": "local_operation_failed"}))
        sys.exit(2)
