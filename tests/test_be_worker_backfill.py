"""The worker follows the daily check with the incremental performance backfill (F6): a sold
instrument (not in the daily refresh) gets its price history; offline runs skip it; a failing backfill
never fails the run."""

from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

from sqlmodel import select

sys.path.insert(0, str(Path(__file__).parent / "investments" / "persistence"))

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

from cashu.core.db import get_session
from cashu.core.worker import investments as inv
from cashu.core.worker import runner
from cashu.modules.investments.models import InvInstrument, InvPriceBar
from cashu.modules.investments.service import files

MONDAY = dt.datetime(2026, 3, 2, 7, 30, tzinfo=dt.timezone(dt.timedelta(hours=1)))
SELL_ABC = "1,txn,2026-02-02,10:00,sell,T-8,ABC,PLABC0000016,ABC Example SA,XWAR,100,55.00,PLN,5500.00,5.00,,5495.00,,,,"


def _profile_with_a_sold_instrument() -> int:
    pid, slug = make_profile("Inwestor")
    import_file(pid, add_account(pid), canonical_csv(positions=False, extra=[SELL_ABC]))
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML)
    return pid


def _abc_bars() -> list[dt.date]:
    with get_session() as s:
        abc = s.exec(select(InvInstrument).where(InvInstrument.symbol == "ABC")).one()
        return sorted(
            s.exec(select(InvPriceBar.date).where(InvPriceBar.instrument_id == abc.id)).all()
        )


def test_worker_backfills_sold_instruments_after_the_daily_check(db_engine):
    _profile_with_a_sold_instrument()
    prices = FakePrices()
    report = runner.run_worker(
        notifier=None, now=MONDAY, as_of=AS_OF, investments_sources=sources(prices)
    )
    assert report.status == "ok"
    assert [j.job for j in report.jobs if j.job.startswith("investments")] == ["investments.daily"]
    bars = _abc_bars()
    # from the first trade minus 7 days (2026-01-07 - 7) up to the run date
    assert bars[0] == dt.date(2025, 12, 31) and bars[-1] == AS_OF
    assert any(call[0] == "ABC.WA" for call in prices.calls)


def test_offline_runs_skip_the_backfill_and_failures_are_not_fatal(db_engine, monkeypatch):
    _profile_with_a_sold_instrument()
    runner.run_worker(notifier=None, now=MONDAY, as_of=AS_OF, offline=True)
    assert _abc_bars() == []

    def boom(**_kwargs):
        raise RuntimeError("source down")

    from cashu.modules.investments.performance import backfill

    monkeypatch.setattr(backfill, "run_backfill", boom)
    assert inv.backfill_prices(as_of=AS_OF) == {"error": "RuntimeError: source down"}
    report = runner.run_worker(notifier=None, now=MONDAY, as_of=AS_OF, investments_sources=sources)
    assert report.status == "ok"
