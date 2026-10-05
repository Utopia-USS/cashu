"""Alerts and the watchlist in the daily check (F5): alert signals with polarity / severity / dedup by
alert id, the lifecycle and notification policy, cooldown, expiry, snooze / mute / delete, alerts without
a strategy, watched instruments in the refresh, weights / buckets / custom conditions, polarity of rule
signals, the agent cap, and signal snooze ("Odłóż do"). Synthetic data and fake sources only."""

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
from finanse.modules.investments.alerts import AlertSource
from finanse.modules.investments.market import SourceException
from finanse.modules.investments.models import (
    InvAlert,
    InvInstrument,
    InvNotification,
    InvPriceBar,
    InvSignal,
)
from finanse.modules.investments.service import alerts as alert_service
from finanse.modules.investments.service import daily, files, views
from finanse.modules.investments.service import watchlist as watch_service
from finanse.modules.investments.store import signals as signal_store

T0 = dt.datetime(2026, 3, 2, 8, 0, tzinfo=dt.UTC)


@pytest.fixture
def investor(db_engine):
    pid, slug = make_profile()
    aid = add_account(pid)
    import_file(pid, aid, canonical_csv())
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML)
    return pid, slug


def instrument_id(symbol: str) -> int:
    with get_session() as s:
        return s.exec(select(InvInstrument.id).where(InvInstrument.symbol == symbol)).one()


def create(pid: int, kind: str, params: dict, *, symbol: str | None = "XMPL", now=T0, **kw) -> int:
    with get_session() as s:
        profile = s.get(Profile, pid)
        row = alert_service.create(
            s,
            profile,
            alert_service.AlertInput(
                kind=kind,
                title=kw.pop("title", f"{kind} test"),
                params=params,
                instrument_id=instrument_id(symbol) if symbol else None,
                **kw,
            ),
            now=now,
        )
        return row.id


def run(pid: int, *, at=T0, prices: dict | None = None, price_source=None, **kw):
    fake = price_source or FakePrices({**PRICES, **(prices or {})})
    report = daily.run_daily_check(
        "worker", profile_ids=[pid], as_of=AS_OF, sources=sources(fake), clock=lambda: at, **kw
    )
    (profile_run,) = report.profiles
    return profile_run


def alert_row(alert_id: int) -> InvAlert:
    with get_session() as s:
        return s.get(InvAlert, alert_id)


def alert_signals(pid: int, alert_id: int) -> list[InvSignal]:
    with get_session() as s:
        return list(
            s.exec(
                select(InvSignal)
                .where(InvSignal.profile_id == pid, InvSignal.rule_id == f"alert:{alert_id}")
                .order_by(InvSignal.id)
            ).all()
        )


def notifications(signal_id: int) -> list[InvNotification]:
    with get_session() as s:
        return list(
            s.exec(select(InvNotification).where(InvNotification.signal_id == signal_id)).all()
        )


def test_a_triggered_alert_becomes_a_signal_once(investor):
    pid, _slug = investor
    aid = create(
        pid,
        "price_above",
        {"level": 90},
        polarity="positive",
        severity="action",
        title="XMPL above 90",
    )
    first = run(pid)
    assert first.status == "ok" and first.stats["alerts"] == 1
    assert first.stats["alert_signals_new"] == 1 and first.stats["alerts_fired"] == 1
    (sig,) = alert_signals(pid, aid)
    assert (sig.kind, sig.dedup_key, sig.status) == ("alert:price_above", f"alert:{aid}", "active")
    assert (sig.polarity, sig.severity) == ("positive", "action")
    assert sig.message == f"XMPL above 90: XMPL closed at 100 USD on {AS_OF}, above 90 USD."
    assert sig.instrument_id == instrument_id("XMPL")
    assert len(notifications(sig.id)) == 1  # action: the default immediate policy
    assert any(x["rule_id"] == f"alert:{aid}" for x in first.new_signals)
    row = alert_row(aid)
    assert row.status == "triggered" and row.last_value == "100"
    assert row.last_triggered_at is not None and row.last_checked_at is not None
    triggered_at = row.last_triggered_at

    second = run(pid, at=T0 + dt.timedelta(hours=1))
    assert second.stats["alert_signals_new"] == 0
    assert [s.id for s in alert_signals(pid, aid)] == [sig.id]  # dedup by alert id
    assert len(notifications(sig.id)) == 1
    assert alert_row(aid).last_triggered_at == triggered_at
    # the strategy pass never expires alert signals
    assert alert_signals(pid, aid)[0].status == "active"


