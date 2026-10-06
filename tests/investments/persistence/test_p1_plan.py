"""P1 backend: the model recommendation per instrument (legacy ``plan`` storage and API route),
422 for an unknown value or a held-only plan on a watched instrument), ``plan`` / ``plan_at`` in
every ``instrument_dict`` (positions, asset detail, instrument list, watchlist), the stale rule (a
reduce plan of a sold position is emitted as null), profile isolation, the plan checks in the daily
run (fire, escalate, resolve after an exit plan is written or the plan changes; fulfilled thesis),
and the MCP tools carrying and generating a recommendation. Synthetic data only."""

from __future__ import annotations

import datetime as dt

import pytest
from invp_support import (
    AS_OF,
    STRATEGY_YAML,
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
from finanse.core.models import utcnow
from finanse.modules.investments.models import (
    InvDecision,
    InvInstrument,
    InvProfileInstrument,
    InvResearchNote,
    InvSignal,
)
from finanse.modules.investments.service import daily, files

XMPL_DOUBLED = {"ABC.WA": 60, "WRLD.DE": 110, "XMPL": 200}  # XMPL bought at 100 USD: +100 %


def setup_investor(name: str = "Inwestor") -> tuple[int, str, int]:
    pid, slug = make_profile(name)
    aid = add_account(pid)
    import_file(pid, aid, canonical_csv())
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML)
    return pid, slug, aid


@pytest.fixture
def api(api_empty):
    pid, slug, aid = setup_investor()
    return api_empty, pid, f"/api/p/{slug}/investments", aid


def instrument_id(symbol: str) -> int:
    with get_session() as s:
        return s.exec(select(InvInstrument.id).where(InvInstrument.symbol == symbol)).one()


def run(prices: dict | None = None) -> daily.DailyCheckReport:
    from decimal import Decimal

    fake = FakePrices({k: Decimal(v) for k, v in (prices or XMPL_DOUBLED).items()})
    return daily.run_daily_check("worker", as_of=AS_OF, sources=sources(fake))


def plan_signals(pid: int, *, open_only: bool = True) -> dict[str, InvSignal]:
    with get_session() as s:
        rows = s.exec(
            select(InvSignal).where(
                InvSignal.profile_id == pid, InvSignal.dedup_key.startswith("plan:")
            )
        ).all()
        for r in rows:
            s.expunge(r)
    return {r.dedup_key: r for r in rows if not open_only or r.status in ("active", "acknowledged")}


def add_note(pid: int, iid: int, relation: str, *, field: str | None = None) -> None:
    now = utcnow()
    with get_session() as s:
        s.add(
            InvResearchNote(
                profile_id=pid,
                instrument_id=iid,
                kind="news",
                polarity="neutral",
                strength=2,
                thesis_relation=relation,
                thesis_field=field,
                title=f"Example fact {relation}",
                summary="Przykladowy fakt ze zrodlem.",
                sources=[],
                observed_at=now - dt.timedelta(hours=1),
                expires_at=now + dt.timedelta(days=30),
                created_by="agent",
                created_at=now,
                updated_at=now,
                read_at=now,
            )
        )


def put_plan(client, base: str, iid: int, plan):
    return client.put(f"{base}/instruments/{iid}/plan", json={"plan": plan})


# --------------------------------------------------------------------------- #
# The plan write and its views
# --------------------------------------------------------------------------- #


