"""End to end on synthetic data: strategy YAML through the loader, transactions through D's real portfolio
pipeline (build_snapshot -> value_portfolio -> allocate), then the rules engine. Checks the right numbers
and that frozen / manual / cost valuations never fire a price rule (they skip with a reason)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from rules_fixtures import describe, skip_reason

from cashu.modules.investments.domain import (
    AssetClass,
    Currency,
    FrozenValuedAtZero,
    Instrument,
    InstrumentStatus,
    MarketView,
    MissingManualValuation,
    PriceBar,
    Transaction,
    TxnType,
)
from cashu.modules.investments.portfolio import (
    InMemoryFxLookup,
    allocate,
    build_snapshot,
    value_portfolio,
)
from cashu.modules.investments.rules import Fired, RuleContext, RulesEngine
from cashu.modules.investments.strategy import StrategyConfig, load_strategy

PLN = Currency.PLN
AS_OF = date(2026, 10, 2)
ACCOUNT = "acc-1"
VWCE = Instrument(
    "i-VWCE", "VWCE name", PLN, AssetClass.ETF, symbol="VWCE", tags=("global_equity",)
)
EDO = Instrument("i-EDO", "EDO0536", PLN, AssetClass.TREASURY_BOND, symbol="EDO0536")
FTX = Instrument(
    "i-FTX", "FTX claim", PLN, AssetClass.CLAIM, symbol="FTX", status=InstrumentStatus.FROZEN
)
CLAIM = Instrument("i-CLM", "Other claim", PLN, AssetClass.CLAIM, symbol="CLM")

STRATEGY = """\
version: 1
base_currency: PLN
contributions: { monthly_amount: 1000 }
buckets:
  - { id: global_equity, match: { asset_class: etf, tags: [global_equity] } }
  - { id: bond_etfs, match: { asset_class: etf, tags: [bonds] } }
  - { id: treasury_bonds, match: { asset_class: [bond, treasury_bond] } }
  - { id: cash, match: { asset_class: cash } }
allocation:
  targets: { global_equity: 0.70, bond_etfs: 0.10, treasury_bonds: 0.15, cash: 0.05 }
  rebalance: { absolute_band_pp: 5, relative_band: 0.25, min_trade_value: 500 }
rules:
  - { id: drift, kind: allocation_drift }
  - { id: idle_cash, kind: cash_level, params: { max_weight: 0.15 } }
  - { id: loss, kind: loss_from_cost, params: { threshold: 0.25, asset_class: [etf, claim, treasury_bond] } }
  - { id: dip, kind: drawdown_from_high, params: { threshold: 0.15, window_days: 5, asset_class: [etf, claim, treasury_bond] } }
  - id: wipeout
    kind: custom
    params: { scope: instrument, asset_class: [etf, claim, treasury_bond], when: "unrealized_pct <= -50%" }
  - { id: deposits, kind: contribution_gap }
