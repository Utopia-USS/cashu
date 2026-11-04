"""Macro reference closes (P6, ``inv_macro_bars``; shared, not per profile) and the NBP USD/PLN rate
the dollar card reads: the last stored dates a refresh plans against, applying a ``MacroReport`` in
the caller's (short) write transaction, the closes the regimes read and a cheap data version for the
macro view cache."""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable, Sequence
from decimal import Decimal

from sqlalchemy import func
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlmodel import Session, select

from ..domain import Currency
from ..macro.refresh import MacroReport
from ..macro.series import SERIES_KEYS, USDPLN
from ..models import InvFxRate, InvMacroBar
from . import convert
from .market import FX_BASE

_CHUNK = 200
_SAME = Decimal("1e-9")
_PLACES = Decimal("0.000001")


def last_dates(session: Session) -> dict[str, dt.date]:
    """The newest stored close per series key."""
    rows = session.exec(
        select(InvMacroBar.series, func.max(InvMacroBar.date)).group_by(InvMacroBar.series)
    ).all()
    return {series: day for series, day in rows}


def upsert(
    session: Session,
    series: str,
    closes: Iterable[tuple[dt.date, object]],
    *,
    source: str,
    now: dt.datetime,
) -> int:
    rows = [
        {
            "series": series,
            "date": day,
            "close": close,
            "source": source,
            "fetched_at": convert.aware(now),
        }
        for day, close in closes
    ]
    table = InvMacroBar.__table__
    for start in range(0, len(rows), _CHUNK):
        statement = sqlite_insert(table).values(rows[start : start + _CHUNK])
        statement = statement.on_conflict_do_update(
            index_elements=["series", "date"],
            set_={c: statement.excluded[c] for c in ("close", "source", "fetched_at")},
        )
        session.exec(statement)
    return len(rows)


def apply_report(session: Session, report: MacroReport, *, now: dt.datetime) -> dict[str, int]:
    """Upsert a refresh's closes by (series, date) in the caller's transaction; for adjusted series
    the stored bars older than the fetched window are rescaled first (:func:`rescale_older`).
    Returns counts."""
    written = rescaled = 0
    for item in report.series:
        if not item.closes:
            continue
        if item.adjusted:
            rescaled += rescale_older(session, item.series, item.closes)
        written += upsert(session, item.series, item.closes, source=item.source or "yahoo", now=now)
    return {"macro_bars_written": written, "macro_bars_rescaled": rescaled}


def rescale_older(session: Session, series: str, closes: Sequence[tuple[dt.date, Decimal]]) -> int:
    """A distribution-adjusted history is restated by one factor for every date before a new payout:
    the stored bars older than the refetched window (never fetched again) are multiplied by the
    ratio new / stored on the oldest refetched date that has a stored bar, so the whole series keeps
    one adjustment basis. Returns the rows rescaled (0 when nothing changed)."""
    start, end = closes[0][0], closes[-1][0]
    stored = dict(
        session.exec(
            select(InvMacroBar.date, InvMacroBar.close).where(
                InvMacroBar.series == series, InvMacroBar.date >= start, InvMacroBar.date <= end
            )
        ).all()
    )
    factor = next((new / stored[day] for day, new in closes if stored.get(day)), None)
    if factor is None or abs(factor - 1) <= _SAME:
        return 0
    rows = session.exec(
        select(InvMacroBar).where(InvMacroBar.series == series, InvMacroBar.date < start)
    ).all()
    for row in rows:
        row.close = (row.close * factor).quantize(_PLACES)
        session.add(row)
    session.flush()
    return len(rows)


def closes(
    session: Session, *, until: dt.date, since: dt.date | None = None
) -> dict[str, list[tuple[dt.date, float]]]:
    """Closes per series key dated ``since..until`` (oldest first), plus the NBP USD/PLN rates under
    :data:`~cashu.modules.investments.macro.series.USDPLN`."""
    query = select(InvMacroBar.series, InvMacroBar.date, InvMacroBar.close).where(
        InvMacroBar.date <= until, InvMacroBar.series.in_(SERIES_KEYS)
    )
    if since is not None:
        query = query.where(InvMacroBar.date >= since)
    out: dict[str, list[tuple[dt.date, float]]] = {}
    for series, day, close in session.exec(query.order_by(InvMacroBar.series, InvMacroBar.date)):
        out.setdefault(series, []).append((day, float(close)))
    fx = select(InvFxRate.date, InvFxRate.rate).where(
        InvFxRate.base == FX_BASE, InvFxRate.quote == Currency.USD, InvFxRate.date <= until
    )
    if since is not None:
        fx = fx.where(InvFxRate.date >= since)
    rates = [(day, float(rate)) for day, rate in session.exec(fx.order_by(InvFxRate.date))]
    if rates:
        out[USDPLN] = rates
    return out


def data_version(session: Session) -> tuple:
    """Changes whenever a macro close or a USD/PLN rate is written (count, newest date, newest fetch
    time of each); two aggregate queries, cheap enough for every request."""
    bars = session.exec(
        select(func.count(), func.max(InvMacroBar.date), func.max(InvMacroBar.fetched_at))
    ).one()
    usd = session.exec(
        select(func.count(), func.max(InvFxRate.date), func.max(InvFxRate.fetched_at)).where(
            InvFxRate.base == FX_BASE, InvFxRate.quote == Currency.USD
        )
    ).one()
    return (*tuple(bars), *tuple(usd))
