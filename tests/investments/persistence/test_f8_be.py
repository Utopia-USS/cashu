"""F8 backend (home v3): signal freshness (``current``, the ``max_unverified_days`` expiry, alerts
re-armed and ``last_checked_at`` only on real checks). Synthetic data and fake sources only."""

from __future__ import annotations

import datetime as dt

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
from finanse.core.models import Profile
from finanse.modules.investments.market import SourceException
from finanse.modules.investments.models import (
    InvAlert,
    InvInstrument,
    InvSignal,
)
from finanse.modules.investments.service import alerts as alert_service
from finanse.modules.investments.service import daily, files, views

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
