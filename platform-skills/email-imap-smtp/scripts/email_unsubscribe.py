"""Narrow RFC 8058 transport; URLs and receiver authentication stay private.

The model classifies meaning; it never constructs a request. Authentication is
accepted only from the receiving service selected by the authenticated IMAP
account. Unknown/custom receivers fail closed instead of trusting sender-added
Authentication-Results. This is not a general HTTP client or DKIM verifier.
"""
import base64
import http.client
import ipaddress
import re
import socket
import ssl
import urllib.parse
from email.utils import getaddresses


# These receiving services own the trust boundary described in RFC 8601 and
# remove their own forged authserv-id on ingress. Do NOT derive trust from an
# arbitrary hostname found in the message or permit a suffix/lookalike match.
RECEIVERS = {"imap.gmail.com": "mx.google.com", "imap.mail.ru": "mxs.mail.ru"}
DOMAIN = re.compile(r"(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\Z")


def domain(value):
    value = value.lower()
    if not DOMAIN.fullmatch(value) or "." not in value or any(
            not label or len(label) > 63 or label.startswith("-") or label.endswith("-")
            for label in value.split(".")):
        raise ValueError("EMAIL_UNSUBSCRIBE_UNSUPPORTED")
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return value
    raise ValueError("EMAIL_UNSUBSCRIBE_UNSUPPORTED")


def one(message, name):
    values = message.get_all(name, [])
    if len(values) != 1:
        raise ValueError("EMAIL_UNSUBSCRIBE_UNSUPPORTED")
    value = str(values[0])
    if len(value) > 8192 or any(ord(c) < 32 and c not in "\t\r\n" for c in value):
        raise ValueError("EMAIL_UNSUBSCRIBE_UNSUPPORTED")
    return value


def target(account, message):
    """Return one private signed endpoint, or None. Never expose it to a model.

    Require one unambiguous receiver-owned result, an aligned DKIM pass and a
    signature covering the exact unique headers. Authentication is necessary,
    never sufficient to classify a message as wanted/unwanted marketing.
    """
    try:
        receiver = RECEIVERS.get(account.imap_host.lower())
        if not receiver or message.defects:
            return None
        author = getaddresses([one(message, "From")])
        if len(author) != 1 or author[0][1].count("@") != 1:
            return None
        sender_domain = domain(author[0][1].rsplit("@", 1)[1])
        unsubscribe = one(message, "List-Unsubscribe").strip()
        if one(message, "List-Unsubscribe-Post").strip() != "List-Unsubscribe=One-Click":
            return None
        # A mailto companion is harmless but never executed. Multiple HTTPS
        # choices, unknown URI schemes and free-form text are ambiguous.
        parts = re.findall(r"<([^<>]+)>", unsubscribe)
        if not parts or re.sub(r"<[^<>]+>|[\s,]", "", unsubscribe):
            return None
        urls = [part for part in parts if part.startswith("https://")]
        if len(urls) != 1 or any(not part.startswith(("https://", "mailto:")) for part in parts):
            return None
        url = urls[0]
        if len(url) > 4096 or re.search(r"[\s\x00-\x1f\x7f\\]", url):
            return None
        parsed = urllib.parse.urlsplit(url)
        host = domain(parsed.hostname or "")
        if parsed.scheme != "https" or parsed.username is not None or parsed.password is not None \
                or parsed.port not in (None, 443) or parsed.fragment \
                or not (host == sender_domain or host.endswith("." + sender_domain)):
            return None
        results = [str(value) for value in message.get_all("Authentication-Results", [])]
        if not results or len(results) > 20 or sum(map(len, results)) > 16384:
            return None
        # Only the first result may assert this receiver's authority; another
        # matching row is rejected, not combined with the favourable clauses.
        if results[0].split(";", 1)[0].strip().lower() != receiver or sum(
                row.split(";", 1)[0].strip().lower() == receiver for row in results) != 1:
            return None
        clauses = results[0].split(";")[1:]
        # Comments/quoted exotic grammar is deliberately unsupported in this
        # first bounded profile. Ordinary receiver comments are discarded only
        # when unnested; leftover parentheses/quotes fail closed.
        clauses = [re.sub(r"\([^()]*\)", " ", clause).strip() for clause in clauses]
        if any(re.search(r'[()"\\]', clause) for clause in clauses):
            return None
        passes = []
        for clause in clauses:
            tokens = clause.split()
            if not tokens or tokens[0].lower() != "dkim=pass":
                continue
            properties = {}
            for token in tokens[1:]:
                key, sep, value = token.partition("=")
                if not sep or key.lower() in properties:
                    return None
                properties[key.lower()] = value
            authenticated = properties.get("header.d")
            if authenticated is None and "header.i" in properties:
                authenticated = properties["header.i"].rsplit("@", 1)[-1]
            if authenticated and domain(authenticated) == sender_domain:
                passes.append(properties)
        if len(passes) != 1:
            return None
        signatures = []
        for raw in message.get_all("DKIM-Signature", []):
            if len(str(raw)) > 16384:
                return None
            tags = {}
            for field in str(raw).split(";"):
                # RFC6376 permits a trailing separator/folding whitespace.
                # Empty segments convey no authority; duplicate actual tags
                # and malformed nonempty fields still refuse the signature.
                if not field.strip():
                    continue
                key, sep, value = field.strip().partition("=")
                if not sep or key in tags:
                    return None
                tags[key] = re.sub(r"\s+", "", value)
            if tags.get("d", "").lower() == sender_domain:
                signatures.append(tags)
        if len(signatures) != 1:
            return None
        signature = signatures[0]
        signed = signature.get("h", "").lower().split(":")
        if any(signed.count(name) < 1 for name in ("from", "list-unsubscribe", "list-unsubscribe-post")):
            return None
        passed = passes[0]
        if "header.s" in passed and signature.get("s") != passed["header.s"]:
            return None
        if "header.b" in passed and not signature.get("b", "").startswith(passed["header.b"]):
            return None
        if not signature.get("b") or not signature.get("bh"):
            return None
        base64.b64decode(signature["b"], validate=True)
        base64.b64decode(signature["bh"], validate=True)
        return url
    except (ValueError, TypeError, UnicodeError):
        return None


