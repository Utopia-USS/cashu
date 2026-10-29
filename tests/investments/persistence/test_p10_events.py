"""Typed change events (P10 live data, ``core/events.py`` + ``core/live.py``): recorded by every process's
session layer (an MCP tool call, the app, another process), tailed by id with the row's wire dict for list
entities, pushed over SSE, pruned after a day, never across profiles."""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import subprocess
import sys
import textwrap

import pytest
from invp_support import AS_OF, sources
from mcp_support import TODAY, seed_profile
from sqlmodel import select

from cashu.core import events, live, profiles
from cashu.core.db import get_session, sqlite_file
from cashu.core.mcp.server import CashuMcp
from cashu.core.models import ChangeEvent, Profile
from cashu.modules.investments.models import InvAlert, InvWatchlistItem
from cashu.modules.investments.service import daily, portfolio


def rows(after: int = 0) -> list[ChangeEvent]:
    with get_session() as s:
        return list(s.exec(select(ChangeEvent).where(ChangeEvent.id > after).order_by(ChangeEvent.id)))


def profile(pid: int) -> Profile:
    with get_session() as s:
        return s.get(Profile, pid)


def since(pid: int, after: int | None) -> dict:
    with get_session() as s:
        return events.since(s, profile(pid), after)


@pytest.fixture
def mcp(db_engine):
    pid, slug = seed_profile(run_daily=False)
    return pid, slug, CashuMcp(pid, today=TODAY)


def test_an_mcp_write_records_typed_events_with_the_wire_row(mcp):
    pid, _slug, host = mcp
    start = since(pid, None)["last_id"]
    watched = host.call("add_to_watchlist", {"symbol_or_isin": "CDR.WA", "note": "x"})
    assert watched.ok, watched.error
    item_id = watched.data["item"]["item_id"]

    out = since(pid, start)
    watch = [e for e in out["events"] if e["entity"] == "watchlist"]
    assert [(e["op"], e["ref"]) for e in watch] == [("add", str(item_id))]
    item = watch[0]["payload"]["item"]
    assert item["id"] == item_id and item["instrument"]["symbol"]  # the GET /watchlist row, unredacted

    removed = host.call("remove_from_watchlist", {"id": item_id})
    assert removed.ok, removed.error
    later = since(pid, out["last_id"])["events"]
    assert any(e["entity"] == "watchlist" and e["op"] == "remove" and e["ref"] == str(item_id)
               for e in later)


def test_events_of_another_profile_never_reach_a_window(mcp):
    pid, _slug, host = mcp
    with get_session() as s:
        other = profiles.create_profile(s, name="Inny", modules_=["investments"]).id
    start = since(other, None)["last_id"]
    assert host.call("add_to_watchlist", {"symbol_or_isin": "CDR.WA"}).ok
    assert [e for e in since(other, start)["events"] if e["profile"] is not None] == []
    assert since(pid, start)["events"]


def test_a_bulk_update_is_one_event_without_a_row(mcp):
    pid, _slug, host = mcp
    assert host.call("add_to_watchlist", {"symbol_or_isin": "CDR.WA"}).ok
    start = since(pid, None)["last_id"]
    from sqlalchemy import update

    with get_session() as s:
        s.exec(update(InvWatchlistItem).values(note="bulk"))
    bulk = [r for r in rows(start) if r.entity == "watchlist"]
    assert [(r.op, r.ref, r.profile_id) for r in bulk] == [("update", None, None)]


def test_another_process_is_seen_by_the_tail(mcp, db_engine, tmp_path):
    pid, _slug, host = mcp
    assert host.call("add_to_watchlist", {"symbol_or_isin": "CDR.WA"}).ok
    with get_session() as s:
        item = s.exec(select(InvWatchlistItem).where(InvWatchlistItem.profile_id == pid)).first()
    start = since(pid, None)["last_id"]
    script = textwrap.dedent(f"""
        from sqlmodel import create_engine
        from cashu import db
        db.engine = create_engine("sqlite:///{sqlite_file(str(db_engine.url))}")
        from cashu.core.db import get_session
        from cashu.modules.investments.models import InvWatchlistItem
        with get_session() as s:
            row = s.get(InvWatchlistItem, {item.id})
            row.note = "from another process"
            s.add(row)
    """)
    env = {**os.environ, "CASHU_DATA_DIR": str(tmp_path / "data")}
    subprocess.run([sys.executable, "-c", script], check=True, env=env, timeout=60)
    out = since(pid, start)["events"]
    assert [(e["entity"], e["op"], e["ref"]) for e in out] == [("watchlist", "update", str(item.id))]
    assert out[0]["payload"]["item"]["note"] == "from another process"


