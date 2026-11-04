"""What moved the portfolio over a short window, by market segment, and how much was currency (P5).
Pure: no IO; the service hands in the start holdings, the bars and the rates.

Method (holdings-based):

- The window is ``start`` -> ``end`` (``1w`` = 7 days, ``4w`` = 28 days, ``end`` = the portfolio's
  as-of day). Holdings are the quantities at ``start`` (positions opened later are not attributed;
  they are counted in ``new_positions``), from the same transactions the positions view reads.
- Snapshot-held positions (P7): a position the history knows only from the account's FIRST broker
  position snapshot (its first transaction in that account is the reconciliation ``adjustment`` the
  snapshot import wrote, dated the account's earliest reconciliation day) was held before that day,
  the history just does not say since when. :func:`snapshot_openings` dates such an opening at
  ``start`` when it is later, so the position counts as held at ``start`` (never a new position). An
  opening dated on or before ``start`` (the snapshot predates the window) is held anyway; a position
  with any earlier trade, transfer or other transaction in that account keeps its dates (the history
  is the information); a position first reported by a LATER snapshot of the account keeps its date
  too (the earlier snapshot without it is the information: it is a new position).
- ``T0`` = the full portfolio value at ``start`` in the base currency (all accounts, cash and cost /
  manually valued holdings included).
- For each market-valued holding at ``start``: ``V0`` = its base value at ``start``; ``rL`` = the
  local price return (close on/before ``start`` -> close on/before ``end``, the valuation's lookup;
  a close older than ``max_price_age_days`` is still used but flagged in ``stale``; no close = 0 and
  flagged); ``rF`` = the return of its price currency against the base (0 for the base currency or
  a missing rate); ``rB = (1 + rL)(1 + rF) - 1``.

  - its segment's contribution += ``V0 * rL / T0``;
  - the currency contribution += ``V0 * (rB - rL) / T0`` (also per currency).
- Holdings without a segment form the ``unassigned`` row. Cost / manually valued holdings and claims
  contribute 0 but keep their weight in their segment's row (return None: treasury bonds still show
  as ``bonds`` exposure); cash stays in ``T0`` only.
- A holding held at ``start`` is never a new position. One the valuation could not value there
  (missing or too old price / rate) is valued by the service from the nearest close and rate on or
  before ``start`` whatever their age (``stale``); one without any price or rate is left out of
  ``T0`` and the rows (``unvalued``) and listed in ``stale``.
- ``explained`` = every segment row (unassigned included) + currency. The service compares it with
  the time-weighted return of the whole portfolio over the same window; the rest (trades within the
  window, dividends, manual valuations, stale prices) is the residual.
- Per segment: ``weight`` = sum of ``V0`` / ``T0``, ``ret`` = the ``V0``-weighted local return of its
  holdings, ``instruments`` sorted by |contribution|. Rows are sorted by |contribution| (ties by key);
  ``T0 <= 0`` gives an empty result.
"""

from __future__ import annotations

import datetime as dt
from bisect import bisect_right
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass, replace
from decimal import Decimal

from ..domain import (
    Currency,
    FxLookup,
    InstrumentId,
    PriceBar,
    Transaction,
    TxnSource,
    TxnType,
    chronological_key,
    days_between,
    exact,
)

DEFAULT_MAX_PRICE_AGE_DAYS = 5


@dataclass(frozen=True, slots=True)
class StartHolding:
    """One holding at ``start`` (several accounts holding the same instrument may be given apart;
    they are summed)."""

    instrument_id: InstrumentId
    currency: Currency
    """The price currency of its bars (the instrument currency)."""
    value_base: Decimal
    """``V0``: the value at ``start`` in the base currency."""
    market: bool = True
    """Valued from market prices; False for cost / manual valuation (weight only, contributes 0)."""
    stale: bool = False
    """Valued from data older than the valuation allows (listed in ``stale``)."""


