"""Daily check end to end on a synthetic canonical file: import -> run -> signals -> second run
idempotent; strategy states (missing / invalid / partial) and versions; market failures; the run lock."""

from __future__ import annotations

import pytest
from invp_support import (
    AS_OF,
    STRATEGY_YAML,
    FakeFx,
    FakePrices,
    add_account,
    canonical_csv,
    import_file,
    make_profile,
    sources,
)
from sqlmodel import select

from cashu.core import locks
from cashu.core.db import get_session
from cashu.modules.investments.market import SourceException
from cashu.modules.investments.models import (
    InvNotification,
    InvRuleRun,
    InvSignal,
    InvStrategyVersion,
)
from cashu.modules.investments.service import daily, files


@pytest.fixture
def investor(db_engine):
    pid, slug = make_profile()
    aid = add_account(pid)
    import_file(pid, aid, canonical_csv())
    return pid, slug, aid


def write_strategy(slug: str, text: str = STRATEGY_YAML) -> None:
    files.write_text_private(files.strategy_yaml_path(slug), text)


def run(**kwargs) -> daily.DailyCheckReport:
    kwargs.setdefault("sources", sources())
    return daily.run_daily_check("worker", as_of=AS_OF, **kwargs)


def signal_rows(pid: int) -> list[InvSignal]:
    with get_session() as s:
        return list(
            s.exec(
                select(InvSignal).where(InvSignal.profile_id == pid).order_by(InvSignal.id)
            ).all()
        )


def test_import_run_signals_and_idempotent_second_run(investor):
    pid, slug, _aid = investor
    write_strategy(slug)

    first = run()
    assert first.market is not None and not first.market.has_errors
    assert first.market_stats["bars_written"] > 0 and first.market_stats["rates_written"] > 0
    (p,) = first.profiles
    assert (p.status, p.strategy) == ("ok", "valid")
    assert p.stats["holdings"] == 3 and p.stats["total_base"] == "21459.000"
    # XMPL: 20 x 100 USD x 4.0 = 8000 of 21459 PLN -> 37.3 % > 30 % (action)
    assert [(x["rule_id"], x["severity"]) for x in p.new_signals] == [("concentration", "action")]
    assert p.stats["signals_new"] == 1 and p.stats["notifications"] == 1

    second = run()
    (q,) = second.profiles
    assert q.new_signals == [] and q.escalated_signals == []
    assert q.stats["signals_new"] == 0 and q.stats["signals_refreshed"] == 1
    assert q.stats["notifications"] == 0
    rows = signal_rows(pid)
    assert len(rows) == 1 and rows[0].status == "active" and rows[0].last_run_id == q.run_id
    with get_session() as s:
        assert len(s.exec(select(InvNotification)).all()) == 1
        runs = s.exec(select(InvRuleRun).where(InvRuleRun.profile_id == pid)).all()
        assert [r.status for r in runs] == ["ok", "ok"]
        assert runs[0].report["new"] == [rows[0].id] and runs[1].report["new"] == []
        assert runs[0].strategy_version_id == runs[1].strategy_version_id is not None
        assert len(s.exec(select(InvStrategyVersion)).all()) == 1


def test_signal_resolves_when_the_condition_clears(investor):
    pid, slug, _ = investor
    write_strategy(slug)
    run()
    # A higher limit: the concentration no longer holds -> resolved (a new strategy version).
    write_strategy(slug, STRATEGY_YAML.replace("max_weight: 0.30", "max_weight: 0.50"))
    report = run()
    assert report.profiles[0].stats["signals_resolved"] == 1
    (row,) = signal_rows(pid)
    assert row.status == "resolved" and row.closed_at is not None
    with get_session() as s:
        versions = s.exec(select(InvStrategyVersion).order_by(InvStrategyVersion.version)).all()
        assert [v.version for v in versions] == [1, 2] and versions[1].state == "valid"


def test_missing_strategy_values_only(investor):
    report = run()
    (p,) = report.profiles
    assert (p.status, p.strategy, p.stats["rules"]) == ("ok", "missing", 0)
    assert p.stats["total_base"] == "21459.000"
    assert signal_rows(investor[0]) == []


def test_invalid_strategy_is_partial_and_leaves_signals_untouched(investor):
    pid, slug, _ = investor
    write_strategy(slug)
    run()
    write_strategy(slug, STRATEGY_YAML.replace("base_currency: PLN", "base_currency: 12"))
    report = run()
    (p,) = report.profiles
    assert (p.status, p.strategy) == ("partial", "invalid")
    assert any("strategy invalid" in e for e in p.errors)
    (row,) = signal_rows(pid)
    assert row.status == "active"  # untouched, not resolved or expired


