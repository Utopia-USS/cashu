"""Egress proxy for fetch runs: an HTTP CONNECT proxy on 127.0.0.1:<ephemeral port>, one per run.

The sandbox lets a fetch connector reach only this port. The proxy allows ``CONNECT <host>:443`` where
``host`` is one of the manifest's ``fetch.hosts`` (exact, case-insensitive) and the host resolves to public
addresses only; everything else (another host or port, plain HTTP, a malformed request) gets ``403`` and
the host name (never more) is recorded for the run. Bytes are counted both ways. TLS stays end to end:
the proxy only sees the host name.

:func:`decide` is the pure allow-list logic (unit-tested on its own); :class:`EgressProxy` runs an asyncio
server in a background thread so the synchronous runner can start it, run the sandbox, and stop it.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import threading
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Self

ALLOWED_PORT = 443
MAX_HEAD_BYTES = 8 * 1024
HEAD_TIMEOUT_S = 10.0
CONNECT_TIMEOUT_S = 15.0
MAX_DENIED_RECORDED = 20
_HOST = re.compile(r"^[a-z0-9.-]{1,253}$")
_REQUEST_LINE = re.compile(r"^([A-Z]{1,16}) (\S{1,2048}) HTTP/1\.[01]$")

Connector = Callable[[str, int], Awaitable[tuple[asyncio.StreamReader, asyncio.StreamWriter]]]


@dataclass(frozen=True, slots=True)
class Decision:
    allowed: bool
    host: str | None  # lower-cased host name when one could be read (recorded when denied)
    port: int | None
    status: int  # 200 allowed, 403 refused, 400 malformed


def _clean_host(raw: str) -> str | None:
    host = raw.strip().lower().rstrip(".")
    if host.startswith("[") or not _HOST.match(host):
        return None
    return host


def decide(request_line: str, hosts: Iterable[str]) -> Decision:
    """Allow-list decision for the first line of a proxy request."""
    allowed = {h.lower() for h in hosts}
    m = _REQUEST_LINE.match(request_line.strip())
    if not m:
        return Decision(False, None, None, 400)
    method, target = m.groups()
    if method != "CONNECT":
        # Plain HTTP through the proxy (absolute URI): refused, the host is recorded.
        hm = re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://([^/:?#]+)", target)
        return Decision(False, _clean_host(hm.group(1)) if hm else None, None, 403)
    host_part, sep, port_part = target.rpartition(":")
    if not sep or not port_part.isdigit():
        return Decision(False, _clean_host(target), None, 403)
    host = _clean_host(host_part)
    port = int(port_part)
    if host is None:
        return Decision(False, None, port, 403)
    if port != ALLOWED_PORT or host not in allowed:
        return Decision(False, host, port, 403)
    return Decision(True, host, port, 200)


def public_address(infos: list) -> str | None:
    """The first resolved address when every resolved address is public, else None (no tunnel to the
    machine itself, the LAN, link-local or multicast addresses: DNS cannot point a connector there)."""
    addresses = []
    for info in infos:
        try:
            addresses.append(ipaddress.ip_address(info[4][0]))
        except (ValueError, IndexError, TypeError):
            return None
    if not addresses or not all(a.is_global and not a.is_multicast for a in addresses):
        return None
    return str(addresses[0])


async def _open_public(host: str, port: int):
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    address = public_address(infos)
    if address is None:
        raise ConnectionRefusedError("not a public address")
    return await asyncio.open_connection(address, port)


class EgressProxy:
    """One proxy per fetch run: ``with EgressProxy(hosts) as proxy: ... proxy.port ...``."""

    def __init__(self, hosts: Iterable[str], *, connect: Connector | None = None):
        self.hosts = tuple(h.lower() for h in hosts)
        self._connect = connect or _open_public
        self.denied_hosts: list[str] = []
        self.bytes_up = 0  # connector -> upstream
        self.bytes_down = 0  # upstream -> connector
        self.port: int | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server: asyncio.base_events.Server | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._lock = threading.Lock()
        self._error: BaseException | None = None

    # -- lifecycle ------------------------------------------------------------ #

    def start(self) -> int:
        self._thread = threading.Thread(target=self._serve, daemon=True, name="connector-proxy")
        self._thread.start()
        self._ready.wait(timeout=10)
        if self.port is None:
            raise RuntimeError(f"egress proxy did not start ({type(self._error).__name__})")
        return self.port

    def stop(self) -> None:
        loop = self._loop
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(self._shutdown)
        if self._thread is not None:
            self._thread.join(timeout=5)

    def __enter__(self) -> Self:
        self.start()
        return self

    def __exit__(self, *_exc) -> None:
        self.stop()

    def _serve(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        try:
            self._server = loop.run_until_complete(
                asyncio.start_server(self._handle, "127.0.0.1", 0, limit=MAX_HEAD_BYTES)
            )
            self.port = self._server.sockets[0].getsockname()[1]
        except OSError as e:
            self._error = e
            self._ready.set()
            loop.close()
            return
        self._ready.set()
        try:
            loop.run_forever()
        finally:
            for task in asyncio.all_tasks(loop):
                task.cancel()
            loop.run_until_complete(asyncio.sleep(0))
            loop.close()

    def _shutdown(self) -> None:
        if self._server is not None:
            self._server.close()
        for task in asyncio.all_tasks():
            task.cancel()
        assert self._loop is not None
        self._loop.call_soon(self._loop.stop)

    # -- requests ------------------------------------------------------------- #

    def _deny(self, host: str | None) -> None:
        with self._lock:
            name = host or "<invalid>"
            if name not in self.denied_hosts and len(self.denied_hosts) < MAX_DENIED_RECORDED:
                self.denied_hosts.append(name)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            try:
                head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), HEAD_TIMEOUT_S)
            except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
                await _reply(writer, 400)
                return
            first = head.split(b"\r\n", 1)[0].decode("latin-1")
            decision = decide(first, self.hosts)
            if not decision.allowed:
                self._deny(decision.host)
                await _reply(writer, decision.status)
                return
            try:
                up_reader, up_writer = await asyncio.wait_for(
                    self._connect(decision.host, decision.port), CONNECT_TIMEOUT_S
                )
            except (OSError, TimeoutError):
                await _reply(writer, 502)
                return
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
            await asyncio.gather(
                self._pipe(reader, up_writer, up=True),
                self._pipe(up_reader, writer, up=False),
            )
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            _close(writer)

    async def _pipe(self, src: asyncio.StreamReader, dst: asyncio.StreamWriter, *, up: bool) -> None:
        try:
            while data := await src.read(64 * 1024):
                with self._lock:
                    if up:
                        self.bytes_up += len(data)
                    else:
                        self.bytes_down += len(data)
                dst.write(data)
                await dst.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            _close(dst)


_REASONS = {400: "Bad Request", 403: "Forbidden", 502: "Bad Gateway"}


async def _reply(writer: asyncio.StreamWriter, status: int) -> None:
    try:
        writer.write(
            f"HTTP/1.1 {status} {_REASONS.get(status, 'Error')}\r\nContent-Length: 0\r\n"
            "Connection: close\r\n\r\n".encode("ascii")
        )
        await writer.drain()
    except (ConnectionError, OSError):
        pass


def _close(writer: asyncio.StreamWriter) -> None:
    try:
        writer.close()
    except (ConnectionError, OSError, RuntimeError):
        pass


__all__ = ["ALLOWED_PORT", "Decision", "EgressProxy", "decide", "public_address"]
