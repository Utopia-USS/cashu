"""Builds the derived state of a profile (holdings, cash, deposits, realized trades) from its
transactions. Pure, no IO."""

from __future__ import annotations

from collections.abc import Collection, Iterable, Sequence
from decimal import Decimal

from ..domain import (
    AccountId,
    CalendarDate,
    CashHistoryGap,
    Holding,
    InstrumentId,
    InstrumentRename,
    MixedLotCurrencies,
    OpenLot,
    PortfolioSnapshot,
    PortfolioWarning,
    ProfileId,
    Transaction,
    exact,
)
from .last_trade_prices import last_trade_prices
from .lot_engine import run_lots


@exact
def build_snapshot(
    profile_id: ProfileId,
    txns: Iterable[Transaction],
    as_of: CalendarDate,
    *,
    profile_accounts: Collection[AccountId] | None = None,
    account_ids: Collection[AccountId] | None = None,
    renames: Sequence[InstrumentRename] = (),
) -> PortfolioSnapshot:
    """The :class:`PortfolioSnapshot` of a profile as of ``as_of``.

    Uses only transactions dated on/before ``as_of`` of the profile's accounts (``profile_accounts``;
    None = every account in ``txns`` belongs to the profile), restricted to ``account_ids`` when given.
    Holdings are one per (account, instrument) with a non-zero quantity, in order of first appearance;
    a holding's currency is its first lot's (lots in several currencies add :class:`MixedLotCurrencies`).
    A negative cash balance (deposits missing from the history, R2) adds a :class:`CashHistoryGap`.
    ``last_trade_prices`` comes from the same transactions. ``renames`` dated on/before ``as_of`` carry
    lots across (see :func:`run_lots`).
    """
    scoped = [
        t
        for t in txns
        if t.trade_date <= as_of
        and (profile_accounts is None or t.account_id in profile_accounts)
        and (account_ids is None or t.account_id in account_ids)
    ]
    active_renames = [r for r in renames if r.date <= as_of]
    result = run_lots(scoped, renames=active_renames)

    lots_by_position: dict[tuple[AccountId, InstrumentId], list[OpenLot]] = {}
    for lot in result.open_lots:
        lots_by_position.setdefault((lot.account_id, lot.instrument_id), []).append(lot)

    holdings: list[Holding] = []
    warnings: list[PortfolioWarning] = list(result.warnings)
    for (account_id, instrument_id), lots in lots_by_position.items():
        currencies = {lot.currency for lot in lots}
        if len(currencies) > 1:
            warnings.append(
                MixedLotCurrencies(
                    account_id=account_id,
                    instrument_id=instrument_id,
                    currencies=frozenset(currencies),
                )
            )
        holdings.append(
            Holding(
                account_id=account_id,
                instrument_id=instrument_id,
                currency=lots[0].currency,
                quantity=sum((lot.quantity for lot in lots), Decimal(0)),
                lots=tuple(lots),
            )
        )

    for balance in result.cash:
        if balance.amount < 0:
            warnings.append(
                CashHistoryGap(
                    account_id=balance.account_id,
                    currency=balance.currency,
                    amount=balance.amount,
                    as_of=as_of,
                )
            )

    return PortfolioSnapshot(
        profile_id=profile_id,
        as_of=as_of,
        holdings=tuple(holdings),
        cash=result.cash,
        deposits=result.deposits,
        realized=result.realized,
        last_trade_prices=last_trade_prices(scoped, as_of=as_of, renames=active_renames),
        warnings=tuple(warnings),
    )


def restrict_snapshot(
    snapshot: PortfolioSnapshot, account_ids: Collection[AccountId]
) -> PortfolioSnapshot:
    """``snapshot`` reduced to ``account_ids``: holdings, cash, deposits, realized trades and
    account-scoped warnings of other accounts are dropped (warnings without an account are kept).

    ``last_trade_prices`` stays whole: a price observed in another account is still the instrument's.
    """
    return PortfolioSnapshot(
        profile_id=snapshot.profile_id,
        as_of=snapshot.as_of,
        holdings=tuple(h for h in snapshot.holdings if h.account_id in account_ids),
        cash=tuple(c for c in snapshot.cash if c.account_id in account_ids),
        deposits=tuple(d for d in snapshot.deposits if d.account_id in account_ids),
        realized=tuple(r for r in snapshot.realized if r.account_id in account_ids),
        last_trade_prices=snapshot.last_trade_prices,
        warnings=tuple(
            w for w in snapshot.warnings if w.account_id is None or w.account_id in account_ids
        ),
    )
