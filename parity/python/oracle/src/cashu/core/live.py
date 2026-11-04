"""The change-event stream of one window (P10 live data, ``GET /api/p/{slug}/changes/stream``).

Every ``TICK`` the stream checks ``PRAGMA data_version`` (``core/changes.py``: one pragma on a dedicated
connection, no table read); only when some process committed does it read the new ``change_events`` rows
of the profile (``core/events.py``) and send them, each with the row's wire dict for list entities. A
comment every ``KEEPALIVE`` keeps proxies and the browser from closing it; after ``LIFETIME`` the stream
ends and the client reconnects with the last id (so a server shutdown never waits on an open stream for
long). Database work runs in a worker thread, never on the event loop.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Callable

from . import changes, events
from .db import get_session

TICK = 1.0
KEEPALIVE = 15.0
LIFETIME = 300.0
RETRY_MS = 3000


def _since(profile, after: int | None) -> dict:
    with get_session() as s:
        return events.since(s, profile, after)


def frame(event: str, data: dict, event_id: int | None = None) -> str:
    head = f"id: {event_id}\n" if event_id is not None else ""
    return f"{head}event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


async def stream(
    profile,
    request,
    after: int | None,
    *,
    tick: float | None = None,
    lifetime: float | None = None,
    token: Callable[[], str] = changes.token,
) -> AsyncIterator[str]:
    tick = TICK if tick is None else tick
    lifetime = LIFETIME if lifetime is None else lifetime
    began = last_sent = time.monotonic()
    yield f"retry: {RETRY_MS}\n\n"
    seen = await asyncio.to_thread(token)
    batch = await asyncio.to_thread(_since, profile, after)
    cursor = batch["last_id"]
    yield frame("hello", {"last_id": cursor})
    for item in batch["events"]:
        yield frame("change", item, item["id"])
    if batch["reset"]:
        yield frame("reset", {"last_id": cursor})
    while time.monotonic() - began < lifetime:
        if await request.is_disconnected():
            return
        await asyncio.sleep(tick)
        current = await asyncio.to_thread(token)
        if current != seen:
            seen = current
            batch = await asyncio.to_thread(_since, profile, cursor)
            for item in batch["events"]:
                yield frame("change", item, item["id"])
                last_sent = time.monotonic()
            if batch["reset"]:
                yield frame("reset", {"last_id": batch["last_id"]})
            cursor = batch["last_id"]
        if time.monotonic() - last_sent >= KEEPALIVE:
            last_sent = time.monotonic()
            yield ": keepalive\n\n"
