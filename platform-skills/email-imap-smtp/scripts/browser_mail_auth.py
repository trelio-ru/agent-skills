"""Generic protected email OTP delivery to a host-owned browser attempt.

No site identifiers or selectors live here. The browser's signed recipe owns
the matcher, the selected mailbox owns credentials/IMAP, and the common host
owns private delivery, successful-login proof and the one-write ACK fence.
"""
from __future__ import annotations

import argparse
import email
import hashlib
import imaplib
import json
import os
from pathlib import Path
import re
import subprocess
import time
from email.policy import default
from email.utils import getaddresses
from urllib.parse import unquote, urlsplit

API = "trelio.protected-browser-mail-auth/v1"
HANDLE = re.compile(r"[a-f0-9]{64}\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")


def request_handle(value):
    if not isinstance(value, str) or not HANDLE.fullmatch(value):
        raise argparse.ArgumentTypeError("EMAIL_BROWSER_AUTH_INPUT_INVALID")
    return value


def private_host(message, runtime):
    """Same host-selected interpreter/module as local forms, no shell or values
    in argv/environment. Both output streams stay in private captured pipes;
    raw exceptions and partial/oversized output never reach ordinary CLI.
    """
    try:
        url = urlsplit(os.environ.get("TRELIO_BROWSER_MAIL_MODULE_URL", ""))
        node = Path(os.environ.get("TRELIO_LOCAL_FORM_NODE_EXECUTABLE", ""))
        if url.scheme != "file" or url.netloc or url.query or url.fragment or not node.is_absolute():
            raise ValueError()
        name = unquote(url.path)
        if os.name == "nt" and re.match(r"^/[a-zA-Z]:/", name):
            name = name[1:]
        module = Path(name)
        if not module.is_absolute() or module.name != "trelio-browser-session.mjs":
            raise ValueError()
        runtime.require_credential_lease()
        result = subprocess.run([str(node), str(module)], input=json.dumps(message).encode("utf-8"),
                                capture_output=True, check=False, timeout=36, shell=False,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        if result.returncode or len(result.stdout) > 16384 or result.stderr:
            raise ValueError()
        value = json.loads(result.stdout.decode("utf-8", errors="strict"))
        if not isinstance(value, dict) or value.get("ok") is not True:
            raise ValueError()
        return value
    except Exception:
        raise runtime.MailboxError("EMAIL_BROWSER_AUTH_HOST_UNAVAILABLE") from None


def exact_addresses(message, names):
    values = [str(v) for name in names for v in message.get_all(name, [])]
    return [address.lower() for _, address in getaddresses(values) if address]


def extract_code(raw, spec, recipient, runtime):
    """Untrusted MIME is data only. Require exact native recipient/sender and
    literal provider anchors; accept exactly ONE code occurrence, never the
    first number, an attachment, forwarded message or fallback sender/domain.
    """
    message = email.message_from_bytes(raw, policy=default)
    if message.defects or len(message.get_all("From", [])) != 1 or len(message.get_all("Subject", [])) != 1:
        return None
    if exact_addresses(message, ["From"]) != [spec["sender"].lower()]:
        return None
    if recipient.lower() not in exact_addresses(message, ["To"]):
        return None
    subject = runtime.decode_header_value(message.get("Subject"))
    body = runtime.message_text(message)
    if len(subject) > 2000 or len(body) > 65536 or spec["subjectIncludes"].casefold() not in subject.casefold() or spec["bodyIncludes"].casefold() not in body.casefold():
        return None
    codes = re.findall(r"(?<!\w)[0-9]{" + str(spec["digits"]) + r"}(?!\w)", body)
    return codes[0] if len(codes) == 1 else None


def received_at(client, uid, runtime):
    # INTERNALDATE, rather than an attacker-controlled Date header, determines
    # whether this exact UID arrived during the active browser request.
    status, rows = runtime.email_ack_metadata(client, "fetch", str(uid), "(UID INTERNALDATE)")
    if status != "OK" or not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], bytes):
        raise runtime.MailboxError("EMAIL_BROWSER_AUTH_MAIL_CHANGED")
    match = re.fullmatch(rb'[1-9][0-9]{0,9} \((?:UID ([1-9][0-9]{0,9}) INTERNALDATE "([^"]{26})"|INTERNALDATE "([^"]{26})" UID ([1-9][0-9]{0,9}))\)', rows[0], re.I)
    if not match or int(match[1] or match[4]) != uid:
        raise runtime.MailboxError("EMAIL_BROWSER_AUTH_MAIL_CHANGED")
    value = imaplib.Internaldate2tuple(b'INTERNALDATE "' + (match[2] or match[3]) + b'"')
    if value is None:
        raise runtime.MailboxError("EMAIL_BROWSER_AUTH_MAIL_CHANGED")
    return int(time.mktime(value) * 1000)


