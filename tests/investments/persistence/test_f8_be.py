"""F8 backend (home v3): signal freshness (``current``, the ``max_unverified_days`` expiry, alerts
re-armed and ``last_checked_at`` only on real checks), unread research notes (``read_at``, the
``POST research/read`` mark, counts on notes / summary / positions / watchlist, profile isolation) and
the new alert kinds through the API (catalog, ``state``, signals) and MCP strict mode. Synthetic data
and fake sources only."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from invp_support import (
    AS_OF,
    PRICES,
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
from finanse.core.models import Profile, utcnow
from finanse.modules.investments.market import SourceException
from finanse.modules.investments.models import (
    InvAlert,
    InvInstrument,
    InvPriceBar,
    InvResearchNote,
    InvSignal,
)
from finanse.modules.investments.research import service as research
from finanse.modules.investments.research.validation import validate_note
from finanse.modules.investments.service import alerts as alert_service
from finanse.modules.investments.service import daily, files, views
from finanse.modules.investments.service import watchlist as watch_service

T0 = dt.datetime(2026, 3, 2, 8, 0, tzinfo=dt.UTC)
CONC_XMPL = "concentration"


def setup_investor() -> tuple[int, str]:
    pid, slug = make_profile()
    aid = add_account(pid)
    import_file(pid, aid, canonical_csv())
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML)
    return pid, slug


@pytest.fixture
def investor(db_engine):
    return setup_investor()


@pytest.fixture
def api_investor(api_empty):
    pid, slug = setup_investor()
    return api_empty, pid, slug


def instrument_id(symbol: str) -> int:
    with get_session() as s:
        return s.exec(select(InvInstrument.id).where(InvInstrument.symbol == symbol)).one()


def create_alert(pid: int, kind: str, params: dict, *, symbol: str = "XMPL", **kw) -> int:
    with get_session() as s:
        row = alert_service.create(
            s,
            s.get(Profile, pid),
            alert_service.AlertInput(
                kind=kind,
                title=kw.pop("title", f"{kind} test"),
                params=params,
                instrument_id=instrument_id(symbol),
                **kw,
            ),
            now=T0,
        )
        return row.id


class _NoXmpl(FakePrices):
    """The source fails for XMPL (its stored close goes stale), the rest refreshes."""

    def fetch(self, instrument, start, end):
        if instrument.alias("yahoo") == "XMPL":
            raise SourceException("yahoo", "HTTP 500 for XMPL")
        return super().fetch(instrument, start, end)


def run(pid: int, days: int = 0, *, stale_xmpl: bool = False):
    fake = _NoXmpl(PRICES) if stale_xmpl else FakePrices(PRICES)
    report = daily.run_daily_check(
        "worker",
        profile_ids=[pid],
        as_of=AS_OF + dt.timedelta(days=days),
        sources=sources(fake),
        clock=lambda: T0 + dt.timedelta(days=days),
    )
    (profile_run,) = report.profiles
    return profile_run


def signal_rows(pid: int, rule_id: str) -> list[InvSignal]:
    with get_session() as s:
        return list(
            s.exec(
                select(InvSignal)
                .where(InvSignal.profile_id == pid, InvSignal.rule_id == rule_id)
                .order_by(InvSignal.id)
            ).all()
        )


def xmpl_conc(pid: int) -> list[InvSignal]:
    xmpl = instrument_id("XMPL")
    return [r for r in signal_rows(pid, CONC_XMPL) if r.instrument_id == xmpl]


def signals_view(pid: int) -> dict[int, dict]:
    with get_session() as s:
        return {r["id"]: r for r in views.signals_view(s, s.get(Profile, pid), "all")}


# --- signal freshness -----------------------------------------------------------------------------


def test_unverified_signals_expire_without_a_cooldown_and_rearm_the_alert(investor):
    pid, _ = investor
    aid = create_alert(pid, "price_above", {"level": 90}, cooldown_days=30)
    assert run(pid).status == "ok"
    (conc,) = xmpl_conc(pid)
    (alert_sig,) = signal_rows(pid, f"alert:{aid}")
    assert conc.status == alert_sig.status == "active"
    with get_session() as s:
        checked = s.get(InvAlert, aid).last_checked_at
    assert signals_view(pid)[conc.id]["current"] is True

    # XMPL prices stop: its rule scope and its alert are skipped, nothing is confirmed
    partial = run(pid, 10, stale_xmpl=True)
    assert partial.status == "partial"
    assert [r.status for r in xmpl_conc(pid)] == ["active"]
    rows = signals_view(pid)
    assert rows[conc.id]["current"] is False and rows[alert_sig.id]["current"] is False
    with get_session() as s:
        row = s.get(InvAlert, aid)
        assert row.status == "triggered" and row.last_checked_at == checked  # a skip is no check
        overview = views.overview(s, s.get(Profile, pid))
    attention = {i["signal_id"]: i for i in overview["attention"]}
    assert attention[conc.id]["current"] is False

    # past max_unverified_days (default 14): both close as expired, reason unverified
    run(pid, 15, stale_xmpl=True)
    (closed,) = xmpl_conc(pid)
    (closed_alert,) = signal_rows(pid, f"alert:{aid}")
    for sig in (closed, closed_alert):
        assert sig.status == "expired"
        assert sig.payload["closed_reason"] == sig.payload["closed_by"] == "unverified"
    assert closed.last_run_id == conc.last_run_id  # the last run that confirmed it
    with get_session() as s:
        row = s.get(InvAlert, aid)
        assert row.status == "active" and row.last_checked_at == checked

    # prices back: both fire again at once (an unverified close starts no cooldown)
    run(pid, 16)
    assert [r.status for r in xmpl_conc(pid)] == ["expired", "active"]
    assert [r.status for r in signal_rows(pid, f"alert:{aid}")] == ["expired", "active"]
    with get_session() as s:
        row = s.get(InvAlert, aid)
        assert row.status == "triggered" and row.last_checked_at > checked
    new = xmpl_conc(pid)[-1]
    assert signals_view(pid)[new.id]["current"] is True


def test_max_unverified_days_null_keeps_unverified_signals_open(investor):
    pid, slug = investor
    files.write_text_private(
        files.strategy_yaml_path(slug),
        STRATEGY_YAML.replace("  max_price_age_days: 5\n", "  max_price_age_days: 5\n  max_unverified_days: null\n"),
    )  # fmt: skip
    run(pid)
    run(pid, 30, stale_xmpl=True)
    assert [r.status for r in xmpl_conc(pid)] == ["active"]


def test_an_invalid_strategy_still_expires_unverified_rule_signals(investor):
    # F8 review BE-1: no rule runs under a broken strategy.yaml, so the age-based expiry (default limit)
    # closes the open rule signals like any other skipped check.
    pid, slug = investor
    run(pid)
    (conc,) = xmpl_conc(pid)
    files.write_text_private(files.strategy_yaml_path(slug), "version: [broken\n")
    run(pid, 10)
    assert [r.status for r in xmpl_conc(pid)] == ["active"]
    assert signals_view(pid)[conc.id]["current"] is False
    run(pid, 15)
    (closed,) = xmpl_conc(pid)
    assert closed.status == "expired"
    assert closed.payload["closed_reason"] == closed.payload["closed_by"] == "unverified"
    assert closed.last_run_id == conc.last_run_id


def test_a_failed_run_is_not_the_reference_for_current(investor):
    pid, _ = investor
    run(pid)
    (conc,) = xmpl_conc(pid)
    with get_session() as s:
        from finanse.modules.investments.models import InvRuleRun

        s.add(
            InvRuleRun(
                profile_id=pid,
                trigger="worker",
                as_of=AS_OF,
                status="failed",
                started_at=T0 + dt.timedelta(hours=1),
                finished_at=T0 + dt.timedelta(hours=1),
            )
        )
    assert signals_view(pid)[conc.id]["current"] is True


def test_signal_action_answers_carry_current(api_investor):
    client, pid, slug = api_investor
    run(pid)
    run(pid, 10, stale_xmpl=True)
    (conc,) = xmpl_conc(pid)
    api = f"/api/p/{slug}/investments"
    listed = {r["id"]: r for r in client.get(f"{api}/signals").json()}
    assert listed[conc.id]["current"] is False
    acked = client.post(f"{api}/signals/{conc.id}/acknowledge", json={}).json()
    assert acked["signal"]["current"] is False
    assert client.get(f"{api}/overview").json()["attention"][0]["current"] in (True, False)


# --- unread research notes ----------------------------------------------------------------------


def add_note(pid: int, n: int, *, instrument: str | None = "XMPL", created_by="agent", **raw):
    data = {
        "kind": "news",
        "polarity": "negative",
        "strength": 2,
        "title": f"Example fact {n}",
        "summary": "Przykladowy fakt ze zrodla, opisany neutralnie.",
        "sources": [
            {
                "url": f"https://example.com/f8/{n}",
                "publisher": "Example News",
                "published_at": utcnow().date().isoformat(),
            }
        ],
        **raw,
    }
    with get_session() as s:
        p = s.get(Profile, pid)
        ref = research.resolve_reference(s, pid, instrument) if instrument else None
        return research.add_note(
            s, p, validate_note(data, now=utcnow()), instrument_id=ref, created_by=created_by
        ).note.id


def test_unread_counts_and_marking_read(api_investor):
    client, pid, slug = api_investor
    api = f"/api/p/{slug}/investments"
    xmpl = instrument_id("XMPL")
    a1 = add_note(pid, 1)
    add_note(pid, 2)
    owner = add_note(pid, 3, created_by="user")
    theme_note = add_note(pid, 4, instrument=None, theme="Półprzewodniki")
    dismissed = add_note(pid, 5, instrument="ABC")
    client.patch(f"{api}/research/{dismissed}", json={"dismissed": True})

    notes = {n["id"]: n for n in client.get(f"{api}/research").json()}
    assert notes[a1]["unread"] is True and notes[a1]["read_at"] is None
    assert notes[owner]["unread"] is False and notes[owner]["read_at"] is not None
    summary = client.get(f"{api}/research/summary").json()
    assert summary["totals"]["notes_unread"] == 3  # two XMPL notes + the theme note
    by_inst = {i["instrument_id"]: i for i in summary["instruments"]}
    assert by_inst[xmpl]["unread"] == 2 and by_inst[instrument_id("ABC")]["unread"] == 0
    (theme,) = summary["themes"]
    assert theme["unread"] == 1
    positions = {
        p["instrument"]["id"]: p for p in client.get(f"{api}/positions").json()["positions"]
    }
    assert positions[xmpl]["research_unread"] == 2
    assert positions[instrument_id("ABC")]["research_unread"] == 0

    r = client.post(f"{api}/research/read", json={"instrument_id": xmpl})
    assert r.status_code == 200 and r.json() == {"marked": 2}
    assert client.post(f"{api}/research/read", json={"instrument_id": xmpl}).json() == {"marked": 0}
    assert client.post(f"{api}/research/read", json={"theme": "PÓŁPRZEWODNIKI"}).json() == {
        "marked": 1
    }
    notes = {n["id"]: n for n in client.get(f"{api}/research").json()}
    assert notes[a1]["unread"] is False and notes[a1]["read_at"] is not None
    assert notes[theme_note]["unread"] is False
    assert client.get(f"{api}/research/summary").json()["totals"]["notes_unread"] == 0
    with get_session() as s:
        assert s.get(InvResearchNote, owner).read_at is not None

    a6 = add_note(pid, 6)
    assert client.post(f"{api}/research/read", json={"ids": [a6, 999999]}).json() == {"marked": 1}


def test_watchlist_rows_carry_research_unread(investor):
    pid, _ = investor
    with get_session() as s:
        watched = watch_service.add(s, s.get(Profile, pid), "WATCH.DE").item.instrument_id
    add_note(pid, 1, instrument=str(watched))
    with get_session() as s:
        rows = views.watchlist_view(s, s.get(Profile, pid), as_of=AS_OF)
    assert next(r for r in rows if r["instrument_id"] == watched)["research_unread"] == 1


def test_notes_unread_counts_only_notes_the_app_can_clear(api_investor):
    # F8 review BE-2: a note on an instrument that is neither held nor watched (any more) has no view that
    # marks it read, so the strip's total leaves it out; the theme notes stay in.
    client, pid, slug = api_investor
    api = f"/api/p/{slug}/investments"
    with get_session() as s:
        item = watch_service.add(s, s.get(Profile, pid), "WATCH.DE").item
        watched, item_id = item.instrument_id, item.id
    add_note(pid, 1, instrument=str(watched))
    add_note(pid, 2, instrument=None, theme="Półprzewodniki")
    assert client.get(f"{api}/research/summary").json()["totals"]["notes_unread"] == 2
    with get_session() as s:
        watch_service.remove(s, s.get(Profile, pid), item_id)
    assert client.get(f"{api}/research/summary").json()["totals"]["notes_unread"] == 1


def test_research_read_validation_and_isolation(api_investor):
    client, pid, slug = api_investor
    api = f"/api/p/{slug}/investments"
    note_id = add_note(pid, 1)
    for body in ({}, {"instrument_id": 1, "theme": "x"}, {"ids": []}, {"theme": "  "}):
        r = client.post(f"{api}/research/read", json=body)
        assert r.status_code == 422, body
        assert r.headers.get("X-Finanse-Error-Code") == "research_invalid", body
    other_slug = client.post("/api/profiles", json={"name": "Inna", "modules": ["investments"]}).json()[
        "slug"
    ]  # fmt: skip
    other = f"/api/p/{other_slug}/investments"
    r = client.post(f"{other}/research/read", json={"instrument_id": instrument_id("XMPL")})
    assert r.status_code == 404 and r.headers["X-Finanse-Error-Code"] == "not_found"
    assert client.post(f"{other}/research/read", json={"ids": [note_id]}).json() == {"marked": 0}
    assert client.get(f"{api}/research").json()[0]["unread"] is True


# --- new alert kinds through the API and MCP ------------------------------------------------------


def _set_bars(symbol: str, closes: list[str], volumes: list[int] | None = None) -> None:
    """Replace the instrument's stored bars with ``closes`` ending on AS_OF (weekdays back)."""
    iid = instrument_id(symbol)
    days: list[dt.date] = []
    day = AS_OF
    while len(days) < len(closes):
        if day.weekday() < 5:
            days.append(day)
        day -= dt.timedelta(days=1)
    days.reverse()
    with get_session() as s:
        for bar in s.exec(select(InvPriceBar).where(InvPriceBar.instrument_id == iid)).all():
            s.delete(bar)
        s.flush()
        for i, (d, c) in enumerate(zip(days, closes, strict=True)):
            s.add(
                InvPriceBar(
                    instrument_id=iid,
                    date=d,
                    close=Decimal(c),
                    volume=None if volumes is None else volumes[i],
                    currency="USD",
                    source="yahoo",
                )
            )