def post_once(url, permit):
    """Pin public DNS results to the actual TLS connection; never follow redirects.

    No proxy environment, cookie jar, Authorization, Referer or browser session
    is used. Marking the boundary BEFORE request() is intentionally conservative:
    TLS/HTTP failure can never be interpreted as permission to send again.
    """
    parsed = urllib.parse.urlsplit(url)
    host = domain(parsed.hostname or "")
    permit()
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    def public_address(value):
        address = ipaddress.ip_address(value)
        if not address.is_global or address.is_reserved:
            return False
        # Public-looking transition addresses may encapsulate a private IPv4
        # destination. This operation needs no NAT64/6to4/Teredo fallback.
        if isinstance(address, ipaddress.IPv6Address):
            return not (address.ipv4_mapped or address.sixtofour or address.teredo
                        or address in ipaddress.ip_network("64:ff9b::/96")
                        or address in ipaddress.ip_network("64:ff9b:1::/48"))
        return True
    if not addresses or len(addresses) > 32 or any(
            not public_address(item[4][0])
            for item in addresses):
        return {"outcome": "skipped", "writeAttempted": False}
    # Choosing one address is not a retry policy. A failed connection stays a
    # failed attempt; another IP or transport never receives the same POST.
    address = addresses[0][4][0]

    class PinnedHTTPS(http.client.HTTPSConnection):
        def connect(self):
            permit()
            sock = socket.create_connection((address, 443), timeout=15)
            try:
                self.sock = self._context.wrap_socket(sock, server_hostname=host)
            except BaseException:
                sock.close()
                raise

    connection = PinnedHTTPS(host, timeout=15, context=ssl.create_default_context())
    attempted = False
    try:
        connection.connect()
        permit()
        attempted = True
        connection.request("POST", urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, "")),
                           body=b"List-Unsubscribe=One-Click", headers={
                               "Content-Type": "application/x-www-form-urlencoded", "Connection": "close"})
        response = connection.getresponse()
        # A 2xx acknowledges the request only, not the future absence of mail.
        return {"outcome": "requested" if 200 <= response.status < 300 else "unknown", "writeAttempted": True}
    except Exception:
        return {"outcome": "unknown" if attempted else "skipped", "writeAttempted": attempted}
    finally:
        try:
            connection.close()
        except Exception:
            pass