def test_info_alerts_follow_the_policy_without_immediate_notification(investor):
    pid, _ = investor
    aid = create(pid, "price_below", {"level": 150}, severity="info")
    run(pid)
    (sig,) = alert_signals(pid, aid)
    assert notifications(sig.id) == [] and sig.polarity == "neutral"


def test_resolution_rearm_and_cooldown(investor):
    pid, _ = investor
    aid = create(pid, "price_above", {"level": 90}, cooldown_days=7)
    run(pid)
    assert alert_row(aid).status == "triggered"
    run(pid, at=T0 + dt.timedelta(days=1), prices={"XMPL": Decimal(80)})
    (closed,) = alert_signals(pid, aid)
    assert closed.status == "resolved" and alert_row(aid).status == "active"
    third = run(pid, at=T0 + dt.timedelta(days=2), prices={"XMPL": Decimal(100)})
    assert third.stats["alert_signals_suppressed"] == 1
    assert len(alert_signals(pid, aid)) == 1 and alert_row(aid).status == "active"
    run(pid, at=T0 + dt.timedelta(days=9), prices={"XMPL": Decimal(100)})
    assert [s.status for s in alert_signals(pid, aid)] == ["resolved", "active"]
    assert alert_row(aid).status == "triggered"


def test_expiry_snooze_mute_and_delete(investor):
    pid, _ = investor
    expiring = create(pid, "price_above", {"level": 90}, expires_in_days=1, title="expiring")
    snoozed = create(pid, "price_above", {"level": 91}, title="snoozed")
    muted = create(pid, "price_above", {"level": 92}, title="muted")
    deleted = create(pid, "price_above", {"level": 93}, title="deleted")
    run(pid)
    assert all(alert_row(a).status == "triggered" for a in (expiring, snoozed, muted, deleted))
    with get_session() as s:
        profile = s.get(Profile, pid)
        alert_service.update(s, profile, snoozed, {"status": "snoozed", "snooze_days": 3}, now=T0)
        alert_service.mute(s, profile, muted, now=T0)
        alert_service.delete(s, profile, deleted, now=T0)
    # closed at once
    for a in (snoozed, muted, deleted):
        assert [x.status for x in alert_signals(pid, a)] == ["expired"], a
    checked = alert_row(muted).last_checked_at

    report = run(pid, at=T0 + dt.timedelta(days=2))
    assert report.stats["alerts_expired"] == 1 and report.stats["alerts"] == 0
    assert alert_row(expiring).status == "expired"
    assert [x.status for x in alert_signals(pid, expiring)] == ["expired"]
    assert alert_row(snoozed).status == "snoozed" and alert_row(muted).status == "muted"
    assert alert_row(muted).last_checked_at == checked  # never evaluated while muted
    assert alert_row(deleted).deleted_at is not None  # F6: a tombstone, never evaluated

    woke = run(pid, at=T0 + dt.timedelta(days=4))
    assert woke.stats["alerts_woken"] == 1
    assert alert_row(snoozed).status == "triggered"
    assert [x.status for x in alert_signals(pid, snoozed)] == ["expired", "active"]


def test_alerts_run_without_a_strategy(investor):
    pid, slug = investor
    files.strategy_yaml_path(slug).unlink()
    aid = create(pid, "price_above", {"level": 90}, severity="action")
    result = run(pid)
    assert result.status == "ok" and result.stats["rules"] == 0
    (sig,) = alert_signals(pid, aid)
    assert len(notifications(sig.id)) == 1  # the default policy


class _Failing(FakePrices):
    def fetch(self, instrument, start, end):
        if instrument.alias("yahoo") == "BAD.DE":
            raise SourceException("yahoo", "HTTP 500 for BAD.DE")
        return super().fetch(instrument, start, end)


def test_watched_instruments_join_the_refresh_and_carry_alerts(investor):
    pid, _ = investor
    with get_session() as s:
        profile = s.get(Profile, pid)
        watched = watch_service.add(s, profile, "WATCH.DE", note="idea").item.instrument_id
        watch_service.add(s, profile, "BAD.DE")
    aid = create(pid, "price_below", {"level": 60}, symbol="WATCH", title="WATCH under 60")
    fake = _Failing({**PRICES, "WATCH.DE": Decimal(50)})
    result = run(pid, price_source=fake)
    assert "WATCH.DE" in {c[0] for c in fake.calls}
    assert result.status == "ok"  # a watched instrument's fetch error is not a run error
    (error,) = result.stats["watched_price_errors"]
    assert error.startswith("prices BAD") and "HTTP 500" in error
    with get_session() as s:
        assert s.exec(select(InvPriceBar).where(InvPriceBar.instrument_id == watched)).first()
    (sig,) = alert_signals(pid, aid)
    assert sig.instrument_id == watched and "below 60 EUR" in sig.message
    with get_session() as s:
        rows = views.watchlist_view(s, s.get(Profile, pid), as_of=AS_OF)
    row = next(r for r in rows if r["instrument_id"] == watched)
    assert row["held"] is False and row["price"]["close"] == 50.0 and row["price_source"]
    assert row["closes_30d"] and row["closes_30d"][-1] == {"date": AS_OF.isoformat(), "close": 50.0}
    assert row["alerts"]["count"] == 1 and row["alerts"]["triggered"] == 1
    assert row["alerts"]["nearest"]["distance_pct"] == pytest.approx(0.2)
    assert row["note"] == "idea" and row["instrument"]["needs_classification"] is True


