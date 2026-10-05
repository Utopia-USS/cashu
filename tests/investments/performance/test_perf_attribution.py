"""P/L attribution by instrument and bucket, account-level items and profit concentration,
hand-computed (through the daily series, so the end values are the series' own)."""

from __future__ import annotations

from decimal import Decimal

import pytest
from perf_support import EUR, PLN, bars, day, days, instrument, rates, txn

from finanse.modules.investments.domain import (
    AllocationPlan,
    AssetClass,
    BucketDef,
    BucketMatch,
    InstrumentRename,
)
from finanse.modules.investments.performance import attribution as attr
from finanse.modules.investments.performance import report
from finanse.modules.investments.performance.series import Renames, build_series
from finanse.modules.investments.portfolio import InMemoryFxLookup

END = day("2025-01-31")
FX = rates(EUR, {d.isoformat(): "4.0" for d in days("2024-12-28", "2025-01-31")})


def history():
    # A (PLN equity): bought 10 @ 100 + 5 fee, sold 10 @ 120 - 5 fee        -> P/L 1195 - 1005 = 190
    # B (EUR ETF): bought 10 @ 50 EUR for 2000 PLN, dividend 80 PLN, worth 10 * 55 * 4.0 at the end
    #                                                                        -> 2200 - 2000 + 80 = 280
    # account: fee 10, interest 3                                            -> -7
    # portfolio: cash 10000 - 1005 - 2000 + 80 + 1195 - 10 + 3 = 8263, + 2200 = 10463 -> P/L 463
    txns = [
        txn("deposit", "2025-01-02", "10000"),
        txn("buy", "2025-01-02", "-1005", instrument="A", quantity="10", price="100", fee="5"),
        txn(
            "buy",
            "2025-01-02",
            "-2000",
            instrument="B",
            quantity="10",
            price="50",
            currency=EUR,
            cash_currency=PLN,
        ),
        txn("dividend", "2025-01-10", "80", instrument="B"),
        txn("sell", "2025-01-15", "1195", instrument="A", quantity="10", price="120", fee="5"),
        txn("fee", "2025-01-20", "-10"),
        txn("interest", "2025-01-20", "3"),
    ]
    insts = {
        "A": instrument("A", PLN, AssetClass.EQUITY),
        "B": instrument("B", EUR, AssetClass.ETF),
    }
    a = {d.isoformat(): 100 + i for i, d in enumerate(days("2025-01-01", "2025-01-31"))}
    b = {d.isoformat(): 55 for d in days("2025-01-01", "2025-01-31")}
    return txns, insts, {"A": bars("A", a), "B": bars("B", b)}


def run(start_key: str = "max", start=None):
    txns, insts, bar_map = history()
    fx = InMemoryFxLookup(FX)
    captures = {END} | ({start} if start else set())
    s = build_series(
        txns, instruments=insts, bars=bar_map, fx=fx, base=PLN, end=END, capture_dates=captures
    )
    base = start or report.range_base(start_key, END, s.dates[0])
    result = attr.attribute(
        txns,
        start=base,
        end=END,
        start_values=s.captures.get(base, {}),
        end_values=s.captures[END],
        txn_values=s.txn_values,
        fx=fx,
        base=PLN,
        renames=Renames([]),
    )
    return s, result, insts


def test_instrument_pnl_account_level_and_the_rest():
    s, result, _ = run()
    by_id = {r.instrument_id: r for r in result.instruments}
    assert [r.instrument_id for r in result.instruments] == ["B", "A"]  # largest P/L first
    assert by_id["A"].pnl == Decimal(190) and not by_id["A"].held
    assert (by_id["A"].invested, by_id["A"].returned) == (Decimal(1005), Decimal(1195))
    assert by_id["B"].pnl == Decimal(280) and by_id["B"].held
    assert (by_id["B"].end_value, by_id["B"].income) == (Decimal(2200), Decimal(80))
    level = result.account_level
    assert (level.fees, level.interest, level.total) == (Decimal(10), Decimal(3), Decimal(-7))
    metrics = report.compute_range("max", s.dates, s.combined(), None)
    assert metrics.summary["pnl"] == pytest.approx(463)
    other = Decimal(str(metrics.summary["pnl"])) - result.instruments_pnl - level.total
    assert other == 0


def test_range_starting_mid_history_uses_the_value_at_the_base_day():
    # On 01-12 A is still held: 10 units at the 01-12 close (111) = 1110 -> P/L in range 1195 - 1110
    _s, result, _ = run(start=day("2025-01-12"))
    by_id = {r.instrument_id: r for r in result.instruments}
    assert by_id["A"].start_value == Decimal(1110)
    assert by_id["A"].pnl == Decimal(85)
    assert by_id["B"].pnl == Decimal(0)  # flat price, the dividend was before the range


def test_concentration_and_buckets():
    _s, result, insts = run()
    conc = attr.concentration([(r.instrument_id, r.pnl) for r in result.instruments])
    assert conc.total == Decimal(470)
    shares = dict(conc.top_shares)
    assert shares[1] == pytest.approx(280 / 470)
    assert shares[2] == pytest.approx(1.0)
    assert conc.top2 == ("B", "A") and conc.pnl_without_top2 == 0
    plan = AllocationPlan(
        buckets=(
            BucketDef("stocks", BucketMatch(asset_classes={AssetClass.EQUITY})),
            BucketDef("funds", BucketMatch(asset_classes={AssetClass.ETF})),
        ),
        targets={"stocks": 0.5, "funds": 0.5},
    )
    grouped = attr.group_by_bucket(result.instruments, lambda i: attr.bucket_of(insts[i], plan))
    assert grouped == [("funds", Decimal(280), 1), ("stocks", Decimal(190), 1)]
    assert attr.bucket_of(insts["A"], None) == "equity"  # no buckets: the asset class
    assert attr.bucket_of(None, plan) == "unclassified"


def test_concentration_when_others_lose():
    conc = attr.concentration(
        [("X", Decimal(300)), ("Y", Decimal(100)), ("Z", Decimal(-200)), ("W", Decimal(-100))]
    )
    shares = dict(conc.top_shares)
    assert conc.total == Decimal(100)
    assert shares[1] == pytest.approx(3.0)  # one winner made three times the total
    assert conc.pnl_without_top2 == Decimal(-300)
    assert (conc.positive, conc.negative) == (2, 2)
    assert dict(attr.concentration([("X", Decimal(-5))]).top_shares)[1] is None


def test_renamed_instrument_is_one_line():
    txns = [
        txn("deposit", "2025-01-02", "1000"),
        txn("buy", "2025-01-02", "-1000", instrument="OLD", quantity="10", price="100"),
        txn("sell", "2025-01-20", "1300", instrument="OLD", quantity="10", price="130"),
    ]
    renames = [InstrumentRename(day("2025-01-10"), "OLD", "NEW")]
    result = attr.attribute(
        txns,
        start=day("2025-01-01"),
        end=END,
        start_values={},
        end_values={},
        txn_values={},
        fx=InMemoryFxLookup([]),
        base=PLN,
        renames=Renames(renames),
    )
    assert [(r.instrument_id, r.pnl) for r in result.instruments] == [("NEW", Decimal(300))]