def read_baseline(account, args, runtime):
    with runtime.imap_connection(account) as client:
        folder = runtime.select_folder(client, args.folder, special_use=getattr(args, 'special_use', None))
        scope = runtime.email_monitor_scope(account, folder)
        validity, next_uid = runtime.email_monitor_position(client)
        runtime.select_folder(client, folder)
        fresh_validity, fresh_next = runtime.email_monitor_position(client)
        if fresh_validity != validity or fresh_next < next_uid:
            raise runtime.MailboxError("EMAIL_BROWSER_AUTH_MAIL_CHANGED")
        return {"scope": scope, "uidValidity": validity, "lastUid": fresh_next - 1}


def find_code(account, args, spec, runtime):
    candidates = []
    with runtime.imap_connection(account) as client:
        folder = runtime.select_folder(client, args.folder, special_use=getattr(args, 'special_use', None))
        scope = runtime.email_monitor_scope(account, folder)
        validity, next_uid = runtime.email_monitor_position(client)
        base = spec["baseline"]
        if base["scope"] != scope or base["uidValidity"] != validity or next_uid <= base["lastUid"]:
            raise runtime.MailboxError("EMAIL_BROWSER_AUTH_MAIL_CHANGED")
        # Baseline is captured BEFORE the browser sends any code. No UNSEEN
        # predicate: another device may read this current message. Old UIDs,
        # including codes received in the same wall-clock second, stay excluded.
        lower, upper = base["lastUid"] + 1, next_uid - 1
        if lower > upper:
            return None
        if upper - lower >= 500:
            raise runtime.MailboxError("EMAIL_BROWSER_AUTH_MAIL_AMBIGUOUS")
        sender = spec["sender"]
        if not isinstance(sender, str) or not re.fullmatch(r"[^\s<>@\"\\]+@[^\s<>@\"\\]+\.[^\s<>@\"\\]+", sender):
            raise runtime.MailboxError("EMAIL_BROWSER_AUTH_MATCHER_INVALID")
        status, rows = runtime.email_ack_metadata(client, "search", None, "UID", f"{lower}:{upper}", "FROM", '"' + sender + '"')
        if status != "OK" or not isinstance(rows, list) or len(rows) != 1 or rows[0] is not None and not isinstance(rows[0], bytes):
            raise runtime.MailboxError("EMAIL_BROWSER_AUTH_MAIL_UNAVAILABLE")
        uids = (rows[0] or b"").split()
        if len(uids) > 20 or len(set(uids)) != len(uids):
            raise runtime.MailboxError("EMAIL_BROWSER_AUTH_MAIL_AMBIGUOUS")
        for encoded in uids:
            if not re.fullmatch(rb"[1-9][0-9]{0,9}", encoded) or not lower <= int(encoded) <= upper:
                raise runtime.MailboxError("EMAIL_BROWSER_AUTH_MAIL_CHANGED")
            uid = int(encoded)
            runtime.require_credential_lease()
            if int(time.time() * 1000) >= spec["expiresAt"]:
                raise runtime.MailboxError("EMAIL_BROWSER_AUTH_EXPIRED")
            arrived = received_at(client, uid, runtime)
            if not spec["requestedAt"] - 1000 <= arrived <= spec["expiresAt"]:
                continue
            raw = runtime.fetch_raw_message(client, str(uid), verify_reference=True, maximum_bytes=256 * 1024)
            code = extract_code(raw, spec, account.email_address, runtime)
            if code is not None:
                candidates.append((code, {"scope": scope, "uidValidity": validity, "uid": uid,
                    "revision": runtime.email_reference_revision(scope, validity, uid),
                    "originalSha256": hashlib.sha256(raw).hexdigest()}))
            raw = b""
        runtime.select_folder(client, folder)
        fresh_validity, fresh_next = runtime.email_monitor_position(client)
        if fresh_validity != validity or fresh_next < next_uid:
            raise runtime.MailboxError("EMAIL_BROWSER_AUTH_MAIL_CHANGED")
    if len(candidates) > 1:
        raise runtime.MailboxError("EMAIL_BROWSER_AUTH_MAIL_AMBIGUOUS")
    return candidates[0] if candidates else None


