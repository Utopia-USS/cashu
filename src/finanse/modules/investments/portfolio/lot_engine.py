"""FIFO lot matching: turns transactions into open lots, realized trades and cash. Pure, no IO."""

from __future__ import annotations

from collections import deque
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Context, Decimal
from fractions import Fraction

from ..domain import (
    AccountId,
    CalendarDate,
    CashBalance,
    Currency,
    DatedAmount,
    HistoryGap,
    InstrumentId,
    InstrumentRename,
    InvalidTransaction,
    Money,
    OpenLot,
    PortfolioWarning,
    RealizedCurrencyMismatch,
    RealizedTrade,
    Transaction,
    TxnId,
    TxnType,
    UnknownCostBasis,
    chronological_key,
    divided_by,
    exact,
)
from .split_ratio import decimal_places, split_fraction

SPLIT_REMAINDER_TOLERANCE = Fraction(1, 10**9)
"""Units of split dust forgiven when a sell or transfer-out meets a lot. After a split like 1:15 a lot
can hold a quantity with no finite decimal (1000 shares -> 200/3), which a broker's decimal quantity
never matches exactly: selling 66.6666666667 (all of it) or 0.6666666667 (cash in lieu of the fraction)
would leave 3.3E-11 or 65.99999999996667. When what a request leaves in the lot has no finite decimal
and is within this tolerance of a whole number of units, the lot keeps exactly that whole number (0 =
the lot is closed; no dust lot, no :class:`HistoryGap`). Remainders with a finite decimal are never
snapped: decimal histories are matched exactly."""

QUANTITY_DIGITS = 20
"""Significant digits of a reported quantity that has no finite decimal (7/15 ->
0.46666666666666666667); finite quantities are reported exactly."""


@dataclass(frozen=True, slots=True)
class LotEngineResult:
    """Output of :func:`run_lots`."""

    open_lots: tuple[OpenLot, ...] = ()
    """Grouped by (account, instrument) in order of first appearance, FIFO order inside a group."""
    realized: tuple[RealizedTrade, ...] = ()
    """FIFO matches of sells, in processing order."""
    cash: tuple[CashBalance, ...] = ()
    """Non-zero cash per (account, currency): the sum of ``cash_amount`` in ``cash_currency``."""
    deposits: tuple[DatedAmount, ...] = ()
    """``deposit`` transactions (their ``cash_amount`` in ``cash_currency``), oldest first."""
    warnings: tuple[PortfolioWarning, ...] = ()
    """History gaps, unknown cost bases, currency mismatches and ignored transactions, in order."""


@exact
def run_lots(
    txns: Iterable[Transaction],
    *,
    account_ids: Collection[AccountId] | None = None,
    renames: Sequence[InstrumentRename] = (),
) -> LotEngineResult:
    """FIFO lot engine over ``txns`` (any order; sorted by :func:`chronological_key` here).

    Rules (port of the Kompas ``LotEngine``):

    - ``buy`` opens a lot; cost = gross + fee + tax (all in the transaction currency).
    - ``sell`` consumes lots FIFO; proceeds = gross - fee - tax, shared over the matched units (the last
      match of a fully covered sell takes the remainder, so proceeds add up exactly). Each match is a
      :class:`RealizedTrade`; when the sell's currency differs from the lot's, its ``pnl`` is None and a
      :class:`RealizedCurrencyMismatch` is recorded (two currencies are never subtracted).
    - ``transfer_in`` and ``adjustment`` open a lot at ``price`` (cost = price * quantity); a missing or
      zero price means unknown cost (:class:`UnknownCostBasis`). Transfer fees are not part of the cost.
    - ``transfer_out`` consumes lots FIFO without realizing anything.
    - ``split`` multiplies the open quantities of that account's lots by ``split_ratio`` read as an
      exact fraction (:func:`split_fraction`: ``0.3333333333`` is 1:3); total cost is unchanged, so the
      unit cost is divided by the ratio. Lot quantities are exact fractions inside the engine, so 30
      shares after 1:3 are exactly 10 and a sell of 10 closes them; a quantity with no finite decimal
      (1000 shares after 1:15) is matched by a broker's rounded decimal within
      :data:`SPLIT_REMAINDER_TOLERANCE` and reported with :data:`QUANTITY_DIGITS` digits.
    - Selling or transferring out more than held never raises: the matched part is processed and a
      :class:`HistoryGap` records the shortfall.
    - Every transaction's ``cash_amount`` adds to the cash of (account, ``cash_currency``).
    - ``renames`` take effect at the start of their date (before that day's transactions): open lots of
      the old instrument move to the new one in every account (cost, currency and open date kept; no
      realized trade), and later transactions naming the old instrument count for the new one.

    Lot costs are exact totals, so partial sells never lose cost to rounding: a partial match takes
    ``cost * matched / quantity`` (``divided_by``) and the lot keeps the exact remainder. Accounts are
    kept apart; only transactions of ``account_ids`` are used when given.
    """
    selected = [t for t in txns if account_ids is None or t.account_id in account_ids]
    state = _EngineState()
    for event in _events(selected, renames):
        if isinstance(event, InstrumentRename):
            state.rename(event)
        else:
            state.apply(event)
    return state.result()