def test_new_kinds_through_the_api(api_investor):
    client, pid, slug = api_investor
    api = f"/api/p/{slug}/investments"
    kinds = {k["kind"]: k for k in client.get(f"{api}/alert-kinds").json()["kinds"]}
    assert {"range_breakout", "volume_spike"} <= set(kinds)
    xmpl = instrument_id("XMPL")
    r = client.post(
        f"{api}/alerts",
        json={"kind": "range_breakout", "params": {"max_range_pct": 0.5}, "instrument_id": xmpl,
              "title": "XMPL wybicie"},
    )  # fmt: skip
    assert r.status_code == 422 and "max_range_pct" in r.text
    created = client.post(
        f"{api}/alerts",
        json={"kind": "range_breakout", "params": {"window_days": 10}, "instrument_id": xmpl,
              "title": "XMPL wybicie", "polarity": "positive"},
    )  # fmt: skip
    assert created.status_code == 201, created.text
    alert = created.json()
    assert alert["params"] == {"window_days": 10, "max_range_pct": 0.08, "direction": "any"}
    assert alert["unit"] == "price" and alert["state"] is None  # no bars yet
    volume = client.post(
        f"{api}/alerts",
        json={"kind": "volume_spike", "params": {"window_days": 5}, "instrument_id": xmpl,
              "title": "XMPL wolumen"},
    ).json()  # fmt: skip

    _set_bars("XMPL", ["10", "10.2", "10.4", "10.1", "10.3", "10", "10.2", "10.1", "10.3", "10.2",
                       "11"], [1000] * 10 + [3000])  # fmt: skip
    listed = {a["id"]: a for a in client.get(f"{api}/alerts").json()}
    state = listed[alert["id"]]["state"]
    assert (state["range_low"], state["range_high"], state["close"]) == (10.0, 10.4, 11.0)
    assert state["window_days"] == 10 and state["currency"] == "USD"
    assert listed[volume["id"]]["state"] == {
        "average_volume": 1000.0,
        "volume": 3000,
        "ratio": 3.0,
        "window_days": 5,
    }
    one = client.patch(f"{api}/alerts/{volume['id']}", json={"title": "XMPL wolumen 2"}).json()
    assert one["state"]["ratio"] == 3.0

    with get_session() as s:
        profile = s.get(Profile, pid)
        run_result = alert_service.evaluate_profile(
            s, profile, as_of=AS_OF, now=T0, ctx=None, config=None, run_id=None
        )
    assert run_result.stats["alerts_fired"] == 2
    sigs = {r["kind"]: r for r in client.get(f"{api}/signals").json()}
    breakout = sigs["alert:range_breakout"]
    assert breakout["message_code"] == "alert.range_breakout"
    assert breakout["payload"]["range_high"] == "10.4"
    assert breakout["payload"]["breakout_pct"] == pytest.approx(11 / 10.4 - 1)
    assert "wybicie z konsolidacji 10 sesji" in breakout["message"]
    spike = sigs["alert:volume_spike"]
    assert spike["message_params"]["ratio"] == 3.0
    assert "wolumen 3,0x średniej z 5 sesji" in spike["message"]
    alerts_now = {a["id"]: a for a in client.get(f"{api}/alerts").json()}
    assert alerts_now[alert["id"]]["status"] == "triggered"
    assert alerts_now[alert["id"]]["last_value"] == 11.0
    assert alerts_now[volume["id"]]["last_value"] == 3.0