@dataclass(frozen=True, slots=True)
class StartPortfolio:
    total_base: Decimal
    """``T0``: the full portfolio value at ``start`` in the base currency (cash included)."""
    holdings: tuple[StartHolding, ...] = ()
    unvalued: tuple[InstrumentId, ...] = ()
    """Held at ``start`` without any value there (no price or no rate at all): left out of ``T0``
    and the rows, listed in ``stale``, never a new position."""
    held: tuple[InstrumentId, ...] = ()
    """Every instrument held at ``start`` (cash-like ones included); defaults to the holdings and
    ``unvalued``. What ``new_positions`` compares against."""


@dataclass(frozen=True, slots=True)
class InstrumentMove:
    instrument_id: InstrumentId
    weight: float
    contribution: float
    ret: float | None
    """None for a cost / manually valued holding (no market return)."""


@dataclass(frozen=True, slots=True)
class SegmentMove:
    segment: str | None
    """The segment key; None for the unassigned row."""
    weight: float
    contribution: float
    ret: float | None
    instruments: tuple[InstrumentMove, ...] = ()


@dataclass(frozen=True, slots=True)
class CurrencyMove:
    currency: str
    weight: float
    ret: float
    contribution: float


@dataclass(frozen=True, slots=True)
class SegmentAttribution:
    start: dt.date
    end: dt.date
    segments: tuple[SegmentMove, ...] = ()
    """Rows with a segment, by |contribution| (ties by key)."""
    unassigned: SegmentMove | None = None
    currency_contribution: float = 0.0
    currencies: tuple[CurrencyMove, ...] = ()
    """Foreign price currencies (the base currency is left out: its return is 0)."""
    explained: float = 0.0
    new_positions: int = 0
    stale: tuple[InstrumentId, ...] = ()
    """Instruments whose close at ``start`` or ``end`` is older than allowed or missing, valued at
    ``start`` from old data, or without any value there."""

    @property
    def empty(self) -> bool:
        return not self.segments and self.unassigned is None


def snapshot_openings(txns: Sequence[Transaction], start: dt.date) -> list[Transaction]:
    """``txns`` with each snapshot opening dated ``start`` when it is later (module doc): per
    (account, instrument), when the first transaction is a reconciliation ``adjustment`` (the units
    the broker snapshot reported and the history did not have) dated after ``start`` and on the
    account's earliest reconciliation day (its first snapshot). Every other transaction is returned
    unchanged."""
    first: dict[tuple[str, str], Transaction] = {}
    first_snapshot: dict[str, dt.date] = {}
    for txn in sorted(txns, key=chronological_key):
        if txn.source == TxnSource.RECONCILIATION:
            first_snapshot.setdefault(txn.account_id, txn.trade_date)
        if txn.instrument_id is not None:
            first.setdefault((txn.account_id, txn.instrument_id), txn)
    moved = {
        t.id
        for t in first.values()
        if t.source == TxnSource.RECONCILIATION
        and t.type == TxnType.ADJUSTMENT
        and t.trade_date > start
        and t.trade_date == first_snapshot.get(t.account_id)
    }
    if not moved:
        return list(txns)
    return [replace(t, trade_date=start, settle_date=None) if t.id in moved else t for t in txns]


def close_on_or_before(bars: Sequence[PriceBar], day: dt.date) -> PriceBar | None:
    """The newest bar dated on/before ``day`` (``bars`` oldest first)."""
    dates = [b.date for b in bars]
    i = bisect_right(dates, day)
    return bars[i - 1] if i else None


def _fx_return(fx: FxLookup, currency: Currency, base: Currency, start, end) -> Decimal:
    if currency == base:
        return Decimal(0)
    then = fx.quote_on_or_before(currency, start, base)
    now = fx.quote_on_or_before(currency, end, base)
    if then is None or now is None or then.rate <= 0:
        return Decimal(0)
    return now.rate / then.rate - 1


def _ratio(part: Decimal, total: Decimal) -> float:
    return float(part / total) + 0.0  # never -0.0


Item = tuple[InstrumentId, Decimal, Decimal | None]
"""(instrument, V0, local return; None = not market-valued)."""


