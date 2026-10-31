"""Offline guard of the golden run: no request ever leaves the process.

- every httpx transport (sync and async) raises before sending;
- ``urllib.request.urlopen`` raises;
- ``socket.socket.connect`` / ``connect_ex`` / ``socket.create_connection`` raise for any address
  that is not a Unix socket (SQLite needs none of them).

Each blocked attempt is counted (``blocked()``); the golden index records the count per check, so a
check that silently fell back to "market data unavailable" is visible.
"""

from __future__ import annotations

import socket
import urllib.request

_blocked = 0


class NetworkBlocked(RuntimeError):
    pass


def _refuse(*_args, **_kwargs):
    global _blocked
    _blocked += 1
    raise NetworkBlocked("network access is disabled in the parity golden run")


async def _refuse_async(*args, **kwargs):
    _refuse(*args, **kwargs)


def blocked() -> int:
    return _blocked


def install() -> None:
    try:
        import httpx
    except ImportError:  # pragma: no cover
        httpx = None
    if httpx is not None:
        httpx.HTTPTransport.handle_request = _refuse
        httpx.AsyncHTTPTransport.handle_async_request = _refuse_async
    urllib.request.urlopen = _refuse

    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex

    def connect(self, address):
        if self.family == getattr(socket, "AF_UNIX", None):
            return real_connect(self, address)
        _refuse()

    def connect_ex(self, address):
        if self.family == getattr(socket, "AF_UNIX", None):
            return real_connect_ex(self, address)
        _refuse()

    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex
    socket.create_connection = _refuse