def test_put_plan_values_null_and_errors(api):
    client, pid, base, _aid = api
    xmpl = instrument_id("XMPL")
    for value in ("buy_asap", "buy", "hold", "reduce", "exit_asap"):
        r = put_plan(client, base, xmpl, value)
        assert r.status_code == 200, r.text
        inst = r.json()["instrument"]
        assert inst["id"] == xmpl and inst["plan"] == value and inst["plan_at"].endswith("+00:00")
    cleared = put_plan(client, base, xmpl, None).json()["instrument"]
    assert cleared["plan"] is None and cleared["plan_at"] is None
    with get_session() as s:
        row = s.exec(
            select(InvProfileInstrument).where(InvProfileInstrument.instrument_id == xmpl)
        ).one()
        assert (row.profile_id, row.plan, row.plan_at) == (pid, None, None)

    bad = put_plan(client, base, xmpl, "sell")
    assert bad.status_code == 422 and "Unknown plan" in bad.json()["detail"]
    assert client.put(f"{base}/instruments/{xmpl}/plan", json={"plan": 3}).status_code == 422
    assert put_plan(client, base, 999_999, "hold").status_code == 404
    with get_session() as s:
        foreign = InvInstrument(
            name="Foreign Example", currency="USD", asset_class="equity", valuation_mode="market"
        )
        s.add(foreign)
        s.commit()
        foreign_id = foreign.id
    assert put_plan(client, base, foreign_id, "hold").status_code == 404

    # a watched (not held) instrument: buy / hold yes, reduce / exit_asap no
    watched = client.post(f"{base}/watchlist", json={"symbol_or_isin": "VWCE.DE"}).json()
    wid = watched["instrument"]["id"]
    for value in ("reduce", "exit_asap"):
        r = put_plan(client, base, wid, value)
        assert r.status_code == 422 and "held instrument" in r.json()["detail"]
    assert put_plan(client, base, wid, "buy").json()["instrument"]["plan"] == "buy"
    row = next(i for i in client.get(f"{base}/watchlist").json() if i["instrument_id"] == wid)
    assert row["instrument"]["plan"] == "buy" and row["instrument"]["plan_at"]


def test_plan_in_every_instrument_view(api):
    client, _pid, base, _aid = api
    xmpl = instrument_id("XMPL")
    put_plan(client, base, xmpl, "hold")
    positions = client.get(f"{base}/positions").json()["positions"]
    by_label = {p["instrument"]["label"]: p["instrument"] for p in positions}
    assert by_label["XMPL"]["plan"] == "hold" and by_label["XMPL"]["plan_at"]
    assert by_label["ABC"]["plan"] is None and by_label["ABC"]["plan_at"] is None
    detail = client.get(f"{base}/positions/{xmpl}").json()
    assert detail["instrument"]["plan"] == "hold"
    assert detail["position"]["instrument"]["plan"] == "hold"
    listed = {i["label"]: i for i in client.get(f"{base}/instruments").json()}
    assert listed["XMPL"]["plan"] == "hold" and listed["ABC"]["plan"] is None
    classified = client.patch(f"{base}/instruments/{xmpl}", json={"tags": ["us"]}).json()
    assert classified["plan"] == "hold"  # a classification keeps the plan


def test_stale_reduce_plan_of_a_sold_position_is_emitted_null(api):
    client, _pid, base, aid = api
    abc = instrument_id("ABC")
    assert put_plan(client, base, abc, "reduce").json()["instrument"]["plan"] == "reduce"
    sold = client.post(
        f"{base}/transactions",
        json={
            "account_id": aid,
            "type": "sell",
            "trade_date": "2026-02-20",
            "instrument_id": abc,
            "quantity": 100,
            "price": 60,
        },
    )
    assert sold.status_code == 201, sold.text
    assert "ABC" not in {
        p["instrument"]["label"] for p in client.get(f"{base}/positions").json()["positions"]
    }
    listed = {i["label"]: i for i in client.get(f"{base}/instruments").json()}
    assert listed["ABC"]["plan"] is None and listed["ABC"]["plan_at"] is None
    detail = client.get(f"{base}/positions/{abc}").json()
    assert detail["position"] is None and detail["instrument"]["plan"] is None
    # the stored plan stays (the history); a hold plan is not held-only and is still emitted
    with get_session() as s:
        assert (
            s.exec(
                select(InvProfileInstrument.plan).where(InvProfileInstrument.instrument_id == abc)
            ).one()
            == "reduce"
        )
    assert put_plan(client, base, abc, "reduce").status_code == 422
    assert put_plan(client, base, abc, "hold").json()["instrument"]["plan"] == "hold"