def test_mcp_alert_tools_take_the_new_kinds_and_scrub_amounts(investor):
    from finanse.core.mcp.redaction import Redactor, leak_check
    from finanse.core.mcp.tools import alerts as mcp_alerts
    from finanse.core.mcp.tools import investments as mcp_inv

    pid, _ = investor
    _set_bars("XMPL", [*["10.5", "11.2", "10.8"] * 3, "10.9", "11.9"])
    with get_session() as s:
        from finanse.core.mcp.registry import ToolContext

        profile = s.get(Profile, pid)
        ctx = ToolContext(session=s, profile=profile, privacy="strict", today=AS_OF)
        made = mcp_alerts.add_alert(
            ctx,
            kind="range_breakout",
            params={"window_days": 10, "max_range_pct": 0.1},
            polarity="positive",
            severity="info",
            title="XMPL wybicie",
            instrument="XMPL",
        )
        assert made["alert"]["params"]["max_range_pct"].value == 0.1
        alert_service.evaluate_profile(
            s, profile, as_of=AS_OF, now=T0, ctx=None, config=None, run_id=None
        )
        redactor = Redactor("strict")
        listed = redactor.apply(mcp_alerts.alerts(ctx))
        signals = redactor.apply(mcp_inv.signals(ctx))
    leak_check(listed, strict=True)
    leak_check(signals, strict=True)
    (row,) = [a for a in listed["alerts"] if a["kind"] == "range_breakout"]
    assert row["state"]["range_high"] == 11.2  # a public price level, sent in strict mode
    assert row["status"] == "triggered" and row["signal"]["status"] == "active"
    message = row["signal"]["message"]
    assert "wybicie z konsolidacji 10 sesji" in message
    assert "11,9" not in message and "11,2" not in message  # amounts scrubbed in strict text
    (sig,) = [x for x in signals["signals"] if x["kind"] == "alert:range_breakout"]
    assert "11,9" not in sig["message"]
    # F8 review BE-3: the measured facts survive the strict redaction as fractions
    assert sig["threshold"] == 0.1 and sig["unit"] == "ratio"
    assert 0 < sig["measured"] <= 0.1 and 0 < sig["breakout"] < 0.1