def _events(
    txns: Sequence[Transaction], renames: Sequence[InstrumentRename]
) -> list[Transaction | InstrumentRename]:
    """Transactions in chronological order with each rename placed before the first transaction of its
    date (renames of one date keep their given order)."""
    keyed: list[tuple[tuple, Transaction | InstrumentRename]] = [
        ((t.trade_date, 1, chronological_key(t)), t) for t in txns
    ]
    keyed += [((r.date, 0, (index,)), r) for index, r in enumerate(renames)]
    keyed.sort(key=lambda item: item[0])
    return [event for _, event in keyed]


def _to_decimal(value: Fraction) -> Decimal:
    """``value`` exactly when it has a finite decimal, else rounded to :data:`QUANTITY_DIGITS`
    significant digits (half-up)."""
    places = decimal_places(value)
    if places is None:
        return Context(prec=QUANTITY_DIGITS, rounding=ROUND_HALF_UP).divide(
            Decimal(value.numerator), Decimal(value.denominator)
        )
    return Decimal(f"{value.numerator * (10**places // value.denominator)}E-{places}")


def _rounded(value: Fraction) -> Decimal:
    """``value`` rounded like :func:`divided_by` (half-up, 10 places): unit costs and cost shares."""
    return divided_by(Decimal(value.numerator), Decimal(value.denominator))


def _snapped_remainder(left: Fraction) -> int | None:
    """The whole number of units a lot keeps when a request would leave ``left`` (negative: the request
    exceeds the lot) and ``left`` is split dust away from it (:data:`SPLIT_REMAINDER_TOLERANCE`), else
    None (the request is matched exactly)."""
    if decimal_places(left) is not None:
        return None
    nearest = round(left)
    if nearest < 0 or abs(left - nearest) > SPLIT_REMAINDER_TOLERANCE:
        return None
    return nearest


class _Lot:
    """A mutable lot while the engine runs. ``quantity`` is exact (a fraction: splits like 1:3 have no
    finite decimal), ``cost`` the exact total cost (None = unknown)."""

    __slots__ = (
        "account_id",
        "cost",
        "currency",
        "instrument_id",
        "open_date",
        "open_txn_id",
        "quantity",
    )

    def __init__(
        self,
        account_id: AccountId,
        instrument_id: InstrumentId,
        open_txn_id: TxnId,
        open_date: CalendarDate,
        currency: Currency,
        quantity: Fraction,
        cost: Decimal | None,
    ) -> None:
        self.account_id = account_id
        self.instrument_id = instrument_id
        self.open_txn_id = open_txn_id
        self.open_date = open_date
        self.currency = currency
        self.quantity = quantity
        self.cost = cost

    def to_open_lot(self) -> OpenLot:
        return OpenLot(
            account_id=self.account_id,
            instrument_id=self.instrument_id,
            open_txn_id=self.open_txn_id,
            open_date=self.open_date,
            quantity=_to_decimal(self.quantity),
            currency=self.currency,
            unit_cost=None if self.cost is None else _rounded(Fraction(self.cost) / self.quantity),
        )


@dataclass(slots=True)
class _Match:
    lot: _Lot
    quantity: Fraction
    """Units the request matched (reported on the realized trade)."""
    taken: Fraction
    """Units taken from the lot: ``quantity`` except for split dust (:func:`_snapped_remainder`)."""
    cost: Decimal | None
    """Exact cost of ``taken``."""


