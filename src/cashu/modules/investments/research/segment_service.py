"""Market segments of one profile (P5): the weekly / 4-week move attribution by segment and currency
(``performance.segment_attribution`` over the cached performance computation) joined with the
segment notes, for the API (``GET /research/segments``), the review digest and the MCP context.

The attribution is cached on the performance computation (``performance.service.compute``), so it
follows that cache's invalidation (transactions, renames, overrides incl. segments, manual valuations,
strategy, stored bars / rates, the date). Note facts (latest note, unread, counts) are read fresh.
Weights, returns and contributions are fractions; the payload carries no amounts.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from decimal import Decimal

from sqlmodel import Session, select

from cashu.core.models import Profile, utcnow

from ..domain import AssetClass, InstrumentId, MarketView, ValuationMode
from ..models import InvResearchNote
from ..performance import returns
from ..performance.segment_attribution import (
    SegmentAttribution,
    SegmentMove,
    StartHolding,
    StartPortfolio,
    attribute_segments,
    close_on_or_before,
)
from ..portfolio import build_snapshot, value_portfolio
from ..store import convert
from . import service
from .scoring import iso_week
from .segments import (
    UNASSIGNED,
    catalog_order,
    segment_group,
    segment_label,
    segment_of,
)
from .validation import EXPIRES_MAX_DAYS

WINDOWS: dict[str, int] = {"1w": 7, "4w": 28}
DEFAULT_WINDOW = "1w"
NOTES_WEEKS = 8
DIGEST_ROWS = 6
DIGITS = 6


class WindowError(ValueError):
    """Unknown attribution window (message safe to show)."""


def window_days(window: str) -> int:
    if window not in WINDOWS:
        raise WindowError(f"window must be one of {', '.join(WINDOWS)}")
    return WINDOWS[window]


def _r(value: float | None) -> float | None:
    return None if value is None else round(float(value), DIGITS) + 0.0  # never -0.0


# --------------------------------------------------------------------------- #
# Attribution (cached on the performance computation)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Attributed:
    attribution: SegmentAttribution
    portfolio_return: float | None
    """Time-weighted return of the whole portfolio over the window; None when the series is
    incomplete there (or the portfolio did not exist at the start)."""
    labels: dict[InstrumentId, str]
    base: str
    end: dt.date


def _portfolio_return(computed, start: dt.date, end: dt.date) -> float | None:
    series = computed.series
    if not computed.has_history or not series.dates or start < series.dates[0]:
        return None
    i0 = (start - series.dates[0]).days
    i1 = (end - series.dates[0]).days
    if i1 >= len(series.dates) or i1 <= i0:
        return None
    combined = computed.combined()
    window = slice(i0, i1 + 1)
    complete = combined.complete[window]
    if not all(complete):
        return None
    index = returns.twr_index(combined.values[window], combined.flows[window], complete)
    return returns.period_return(index)


def _any_rate(fx, currency, base, day: dt.date) -> Decimal | None:
    """The nearest rate on or before ``day`` whatever its age (attribution only)."""
    if currency == base:
        return Decimal(1)
    quote = fx.quote_on_or_before(currency, day, base)
    return None if quote is None else quote.rate


def _fallback_value(v, view: MarketView, snapshot, fx, base, start: dt.date) -> Decimal | None:
    """A holding the valuation left without a value at ``start`` (missing or too old price / rate,
    missing cost basis rate), valued from the nearest close and rate on or before ``start`` whatever
    their age; None when there is no price or no rate at all."""
    holding, inst = v.holding, v.instrument
    if v.valuation_mode == ValuationMode.COST:
        cost = holding.cost_basis
        rate = _any_rate(fx, holding.currency, base, start)
        return None if cost is None or rate is None else cost * rate
    if v.valuation_mode == ValuationMode.MANUAL:
        manual = view.manual_valuation(holding.instrument_id, start)
        if manual is None:
            return None
        rate = _any_rate(fx, manual.currency, base, start)
        return None if rate is None else holding.quantity * manual.unit_value * rate
    bar = close_on_or_before(view.series(holding.instrument_id), start)
    if bar is not None:
        price, currency = bar.close, inst.currency
    else:
        last = snapshot.last_trade_prices.get(holding.instrument_id)
        if last is None or last.date > start:
            return None
        price, currency = last.price, last.currency
    rate = _any_rate(fx, currency, base, start)
    return None if rate is None else holding.quantity * price * rate


def _start_portfolio(loaded, start: dt.date) -> StartPortfolio:
    """The holdings at ``start`` with their base values (the valuation's, else the fallback of
    :func:`_fallback_value`, flagged stale), ``T0`` and the instruments held there."""
    then = build_snapshot(
        convert.sid(loaded.profile_id), loaded.txns, start, renames=loaded.renames
    )
    held = {h.instrument_id for h in then.holdings}
    view = MarketView(
        as_of=start,
        instruments={k: v for k, v in loaded.instruments.items() if k in held},
        bars={k: tuple(b for b in loaded.bars.get(k, ()) if b.date <= start) for k in held},
        manual_valuations={k: v for k, v in loaded.manual.items() if k in held},
    )
    valued = value_portfolio(
        then,
        view,
        loaded.fx,
        loaded.base,
        loaded.policy.max_price_age_days,
        max_fx_age_days=loaded.policy.max_fx_age_days,
    )
    total = valued.total_base
    holdings: list[StartHolding] = []
    unvalued: set[InstrumentId] = set()
    for v in valued.valued:
        cash_like = v.instrument.asset_class == AssetClass.CASH
        value, stale = v.market_value_base, v.is_stale
        if value is None:
            value = _fallback_value(v, view, then, loaded.fx, loaded.base, start)
            if value is None:
                unvalued.add(v.holding.instrument_id)
                continue
            total += value
            stale = True
        if cash_like:
            continue  # in T0 only
        holdings.append(
            StartHolding(
                v.holding.instrument_id,
                v.instrument.currency,
                value,
                market=v.valuation_mode == ValuationMode.MARKET,
                stale=stale,
            )
        )
    for c in valued.cash:
        if c.amount_base is None and c.cash.amount > 0:  # no usable rate: the nearest one
            rate = _any_rate(loaded.fx, c.currency, loaded.base, start)
            if rate is not None:
                total += c.cash.amount * rate
    valued_ids = {h.instrument_id for h in holdings}
    return StartPortfolio(
        total, tuple(holdings), tuple(sorted(unvalued - valued_ids, key=str)), tuple(held)
    )


def _attribute(computed, days: int) -> Attributed:
    loaded = computed.loaded
    end = computed.end
    start = end - dt.timedelta(days=days)
    labels = {k: v.label for k, v in loaded.instruments.items()}
    if not loaded.txns:
        return Attributed(SegmentAttribution(start, end), None, labels, str(loaded.base), end)
    now_held = build_snapshot(
        convert.sid(loaded.profile_id), loaded.txns, end, renames=loaded.renames
    )

    def segment_key(iid: InstrumentId) -> str | None:
        inst = loaded.instruments.get(iid)
        return None if inst is None else segment_of(inst, inst.segment, inst.segment_by)[0]

    attribution = attribute_segments(
        _start_portfolio(loaded, start),
        loaded.bars,
        loaded.fx,
        loaded.base,
        start,
        end,
        segment_key,
        held_at_end={h.instrument_id for h in now_held.holdings},
        max_price_age_days=loaded.policy.max_price_age_days,
    )
    return Attributed(
        attribution, _portfolio_return(computed, start, end), labels, str(loaded.base), end
    )


def attribution(
    session: Session,
    profile: Profile,
    *,
    window: str = DEFAULT_WINDOW,
    as_of: dt.date | None = None,
) -> Attributed:
    """The cached attribution of ``window`` ending on ``as_of`` (today by default)."""
    from ..performance import service as perf

    days = window_days(window)
    computed = perf.compute(session, profile, as_of=as_of)
    key = ("segments", window)
    found = computed.extras.get(key)
    if found is None:
        found = _attribute(computed, days)
        computed.extras[key] = found
    return found


# --------------------------------------------------------------------------- #
# Segment notes
# --------------------------------------------------------------------------- #


@dataclass
class SegmentNotes:
    latest: InvResearchNote | None = None
    """The newest active note (not dismissed, not expired)."""
    newest: InvResearchNote | None = None
    """The newest stored note (not dismissed; expired ones count)."""
    unread: int = 0
    notes_8w: int = 0


def segment_note_rows(
    session: Session, profile_id: int, since: dt.datetime
) -> list[InvResearchNote]:
    return list(
        session.exec(
            select(InvResearchNote).where(
                InvResearchNote.profile_id == profile_id,
                InvResearchNote.segment.is_not(None),
                InvResearchNote.observed_at >= since,
            )
        ).all()
    )


def notes_by_segment(
    session: Session, profile_id: int, now: dt.datetime
) -> dict[str, SegmentNotes]:
    """Per segment: the newest active note, the newest stored one, unread agent notes and the notes
    stored in the last 8 weeks (dismissed ones left out)."""
    since_8w = now - dt.timedelta(weeks=NOTES_WEEKS)
    rows = segment_note_rows(
        session, profile_id, now - dt.timedelta(days=max(7 * NOTES_WEEKS, EXPIRES_MAX_DAYS) + 1)
    )
    out: dict[str, SegmentNotes] = {}

    def newer(a: InvResearchNote | None, b: InvResearchNote) -> bool:
        return a is None or (convert.aware(b.observed_at), b.id) > (
            convert.aware(a.observed_at),
            a.id,
        )

    for r in rows:
        if r.dismissed_at is not None:
            continue
        entry = out.setdefault(r.segment, SegmentNotes())
        if newer(entry.newest, r):
            entry.newest = r
        if convert.aware(r.expires_at) > now and newer(entry.latest, r):
            entry.latest = r
        if service.is_unread(r, now):
            entry.unread += 1
        if convert.aware(r.observed_at) >= since_8w:
            entry.notes_8w += 1
    return out


def brief_note(row: InvResearchNote | None) -> dict | None:
    from .views import iso

    if row is None:
        return None
    return {
        "id": row.id,
        "title": row.title,
        "observed_at": iso(convert.aware(row.observed_at)),
        "polarity": row.polarity,
        "kind": row.kind,
        "strength": row.strength,
    }


# --------------------------------------------------------------------------- #
# The view
# --------------------------------------------------------------------------- #


def _instruments(move: SegmentMove, labels: dict[InstrumentId, str]) -> list[dict]:
    return [
        {
            "instrument_id": convert.maybe_pk(m.instrument_id),
            "label": labels.get(m.instrument_id),
            "weight": _r(m.weight),
            "contribution": _r(m.contribution),
            "return": _r(m.ret),
        }
        for m in move.instruments
    ]


def _row(
    key: str,
    move: SegmentMove | None,
    notes: SegmentNotes | None,
    labels: dict[InstrumentId, str],
    now: dt.datetime,
) -> dict:
    latest = notes.latest if notes is not None else None
    return {
        "segment": key,
        "label": segment_label(key),
        "group": segment_group(key),
        "weight": _r(move.weight) if move is not None else 0.0,
        "contribution": _r(move.contribution) if move is not None else 0.0,
        "return": _r(move.ret) if move is not None else None,
        "instruments": _instruments(move, labels) if move is not None else [],
        "note": brief_note(latest),
        "note_this_week": latest is not None
        and iso_week(convert.aware(latest.observed_at).date()) == iso_week(now.date()),
        "unread": notes.unread if notes is not None else 0,
        "notes_8w": notes.notes_8w if notes is not None else 0,
        "last_note_at": brief_note(notes.newest)["observed_at"]
        if notes is not None and notes.newest is not None
        else None,
    }


def segments_view(
    session: Session,
    profile: Profile,
    *,
    window: str = DEFAULT_WINDOW,
    as_of: dt.date | None = None,
    now: dt.datetime | None = None,
) -> dict:
    """``GET /research/segments``: the attribution of ``window`` by segment (segments with exposure
    at the start plus segments with an active note and no exposure), the unassigned row, currency,
    the portfolio's own return and the residual, each segment with its latest note."""
    assert profile.id is not None
    now = convert.aware(now or utcnow())
    found = attribution(session, profile, window=window, as_of=as_of)
    result = found.attribution
    notes = notes_by_segment(session, profile.id, now)
    moves = {m.segment: m for m in result.segments if m.segment is not None}
    keys = set(moves) | {k for k, n in notes.items() if n.latest is not None}
    rows = [_row(k, moves.get(k), notes.get(k), found.labels, now) for k in keys]
    rows.sort(key=lambda r: (-abs(r["contribution"] or 0.0), catalog_order(r["segment"])))
    unassigned = result.unassigned
    explained = _r(result.explained)
    portfolio_return = _r(found.portfolio_return)
    return {
        "as_of": found.end.isoformat(),
        "start": result.start.isoformat(),
        "end": result.end.isoformat(),
        "window": window,
        "base_currency": found.base,
        "portfolio_return": portfolio_return,
        "explained": explained,
        "residual": None
        if portfolio_return is None
        else _r(found.portfolio_return - result.explained),
        "new_positions": result.new_positions,
        "stale": [convert.maybe_pk(i) for i in result.stale],
        "segments": rows,
        "unassigned": None
        if unassigned is None
        else {
            "segment": UNASSIGNED,
            "label": segment_label(UNASSIGNED),
            "weight": _r(unassigned.weight),
            "contribution": _r(unassigned.contribution),
            "return": _r(unassigned.ret),
            "instruments": _instruments(unassigned, found.labels),
        },
        "currency": {
            "contribution": _r(result.currency_contribution),
            "currencies": [
                {
                    "currency": c.currency,
                    "weight": _r(c.weight),
                    "return": _r(c.ret),
                    "contribution": _r(c.contribution),
                }
                for c in result.currencies
            ],
        },
    }