"""

_sequence = iter(range(1, 10_000))


def txn(
    kind: TxnType,
    trade_date: str,
    *,
    instrument: Instrument | None = None,
    quantity="0",
    price="0",
    amount="0",
):
    gross = Decimal(quantity) * Decimal(price) if instrument is not None else Decimal(amount)
    cash = gross if kind == TxnType.DEPOSIT else -gross
    return Transaction(
        id=f"t{next(_sequence)}",
        account_id=ACCOUNT,
        type=kind,
        trade_date=date.fromisoformat(trade_date),
        currency=PLN,
        gross_amount=gross,
        cash_amount=cash,
        cash_currency=PLN,
        instrument_id=None if instrument is None else instrument.id,
        quantity=None if instrument is None else Decimal(quantity),
        price=None if instrument is None else Decimal(price),
        created_at=datetime(2026, 1, 1, tzinfo=UTC) + timedelta(seconds=next(_sequence)),
    )


def closes(instrument: Instrument, values: list[str]) -> tuple[PriceBar, ...]:
    return tuple(
        PriceBar(instrument.id, AS_OF - timedelta(days=len(values) - 1 - i), Decimal(v), "test")
        for i, v in enumerate(values)
    )


def run_pipeline(config: StrategyConfig, txns: list[Transaction], instruments: list[Instrument]):
    snapshot = build_snapshot("p", txns, AS_OF)
    market = MarketView(
        as_of=AS_OF,
        instruments={i.id: i for i in instruments},
        bars={VWCE.id: closes(VWCE, ["150", "155", "160", "150", "150"])},
    )
    valued = value_portfolio(
        snapshot,
        market,
        InMemoryFxLookup([]),
        PLN,
        config.data.max_price_age_days,
        max_fx_age_days=config.data.max_fx_age_days,
    )
    allocation = allocate(valued, config.allocation)
    ctx = RuleContext.build(
        profile_id="p",
        as_of=AS_OF,
        portfolio=valued,
        market=market,
        allocation=allocation,
        data=config.data,
        contributions=config.contributions,
    )
    return valued, RulesEngine(config.rules).evaluate(ctx)


def base_txns() -> list[Transaction]:
    return [
        txn(TxnType.DEPOSIT, "2026-09-10", amount="20000"),
        txn(TxnType.BUY, "2026-09-11", instrument=VWCE, quantity="100", price="140"),
        txn(TxnType.BUY, "2026-09-11", instrument=EDO, quantity="30", price="100"),
    ]


def test_frozen_claim_at_zero_never_fires_price_rules():
    config = load_strategy(STRATEGY).config
    assert config is not None
    txns = [
        *base_txns(),
        txn(TxnType.BUY, "2026-09-12", instrument=FTX, quantity="10", price="100"),
    ]
    valued, outcomes = run_pipeline(config, txns, [VWCE, EDO, FTX])

    assert valued.total_base == Decimal(20000)  # VWCE 15000 + EDO 3000 at cost + FTX 0 + cash 2000
    assert any(isinstance(w, FrozenValuedAtZero) for w in valued.warnings)
    frozen = next(h for h in valued.valued if h.instrument_id == FTX.id)
    assert frozen.valued_manually and frozen.unrealized_pct == -1.0

    by_scope = {describe(o): o for o in outcomes}
    assert list(by_scope) == [
        "not_fired drift|s:global_equity",
        "fired drift|s:bond_etfs",
        "not_fired drift|s:treasury_bonds",
        "fired drift|s:cash",
        "not_fired idle_cash",
        "not_fired loss|i:i-VWCE",
        "not_fired loss|i:i-EDO",
        "skipped loss|i:i-FTX",
        "not_fired dip|i:i-VWCE",
        "skipped dip|i:i-EDO",
        "skipped dip|i:i-FTX",
        "not_fired wipeout|i:i-VWCE",
        "not_fired wipeout|i:i-EDO",
        "skipped wipeout|i:i-FTX",
        "not_fired deposits",
    ]
    assert (
        skip_reason(by_scope["skipped loss|i:i-FTX"])
        == "FTX: wycena ręczna, zmiana od kosztu nie jest wynikiem rynkowym"
    )
    assert (
        skip_reason(by_scope["skipped dip|i:i-EDO"])
        == "EDO0536: wycena po koszcie, brak notowań rynkowych"
    )
    assert (
        skip_reason(by_scope["skipped dip|i:i-FTX"]) == "FTX: wycena ręczna, brak notowań rynkowych"
    )
    assert (
        skip_reason(by_scope["skipped wipeout|i:i-FTX"])
        == "FTX: wycena ręczna, zmiana od kosztu nie jest wynikiem rynkowym"
    )
    fired = [o.candidate for o in outcomes if isinstance(o, Fired)]
    assert [c.message for c in fired] == [
        (
            "Koszyk bond_etfs poniżej celu o 10,0\u00a0pp (0,0\u00a0% wobec 10,0\u00a0%, "
            "do celu brakuje 2\u00a0000 PLN)."
        ),
        "Koszyk cash powyżej celu o 5,0\u00a0pp (10,0\u00a0% wobec 5,0\u00a0%, 1\u00a0000 PLN ponad cel).",
    ]


def test_a_manual_claim_without_valuation_makes_weight_rules_skip():
    config = load_strategy(STRATEGY).config
    txns = [
        *base_txns(),
        txn(TxnType.BUY, "2026-09-12", instrument=CLAIM, quantity="10", price="100"),
    ]
    valued, outcomes = run_pipeline(config, txns, [VWCE, EDO, CLAIM])
    assert any(isinstance(w, MissingManualValuation) for w in valued.warnings)
    by_rule = {describe(o): o for o in outcomes}
    assert skip_reason(by_rule["skipped drift"]).startswith("Brak ceny dla 1 pozycji (CLM)")
    assert skip_reason(by_rule["skipped idle_cash"]).startswith("Brak ceny dla 1 pozycji (CLM)")
    assert (
        skip_reason(by_rule["skipped loss|i:i-CLM"])
        == "CLM: wycena ręczna, zmiana od kosztu nie jest wynikiem rynkowym"
    )
    assert not any(isinstance(o, Fired) for o in outcomes)
