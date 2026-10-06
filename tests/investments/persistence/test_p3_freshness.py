"""P3 backend: the recommendation's freshness (``instrument.plan_freshness``) on positions rows,
watchlist rows and the asset detail, the leading P2 hints ``recommendation_outdated`` /
``recommendation_maybe_outdated``, and MCP ``positions`` / ``watchlist`` (state + reason codes, the
same in strict and full mode). Synthetic data only."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from invp_support import (
    AS_OF,
    FakePrices,
    add_account,
    canonical_csv,
    import_file,
    make_profile,
    sources,
)
from sqlmodel import select

from finanse.core.db import get_session
from finanse.core.mcp.server import FinanseMcp
from finanse.core.models import Profile, utcnow
from finanse.modules.investments.models import (
    InvAlert,
    InvInstrument,
    InvProfileInstrument,
    InvResearchNote,
)
from finanse.modules.investments.service import daily, files

STRATEGY = """\
version: 1
base_currency: PLN
data:
  max_price_age_days: 5
  max_stale_weight: 1.0
  max_unclassified_weight: 1.0
buckets:
  - id: stocks
    match: { asset_class: [equity, etf] }
  - id: cash
    match: { asset_class: cash }
allocation:
  targets: { stocks: 0.9, cash: 0.1 }
rules:
  - id: rule_a
    kind: gain_from_cost
    params: { threshold: 0.5 }