def test_plan_is_per_profile(api):
    client, _pid, base, _aid = api
    _pid_b, slug_b, _aid_b = setup_investor("Druga")
    base_b = f"/api/p/{slug_b}/investments"
    xmpl = instrument_id("XMPL")
    put_plan(client, base, xmpl, "buy_asap")
    other = {
        p["instrument"]["label"]: p for p in client.get(f"{base_b}/positions").json()["positions"]
    }
    assert other["XMPL"]["instrument"]["plan"] is None
    put_plan(client, base_b, xmpl, "exit_asap")
    mine = {
        p["instrument"]["label"]: p for p in client.get(f"{base}/positions").json()["positions"]
    }
    assert mine["XMPL"]["instrument"]["plan"] == "buy_asap"


# --------------------------------------------------------------------------- #
# Plan checks in the daily run and right after a write
# --------------------------------------------------------------------------- #


def test_gain_without_exit_plan_fires_and_resolves_when_the_exit_plan_is_written(api):
    client, pid, base, _aid = api
    xmpl = instrument_id("XMPL")
    report = run()
    assert report.profiles[0].stats["plan_checked"] == 3
    key = f"plan:plan_no_exit|i:{xmpl}"
    found = plan_signals(pid)
    assert list(found) == [key]  # ABC +20 %, WRLD +10 %: below the threshold
    sig = found[key]
    assert (sig.rule_id, sig.kind, sig.severity, sig.polarity) == (
        "plan:plan_no_exit",
        "plan:plan_no_exit",
        "info",
        "negative",
    )
    assert sig.message == "+100 % od kosztu, brak planu wyjścia"
    assert sig.payload == {
        "check": "plan_no_exit",
        "plan": None,
        "health": "no_thesis",
        "has_exit_plan": False,
        "unrealized": 1.0,
        "symbol": "XMPL",
        "trigger": "gain",
        "threshold": 1.0,
    }
    listed = next(s for s in client.get(f"{base}/signals").json() if s["id"] == sig.id)
    assert listed["source"] == "plan" and listed["instrument_id"] == xmpl
    assert "plan:plan_no_exit" in {x["rule_id"] for x in report.profiles[0].new_signals}

    run()  # idempotent: refreshed, nothing new
    assert len(plan_signals(pid, open_only=False)) == 1

    # a thesis without an exit plan changes nothing; writing the exit plan resolves it at once
    created = client.post(
        f"{base}/instruments/{xmpl}/theses",
        json={"entry_type": "trend", "thesis": "Przykladowa teza"},
    ).json()
    assert key in plan_signals(pid)
    client.patch(f"{base}/theses/{created['id']}", json={"exit_plan": "Sprzedaz po premierze"})
    assert key not in plan_signals(pid)
    assert plan_signals(pid, open_only=False)[key].status == "resolved"
    run()
    assert plan_signals(pid) == {}


def test_a_reduce_plan_resolves_the_gain_signal_at_once(api):
    client, pid, base, _aid = api
    xmpl = instrument_id("XMPL")
    run()
    key = f"plan:plan_no_exit|i:{xmpl}"
    assert key in plan_signals(pid)
    put_plan(client, base, xmpl, "reduce")
    assert key not in plan_signals(pid)
    run()
    assert key not in plan_signals(pid)


def test_buy_plan_on_a_weakened_then_invalidated_thesis(api):
    client, pid, base, _aid = api
    abc = instrument_id("ABC")
    client.post(
        f"{base}/instruments/{abc}/theses",
        json={"entry_type": "trend", "thesis": "Przykladowa teza", "exit_plan": "Koniec 2028"},
    )
    put_plan(client, base, abc, "buy")
    add_note(pid, abc, "weakens", field="thesis")
    run()
    key = f"plan:plan_vs_thesis|i:{abc}"
    sig = plan_signals(pid)[key]
    assert (sig.severity, sig.message) == ("info", "Rekomendacja: dokup, teza osłabiona")
    assert sig.payload["plan"] == "buy" and sig.payload["health"] == "weakened"

    add_note(pid, abc, "invalidates", field="invalidation")
    report = run()
    sig = plan_signals(pid)[key]
    assert (sig.severity, sig.message) == ("action", "Rekomendacja: dokup, teza podważona")
    assert [x["rule_id"] for x in report.profiles[0].escalated_signals] == ["plan:plan_vs_thesis"]

    # the owner changes the plan: resolved right after the write
    put_plan(client, base, abc, "hold")
    assert key not in plan_signals(pid)


