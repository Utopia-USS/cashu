"""``history_metrics``: retrospective behaviour metrics computed locally from the profile's investments
history (transactions, FIFO realized trades, stored daily closes). Only counts, days, dates and
percentages leave the machine (amounts in the ``amounts`` privacy mode are not needed here at all).

- activity: trades, first / last trade, days since the last one, gaps between trades (median, max,
  how many longer than 90 / 180 days);
- deposits per year (count) and withdrawals per year (count);
- sells after drawdowns: per sell, the instrument's close vs its 252-day high on the sale date;
  how many sells came 15 % or more below the high;
- buys after run-ups: per buy, the close vs the close 90 days earlier; how many buys came after a
  rise of 20 % or more;
- after sales: the price change 30 / 90 / 180 days after each sale (median, share that rose);
- holding days of winners vs losers (realized FIFO matches, base-currency result);
- fees as % of turnover (per trade currency: fees / gross of buys and sells);
- concentration over time: quarter-end weights of the largest position and of the top 3.

Not measured here (later, with performance metrics): returns vs a benchmark, max drawdown, profit
concentration, rolling relative performance.
"""

from __future__ import annotations

import bisect
import datetime as dt
import statistics
from collections import Counter, defaultdict
from decimal import Decimal
from itertools import pairwise

from .. import labels as L
from ..registry import ToolContext

DRAWDOWN_SELL = 0.15
RUNUP_BUY = 0.20
RUNUP_DAYS = 90
HORIZONS = (30, 90, 180)
MAX_CONCENTRATION_POINTS = 40


def _close_on(bars, dates, day: dt.date):
    """The newest close on or before ``day`` (None when there is none within 7 days)."""
    i = bisect.bisect_right(dates, day) - 1
    if i < 0 or (day - dates[i]).days > 7:
        return None
    return bars[i].close


def _quarter_ends(start: dt.date, end: dt.date) -> list[dt.date]:
    out = []
    year, q = start.year, (start.month - 1) // 3 + 1
    while True:
        month = q * 3
        nxt = dt.date(year + (month == 12), month % 12 + 1, 1)
        day = nxt - dt.timedelta(days=1)
        if day > end:
            break
        out.append(day)
        q += 1
        if q == 5:
            year, q = year + 1, 1
    out.append(end)
    return out[-MAX_CONCENTRATION_POINTS:]


def _median(values):
    return statistics.median(values) if values else None


