"""Tiny one-shot local HTTP server to capture the OAuth redirect `code`.

Enable Banking redirects the browser to the whitelisted redirect URL with a
`code` query param after the user completes bank login (SCA). Rather than make
the user copy that code out of the address bar, we briefly listen on the
redirect URL's host/port and grab it automatically.
"""

from __future__ import annotations

import datetime as dt
import ssl
import tempfile
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

_PAGE = (
    b"<!doctype html><meta charset=utf-8>"
    b"<body style='font-family:sans-serif;padding:3rem'>"
    b"<h2>Signed in.</h2><p>You can return to the terminal.</p></body>"
)


def _self_signed_context(host: str) -> ssl.SSLContext:
    """Generate a throwaway self-signed cert for `host` and wrap it in a context.

    Enable Banking requires an https redirect URL; for a localhost listener that
    means TLS. The browser will warn about the self-signed cert on redirect —
    proceed past it once and the code is captured. (You can always fall back to
    `eb connect <code>` by copying the code from the address bar instead.)
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False)
        .sign(key, hashes.SHA256())
    )
    certf = tempfile.NamedTemporaryFile(delete=False, suffix=".pem")
    keyf = tempfile.NamedTemporaryFile(delete=False, suffix=".pem")
    certf.write(cert.public_bytes(serialization.Encoding.PEM))
    certf.close()
    keyf.write(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    keyf.close()
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certf.name, keyf.name)
    return ctx


def wait_for_authorization_code(redirect_url: str, timeout: float = 300.0) -> str | None:
    """Listen on the redirect URL's host:port and return the captured `code`.

    Serves HTTPS with a self-signed cert when the redirect URL is https (Enable
    Banking's requirement). Returns None on timeout. Browsers may hit the server
    more than once (favicon); we keep going until a request carries `code`.
    """
    parts = urllib.parse.urlparse(redirect_url)
    host = parts.hostname or "localhost"
    is_https = parts.scheme == "https"
    port = parts.port or (443 if is_https else 80)
    captured: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            query = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(query)
            if "code" in params:
                captured["code"] = params["code"][0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(_PAGE)

        def log_message(self, *args):  # silence default stderr logging
            pass

    server = HTTPServer((host, port), Handler)
    if is_https:
        server.socket = _self_signed_context(host).wrap_socket(server.socket, server_side=True)
    server.timeout = 1.0
    deadline = time.monotonic() + timeout
    try:
        while "code" not in captured and time.monotonic() < deadline:
            server.handle_request()
    finally:
        server.server_close()
    return captured.get("code")