def test_fulfilled_thesis_without_exit_plan(api):
    client, pid, base, _aid = api
    wrld = instrument_id("WRLD")
    client.post(
        f"{base}/instruments/{wrld}/theses",
        json={"entry_type": "sentiment_correction", "thesis": "Przykladowa teza"},
    )
    add_note(pid, wrld, "fulfills", field="thesis")
    summary = client.get(f"{base}/research/summary").json()
    row = next(i for i in summary["instruments"] if i["instrument_id"] == wrld)
    assert row["health"] == "fulfilled" and row["counts"]["fulfills"] == 1
    run()
    sig = plan_signals(pid)[f"plan:plan_no_exit|i:{wrld}"]
    assert sig.message == "Teza spełniona, brak planu wyjścia"
    assert sig.payload["trigger"] == "fulfilled" and sig.payload["health"] == "fulfilled"


def test_a_sold_position_resolves_its_plan_signals_in_the_run(api):
    client, pid, base, aid = api
    xmpl = instrument_id("XMPL")
    run()
    assert f"plan:plan_no_exit|i:{xmpl}" in plan_signals(pid)
    client.post(
        f"{base}/transactions",
        json={
            "account_id": aid,
            "type": "sell",
            "trade_date": "2026-02-27",
            "instrument_id": xmpl,
            "quantity": 20,
            "price": 200,
            "currency": "USD",
            "cash_currency": "PLN",
            "fx_rate": 4,
        },
    )
    run()
    assert plan_signals(pid) == {}


# --------------------------------------------------------------------------- #
# MCP: model recommendation
# --------------------------------------------------------------------------- #


def test_mcp_positions_watchlist_and_theses_carry_the_recommendation(api):
    client, pid, base, _aid = api
    xmpl = instrument_id("XMPL")
    put_plan(client, base, xmpl, "hold")
    watched = client.post(f"{base}/watchlist", json={"symbol_or_isin": "VWCE.DE"}).json()
    put_plan(client, base, watched["instrument"]["id"], "buy_asap")
    client.post(
        f"{base}/instruments/{xmpl}/theses",
        json={"entry_type": "trend", "thesis": "Przykladowa teza"},
    )
    mcp = FinanseMcp(pid, today=AS_OF)
    positions = mcp.call("positions")
    assert positions.ok, positions.error
    recommendations = {r["symbol"]: r["recommendation"] for r in positions.data["positions"]}
    assert recommendations == {"XMPL": "hold", "ABC": None, "WRLD": None}
    items = mcp.call("watchlist").data["items"]
    assert [i["recommendation"] for i in items] == ["buy_asap"]
    theses = mcp.call("theses").data["theses"]
    assert [t["recommendation"] for t in theses] == ["hold"]
    assert "set_recommendation" in mcp._tools


def test_mcp_model_sets_recommendation_without_recording_a_decision(api):
    _client, pid, _base, _aid = api
    mcp = FinanseMcp(pid, today=AS_OF)
    before = mcp.call("positions").data["positions"]
    result = mcp.call(
        "set_recommendation",
        {
            "instrument": "XMPL",
            "recommendation": "reduce",
            "reason": "Pozycja wymaga ograniczenia ryzyka po przeglądzie tezy.",
        },
    )
    assert result.ok, result.error
    assert result.data["recommendation"] == "reduce"
    after = mcp.call("positions").data["positions"]
    assert next(r for r in after if r["symbol"] == "XMPL")["recommendation"] == "reduce"
    assert next(r for r in before if r["symbol"] == "XMPL")["recommendation"] is None
    with get_session() as s:
        assert s.exec(select(InvDecision).where(InvDecision.profile_id == pid)).all() == []


