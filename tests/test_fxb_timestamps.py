"""FE1 root cause (F7): every timestamp the API returns carries an explicit UTC offset (``Z`` or
``+00:00``; a local wall-clock time keeps its own offset), never a naive ``2026-10-05T10:00:00``, which
browsers read as local time. Trade and booking dates stay plain ``YYYY-MM-DD``.

The guard walks the profile routes of the seeded household and every investments route of a household
with a run, a decision, a thesis, alerts, a review and a manual valuation."""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent / "investments" / "persistence"))

from test_invp_isolation import INVESTMENTS_GETS, household
from test_profiles import PROFILE_GETS

from cashu.core.api import utc_iso
from cashu.modules.investments.service import daily, portfolio

NAIVE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$")
DATE_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")


def naive_values(value, path: str = "$") -> list[str]:
    if isinstance(value, dict):
        return [x for k, v in value.items() for x in naive_values(v, f"{path}.{k}")]
    if isinstance(value, list):
        return [x for i, v in enumerate(value) for x in naive_values(v, f"{path}[{i}]")]
    if isinstance(value, str) and NAIVE.match(value):
        return [f"{path} = {value}"]
    return []


def count_timestamps(value) -> int:
    if isinstance(value, dict):
        return sum(count_timestamps(v) for v in value.values())
    if isinstance(value, list):
        return sum(count_timestamps(v) for v in value)
    return int(isinstance(value, str) and bool(DATE_TIME.match(value)))


def test_utc_iso():
    import datetime as dt

    naive = dt.datetime(2026, 10, 5, 10, 0, 0, 123456)  # noqa: DTZ001 - SQLite-style naive UTC
    assert utc_iso(naive) == "2026-10-05T10:00:00.123456+00:00"
    warsaw = dt.timezone(dt.timedelta(hours=2))
    assert utc_iso(dt.datetime(2026, 10, 5, 12, 0, tzinfo=warsaw)) == "2026-10-05T10:00:00+00:00"
    assert utc_iso(dt.date(2026, 10, 5)) == "2026-10-05"
    assert utc_iso(None) is None


def test_core_and_budget_routes_send_offset_timestamps(api):
    r = api.post("/api/p/default/reviews", json={"module": "investments", "notes": "ok"})
    assert r.status_code in (200, 201), r.text
    seen, offenders = 0, []
    for path in [*PROFILE_GETS, "/../system", "/../profiles"]:
        url = f"/api/p/default{path}" if not path.startswith("/..") else f"/api{path[3:]}"
        r = api.get(url)
        assert r.status_code == 200, (url, r.text)
        body = r.json()
        seen += count_timestamps(body)
        offenders += [f"{url}: {x}" for x in naive_values(body)]
    assert not offenders, "\n".join(offenders)
    assert seen > 0


@pytest.fixture
def client(api_empty, monkeypatch):
    from invp_support import AS_OF, sources

    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    return api_empty


def test_investments_routes_send_offset_timestamps(client):
    slug, _aid, xmpl = household(client, "Czas")
    assert client.post(f"/api/p/{slug}/reviews", json={"module": "investments"}).status_code in (
        200,
        201,
    )
    seen, offenders = 0, []
    for path in INVESTMENTS_GETS:
        url = f"/api/p/{slug}{path.format(instrument_id=xmpl)}"
        r = client.get(url)
        assert r.status_code == 200, (url, r.text)
        body = r.json()
        seen += count_timestamps(body)
        offenders += [f"{url}: {x}" for x in naive_values(body)]
    assert not offenders, "\n".join(offenders)
    assert seen > 20


def test_mcp_tools_send_offset_timestamps(db_engine):
    import datetime as dt

    from mcp_support import TODAY, seed_profile

    from cashu.core.mcp import labels as L
    from cashu.core.mcp.redaction import Redactor
    from cashu.core.mcp.server import CashuMcp

    naive = dt.datetime(2026, 10, 5, 10, 0)  # noqa: DTZ001 - SQLite-style naive UTC
    assert Redactor("strict").apply({"at": L.date(naive)}) == {"at": "2026-10-05T10:00:00+00:00"}

    pid, _slug = seed_profile()
    mcp = CashuMcp(pid, today=TODAY)
    seen, offenders = 0, []
    tools = (
        "signals",
        "alerts",
        "positions",
        "portfolio_overview",
        "profile_overview",
        "strategy_status",
        "theses",
        "watchlist",
        "research_notes",
        "research_context",
    )
    for tool in tools:
        result = mcp.call(tool, {})
        assert result.ok, (tool, result.error)
        seen += count_timestamps(result.data)
        offenders += [f"{tool}: {x}" for x in naive_values(result.data)]
    assert not offenders, "\n".join(offenders)
    assert seen > 0