def test_weight_bucket_and_custom_alerts(investor):
    pid, _ = investor
    heavy = create(pid, "weight_above", {"threshold": 0.3}, polarity="negative")
    light = create(pid, "weight_below", {"threshold": 0.95, "bucket": "stocks"}, symbol=None)
    cash = create(pid, "custom", {"expression": "cash_weight >= 10%"}, symbol=None)
    calm = create(pid, "custom", {"expression": "cash_weight >= 50%"}, symbol=None)
    run(pid)
    assert "XMPL is 37.3% of the portfolio (above 30.0%)." in alert_signals(pid, heavy)[0].message
    assert "Bucket stocks is 87.3% of the portfolio" in alert_signals(pid, light)[0].message
    assert alert_signals(pid, cash)[0].kind == "alert:custom"
    assert alert_signals(pid, calm) == [] and alert_row(calm).status == "active"


def test_bucket_alerts_need_a_strategy_bucket(investor):
    pid, _ = investor
    with pytest.raises(alert_service.AlertError, match='Unknown bucket "stoks"'):
        create(pid, "weight_below", {"threshold": 0.5, "bucket": "stoks"}, symbol=None)


def test_rule_signals_carry_their_polarity_and_follow_overrides(investor):
    pid, slug = investor
    run(pid)
    with get_session() as s:
        (sig,) = s.exec(select(InvSignal).where(InvSignal.rule_id == "concentration")).all()
        assert sig.polarity == "negative"
    files.write_text_private(
        files.strategy_yaml_path(slug),
        STRATEGY_YAML.replace("severity: action\n", "severity: action\n    polarity: positive\n"),
    )
    run(pid, at=T0 + dt.timedelta(hours=1))
    with get_session() as s:
        (sig,) = s.exec(select(InvSignal).where(InvSignal.rule_id == "concentration")).all()
        assert sig.polarity == "positive"


def test_agent_alert_cap(investor):
    pid, _ = investor
    with get_session() as s:
        profile = s.get(Profile, pid)
        ids = [
            alert_service.create(
                s,
                profile,
                alert_service.AlertInput(
                    kind="price_above",
                    title=f"a{i}",
                    params={"level": i + 1},
                    instrument_id=instrument_id("XMPL"),
                ),
                source=AlertSource.AGENT,
            ).id
            for i in range(alert_service.AGENT_ALERT_LIMIT)
        ]
        with pytest.raises(alert_service.AlertLimit, match="At most 50 active agent alerts"):
            alert_service.create(
                s,
                profile,
                alert_service.AlertInput(
                    kind="price_above",
                    title="x",
                    params={"level": 1},
                    instrument_id=instrument_id("XMPL"),
                ),
                source=AlertSource.AGENT,
            )
        # user alerts never count; a muted agent alert frees a slot
        alert_service.create(
            s,
            profile,
            alert_service.AlertInput(
                kind="price_above",
                title="u",
                params={"level": 1},
                instrument_id=instrument_id("XMPL"),
            ),
        )
        alert_service.mute(s, profile, ids[0])
        alert_service.create(
            s,
            profile,
            alert_service.AlertInput(
                kind="price_above",
                title="y",
                params={"level": 1},
                instrument_id=instrument_id("XMPL"),
            ),
            source=AlertSource.AGENT,
        )


def test_alert_instrument_must_belong_to_the_profile(investor):
    xmpl = instrument_id("XMPL")
    other, _ = make_profile("Druga osoba")
    data = alert_service.AlertInput(
        kind="price_above", title="x", params={"level": 1}, instrument_id=xmpl
    )
    with (
        get_session() as s,
        pytest.raises(alert_service.AlertNotFound, match="add it to the watchlist first"),
    ):
        alert_service.create(s, s.get(Profile, other), data)


