"""P/L attribution by instrument and bucket, and profit concentration. Pure.

Per instrument over a range ``(start, end]`` (all in the base currency, renamed instruments grouped
under their final id):

    pnl = end_value - start_value + returned + income - invested - costs

- ``invested``: buys (their cash, fees included) and units moved in (transfer in, adjustment) at that
  day's unit value (the same value the contribution series counted);
- ``returned``: sells (net cash) and units moved out (transfer out) at that day's unit value;
- ``income``: dividends (net of withholding tax, as booked) and instrument interest;
- ``costs``: fees and taxes booked on the instrument (and transfer fees);
- cash amounts are converted at the rate on/before their date (any age).

Account-level items (no instrument): interest, fees, taxes and FX conversions. ``other`` is what is left
of the portfolio result (end - start - external flows) after the instruments and account-level items:
FX revaluation of cash, implied funding of cash gaps, unvalued days.

Concentration: instruments sorted by P/L; ``top_n_share`` = the top n P/Ls / the sum of every
instrument's P/L (None unless that sum is positive; it can exceed 1 when others lost money);
``pnl_without_top2`` = the sum without the two largest.
"""

from __future__ import annotations

from collections.abc import Callable, Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal

from ..domain import (
    AccountId,
    AllocationPlan,
    CalendarDate,
    Currency,
    FxLookup,
    Instrument,
    InstrumentId,
    Transaction,
    TxnId,
    TxnType,
    exact_decimals,
)
from ..portfolio import matches_bucket
from .series import Renames, cash_flow_base

ZERO = Decimal(0)
TOP_N = (1, 2, 3, 5)


@dataclass
class InstrumentPnl:
    instrument_id: InstrumentId
    start_value: Decimal = ZERO
    end_value: Decimal = ZERO
    invested: Decimal = ZERO
    returned: Decimal = ZERO
    income: Decimal = ZERO
    costs: Decimal = ZERO
    held: bool = False
    """Held at the range end."""
    unvalued: bool = False
    """A holding or a cash amount of it could not be valued (its P/L is incomplete)."""

    @property
    def pnl(self) -> Decimal:
        return (
            self.end_value
            - self.start_value
            + self.returned
            + self.income
            - self.invested
            - self.costs
        )


@dataclass
class AccountLevel:
    interest: Decimal = ZERO
    fees: Decimal = ZERO
    """Paid, positive."""
    taxes: Decimal = ZERO
    """Paid, positive."""
    fx_conversions: Decimal = ZERO
    """Net base value of FX conversion bookings (the conversion cost when negative)."""
    other_income: Decimal = ZERO

    @property
    def total(self) -> Decimal:
        return self.interest - self.fees - self.taxes + self.fx_conversions + self.other_income


@dataclass
class Attribution:
    instruments: list[InstrumentPnl] = field(default_factory=list)
    """Sorted by P/L, largest first."""
    account_level: AccountLevel = field(default_factory=AccountLevel)
    unknown_cash: int = 0
    """Cash amounts that could not be converted (no rate)."""

    @property
    def instruments_pnl(self) -> Decimal:
        return sum((i.pnl for i in self.instruments), ZERO)