@exact
def attribute_segments(
    holdings_t0: StartPortfolio,
    prices: Mapping[InstrumentId, Sequence[PriceBar]],
    fx: FxLookup,
    base: Currency,
    start: dt.date,
    end: dt.date,
    segment_of: Callable[[InstrumentId], str | None],
    *,
    held_at_end: Collection[InstrumentId] = (),
    max_price_age_days: int = DEFAULT_MAX_PRICE_AGE_DAYS,
) -> SegmentAttribution:
    """The segment / currency attribution of ``holdings_t0`` over ``start`` -> ``end`` (method in
    the module docstring). ``held_at_end``: instruments held at ``end`` (those not held at ``start``
    count as ``new_positions``)."""
    at_start = set(holdings_t0.held) | {h.instrument_id for h in holdings_t0.holdings}
    at_start |= set(holdings_t0.unvalued)
    new_positions = len(set(held_at_end) - at_start)
    stale: set[InstrumentId] = set(holdings_t0.unvalued)
    total = holdings_t0.total_base
    if total <= 0:
        return SegmentAttribution(
            start, end, new_positions=new_positions, stale=tuple(sorted(stale, key=str))
        )

    values: dict[InstrumentId, Decimal] = {}
    currency_of: dict[InstrumentId, Currency] = {}
    market: dict[InstrumentId, bool] = {}
    for h in holdings_t0.holdings:
        if h.value_base is None or h.value_base <= 0:
            continue
        values[h.instrument_id] = values.get(h.instrument_id, Decimal(0)) + h.value_base
        currency_of[h.instrument_id] = h.currency
        market[h.instrument_id] = market.get(h.instrument_id, False) or h.market
        if h.stale:
            stale.add(h.instrument_id)

    rows: dict[str | None, list[Item]] = {}
    by_currency: dict[str, list[Decimal]] = {}  # currency -> [V0 sum, contribution sum, rF]
    currency_total = Decimal(0)
    for iid, v0 in values.items():
        if not market[iid]:
            rows.setdefault(segment_of(iid), []).append((iid, v0, None))
            continue
        series = prices.get(iid, ())
        first = close_on_or_before(series, start)
        last = close_on_or_before(series, end)
        flagged = first is None or last is None
        flagged = flagged or days_between(first.date, start) > max_price_age_days
        flagged = flagged or days_between(last.date, end) > max_price_age_days
        if flagged:
            stale.add(iid)
        local = (
            last.close / first.close - 1
            if first is not None and last is not None and first.close > 0
            else Decimal(0)
        )
        currency = currency_of[iid]
        fx_ret = _fx_return(fx, currency, base, start, end)
        total_ret = (1 + local) * (1 + fx_ret) - 1
        rows.setdefault(segment_of(iid), []).append((iid, v0, local))
        fx_part = v0 * (total_ret - local)
        currency_total += fx_part
        if currency != base:
            entry = by_currency.setdefault(str(currency), [Decimal(0), Decimal(0), fx_ret])
            entry[0] += v0
            entry[1] += fx_part

    def move(segment: str | None, items: list[Item]) -> SegmentMove:
        v0 = sum((v for _, v, _ in items), Decimal(0))
        priced = [(v, r) for _, v, r in items if r is not None]
        priced_v0 = sum((v for v, _ in priced), Decimal(0))
        gain = sum((v * r for v, r in priced), Decimal(0))
        instruments = sorted(
            (
                InstrumentMove(
                    iid,
                    _ratio(v, total),
                    _ratio(v * r, total) if r is not None else 0.0,
                    float(r) + 0.0 if r is not None else None,
                )
                for iid, v, r in items
            ),
            key=lambda m: (-abs(m.contribution), m.ret is None, str(m.instrument_id)),
        )
        return SegmentMove(
            segment,
            _ratio(v0, total),
            _ratio(gain, total),
            float(gain / priced_v0) + 0.0 if priced_v0 > 0 else None,
            tuple(instruments),
        )

    segments = sorted(
        (move(key, items) for key, items in rows.items() if key is not None),
        key=lambda m: (-abs(m.contribution), m.segment or ""),
    )
    unassigned = move(None, rows[None]) if None in rows else None
    explained = (
        sum((v * r for items in rows.values() for _, v, r in items if r is not None), Decimal(0))
        + currency_total
    )
    currencies = sorted(
        (
            CurrencyMove(
                code, _ratio(entry[0], total), float(entry[2]) + 0.0, _ratio(entry[1], total)
            )
            for code, entry in by_currency.items()
        ),
        key=lambda c: (-abs(c.contribution), c.currency),
    )
    return SegmentAttribution(
        start=start,
        end=end,
        segments=tuple(segments),
        unassigned=unassigned,
        currency_contribution=_ratio(currency_total, total),
        currencies=tuple(currencies),
        explained=_ratio(explained, total),
        new_positions=new_positions,
        stale=tuple(sorted(stale, key=str)),
    )