def history_metrics(ctx: ToolContext) -> dict:
    from cashu.modules.investments.domain import TxnType
    from cashu.modules.investments.service import portfolio
    from cashu.modules.investments.service import strategy as strategy_files
    from cashu.modules.investments.store import convert, market, transactions

    s, profile = ctx.session, ctx.profile
    txns = transactions.transactions(s, ctx.profile_id)
    if not txns:
        return {"note": L.text("no investments history yet"), "trades": L.count(0)}
    trades = sorted(
        (t for t in txns if t.type in (TxnType.BUY, TxnType.SELL)), key=lambda t: t.trade_date
    )
    trade_dates = sorted({t.trade_date for t in trades})
    gaps = [(b - a).days for a, b in pairwise(trade_dates)]
    deposits = Counter(t.trade_date.year for t in txns if t.type == TxnType.DEPOSIT)
    withdrawals = Counter(t.trade_date.year for t in txns if t.type == TxnType.WITHDRAWAL)

    ids = {convert.pk(t.instrument_id) for t in trades if t.instrument_id}
    series = market.bars(s, ids, until=ctx.today)
    index = {k: [b.date for b in v] for k, v in series.items()}

    sells_after_dd = sells_checked = 0
    buys_after_runup = buys_checked = 0
    after_sale: dict[int, list[float]] = defaultdict(list)
    drawdowns_at_sale: list[float] = []
    for t in trades:
        bars = series.get(t.instrument_id or "")
        if not bars:
            continue
        dates = index[t.instrument_id]
        close = _close_on(bars, dates, t.trade_date)
        if close is None or close <= 0:
            continue
        if t.type == TxnType.SELL:
            window = [
                b.close
                for b in bars
                if t.trade_date - dt.timedelta(days=365) <= b.date <= t.trade_date
            ]
            if window:
                high = max(window)
                dd = float(1 - close / high) if high else 0.0
                drawdowns_at_sale.append(dd)
                sells_checked += 1
                sells_after_dd += dd >= DRAWDOWN_SELL
            for h in HORIZONS:
                later_day = t.trade_date + dt.timedelta(days=h)
                if later_day > ctx.today:
                    continue
                later = _close_on(bars, dates, later_day)
                if later is not None:
                    after_sale[h].append(float(later / close - 1))
        else:
            before = _close_on(bars, dates, t.trade_date - dt.timedelta(days=RUNUP_DAYS))
            if before is not None and before > 0:
                buys_checked += 1
                buys_after_runup += float(close / before - 1) >= RUNUP_BUY

    st = strategy_files.load(s, profile)
    state = portfolio.build(s, profile, strategy=st.config, as_of=ctx.today)
    winners, losers = [], []
    for r in state.valued.realized:
        pnl = r.pnl_base if r.pnl_base is not None else r.trade.pnl
        if pnl is None:
            continue
        days = (r.trade.close_date - r.trade.open_date).days
        (winners if pnl > 0 else losers).append(days)

    fees: dict[str, list[Decimal]] = defaultdict(lambda: [Decimal(0), Decimal(0)])
    for t in trades:
        fees[str(t.currency)][0] += t.fee or Decimal(0)
        fees[str(t.currency)][1] += t.gross_amount or Decimal(0)

    concentration = []
    first = trade_dates[0] if trade_dates else min(t.trade_date for t in txns)
    for day in _quarter_ends(first, ctx.today):
        point = portfolio.build(s, profile, strategy=st.config, as_of=day)
        weights = sorted(
            (v.weight for v in point.valued.valued if v.weight is not None), reverse=True
        )
        concentration.append(
            {
                "date": L.date(day),
                "positions": L.count(len(weights)),
                "largest": L.pct(weights[0] if weights else None),
                "top3": L.pct(sum(weights[:3]) if weights else None),
            }
        )

    return {
        "activity": {
            "trades": L.count(len(trades)),
            "first_trade": L.date(trade_dates[0] if trade_dates else None),
            "last_trade": L.date(trade_dates[-1] if trade_dates else None),
            "days_since_last_trade": L.count(
                (ctx.today - trade_dates[-1]).days if trade_dates else None
            ),
            "median_gap_days": L.count(round(_median(gaps)) if gaps else None),
            "max_gap_days": L.count(max(gaps) if gaps else None),
            "gaps_over_90_days": L.count(sum(g > 90 for g in gaps)),
            "gaps_over_180_days": L.count(sum(g > 180 for g in gaps)),
        },
        "deposits_per_year": [
            {
                "year": L.count(y),
                "deposits": L.count(deposits[y]),
                "withdrawals": L.count(withdrawals[y]),
            }
            for y in sorted(set(deposits) | set(withdrawals))
        ],
        "sells_after_drawdown": {
            "threshold": L.pct(DRAWDOWN_SELL),
            "sells_checked": L.count(sells_checked),
            "sells_at_or_below_threshold": L.count(sells_after_dd),
            "median_drawdown_at_sale": L.pct(_median(drawdowns_at_sale)),
        },
        "buys_after_runup": {
            "threshold": L.pct(RUNUP_BUY),
            "lookback_days": L.count(RUNUP_DAYS),
            "buys_checked": L.count(buys_checked),
            "buys_after_runup": L.count(buys_after_runup),
        },
        "price_after_sales": [
            {
                "days": L.count(h),
                "sales": L.count(len(after_sale[h])),
                "median_change": L.pct(_median(after_sale[h])),
                "share_rose": L.share(sum(x > 0 for x in after_sale[h]), len(after_sale[h])),
            }
            for h in HORIZONS
        ],
        "holding_days": {
            "winners": L.count(len(winners)),
            "losers": L.count(len(losers)),
            "winners_median_days": L.count(round(_median(winners)) if winners else None),
            "losers_median_days": L.count(round(_median(losers)) if losers else None),
        },
        "fees_pct_of_turnover": [
            {"currency": L.category(cur), "fees_share": L.share(fee, gross)}
            for cur, (fee, gross) in sorted(fees.items())
        ],
        "concentration": concentration,
        "not_measured": L.text(
            "returns vs a benchmark, max drawdown, profit concentration and rolling relative "
            "performance come with the performance metrics (later stage)"
        ),
    }
