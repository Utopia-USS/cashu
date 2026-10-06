"""Local API protection for the dashboard server.

The API serves personal financial data on localhost, so any web page the user
visits could try to reach it. Three layers:

1. ``cashu serve`` binds 127.0.0.1 by default (``CASHU_HOST`` / ``CASHU_PORT``).
2. Host allowlist: only ``127.0.0.1`` / ``localhost`` on the serving port are
   answered. This defeats DNS rebinding (a hostile domain re-pointed at
   127.0.0.1 still sends its own name in the Host header).
3. A random per-launch token, required as ``X-Cashu-Token`` on every request
   except the SPA shell and its static assets (so on every ``/api/*`` call). A
   cross-site page can fire requests (forms, no-cors fetch) but cannot read the
   token, and cannot add a custom header without a CORS preflight, which is
   never granted (there is no CORS middleware).

Nothing is served with the token: an unauthenticated ``GET /`` must not hand it out,
because any local process (another macOS user, a browser extension, an app with network
access) can open a TCP connection to 127.0.0.1 and send an allowed Host header. The SPA gets
the token out of band (``frontend/src/core/token.ts``):

- desktop window (``cashu app``): from the pywebview bridge
  ``window.pywebview.api.token()`` (``desktop/shell.py``), reachable only from inside the window;
- browser (``cashu serve``): from the one-time URL ``http://127.0.0.1:<port>/#token=<token>``
  that the command prints; the fragment never reaches the server, the SPA moves it to
  ``sessionStorage`` and strips it from the address bar;
- ``npm run dev``: the Vite proxy adds the header itself (from ``<data dir>/api-token``).

``CASHU_DEV_EMBED_TOKEN=1`` restores the old ``<meta name="cashu-token">`` injection into
``/`` for development only (logged as a warning on every launch).

Every response also forbids framing (``X-Frame-Options: DENY`` and CSP
``frame-ancestors 'none'``): a hostile page could otherwise load the real
dashboard in an iframe and steer the user's own clicks (clickjacking), which no
token or Host check can tell apart from the user.
``cashu serve`` also writes the token to ``<data dir>/api-token`` (0600) for
the Vite dev proxy and other local clients.
"""

from __future__ import annotations

import hmac
import logging
import os
import re
import secrets
from dataclasses import dataclass
from pathlib import Path

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import paths
from .env import env

TOKEN_HEADER = "X-Cashu-Token"
TOKEN_META = "cashu-token"
# Hands the token to a `cashu serve --reload` worker process (dev only).
TOKEN_ENV = "CASHU_API_TOKEN"
# Development only: embed the token into ``/`` as a meta tag again (see the module doc).
DEV_EMBED_ENV = "CASHU_DEV_EMBED_TOKEN"
# The fragment of the one-time URL ``cashu serve`` prints (frontend/src/core/token.ts reads it).
TOKEN_FRAGMENT = "token"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost"})

# Served without a token: the SPA shell and static files (no personal data).
PUBLIC_PATHS = frozenset({"/"})
PUBLIC_PREFIXES = ("/assets/", "/static/")

# Anti-framing headers on every HTTP response (clickjacking, see the module doc).
FRAME_HEADERS = {
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
}


@dataclass(frozen=True)
class SecurityConfig:
    token: str
    port: int

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def origin(self) -> str:
        """The dashboard's own origin (what the desktop window may show)."""
        return self.base_url

    def token_url(self) -> str:
        """The one-time browser URL: the token rides in the fragment, which browsers never send
        to the server (so it is not in any request line or access log)."""
        return f"{self.base_url}/#{TOKEN_FRAGMENT}={self.token}"

    def host_allowed(self, host_header: str | None) -> bool:
        """True for ``127.0.0.1:<port>`` / ``localhost:<port>`` (no port = 80)."""
        if not host_header:
            return False
        value = host_header.strip().lower()
        if value.startswith("["):  # IPv6 literal: never served (we bind IPv4 loopback)
            return False
        host, sep, port = value.partition(":")
        return host in LOOPBACK_HOSTS and (port if sep else "80") == str(self.port)

    def token_valid(self, presented: str | None) -> bool:
        if not presented:
            return False
        return hmac.compare_digest(presented.encode(), self.token.encode())