def test_mcp_recommendation_reason_is_shown_and_cleared_with_the_plan(api):
    client, pid, base, _aid = api
    mcp = FinanseMcp(pid, today=AS_OF)
    result = mcp.call(
        "set_recommendation",
        {
            "instrument": "XMPL",
            "recommendation": "hold",
            "reason": "  Teza  wzmocniona,\n brak sygnałów. ",
        },
    )
    assert result.ok, result.error
    xmpl = instrument_id("XMPL")
    detail = client.get(f"{base}/positions/{xmpl}").json()
    assert detail["instrument"]["plan"] == "hold"
    assert detail["instrument"]["plan_reason"] == "Teza wzmocniona, brak sygnałów."
    too_long = mcp.call(
        "set_recommendation", {"instrument": "XMPL", "recommendation": "hold", "reason": "x" * 281}
    )
    assert not too_long.ok
    # The legacy app route can still write without a reason and then drops the old reason.
    put_plan(client, base, xmpl, "buy")
    assert client.get(f"{base}/positions/{xmpl}").json()["instrument"]["plan_reason"] is None


# --------------------------------------------------------------------------- #
# Review fixes (P1-review-be BE-1..BE-7)
# --------------------------------------------------------------------------- #

TODAY = dt.date.today()  # noqa: DTZ011 - the write-time re-evaluation values the portfolio as of today


def run_today(prices: dict | None = None) -> daily.DailyCheckReport:
    """A run with bars up to today, so the re-evaluation after a write sees fresh prices."""
    from decimal import Decimal

    fake = FakePrices({k: Decimal(v) for k, v in (prices or XMPL_DOUBLED).items()})
    return daily.run_daily_check("worker", as_of=TODAY, sources=sources(fake))


def set_plan_at(iid: int, moment: dt.datetime) -> None:
    with get_session() as s:
        row = s.exec(
            select(InvProfileInstrument).where(InvProfileInstrument.instrument_id == iid)
        ).one()
        row.plan_at = moment
        s.add(row)


def test_put_plan_needs_the_plan_key(api):
    """BE-4: a body without ``plan`` is a 422, never a silent clear; an explicit null clears."""
    client, _pid, base, _aid = api
    xmpl = instrument_id("XMPL")
    put_plan(client, base, xmpl, "hold")
    for body in ({}, {"plna": "buy"}):
        r = client.put(f"{base}/instruments/{xmpl}/plan", json=body)
        assert r.status_code == 422, body
    listed = {i["label"]: i for i in client.get(f"{base}/instruments").json()}
    assert listed["XMPL"]["plan"] == "hold"
    assert put_plan(client, base, xmpl, None).json()["instrument"]["plan"] is None


def test_a_reduce_plan_from_before_a_rebuy_is_stale(api):
    """BE-2: sold out after a reduce plan and bought again: the old plan is not shown and the checks
    treat it as no plan (+100 % on the new lot fires plan_no_exit); the stored value stays."""
    client, pid, base, aid = api
    abc, xmpl = instrument_id("ABC"), instrument_id("XMPL")
    put_plan(client, base, abc, "reduce")
    put_plan(client, base, xmpl, "reduce")
    plan_moment = dt.datetime(2026, 2, 1, 12, 0, tzinfo=dt.UTC)
    set_plan_at(abc, plan_moment)
    set_plan_at(xmpl, plan_moment)  # XMPL's lot (2026-01-14) predates the plan: still current
    for body in (
        {"type": "sell", "trade_date": "2026-02-10", "quantity": 100, "price": 55},
        {"type": "buy", "trade_date": "2026-02-15", "quantity": 100, "price": 30},
    ):
        r = client.post(
            f"{base}/transactions", json={"account_id": aid, "instrument_id": abc, **body}
        )
        assert r.status_code == 201, r.text
    positions = {
        p["instrument"]["label"]: p for p in client.get(f"{base}/positions").json()["positions"]
    }
    assert positions["ABC"]["instrument"]["plan"] is None
    assert positions["XMPL"]["instrument"]["plan"] == "reduce"
    listed = {i["label"]: i for i in client.get(f"{base}/instruments").json()}
    assert listed["ABC"]["plan"] is None and listed["XMPL"]["plan"] == "reduce"
    assert client.get(f"{base}/positions/{abc}").json()["instrument"]["plan"] is None
    with get_session() as s:
        stored = s.exec(
            select(InvProfileInstrument.plan).where(InvProfileInstrument.instrument_id == abc)
        ).one()
    assert stored == "reduce"  # hidden, never silently cleared

    run()  # ABC: 60 vs 30 = +100 % on the new lot; XMPL +100 % but a current reduce plan
    found = plan_signals(pid)
    assert list(found) == [f"plan:plan_no_exit|i:{abc}"]
    assert found[f"plan:plan_no_exit|i:{abc}"].payload["plan"] is None

    # a plan written again after the re-buy is current
    put_plan(client, base, abc, "reduce")
    positions = {
        p["instrument"]["label"]: p for p in client.get(f"{base}/positions").json()["positions"]
    }
    assert positions["ABC"]["instrument"]["plan"] == "reduce"