def test_mcp_measures_the_volume_multiple():
    from finanse.core.mcp.redaction import Redactor
    from finanse.core.mcp.tools import investments as mcp_inv

    out = Redactor("strict").apply(
        mcp_inv._measure(None, "alert:volume_spike", {"ratio": 3.4, "multiple": 2.5})  # type: ignore[arg-type]
    )
    assert out == {"measured": 3.4, "threshold": 2.5, "unit": "multiple"}


def test_nearest_level_skips_a_breakout_whose_range_is_too_wide(investor):
    # F8 review BE-4: a range wider than max_range_pct cannot break out, so it names no level
    from finanse.modules.investments.store import instruments as instrument_store
    from finanse.modules.investments.store import market as market_store

    pid, _ = investor
    aid = create_alert(pid, "range_breakout", {"window_days": 10, "max_range_pct": 0.08})
    iid = instrument_id("XMPL")

    def nearest():
        with get_session() as s:
            inst = instrument_store.load(s, {iid}, profile_id=pid)[iid]
            bars = market_store.bars(s, {iid}, until=AS_OF, since=AS_OF - dt.timedelta(days=60))
            return views.nearest_alert([s.get(InvAlert, aid)], inst, tuple(bars[inst.id]), AS_OF)

    _set_bars("XMPL", [*["10", "12.5"] * 5, "11"])  # 25 % wide
    assert nearest() is None
    _set_bars("XMPL", [*["10.5", "11"] * 5, "10.9"])  # 4.8 % wide
    near = nearest()
    assert near is not None and near["alert_id"] == aid and Decimal(near["level"]) == Decimal(11)
