"""The database change token (P10 "MCP changes", ``core/changes.py``, ``token`` of ``GET /api/p/{slug}/changes``): a commit by any
other connection or process changes it, reads never do, so the open app re-reads only after real writes (an
agent's ``cashu mcp`` process writes through its own connection)."""

from __future__ import annotations

import sqlite3

import pytest
from invp_support import AS_OF, sources
from test_invp_isolation import INVESTMENTS_GETS, household

from cashu.core import changes
from cashu.core.db import sqlite_file
from cashu.modules.investments.service import daily, portfolio


def test_two_connections_a_commit_changes_the_token_a_read_does_not(tmp_path):
    path = tmp_path / "x.db"
    writer = sqlite3.connect(path, isolation_level=None)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("CREATE TABLE t (v INTEGER)")
    watcher = changes.ChangeWatcher(path)
    first = watcher.token()
    assert watcher.token() == first  # nothing committed

    reader = sqlite3.connect(path)
    reader.execute("SELECT count(*) FROM t").fetchone()
    assert watcher.token() == first  # reads are no change

    writer.execute("INSERT INTO t VALUES (1)")
    second = watcher.token()
    assert second != first
    assert watcher.token() == second

    writer.execute("BEGIN")
    writer.execute("INSERT INTO t VALUES (2)")
    assert watcher.token() == second  # not committed yet
    writer.execute("COMMIT")
    assert watcher.token() not in (first, second)
    for c in (writer, reader):
        c.close()
    watcher.close()


def test_a_db_that_is_not_a_file_has_a_fixed_token():
    watcher = changes.ChangeWatcher(None)
    assert watcher.token() == watcher.token()


@pytest.fixture
def client(api_empty, monkeypatch):
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    return api_empty


def test_endpoint_stable_across_reads_and_changed_by_another_process(client, db_engine):
    slug, _aid, xmpl = household(client, "Anna")
    token = client.get(f"/api/p/{slug}/changes").json()["token"]
    # every investments GET the app re-reads after a change: none of them writes, so no reload loop
    for path in INVESTMENTS_GETS:
        client.get(f"/api/p/{slug}{path.format(instrument_id=xmpl)}")
    client.get(f"/api/p/{slug}/summary")
    client.get(f"/api/p/{slug}/networth")
    assert client.get(f"/api/p/{slug}/changes").json()["token"] == token

    # an agent's MCP process: its own connection to the same file
    other = sqlite3.connect(sqlite_file(str(db_engine.url)), isolation_level=None)
    other.execute("UPDATE profiles SET name = name || ' (MCP)' WHERE slug = ?", (slug,))
    other.close()
    after = client.get(f"/api/p/{slug}/changes").json()["token"]
    assert after != token

    # the app's own write changes it too (one extra re-read, no loop)
    client.post(f"/api/p/{slug}/investments/watchlist", json={"instrument_id": xmpl})
    assert client.get(f"/api/p/{slug}/changes").json()["token"] != after