def test_partial_strategy_runs_valid_rules_and_keeps_inactive_rule_signals(investor):
    pid, slug, _ = investor
    write_strategy(slug)
    run()
    broken = STRATEGY_YAML.replace("params: { max_weight: 0.30 }", "params: { max_weight: -1 }")
    write_strategy(slug, broken)
    report = run()
    (p,) = report.profiles
    assert (p.status, p.strategy) == ("partial", "partial")
    assert p.stats["rules"] == 1 and p.stats["inactive_rules"] == 1
    assert any("rule concentration inactive" in e for e in p.errors)
    (row,) = signal_rows(pid)
    assert row.status == "active" and p.stats["signals_expired"] == 0


def test_removed_rule_expires_its_signal(investor):
    pid, slug, _ = investor
    write_strategy(slug)
    run()
    without = STRATEGY_YAML.split("  - id: concentration")[0] + (
        "  - id: idle_cash\n    kind: cash_level\n    params: { max_weight: 0.15 }\n"
    )
    write_strategy(slug, without)
    run()
    (row,) = signal_rows(pid)
    assert row.status == "expired"


def test_market_errors_make_the_run_partial_not_failed(investor):
    _pid, slug, _ = investor
    write_strategy(slug)

    class Broken(FakePrices):
        def fetch(self, instrument, start, end):
            raise SourceException("yahoo", "HTTP 503", retryable=True)

    report = run(sources=sources(Broken(), FakeFx()))
    (p,) = report.profiles
    assert p.status == "partial" and any(e.startswith("prices ") for e in p.errors)
    assert report.market.to_stats()["instruments_error"] == 3


def test_offline_uses_stored_prices_only(investor):
    _pid, slug, _ = investor
    write_strategy(slug)
    run()
    prices = FakePrices()
    report = run(offline=True, sources=sources(prices))
    assert report.market is None and prices.calls == []
    assert report.profiles[0].stats["total_base"] == "21459.000"


def test_profiles_without_investments_are_not_checked(investor, db_engine):
    other_pid, _ = make_profile("Budżet", modules=("budget",))
    report = run()
    assert [p.profile_id for p in report.profiles] == [investor[0]]
    report = run(profile_ids=[other_pid])
    assert [p.profile_id for p in report.profiles] == [other_pid]


def test_a_failing_profile_is_recorded_and_the_others_still_run(investor, monkeypatch):
    pid, slug, _ = investor
    other_pid, _ = make_profile("Druga")
    write_strategy(slug)
    original = daily._evaluate

    def flaky(s, needs, run_row, as_of, clock, errors):
        if needs.profile.id == other_pid:
            raise RuntimeError("boom")
        return original(s, needs, run_row, as_of, clock, errors)

    monkeypatch.setattr(daily, "_evaluate", flaky)
    report = run()
    statuses = {p.profile_id: p.status for p in report.profiles}
    assert statuses == {pid: "ok", other_pid: "failed"}
    with get_session() as s:
        failed = s.exec(select(InvRuleRun).where(InvRuleRun.profile_id == other_pid)).one()
        assert failed.status == "failed" and "RuntimeError: boom" in failed.errors[-1]


def test_the_run_lock_is_shared(investor):
    with locks.run_lock(daily.LOCK_NAME), pytest.raises(daily.RunBusy):
        run()
    assert run().profiles  # free again


def test_no_transaction_is_held_while_fetching(investor, tmp_path):
    """While the sources are 'on the network', another connection can write to the database."""
    from cashu.core.db import make_engine
    from cashu.db import engine

    probe = make_engine(str(engine.url))
    writes: list[bool] = []

    class Probing(FakePrices):
        def fetch(self, instrument, start, end):
            with probe.connect() as c:
                c.exec_driver_sql("PRAGMA busy_timeout=100")
                c.exec_driver_sql("CREATE TABLE IF NOT EXISTS probe (x INTEGER)")
                c.exec_driver_sql("INSERT INTO probe VALUES (1)")
                c.commit()
            writes.append(True)
            return super().fetch(instrument, start, end)

    write_strategy(investor[1])
    report = run(sources=sources(Probing(), FakeFx()))
    assert len(writes) == 3 and report.profiles[0].status == "ok"
    probe.dispose()