def test_a_partial_fifo_sell_after_a_reduce_plan_keeps_the_plan(api):
    """Review follow-up: the plan follows the position, not its lots. A partial sell that consumes
    every lot older than the plan (FIFO) never brought the quantity to 0: the plan stays."""
    client, pid, base, aid = api
    abc = instrument_id("ABC")
    put_plan(client, base, abc, "reduce")
    set_plan_at(abc, dt.datetime(2026, 2, 1, 12, 0, tzinfo=dt.UTC))
    for body in (
        {"type": "buy", "trade_date": "2026-02-05", "quantity": 50, "price": 30},
        {"type": "sell", "trade_date": "2026-02-10", "quantity": 100, "price": 55},
    ):
        r = client.post(
            f"{base}/transactions", json={"account_id": aid, "instrument_id": abc, **body}
        )
        assert r.status_code == 201, r.text
    position = next(
        p
        for p in client.get(f"{base}/positions").json()["positions"]
        if p["instrument"]["id"] == abc
    )
    assert [lot["open_date"] for lot in position["lots"]] == ["2026-02-05"]  # pre-plan lot gone
    assert position["instrument"]["plan"] == "reduce"
    listed = {i["label"]: i for i in client.get(f"{base}/instruments").json()}
    assert listed["ABC"]["plan"] == "reduce"
    assert client.get(f"{base}/positions/{abc}").json()["instrument"]["plan"] == "reduce"
    # the checks see the plan too: ABC is at +100 % on the remaining lot, yet no plan_no_exit
    run()
    assert f"plan:plan_no_exit|i:{abc}" not in plan_signals(pid)


def test_mcp_theses_hide_a_stale_reduce_recommendation(api):
    client, pid, base, _aid = api
    abc = instrument_id("ABC")
    client.post(
        f"{base}/instruments/{abc}/theses", json={"entry_type": "trend", "thesis": "Przykladowa"}
    )
    put_plan(client, base, abc, "reduce")
    assert [
        t["recommendation"] for t in FinanseMcp(pid, today=AS_OF).call("theses").data["theses"]
    ] == ["reduce"]
    set_plan_at(abc, dt.datetime(2026, 1, 1, tzinfo=dt.UTC))  # before the lot of 2026-01-07
    assert [
        t["recommendation"] for t in FinanseMcp(pid, today=AS_OF).call("theses").data["theses"]
    ] == [None]


def test_a_failing_plan_pass_leaves_the_run_partial_not_failed(api, monkeypatch):
    """BE-1: the plan pass rolls back to its savepoint; strategy and alert work of the run stays."""
    from finanse.modules.investments.service import plans

    _client, pid, _base, _aid = api
    real = plans.evaluate_profile

    def broken(*args, **kwargs):
        real(*args, **kwargs)  # writes its signals, then fails
        raise RuntimeError("example failure")

    monkeypatch.setattr(plans, "evaluate_profile", broken)
    report = run()
    outcome = report.profiles[0]
    assert outcome.status == "partial"
    assert any(e.startswith("plan checks failed: RuntimeError") for e in outcome.errors)
    assert plan_signals(pid, open_only=False) == {}  # rolled back
    with get_session() as s:
        strategy = s.exec(
            select(InvSignal).where(
                InvSignal.profile_id == pid, InvSignal.rule_id == "concentration"
            )
        ).all()
    assert strategy  # the strategy rule pass of the same transaction stands
    monkeypatch.setattr(plans, "evaluate_profile", real)
    assert run().profiles[0].status == "ok" and plan_signals(pid)