# --------------------------------------------------------------------------- #
# Topic trends (P7)
# --------------------------------------------------------------------------- #

TREND_WINDOWS: tuple[int, ...] = (7, 28)
"""Days of ``trend_1w`` and ``trend_4w``."""


@dataclass(frozen=True, slots=True)
class MemberMove:
    instrument_id: InstrumentId
    held: bool
    """Held at ``end`` (else only watched)."""
    returns: tuple[float | None, ...]
    """Local price return per :data:`TREND_WINDOWS` window (None without usable closes)."""


@dataclass(frozen=True, slots=True)
class SegmentTrend:
    """A segment's price trend independent of the holdings' weights: the equal-weighted local
    return of its held and watched instruments."""

    segment: str
    trends: tuple[float | None, ...]
    """Per :data:`TREND_WINDOWS` window; None when no member has usable closes there."""
    members: int
    """Members with a usable return in the first (1w) window."""
    instruments: tuple[MemberMove, ...] = ()
    """Every member (held first, then by |1w return|)."""


def member_return(
    bars: Sequence[PriceBar], end: dt.date, days: int, max_price_age_days: int
) -> float | None:
    """The local return close on/before ``end - days`` -> close on/before ``end``; None when either
    close is missing, older than ``max_price_age_days`` before its day, or both are the same bar."""
    start = end - dt.timedelta(days=days)
    last = close_on_or_before(bars, end)
    first = close_on_or_before(bars, start)
    if last is None or first is None or first.close <= 0 or first.date >= last.date:
        return None
    if days_between(last.date, end) > max_price_age_days:
        return None
    if days_between(first.date, start) > max_price_age_days:
        return None
    return float(last.close / first.close - 1) + 0.0


@exact
def segment_trends(
    members: Mapping[InstrumentId, tuple[str, bool]],
    prices: Mapping[InstrumentId, Sequence[PriceBar]],
    end: dt.date,
    *,
    max_price_age_days: int = DEFAULT_MAX_PRICE_AGE_DAYS,
) -> dict[str, SegmentTrend]:
    """Per segment the equal-weighted local price return over each :data:`TREND_WINDOWS` window of
    its ``members`` (instrument -> (segment, held at ``end``)): held and watched instruments count
    alike, whatever their weight in the portfolio; an instrument without usable closes in a window
    is left out of that window's mean (:func:`member_return`). Every segment with a member is in the
    result (trends None when no member has prices)."""
    grouped: dict[str, list[MemberMove]] = {}
    for iid, (segment, held) in members.items():
        series = prices.get(iid, ())
        moves = tuple(member_return(series, end, d, max_price_age_days) for d in TREND_WINDOWS)
        grouped.setdefault(segment, []).append(MemberMove(iid, held, moves))
    out: dict[str, SegmentTrend] = {}
    for segment, items in grouped.items():
        trends = []
        for i in range(len(TREND_WINDOWS)):
            values = [m.returns[i] for m in items if m.returns[i] is not None]
            trends.append(sum(values) / len(values) + 0.0 if values else None)
        ordered = sorted(
            items,
            key=lambda m: (
                not m.held,
                m.returns[0] is None,
                -abs(m.returns[0] or 0.0),
                str(m.instrument_id),
            ),
        )
        out[segment] = SegmentTrend(
            segment,
            tuple(trends),
            sum(1 for m in items if m.returns[0] is not None),
            tuple(ordered),
        )
    return out