def acknowledge(args, reference, runtime, host):
    claim = host({"operation": "claim-ack", "handle": args.request, "payload": reference})
    if claim.get("action") == "none":
        return "complete"
    if claim.get("action") not in {"verify_only", "mark_seen_once"}:
        raise runtime.MailboxError("EMAIL_BROWSER_AUTH_HOST_UNAVAILABLE")
    attempted, seen = False, False
    try:
        # Reuse the SAME native exact-UID/UIDVALIDITY/hash +FLAGS.SILENT path.
        # It preserves all other flags and independently checks mailbox policy.
        result = runtime.command_ack_reference(argparse.Namespace(account=args.account, folder=args.folder,
            special_use=getattr(args, 'special_use', None), uid=str(reference["uid"]), uid_validity=str(reference["uidValidity"]),
            expected_revision=reference["revision"], expected_original_sha256=reference["originalSha256"],
            confirm=claim["action"] == "mark_seen_once", verify_only=claim["action"] == "verify_only"))
        state = result["readState"]
        attempted, seen = state["writeAttempted"], state["verified"] and state["seen"]
    except runtime.EmailAckError as error:
        attempted = error.attempted
        # No second STORE follows an uncertain result. A future invocation
        # receives verify_only from the already persisted browser fence.
    return host({"operation": "record-ack", "handle": args.request,
                 "payload": {"seenVerified": bool(seen), "writeAttempted": bool(attempted)}})["acknowledgement"]


def complete(args, runtime, host=None):
    """Public result contains status only, never the code, message or matcher."""
    request_handle(args.request)
    if runtime.selected_local_account() is None:
        raise runtime.MailboxError("EMAIL_BROWSER_AUTH_BOUND_ACCOUNT_REQUIRED")
    host = host or (lambda message: private_host(message, runtime))
    account = runtime.load_account(args.account)
    runtime.require_imap(account)
    try:
        # Every continuation starts with native live evidence. In particular,
        # a lost delivery response never sends the code twice, and an ACK fence
        # distinguishes a first authorized write from readonly reconciliation.
        state = host({"operation": "status", "handle": args.request})
        if args.verify_only or state.get("authenticated") is True:
            ack = state.get("acknowledgement", "none")
            may_ack = not args.verify_only or ack in {"pending", "unknown"}
            if state.get("authenticated") is True and ack != 'complete' and may_ack and args.mark_read_after_success:
                try:
                    ack = acknowledge(args, state["reference"], runtime, host)
                except Exception:
                    ack = "unknown"
            return {"protocol": API, "authenticated": state.get("authenticated") is True,
                    "state": "pending" if state.get("finished") is False else "reconciled",
                    "acknowledgement": ack, "automaticRetryAllowed": False}
        if state.get("finished") is True or state.get("state") not in {"waiting", "armed"}:
            return {"protocol": API, "authenticated": False,
                    "state": "login_not_verified" if state.get("finished") else "pending",
                    "acknowledgement": state.get("acknowledgement", "none"), "automaticRetryAllowed": False}
        spec = state.get("request") if state.get("state") == 'armed' else host({"operation": "prepare", "handle": args.request})
        if spec.get("api") != API or spec.get("skillId") != os.environ.get("TRELIO_SKILL_ID"):
            raise runtime.MailboxError("EMAIL_BROWSER_AUTH_HOST_UNAVAILABLE")
        if state.get("state") == 'armed':
            baseline = state['baseline']
        else:
            baseline = read_baseline(account, args, runtime)
            # This one-use step releases the browser's first login action.
            # An unknown response never restarts the baseline or sends mail.
            begun = host({"operation": "begin", "handle": args.request, "payload": baseline})
            if begun.get("armed") is not True:
                raise runtime.MailboxError("EMAIL_BROWSER_AUTH_HOST_UNAVAILABLE")
        spec = {**spec, "baseline": baseline}
        selected = None
        # A single bounded read wait, not another sign-in/resend operation.
        until = min(spec["expiresAt"], int(time.time() * 1000) + 30000)
        while int(time.time() * 1000) < until:
            selected = find_code(account, args, spec, runtime)
            if selected is not None:
                break
            runtime.require_credential_lease()
            time.sleep(1)
        if selected is None:
            return {"protocol": API, "authenticated": False, "state": "mail_not_found", "acknowledgement": "none", "automaticRetryAllowed": False}
        code, reference = selected
        try:
            result = host({"operation": "deliver", "handle": args.request,
                           "payload": {"code": code, "reference": reference}})
        finally:
            code = ""; selected = None
        authenticated = result.get("authenticated") is True
        ack = "none"
        if authenticated and args.mark_read_after_success:
            try:
                ack = acknowledge(args, reference, runtime, host)
            except Exception:
                # The successful external login cannot be undone by a later
                # mail-flag/read-back failure. Preserve that fact separately.
                ack = "unknown"
        return {"protocol": API, "authenticated": authenticated,
                "state": "complete" if authenticated else "login_not_verified",
                "acknowledgement": ack, "automaticRetryAllowed": False}
    except Exception:
        # Do not propagate IMAP/native/subprocess exceptions with MIME/code or
        # private request data. Unknown delivery never authorizes a retry.
        raise runtime.MailboxError("EMAIL_BROWSER_AUTH_UNAVAILABLE") from None