def test_signal_snooze_hides_and_wakes(investor):
    pid, _ = investor
    run(pid)
    with get_session() as s:
        (sig,) = s.exec(select(InvSignal).where(InvSignal.rule_id == "concentration")).all()
        signal_id = sig.id
    assert len(notifications(signal_id)) == 1  # pending (never sent: no worker in this test)
    with get_session() as s:
        row = s.get(InvSignal, signal_id)
        signal_store.snooze(s, row, utcnow() + dt.timedelta(days=1))
    assert notifications(signal_id) == []  # the pending entry is dropped
    with get_session() as s:
        overview = views.overview(s, s.get(Profile, pid))
    assert all(a["signal_id"] != signal_id for a in overview["attention"])
    assert overview["attention_snoozed"] == 1
    with get_session() as s:
        listed = views.signals_view(s, s.get(Profile, pid))
    assert listed[-1]["id"] == signal_id and listed[-1]["snoozed"] is True

    # still snoozed one hour later: refreshed by the run, not notified
    run(pid, at=utcnow() + dt.timedelta(hours=1))
    assert notifications(signal_id) == []
    woke = run(pid, at=utcnow() + dt.timedelta(days=2))
    assert woke.stats["signals_woken"] == 1
    with get_session() as s:
        row = s.get(InvSignal, signal_id)
        assert row.snoozed_until is None and row.status == "active"
    assert len(notifications(signal_id)) == 1


def test_the_watchlist_is_bounded(investor, monkeypatch):
    pid, _ = investor
    monkeypatch.setattr(watch_service, "MAX_ITEMS", 2)
    with get_session() as s:
        profile = s.get(Profile, pid)
        watch_service.add(s, profile, "AAA.DE")
        watch_service.add(s, profile, "BBB.DE")
        with pytest.raises(watch_service.WatchlistError, match="at most 2 instruments"):
            watch_service.add(s, profile, "CCC.DE")


def test_a_snoozed_alert_wakes_without_inheriting_its_cooldown(investor):
    """F6 review V5: snooze 1 day with a 7-day cooldown; the condition still holds when it wakes."""
    pid, _ = investor
    aid = create(pid, "price_above", {"level": 90}, cooldown_days=7)
    run(pid)
    with get_session() as s:
        alert_service.update(
            s, s.get(Profile, pid), aid, {"status": "snoozed", "snooze_days": 1}, now=T0
        )
    (closed,) = alert_signals(pid, aid)
    assert closed.status == "expired" and closed.payload["closed_by"] == "snooze"
    woke = run(pid, at=T0 + dt.timedelta(days=2))
    assert woke.stats["alerts_woken"] == 1 and woke.stats["alert_signals_suppressed"] == 0
    assert [x.status for x in alert_signals(pid, aid)] == ["expired", "active"]
    assert alert_row(aid).status == "triggered"


def test_a_rearmed_muted_alert_does_not_inherit_its_cooldown(investor):
    pid, _ = investor
    aid = create(pid, "price_above", {"level": 90}, cooldown_days=7)
    run(pid)
    with get_session() as s:
        alert_service.mute(s, s.get(Profile, pid), aid, now=T0)
    with get_session() as s:
        alert_service.update(
            s, s.get(Profile, pid), aid, {"status": "active"}, now=T0 + dt.timedelta(hours=2)
        )
    again = run(pid, at=T0 + dt.timedelta(days=1))
    assert again.stats["alert_signals_suppressed"] == 0
    assert [x.status for x in alert_signals(pid, aid)] == ["expired", "active"]


def test_a_real_resolution_still_starts_the_cooldown_after_a_snooze(investor):
    pid, _ = investor
    aid = create(pid, "price_above", {"level": 90}, cooldown_days=7)
    run(pid)
    run(pid, at=T0 + dt.timedelta(days=1), prices={"XMPL": Decimal(80)})  # resolved
    with get_session() as s:
        alert_service.update(
            s, s.get(Profile, pid), aid, {"status": "snoozed", "snooze_days": 1},
            now=T0 + dt.timedelta(days=1, hours=1),
        )
    later = run(pid, at=T0 + dt.timedelta(days=3), prices={"XMPL": Decimal(100)})
    assert later.stats["alert_signals_suppressed"] == 1  # cooldown from the resolution on day 1
    assert [x.status for x in alert_signals(pid, aid)] == ["resolved"]


def test_a_restored_alert_signal_loses_the_closed_by_mark(investor):
    pid, _ = investor
    aid = create(pid, "price_above", {"level": 90}, cooldown_days=7)
    run(pid)
    with get_session() as s:
        alert_service.delete(s, s.get(Profile, pid), aid, now=T0)
    with get_session() as s:
        alert_service.restore(s, s.get(Profile, pid), aid, now=T0 + dt.timedelta(minutes=1))
    (sig,) = alert_signals(pid, aid)
    assert sig.status == "active" and "closed_by" not in sig.payload