"""
PRICES = {"ABC.WA": 60, "WRLD.DE": 50, "XMPL": 200}  # XMPL +100 %


@pytest.fixture
def api(api_empty):
    pid, slug = make_profile("Inwestor")
    aid = add_account(pid)
    import_file(pid, aid, canonical_csv())
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY)
    return api_empty, pid, f"/api/p/{slug}/investments"


def instrument_id(symbol: str) -> int:
    with get_session() as s:
        return s.exec(select(InvInstrument.id).where(InvInstrument.symbol == symbol)).one()


def run() -> None:
    fake = FakePrices({k: Decimal(v) for k, v in PRICES.items()})
    daily.run_daily_check("worker", as_of=AS_OF, sources=sources(fake))


def set_plan(client, base: str, iid: int, plan: str, *, ago: dt.timedelta) -> None:
    """Write the recommendation, then date it ``ago`` back."""
    assert client.put(f"{base}/instruments/{iid}/plan", json={"plan": plan}).status_code == 200
    with get_session() as s:
        row = s.exec(
            select(InvProfileInstrument).where(InvProfileInstrument.instrument_id == iid)
        ).one()
        row.plan_at = utcnow() - ago
        s.add(row)
        s.commit()


def add_note(pid: int, iid: int, relation: str) -> int:
    now = utcnow()
    with get_session() as s:
        row = InvResearchNote(
            profile_id=pid,
            instrument_id=iid,
            kind="news",
            polarity="negative",
            strength=2,
            thesis_relation=relation,
            thesis_field="thesis",
            title=f"Example fact {relation}",
            summary="Przykladowy fakt ze zrodlem.",
            sources=[],
            observed_at=now - dt.timedelta(minutes=5),
            expires_at=now + dt.timedelta(days=30),
            created_by="agent",
            read_at=now,
        )
        s.add(row)
        s.commit()
        return row.id


def triggered_alert(pid: int, iid: int, *, ago: dt.timedelta = dt.timedelta(minutes=1)) -> int:
    with get_session() as s:
        row = InvAlert(
            profile_id=pid,
            instrument_id=iid,
            scope="instrument",
            kind="price_below",
            params={"level": 12.5},
            title="Ponizej 12.50 EUR",
            status="triggered",
            last_triggered_at=utcnow() - ago,
        )
        s.add(row)
        s.commit()
        return row.id


def position(client, base: str, iid: int) -> dict:
    rows = client.get(f"{base}/positions").json()["positions"]
    return next(r for r in rows if r["instrument"]["id"] == iid)


def codes(freshness: dict) -> list[str]:
    return [r["code"] for r in freshness["reasons"]]


def strip_at(freshness: dict) -> dict:
    return {
        "state": freshness["state"],
        "reasons": [{k: v for k, v in r.items() if k != "at"} for r in freshness["reasons"]],
    }


# --------------------------------------------------------------------------- #
# Held: positions rows and the asset detail
# --------------------------------------------------------------------------- #


def test_held_freshness_on_positions_and_the_asset_detail(api):
    client, pid, base = api
    abc = instrument_id("ABC")
    row = position(client, base, abc)
    assert row["instrument"]["plan"] is None and row["instrument"]["plan_freshness"] is None

    set_plan(client, base, abc, "buy", ago=dt.timedelta(hours=1))
    row = position(client, base, abc)
    assert row["instrument"]["plan_freshness"] == {"state": "fresh", "reasons": []}
    assert [h["code"] for h in row["hints"]] == ["no_thesis"]

    note_id = add_note(pid, abc, "invalidates")
    row = position(client, base, abc)
    fresh = row["instrument"]["plan_freshness"]
    assert strip_at(fresh) == {
        "state": "outdated",
        "reasons": [
            {"code": "note_invalidates", "note_id": note_id, "relation": "invalidates", "count": 1}
        ],
    }
    assert fresh["reasons"][0]["at"].endswith("+00:00")
    assert row["hints"][0] == {
        "code": "recommendation_outdated",
        "severity": "rule",
        "params": {"reasons": ["note_invalidates"]},
    }
    detail = client.get(f"{base}/positions/{abc}").json()
    assert detail["instrument"]["plan_freshness"] == fresh
    assert detail["position"]["instrument"]["plan_freshness"] == fresh
    assert detail["hints"] == row["hints"]


def test_strategy_rule_signals_after_the_plan(api):
    client, _pid, base = api
    xmpl = instrument_id("XMPL")
    set_plan(client, base, xmpl, "hold", ago=dt.timedelta(hours=1))
    run()  # gain_from_cost fires on XMPL after the recommendation
    row = position(client, base, xmpl)
    fresh = row["instrument"]["plan_freshness"]
    assert fresh["state"] == "maybe_outdated"
    assert [(r["code"], r["kind"]) for r in fresh["reasons"]] == [("rule_fired", "gain_from_cost")]
    assert isinstance(fresh["reasons"][0]["signal_id"], int)
    assert row["hints"][0] == {
        "code": "recommendation_maybe_outdated",
        "severity": "review",
        "params": {"reasons": ["rule_fired"]},
    }
    # a recommendation newer than the signal is fresh again
    set_plan(client, base, xmpl, "hold", ago=dt.timedelta(0))
    assert position(client, base, xmpl)["instrument"]["plan_freshness"]["state"] == "fresh"


# --------------------------------------------------------------------------- #
# Watched: watchlist rows, the asset detail, neither held nor watched
# --------------------------------------------------------------------------- #


def test_watched_freshness_alerts_age_and_unwatched(api):
    client, pid, base = api
    r = client.post(f"{base}/watchlist", json={"symbol_or_isin": "VWCE.DE"})
    assert r.status_code == 201, r.text
    vwce = r.json()["instrument"]["id"]
    assert client.get(f"{base}/watchlist").json()[0]["instrument"]["plan_freshness"] is None

    set_plan(client, base, vwce, "hold", ago=dt.timedelta(days=40))
    triggered_alert(pid, vwce, ago=dt.timedelta(days=50))  # before the recommendation
    alert_id = triggered_alert(pid, vwce)
    item = client.get(f"{base}/watchlist").json()[0]
    fresh = item["instrument"]["plan_freshness"]
    assert strip_at(fresh) == {
        "state": "maybe_outdated",
        "reasons": [
            {"code": "alert_triggered", "alert_id": alert_id, "kind": "price_below"},
            {"code": "age"},
        ],
    }
    assert item["hints"][0] == {
        "code": "recommendation_maybe_outdated",
        "severity": "review",
        "params": {"reasons": ["alert_triggered", "age"]},
    }
    assert [h["code"] for h in item["hints"][1:3]] == ["alert_triggered", "alert_triggered"]
    detail = client.get(f"{base}/positions/{vwce}").json()
    assert detail["instrument"]["plan_freshness"] == fresh and detail["hints"] == item["hints"]

    # neither held nor watched: no hints, the recommendation's freshness stays on the detail
    assert client.delete(f"{base}/watchlist/{item['id']}").status_code == 200
    detail = client.get(f"{base}/positions/{vwce}").json()
    assert detail["hints"] == [] and detail["instrument"]["plan_freshness"] == fresh


def test_a_held_only_plan_on_a_watched_instrument_has_no_freshness(api):
    client, _pid, base = api
    xmpl = instrument_id("XMPL")
    set_plan(client, base, xmpl, "reduce", ago=dt.timedelta(days=40))
    # held: the reduce plan is effective and old
    fresh = position(client, base, xmpl)["instrument"]["plan_freshness"]
    assert (fresh["state"], codes(fresh)) == ("maybe_outdated", ["age"])

    vwce = client.post(f"{base}/watchlist", json={"symbol_or_isin": "VWCE.DE"}).json()
    vwce = vwce["instrument"]["id"]
    set_plan(client, base, vwce, "hold", ago=dt.timedelta(days=40))
    with get_session() as s:  # a stale held-only plan on a watched instrument (no API path)
        row = s.exec(
            select(InvProfileInstrument).where(InvProfileInstrument.instrument_id == vwce)
        ).one()
        row.plan = "exit_asap"
        s.add(row)
        s.commit()
    item = client.get(f"{base}/watchlist").json()[0]
    assert item["instrument"]["plan"] is None and item["instrument"]["plan_freshness"] is None
    assert client.get(f"{base}/positions/{vwce}").json()["instrument"]["plan_freshness"] is None


# --------------------------------------------------------------------------- #
# MCP: state + reason codes, strict == full
# --------------------------------------------------------------------------- #


def test_mcp_plan_freshness_is_the_same_in_strict_and_full(api):
    client, pid, base = api
    abc = instrument_id("ABC")
    set_plan(client, base, abc, "buy", ago=dt.timedelta(hours=1))
    add_note(pid, abc, "invalidates")
    vwce = client.post(f"{base}/watchlist", json={"symbol_or_isin": "VWCE.DE"}).json()
    vwce_id = vwce["instrument"]["id"]
    set_plan(client, base, vwce_id, "hold", ago=dt.timedelta(days=40))
    triggered_alert(pid, vwce_id)

    def read(level: str) -> tuple[dict, list]:
        with get_session() as s:
            p = s.get(Profile, pid)
            p.mcp_privacy = level
            s.add(p)
            s.commit()
        mcp = FinanseMcp(pid, today=AS_OF)
        positions = mcp.call("positions")
        watchlist = mcp.call("watchlist")
        assert positions.ok and watchlist.ok, (positions.error, watchlist.error)
        return (
            {r["symbol"]: (r["plan_freshness"], r["hints"]) for r in positions.data["positions"]},
            [(i["plan_freshness"], i["hints"]) for i in watchlist.data["items"]],
        )

    strict, full = read("strict"), read("amounts")
    assert strict == full
    held, watched = strict
    assert held["ABC"][0] == {"state": "outdated", "reasons": ["note_invalidates"]}
    assert held["ABC"][1][0] == {
        "code": "recommendation_outdated",
        "severity": "rule",
        "params": {"reasons": ["note_invalidates"]},
    }
    assert held["WRLD"][0] is None
    assert watched[0][0] == {"state": "maybe_outdated", "reasons": ["alert_triggered", "age"]}
    assert watched[0][1][0]["params"] == {"reasons": ["alert_triggered", "age"]}