def attribute(
    txns: Iterable[Transaction],
    *,
    start: CalendarDate,
    end: CalendarDate,
    start_values: Mapping[tuple[AccountId, InstrumentId], Decimal | None],
    end_values: Mapping[tuple[AccountId, InstrumentId], Decimal | None],
    txn_values: Mapping[TxnId, Decimal],
    fx: FxLookup,
    base: Currency,
    renames: Renames,
    account_ids: Collection[AccountId] | None = None,
) -> Attribution:
    """P/L per instrument for transactions dated after ``start`` up to ``end`` plus the holding values at
    both ends (``*_values`` per (account, instrument), None = not valued)."""
    rows: dict[InstrumentId, InstrumentPnl] = {}
    level = AccountLevel()
    unknown = 0

    def row(instrument_id: InstrumentId) -> InstrumentPnl:
        final = renames.final(instrument_id) or instrument_id
        if final not in rows:
            rows[final] = InstrumentPnl(final)
        return rows[final]

    def in_scope(account_id: AccountId) -> bool:
        return account_ids is None or account_id in account_ids

    with exact_decimals():
        for (account_id, iid), value in start_values.items():
            if not in_scope(account_id):
                continue
            r = row(iid)
            if value is None:
                r.unvalued = True
            else:
                r.start_value += value
        for (account_id, iid), value in end_values.items():
            if not in_scope(account_id):
                continue
            r = row(iid)
            r.held = True
            if value is None:
                r.unvalued = True
            else:
                r.end_value += value

        for t in txns:
            if not (start < t.trade_date <= end) or not in_scope(t.account_id):
                continue
            if t.type in (TxnType.DEPOSIT, TxnType.WITHDRAWAL, TxnType.SPLIT):
                continue
            moved_units = t.type in (
                TxnType.TRANSFER_IN,
                TxnType.TRANSFER_OUT,
                TxnType.ADJUSTMENT,
            )
            if moved_units and (t.instrument_id is None or not t.quantity):
                continue  # a cash transfer: an external flow, not P/L
            cash = cash_flow_base(t, fx, base)
            if cash is None:
                unknown += 1
                if t.instrument_id is not None:
                    row(t.instrument_id).unvalued = True
                continue
            if t.instrument_id is None:
                match t.type:
                    case TxnType.INTEREST:
                        level.interest += cash
                    case TxnType.FEE:
                        level.fees -= cash
                    case TxnType.TAX:
                        level.taxes -= cash
                    case TxnType.FX_CONVERSION:
                        level.fx_conversions += cash
                    case _:
                        level.other_income += cash
                continue
            r = row(t.instrument_id)
            match t.type:
                case TxnType.BUY:
                    r.invested -= cash
                case TxnType.SELL:
                    r.returned += cash
                case TxnType.DIVIDEND | TxnType.INTEREST:
                    r.income += cash
                case TxnType.FEE | TxnType.TAX:
                    r.costs -= cash
                case TxnType.TRANSFER_IN | TxnType.ADJUSTMENT:
                    r.costs -= cash
                    moved = txn_values.get(t.id)
                    if moved is None:
                        r.unvalued = True
                    else:
                        r.invested += moved
                case TxnType.TRANSFER_OUT:
                    r.costs -= cash
                    moved = txn_values.get(t.id)
                    if moved is None:
                        r.unvalued = True
                    else:
                        r.returned += moved
                case _:
                    r.income += cash

    ordered = sorted(rows.values(), key=lambda r: (-r.pnl, r.instrument_id))
    return Attribution(ordered, level, unknown)


def bucket_of(instrument: Instrument | None, plan: AllocationPlan | None) -> str:
    """The strategy bucket (first match in declaration order), ``unclassified`` when none matches;
    without buckets the asset class."""
    if instrument is None:
        return "unclassified"
    if plan is None or not plan.buckets:
        return instrument.asset_class.value
    for bucket in plan.buckets:
        if matches_bucket(bucket.match, instrument):
            return bucket.id
    return "unclassified"


@dataclass(frozen=True, slots=True)
class Concentration:
    total: Decimal
    """Sum of every instrument's P/L."""
    top_shares: tuple[tuple[int, float | None], ...]
    """(n, share of the total P/L held by the top n)."""
    top2: tuple[InstrumentId, ...]
    pnl_without_top2: Decimal
    positive: int
    negative: int


def concentration(pnls: Sequence[tuple[InstrumentId, Decimal]]) -> Concentration:
    ordered = sorted(pnls, key=lambda p: (-p[1], p[0]))
    total = sum((p for _, p in ordered), ZERO)
    shares: list[tuple[int, float | None]] = []
    for n in TOP_N:
        top = sum((p for _, p in ordered[:n]), ZERO)
        shares.append((n, float(top / total) if total > 0 and len(ordered) >= 1 else None))
    top2 = tuple(i for i, _ in ordered[:2])
    without = total - sum((p for _, p in ordered[:2]), ZERO)
    return Concentration(
        total=total,
        top_shares=tuple(shares),
        top2=top2,
        pnl_without_top2=without,
        positive=sum(1 for _, p in ordered if p > 0),
        negative=sum(1 for _, p in ordered if p < 0),
    )


def group_by_bucket(
    rows: Sequence[InstrumentPnl],
    bucket: Callable[[InstrumentId], str],
) -> list[tuple[str, Decimal, int]]:
    """(bucket, P/L, instruments) sorted by P/L, largest first."""
    totals: dict[str, list] = {}
    for r in rows:
        key = bucket(r.instrument_id)
        entry = totals.setdefault(key, [ZERO, 0])
        entry[0] += r.pnl
        entry[1] += 1
    return sorted(
        ((k, v[0], v[1]) for k, v in totals.items()), key=lambda item: (-item[1], item[0])
    )