def test_reset_after_pruned_events_and_prune(mcp):
    pid, _slug, host = mcp
    assert host.call("add_to_watchlist", {"symbol_or_isin": "CDR.WA"}).ok
    newest = since(pid, None)["last_id"]
    with get_session() as s:
        old = dt.datetime.now(dt.UTC) - dt.timedelta(days=2)
        for r in s.exec(select(ChangeEvent)).all():
            r.ts = old
            s.add(r)
    with get_session() as s:
        assert events.prune(s) >= 1
    with get_session() as s:
        events.emit(s, "prices", "update")
    out = since(pid, 0)
    assert out["events"] and not out["reset"]  # from the start: nothing to miss
    assert since(pid, 1)["reset"] is (newest > 1)


class FakeRequest:
    def __init__(self) -> None:
        self.closed = False

    async def is_disconnected(self) -> bool:
        return self.closed


def test_the_stream_pushes_a_commit_of_another_connection(mcp, db_engine):
    pid, _slug, host = mcp
    assert host.call("add_to_watchlist", {"symbol_or_isin": "CDR.WA"}).ok
    with get_session() as s:
        alert_count = len(s.exec(select(InvAlert)).all())
    who = profile(pid)

    async def run() -> list[str]:
        frames: list[str] = []
        gen = live.stream(who, FakeRequest(), None, tick=0.05, lifetime=3.0)
        frames.append(await gen.__anext__())  # retry
        frames.append(await gen.__anext__())  # hello
        # an agent's MCP process: its own connection, a real tool call
        added = await asyncio.to_thread(
            host.call, "add_to_watchlist", {"symbol_or_isin": "AAPL", "note": "pushed"}
        )
        assert added.ok, added.error
        async for f in gen:
            frames.append(f)
            if "pushed" in f:
                break
        await gen.aclose()
        return frames

    frames = asyncio.run(run())
    assert frames[0].startswith("retry:") and frames[1].startswith("event: hello")
    pushed = [f for f in frames if f.startswith("id: ") and "event: change" in f]
    data = [json.loads(f.split("data: ", 1)[1]) for f in pushed]
    watch = [d for d in data if d["entity"] == "watchlist" and d["op"] == "add"]
    assert watch and watch[-1]["payload"]["item"]["note"] == "pushed"
    assert alert_count >= 0


@pytest.fixture
def client(api_empty, monkeypatch):
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    return api_empty


def test_endpoints(client, monkeypatch):
    slug = client.post("/api/profiles", json={"name": "Anna", "modules": ["investments"]}).json()["slug"]
    other = client.post("/api/profiles", json={"name": "Ola", "modules": ["investments"]}).json()["slug"]
    base = client.get(f"/api/p/{slug}/changes").json()
    assert set(base) >= {"token", "last_id", "events", "reset"} and base["events"] == []
    r = client.post(f"/api/p/{slug}/investments/watchlist", json={"symbol_or_isin": "AAPL.US"})
    assert r.status_code == 201, r.text
    got = client.get(f"/api/p/{slug}/changes", params={"after": base["last_id"]}).json()
    assert got["token"] != base["token"]
    added = [e for e in got["events"] if e["entity"] == "watchlist"]
    assert added and added[0]["profile"] == slug and added[0]["payload"]["item"]["id"]
    theirs = client.get(f"/api/p/{other}/changes", params={"after": base["last_id"]}).json()
    assert all(e["profile"] is None for e in theirs["events"])

    monkeypatch.setattr(live, "LIFETIME", 0.3)
    monkeypatch.setattr(live, "TICK", 0.05)
    with client.stream("GET", f"/api/p/{slug}/changes/stream", params={"after": 0}) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        body = "".join(r.iter_text())
    assert "event: hello" in body
    pushed = [json.loads(b.split("data: ", 1)[1]) for b in body.split("\n\n") if "event: change" in b]
    assert all(e["profile"] in (slug, None) for e in pushed)