_config: SecurityConfig | None = None


def generate_token() -> str:
    return secrets.token_urlsafe(32)


def configure(token: str | None = None, port: int | None = None) -> SecurityConfig:
    """Set the active config (``cashu serve`` / a desktop shell call this)."""
    global _config
    if port is None:
        from ..config import settings

        port = settings.port
    _config = SecurityConfig(token=token or generate_token(), port=port)
    return _config


def get_config() -> SecurityConfig:
    """The active config; created on first use (token from ``CASHU_API_TOKEN``
    when a reload worker inherits it, else a fresh random token)."""
    if _config is None:
        return configure(token=env(TOKEN_ENV) or None)
    return _config


_frozen_embed_logged = False


def embed_token_enabled() -> bool:
    """True only in the explicit dev mode ``CASHU_DEV_EMBED_TOKEN=1`` from a source checkout. The
    packaged app ignores the switch (a stray ``launchctl setenv`` must not bring the token back into
    ``/``; F7 review R3) and logs that once at error level."""
    global _frozen_embed_logged
    if env(DEV_EMBED_ENV) != "1":
        return False
    from . import runtime

    if runtime.frozen():
        if not _frozen_embed_logged:
            _frozen_embed_logged = True
            logging.getLogger("cashu.security").error(
                "%s=1 is ignored in the packaged app: the API token is never embedded into /",
                DEV_EMBED_ENV,
            )
        return False
    return True


def _is_public(path: str) -> bool:
    return path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES)


class LocalOnlyMiddleware:
    """Pure ASGI middleware enforcing the Host allowlist and the API token."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "http":
            send = _with_frame_headers(send)
        cfg = get_config()
        headers = Headers(scope=scope)
        path = scope.get("path", "")
        if not cfg.host_allowed(headers.get("host")):
            reject = PlainTextResponse("Invalid host header", status_code=400)
        elif not _is_public(path) and not cfg.token_valid(headers.get(TOKEN_HEADER)):
            reject = JSONResponse({"detail": "Missing or invalid API token"}, status_code=401)
        else:
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        await reject(scope, receive, send)


def _with_frame_headers(send: Send) -> Send:
    async def wrapped(message: Message) -> None:
        if message["type"] == "http.response.start":
            headers = MutableHeaders(scope=message)
            for name, value in FRAME_HEADERS.items():
                if name not in headers:
                    headers.append(name, value)
        await send(message)

    return wrapped


_HEAD_TAG = re.compile(r"<head(\s[^>]*)?>", re.IGNORECASE)


def inject_token_meta(html: str, token: str) -> str:
    """Dev mode only (:func:`embed_token_enabled`). Insert ``<meta name="cashu-token" content="...">`` right after ``<head>``.
    The token is URL-safe base64, so it needs no HTML escaping."""
    tag = f'<meta name="{TOKEN_META}" content="{token}" />'
    match = _HEAD_TAG.search(html)
    if match is None:
        return tag + html
    return f"{html[: match.end()]}\n    {tag}{html[match.end():]}"


def write_token_file(token: str, path: Path | None = None) -> Path:
    """Write the token owner-only (0600), atomically."""
    path = path or paths.token_path()
    paths.ensure_private_dir(path.parent)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token)
    if os.name == "posix":
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return path


def read_token_file(path: Path | None = None) -> str | None:
    path = path or paths.token_path()
    try:
        return path.read_text().strip() or None
    except OSError:
        return None


def remove_token_file(token: str, path: Path | None = None) -> None:
    """Delete the token file if it still holds ``token`` (another server may have
    replaced it meanwhile)."""
    path = path or paths.token_path()
    if read_token_file(path) == token:
        path.unlink(missing_ok=True)