def test_a_failing_re_evaluation_keeps_the_plan_and_thesis_writes(api, monkeypatch):
    """BE-7 / BE-3: a failure computing or writing the plan signals after a write is logged; the
    plan / thesis write itself stands (the signal write runs in a savepoint after the flush)."""
    from finanse.modules.investments.service import plans

    client, pid, base, _aid = api
    xmpl = instrument_id("XMPL")

    def boom(*args, **kwargs):
        raise RuntimeError("example failure")

    real_facts, real_apply = plans.facts, plans.signals.apply_reconciliation
    monkeypatch.setattr(plans, "facts", boom)  # compute phase
    assert put_plan(client, base, xmpl, "hold").status_code == 200
    monkeypatch.setattr(plans, "facts", real_facts)
    monkeypatch.setattr(plans.signals, "apply_reconciliation", boom)  # write phase (savepoint)
    assert put_plan(client, base, xmpl, "buy").status_code == 200
    created = client.post(
        f"{base}/instruments/{xmpl}/theses",
        json={"entry_type": "trend", "thesis": "Przykladowa teza"},
    )
    assert created.status_code == 201
    monkeypatch.setattr(plans.signals, "apply_reconciliation", real_apply)
    listed = {i["label"]: i for i in client.get(f"{base}/instruments").json()}
    assert listed["XMPL"]["plan"] == "buy"
    assert [t["thesis"] for t in client.get(f"{base}/instruments/{xmpl}/theses").json()] == [
        "Przykladowa teza"
    ]
    assert plan_signals(pid) == {}


def test_isolated_opens_a_savepoint_only_inside_a_driver_transaction(api):
    """BE-3: no SAVEPOINT before the first write (pysqlite would make it the outermost transaction)."""
    from finanse.modules.investments.service import plans

    _client, pid, _base, _aid = api
    with get_session() as s:
        with plans.isolated(s) as savepoint:
            assert savepoint is False
        s.add(InvProfileInstrument(profile_id=pid, instrument_id=instrument_id("ABC"), plan="hold"))
        s.flush()
        with plans.isolated(s) as savepoint:
            assert savepoint is True
        s.rollback()
    with get_session() as s:
        assert s.exec(select(InvProfileInstrument)).all() == []


def test_thesis_delete_and_mcp_upsert_re_evaluate(api):
    """BE-7: deleting the thesis (its exit plan with it) fires plan_no_exit at once; writing an exit
    plan through MCP ``upsert_thesis`` resolves it at once."""
    client, pid, base, _aid = api
    xmpl = instrument_id("XMPL")
    key = f"plan:plan_no_exit|i:{xmpl}"
    thesis = client.post(
        f"{base}/instruments/{xmpl}/theses",
        json={"entry_type": "trend", "thesis": "Przykladowa teza", "exit_plan": "Koniec 2028"},
    ).json()
    run_today()
    assert key not in plan_signals(pid)
    client.delete(f"{base}/theses/{thesis['id']}")
    assert key in plan_signals(pid)

    mcp = FinanseMcp(pid, today=TODAY)
    done = mcp.call(
        "upsert_thesis",
        {
            "instrument": "XMPL",
            "entry_type": "trend",
            "thesis": "Przykladowa teza",
            "exit_plan": "Sprzedaz po premierze",
        },
    )
    assert done.ok, done.error
    assert key not in plan_signals(pid)


def test_mcp_recommendation_is_the_same_in_strict_and_full(api):
    """BE-7: a recommendation is not an amount: identical in strict and amounts mode."""
    from finanse.core.models import Profile

    client, pid, base, _aid = api
    put_plan(client, base, instrument_id("XMPL"), "buy")

    def plans_in(level: str) -> tuple:
        with get_session() as s:
            p = s.get(Profile, pid)
            p.mcp_privacy = level
            s.add(p)
        mcp = FinanseMcp(pid, today=AS_OF)
        rows = mcp.call("positions").data["positions"]
        return tuple(sorted((r["instrument_id"], r["recommendation"]) for r in rows))

    strict, full = plans_in("strict"), plans_in("amounts")
    assert strict == full and (instrument_id("XMPL"), "buy") in strict