def profile(args, runtime):
    """Bounded read-only matcher discovery, never ordinary OTP/message output.

    Return only the exact sender and verified literal anchors from a small
    public vocabulary/the operator's brand. No subject/body, digits, auth URL
    or code is returned. This is evidence for a provider author, not a grant
    to deliver mail or change its read state.
    """
    brand = args.brand
    if not isinstance(brand, str) or not 2 <= len(brand) <= 80 or not re.fullmatch(r"[\w .-]+", brand):
        raise runtime.MailboxError("EMAIL_BROWSER_AUTH_INPUT_INVALID")
    if runtime.selected_local_account() is None:
        raise runtime.MailboxError("EMAIL_BROWSER_AUTH_BOUND_ACCOUNT_REQUIRED")
    account = runtime.load_account(args.account)
    runtime.require_imap(account)
    results = []
    try:
        with runtime.imap_connection(account) as client:
            folder = runtime.select_folder(client, args.folder, special_use=getattr(args, 'special_use', None))
            validity, next_uid = runtime.email_monitor_position(client)
            if next_uid <= 1:
                return {"protocol": API, "profiles": [], "marksRead": False}
            lower, upper = max(1, next_uid - 500), next_uid - 1
            quoted = b'"' + brand.encode("utf-8") + b'"'
            status, rows = runtime.email_ack_metadata(client, "search", "UTF-8", "UID", f"{lower}:{upper}", "TEXT", quoted)
            if status != "OK" or not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0] or b"", bytes):
                raise ValueError()
            uids = (rows[0] or b"").split()
            if len(uids) > 20 or len(set(uids)) != len(uids):
                raise ValueError()
            for encoded in uids:
                if not re.fullmatch(rb"[1-9][0-9]{0,9}", encoded) or not lower <= int(encoded) <= upper:
                    raise ValueError()
                raw = runtime.fetch_raw_message(client, encoded.decode("ascii"), verify_reference=True, maximum_bytes=256 * 1024)
                message = email.message_from_bytes(raw, policy=default)
                if message.defects or account.email_address.lower() not in exact_addresses(message, ["To"]):
                    continue
                senders = exact_addresses(message, ["From"])
                if len(senders) != 1 or len(senders[0]) > 240:
                    continue
                subject, body = runtime.decode_header_value(message.get("Subject")), runtime.message_text(message)
                if len(subject) > 2000 or len(body) > 65536 or brand.casefold() not in body.casefold():
                    continue
                codes = re.findall(r"(?<!\w)[0-9]{6}(?:[0-9]{2})?(?!\w)", body)
                if len(codes) != 1:
                    continue
                anchor = next((word for word in [brand, "код", "code", "вход", "login", "verification", "подтверж"]
                               if word.casefold() in subject.casefold()), None)
                if anchor:
                    item = {"sender": senders[0], "subjectAnchor": anchor, "bodyAnchor": brand,
                            "digits": len(codes[0]), "recipientVerified": True}
                    if item not in results:
                        results.append(item)
                raw = b""; codes = []
            runtime.select_folder(client, folder)
            if runtime.email_monitor_position(client)[0] != validity:
                raise ValueError()
        if len(results) > 5:
            raise ValueError()
        return {"protocol": API, "profiles": results, "marksRead": False,
                "coverage": "last_500_uid_slots", "originalTextOmitted": True}
    except Exception:
        raise runtime.MailboxError("EMAIL_BROWSER_AUTH_PROFILE_UNAVAILABLE") from None