class _EngineState:
    def __init__(self) -> None:
        self._lots: dict[tuple[AccountId, InstrumentId], deque[_Lot]] = {}
        self._cash: dict[tuple[AccountId, Currency], Decimal] = {}
        self._realized: list[RealizedTrade] = []
        self._deposits: list[DatedAmount] = []
        self._warnings: list[PortfolioWarning] = []
        self._redirect: dict[InstrumentId, InstrumentId] = {}

    # --- renames ---------------------------------------------------------------------------------

    def _resolve(self, instrument_id: InstrumentId | None) -> InstrumentId | None:
        seen: set[InstrumentId] = set()
        while instrument_id is not None and instrument_id in self._redirect:
            if instrument_id in seen:  # a cycle of renames: stop at the last hop
                break
            seen.add(instrument_id)
            instrument_id = self._redirect[instrument_id]
        return instrument_id

    def rename(self, rename: InstrumentRename) -> None:
        old = self._resolve(rename.old_instrument_id)
        new = self._resolve(rename.new_instrument_id)
        if old is None or new is None or old == new:
            return
        self._redirect[old] = new
        for key in [k for k in self._lots if k[1] == old]:
            account_id = key[0]
            moved = self._lots.pop(key)
            for lot in moved:
                lot.instrument_id = new
            target = self._lots.setdefault((account_id, new), deque())
            merged = sorted([*moved, *target], key=lambda lot: lot.open_date)
            target.clear()
            target.extend(merged)

    # --- transactions ----------------------------------------------------------------------------

    def apply(self, txn: Transaction) -> None:
        key = (txn.account_id, txn.cash_currency)
        self._cash[key] = self._cash.get(key, Decimal(0)) + txn.cash_amount
        match txn.type:
            case TxnType.BUY:
                self._open(txn, txn.gross_amount + txn.fee + txn.tax)
            case TxnType.TRANSFER_IN | TxnType.ADJUSTMENT:
                self._open_at_price(txn)
            case TxnType.SELL:
                self._sell(txn)
            case TxnType.TRANSFER_OUT:
                position = self._position(txn)
                if position is not None:
                    self._consume(txn, *position)
            case TxnType.SPLIT:
                self._split(txn)
            case TxnType.DEPOSIT:
                self._deposits.append(
                    DatedAmount(
                        account_id=txn.account_id,
                        date=txn.trade_date,
                        amount=Money(txn.cash_amount, txn.cash_currency),
                    )
                )
            case _:
                pass  # dividend, withdrawal, fee, tax, interest, fx_conversion: cash only

    def _open_at_price(self, txn: Transaction) -> None:
        price, quantity = txn.price, txn.quantity
        known = price is not None and price > 0
        cost = price * quantity if known and quantity is not None else None
        if self._open(txn, cost) and not known:
            self._warnings.append(
                UnknownCostBasis(
                    account_id=txn.account_id,
                    instrument_id=self._resolve(txn.instrument_id),
                    txn_id=txn.id,
                    date=txn.trade_date,
                )
            )

    def _open(self, txn: Transaction, cost: Decimal | None) -> bool:
        """Opens a lot of the transaction's quantity with total ``cost``; False (plus a warning) when
        the transaction cannot open one."""
        position = self._position(txn)
        if position is None:
            return False
        instrument_id, quantity = position
        self._lots.setdefault((txn.account_id, instrument_id), deque()).append(
            _Lot(
                account_id=txn.account_id,
                instrument_id=instrument_id,
                open_txn_id=txn.id,
                open_date=txn.trade_date,
                currency=txn.currency,
                quantity=Fraction(quantity),
                cost=cost,
            )
        )
        return True

    def _sell(self, txn: Transaction) -> None:
        position = self._position(txn)
        if position is None:
            return
        instrument_id, quantity = position
        proceeds = txn.gross_amount - txn.fee - txn.tax
        close_unit_price = divided_by(proceeds, quantity)
        matches, shortfall = self._consume(txn, instrument_id, quantity)
        mismatched: set[Currency] = set()
        allocated = Decimal(0)
        for index, match in enumerate(matches):
            is_last = index == len(matches) - 1 and shortfall == 0
            share = (
                proceeds - allocated
                if is_last
                else _rounded(Fraction(proceeds) * match.quantity / Fraction(quantity))
            )
            allocated += share
            same_currency = match.lot.currency == txn.currency
            self._realized.append(
                RealizedTrade(
                    account_id=txn.account_id,
                    instrument_id=instrument_id,
                    open_txn_id=match.lot.open_txn_id,
                    close_txn_id=txn.id,
                    open_date=match.lot.open_date,
                    close_date=txn.trade_date,
                    quantity=_to_decimal(match.quantity),
                    close_unit_price=close_unit_price,
                    currency=txn.currency,
                    cost_currency=match.lot.currency,
                    open_unit_cost=None
                    if match.cost is None
                    else _rounded(Fraction(match.cost) / match.taken),
                    pnl=None if match.cost is None or not same_currency else share - match.cost,
                )
            )
            if not same_currency:
                mismatched.add(match.lot.currency)
        if mismatched:
            self._warnings.append(
                RealizedCurrencyMismatch(
                    account_id=txn.account_id,
                    instrument_id=instrument_id,
                    txn_id=txn.id,
                    date=txn.trade_date,
                    sale_currency=txn.currency,
                    lot_currencies=frozenset(mismatched),
                )
            )

    def _split(self, txn: Transaction) -> None:
        instrument_id = self._resolve(txn.instrument_id)
        ratio = txn.split_ratio
        if instrument_id is None:
            self._invalid(txn, "missing instrument")
            return
        if ratio is None or ratio <= 0:
            self._invalid(txn, "missing or non-positive split ratio")
            return
        exact_ratio = split_fraction(ratio)
        for lot in self._lots.get((txn.account_id, instrument_id), ()):
            lot.quantity *= exact_ratio

    def _consume(
        self, txn: Transaction, instrument_id: InstrumentId, quantity: Decimal
    ) -> tuple[list[_Match], Fraction]:
        """Takes ``quantity`` units FIFO from the lots of (account, instrument); records a
        :class:`HistoryGap` for any shortfall. A request that would leave split dust in a lot leaves a
        whole number of units instead (:func:`_snapped_remainder`)."""
        queue = self._lots.get((txn.account_id, instrument_id), deque())
        matches: list[_Match] = []
        remaining = Fraction(quantity)
        while remaining > 0 and queue:
            lot = queue[0]
            kept = _snapped_remainder(lot.quantity - remaining)
            if kept is not None and kept < lot.quantity:
                matched, take = remaining, lot.quantity - kept
            else:
                matched = take = min(lot.quantity, remaining)
            lot_cost = lot.cost
            if lot_cost is None or take == lot.quantity:
                cost = lot_cost
            else:
                cost = _rounded(Fraction(lot_cost) * take / lot.quantity)
            matches.append(_Match(lot=lot, quantity=matched, taken=take, cost=cost))
            lot.quantity -= take
            if lot_cost is not None and cost is not None:
                lot.cost = lot_cost - cost
            if lot.quantity == 0:
                queue.popleft()
            remaining -= matched
        if remaining > 0:
            self._warnings.append(
                HistoryGap(
                    account_id=txn.account_id,
                    instrument_id=instrument_id,
                    date=txn.trade_date,
                    shortfall=_to_decimal(remaining),
                    txn_id=txn.id,
                )
            )
        return matches, remaining

    def _position(self, txn: Transaction) -> tuple[InstrumentId, Decimal] | None:
        """The (renamed) instrument and a positive quantity of a trade-like transaction, or None after a
        warning."""
        instrument_id = self._resolve(txn.instrument_id)
        if instrument_id is None:
            self._invalid(txn, "missing instrument")
            return None
        if txn.quantity is None or txn.quantity == 0:
            self._invalid(txn, "missing or zero quantity")
            return None
        return instrument_id, txn.quantity

    def _invalid(self, txn: Transaction, reason: str) -> None:
        self._warnings.append(
            InvalidTransaction(
                account_id=txn.account_id, txn_id=txn.id, date=txn.trade_date, reason=reason
            )
        )

    def result(self) -> LotEngineResult:
        return LotEngineResult(
            open_lots=tuple(lot.to_open_lot() for queue in self._lots.values() for lot in queue),
            realized=tuple(self._realized),
            cash=tuple(
                CashBalance(account_id=account_id, currency=currency, amount=amount)
                for (account_id, currency), amount in self._cash.items()
                if amount != 0
            ),
            deposits=tuple(self._deposits),
            warnings=tuple(self._warnings),
        )
