"""Macro regimes (P6, pure): every state of every regime on synthetic series, thresholds exactly at the
boundary, hysteresis (4 sessions do not switch, 5 do; ``since``), missing / short data, stale, the
yield-curve inversion flag (with its own hysteresis), ratio alignment on mismatched dates, the history
limit, the pl-PL metric text and the Polish meaning sentences."""

from __future__ import annotations

import datetime as dt
import re

import pytest

from cashu.modules.investments.macro import regimes as rg
from cashu.modules.investments.macro.series import USDPLN

START = dt.date(2024, 1, 1)


def days(n: int, start: dt.date = START) -> list[dt.date]:
    out, day = [], start
    while len(out) < n:
        if day.weekday() < 5:
            out.append(day)
        day += dt.timedelta(days=1)
    return out


def series(values, dates=None) -> list[tuple[dt.date, float]]:
    values = list(values)
    return list(zip(dates or days(len(values)), values, strict=True))


def geometric(n: int, growth: float, p0: float = 100.0) -> list[float]:
    out, value = [], p0
    for _ in range(n):
        out.append(value)
        value *= growth
    return out


def one(closes: dict, key: str, as_of: dt.date | None = None) -> rg.Regime:
    if as_of is None:
        as_of = max(d for points in closes.values() for d, _ in points)
    return next(r for r in rg.evaluate(closes, as_of) if r.key == key)


def texts(regime: rg.Regime) -> dict[str, str]:
    return {m.label: m.text for m in regime.metrics}


N = 300  # sessions: 260 for the first evaluated session plus a little history


# --------------------------------------------------------------------------- #
# Shape, order, missing and stale data
# --------------------------------------------------------------------------- #


def test_order_and_missing_without_data():
    out = rg.evaluate({}, dt.date(2026, 10, 8))
    assert [r.key for r in out] == list(rg.ORDER)
    for r in out:
        assert r.missing and r.state == "unknown" and r.state_label == "brak danych"
        assert r.since is None and r.as_of is None and r.stale and r.metrics == ()
        assert r.tone == "" and r.history == () and r.meaning == rg.UNKNOWN_MEANING
    assert [r.label for r in out] == [
        "Rynek akcji",
        "Dolar",
        "Rynki wschodzące",
        "Surowce",
        "Obligacje i stopy",
    ]


def test_259_bars_are_missing_260_are_enough():
    short = one({"acwi": series([100.0] * 259)}, "risk")
    assert short.missing and short.state == "unknown" and short.as_of == days(259)[-1]
    assert not short.stale
    enough = one({"acwi": series([100.0] * 260)}, "risk")
    assert not enough.missing and enough.state == "flat"
    # the state began before the data: open-ended, never a start date
    assert enough.since is None and enough.since_open and enough.since_min == days(260)[-1]
    assert [(h.date, h.state, h.open) for h in enough.history] == [(days(260)[-1], "flat", True)]


def test_stale_after_five_calendar_days():
    closes = {"acwi": series([100.0] * N)}
    last = days(N)[-1]
    assert not one(closes, "risk", last + dt.timedelta(days=5)).stale
    assert one(closes, "risk", last + dt.timedelta(days=6)).stale


def test_bars_after_as_of_are_ignored():
    values = [100.0] * N + [50.0] * 10  # a crash after as_of
    dates = days(N + 10)
    regime = one({"acwi": series(values, dates)}, "risk", dates[N - 1])
    assert regime.state == "flat" and regime.as_of == dates[N - 1]


def test_non_positive_prices_are_dropped_but_yields_may_be_zero():
    values = [100.0] * N
    values[100] = 0.0
    assert len(one({"acwi": series(values)}, "risk").history) == 1  # no division by zero
    bills = one({"us10y": series([1.0] * N), "us3m": series([0.0] * N)}, "rates")
    assert texts(bills)["krzywa 10l-3m"] == "+100 bp"


# --------------------------------------------------------------------------- #
# Risk (ACWI)
# --------------------------------------------------------------------------- #


def drop_to(level: float) -> list[float]:
    """100 for 250 sessions, then ``level`` (the drawdown holds through the evaluated window)."""
    return [100.0] * 250 + [level] * (N - 250)


def test_risk_bear_at_exactly_minus_20_percent():
    regime = one({"acwi": series(drop_to(80.0))}, "risk")
    assert (regime.state, regime.state_label, regime.tone) == ("bear", "bessa", "neg")
    assert texts(regime)["od szczytu"] == "-20,0 %"


def test_risk_correction_between_10_and_20_percent():
    assert one({"acwi": series(drop_to(80.01))}, "risk").state == "correction"
    exact = one({"acwi": series(drop_to(90.0))}, "risk")
    assert (exact.state, exact.state_label, exact.tone) == ("correction", "korekta", "warn")
    assert one({"acwi": series(drop_to(90.01))}, "risk").state == "weak"


def test_risk_bull_weak_and_flat():
    bull = one({"acwi": series([100 + 0.1 * i for i in range(N)])}, "risk")
    assert (bull.state, bull.state_label, bull.tone) == ("bull", "hossa", "pos")
    weak = one({"acwi": series([100 - 0.01 * i for i in range(N)])}, "risk")
    assert (weak.state, weak.state_label, weak.tone) == ("weak", "słabość", "warn")
    flat = one({"acwi": series([100.0] * N)}, "risk")  # close == ma200: neither above nor below
    assert (flat.state, flat.state_label, flat.tone) == ("flat", "bez trendu", "")
    # above a falling mean: flat
    values = [100 - 0.01 * i for i in range(N - 6)] + [101.0] * 6
    assert one({"acwi": series(values)}, "risk").state == "flat"


def test_risk_metrics():
    acwi = [100.0] * 250 + [95.0] * (N - 250)
    spx = [5000.0] * 270 + [4500.0] * (N - 270)
    regime = one({"acwi": series(acwi), "spx": series(spx)}, "risk")
    t = texts(regime)
    assert list(t) == ["ACWI wobec 200 sesji", "od szczytu", "S&P 500 od szczytu"]
    assert t["od szczytu"] == "-5,0 %" and t["S&P 500 od szczytu"] == "-10,0 %"
    assert t["ACWI wobec 200 sesji"] == "-3,8 %"  # 95 / mean(150 x 100, 50 x 95) - 1
    assert all(m.unit == "pct" for m in regime.metrics)
    # S&P 500 needs a year of sessions for its peak
    assert "S&P 500 od szczytu" not in texts(
        one({"acwi": series(acwi), "spx": series(spx[-251:])}, "risk")
    )


# --------------------------------------------------------------------------- #
# Dollar (DXY)
# --------------------------------------------------------------------------- #


def test_dollar_strong_weak_flat_and_no_tone():
    strong = one({"dxy": series(geometric(N, 1.0003))}, "dollar")
    assert (strong.state, strong.state_label, strong.tone) == ("strong", "umacnia się", "")
    weak = one({"dxy": series(geometric(N, 1 / 1.0003))}, "dollar")
    assert (weak.state, weak.state_label, weak.tone) == ("weak", "słabnie", "")
    flat = one({"dxy": series([100.0] * N)}, "dollar")
    assert (flat.state, flat.state_label) == ("flat", "bez trendu")


def test_dollar_six_month_change_exactly_3_percent_is_flat():
    exact = 1.03 ** (1 / rg.SIX_MONTHS)
    assert one({"dxy": series(geometric(N, exact))}, "dollar").state == "flat"
    assert one({"dxy": series(geometric(N, 1.0301 ** (1 / 126)))}, "dollar").state == "strong"
    assert one({"dxy": series(geometric(N, 1 / exact))}, "dollar").state == "flat"
    assert one({"dxy": series(geometric(N, 0.9699 ** (1 / 126)))}, "dollar").state == "weak"


def test_dollar_needs_the_mean_on_the_same_side():
    # a 6-month rise above 3 % but the close below its 200-session mean: flat
    values = [130.0] * 150 + [100.0] * 50 + geometric(N - 200, 1.0005)
    regime = one({"dxy": series(values)}, "dollar")
    assert texts(regime)["6 mies."].startswith("+")
    assert regime.state == "flat"


def test_dollar_metrics_and_usdpln_coverage():
    dates = days(N)
    dxy = series(geometric(N, 1.0003, 98.44), dates)
    usd = series(geometric(N, 1.0002, 3.9), dates)
    t = texts(one({"dxy": dxy, USDPLN: usd}, "dollar"))
    assert list(t) == ["DXY", "6 mies.", "USD/PLN 6 mies."]
    assert re.fullmatch(r"\d+,\d", t["DXY"]) and t["6 mies."] == "+3,9 %"
    assert t["USD/PLN 6 mies."] == "+2,6 %"
    assert not any(m.stale for m in one({"dxy": dxy, USDPLN: usd}, "dollar").metrics)
    # not enough NBP rates: no USD/PLN metric; too old: marked stale
    assert "USD/PLN 6 mies." not in texts(one({"dxy": dxy, USDPLN: usd[-126:]}, "dollar"))
    old = one({"dxy": dxy, USDPLN: usd[:-10]}, "dollar")
    assert [(m.label, m.stale) for m in old.metrics] == [
        ("DXY", False),
        ("6 mies.", False),
        ("USD/PLN 6 mies.", True),
    ]


# --------------------------------------------------------------------------- #
# Emerging markets (EEM / ACWI)
# --------------------------------------------------------------------------- #


def test_em_leading_lagging_inline():
    acwi = series(geometric(N, 1.0002))
    lead = one({"acwi": acwi, "eem": series(geometric(N, 1.0002 * 1.0005, 40))}, "em")
    assert (lead.state, lead.state_label, lead.tone) == ("leading", "silniejsze od świata", "pos")
    lag = one({"acwi": acwi, "eem": series(geometric(N, 1.0002 / 1.0005, 40))}, "em")
    assert (lag.state, lag.state_label, lag.tone) == ("lagging", "słabsze od świata", "neg")
    inline = one({"acwi": acwi, "eem": series(geometric(N, 1.0002, 40))}, "em")
    assert (inline.state, inline.state_label, inline.tone) == ("inline", "w linii", "")
    t = texts(lead)
    assert list(t) == ["EEM wobec ACWI 6 mies.", "EEM 6 mies."]
    assert t["EEM wobec ACWI 6 mies."] == "+6,5 pp" and t["EEM 6 mies."] == "+9,2 %"
    assert lead.metrics[0].unit == "pp"


def test_em_relative_change_exactly_5_percent_is_inline():
    acwi = series([100.0] * N)
    exact = 1.05 ** (1 / rg.SIX_MONTHS)
    assert one({"acwi": acwi, "eem": series(geometric(N, exact, 40))}, "em").state == "inline"
    above = 1.0501 ** (1 / rg.SIX_MONTHS)
    assert one({"acwi": acwi, "eem": series(geometric(N, above, 40))}, "em").state == "leading"
    assert one({"acwi": acwi, "eem": series(geometric(N, 1 / exact, 40))}, "em").state == "inline"


def test_em_ratio_aligns_mismatched_dates():
    dates = days(N + 40)
    acwi = series([100.0] * (N + 40), dates)
    eem_values = geometric(N + 40, 1.0005, 40)
    # EEM misses every 7th session; ACWI misses every 11th and has a session EEM has not yet
    eem = [p for i, p in enumerate(series(eem_values, dates)) if i % 7 != 3][:-1]
    acwi = [p for i, p in enumerate(acwi) if i % 11 != 5]
    regime = one({"acwi": acwi, "eem": eem}, "em", dates[-1])
    common = sorted({d for d, _ in eem} & {d for d, _ in acwi})
    assert regime.as_of == common[-1] and regime.state == "leading"
    # fewer than 260 common sessions: missing although each series alone is long enough
    sparse_eem = [p for i, p in enumerate(series(eem_values, dates)) if i % 2 == 0]
    sparse_acwi = [p for i, p in enumerate(series([100.0] * (N + 40), dates)) if i % 2 == 1]
    assert one({"acwi": sparse_acwi, "eem": sparse_eem}, "em", dates[-1]).missing


# --------------------------------------------------------------------------- #
# Commodities (DBC)
# --------------------------------------------------------------------------- #


def test_commodities_bull_bear_flat():
    acwi = series([100.0] * N)
    bull = one({"dbc": series(geometric(N, 1.0005, 20)), "acwi": acwi}, "commodities")
    assert (bull.state, bull.state_label, bull.tone) == ("bull", "hossa surowcowa", "pos")
    bear = one({"dbc": series(geometric(N, 1 / 1.0005, 20)), "acwi": acwi}, "commodities")
    assert (bear.state, bear.state_label, bear.tone) == ("bear", "bessa surowcowa", "neg")
    flat = one({"dbc": series([20.0] * N), "acwi": acwi}, "commodities")
    assert (flat.state, flat.state_label, flat.tone) == ("flat", "bez trendu", "")
    t = texts(bull)
    assert list(t) == ["DBC 12 mies.", "wobec ACWI 12 mies."]
    assert t["DBC 12 mies."] == "+13,4 %" and t["wobec ACWI 12 mies."] == "+13,4 pp"
    # without ACWI only the DBC metric
    assert list(texts(one({"dbc": series(geometric(N, 1.0005, 20))}, "commodities"))) == [
        "DBC 12 mies."
    ]


def test_commodities_twelve_month_change_exactly_10_percent_is_flat():
    exact = 1.10 ** (1 / rg.TWELVE_MONTHS)
    assert one({"dbc": series(geometric(N, exact, 20))}, "commodities").state == "flat"
    above = 1.1001 ** (1 / rg.TWELVE_MONTHS)
    assert one({"dbc": series(geometric(N, above, 20))}, "commodities").state == "bull"
    assert one({"dbc": series(geometric(N, 1 / exact, 20))}, "commodities").state == "flat"


# --------------------------------------------------------------------------- #
# Rates (US 10y, 3m)
# --------------------------------------------------------------------------- #


def linear(n: int, start: float, per_session: float) -> list[float]:
    return [start + per_session * i for i in range(n)]


def test_rates_rising_at_exactly_40_bp_falling_and_stable():
    bills = series([3.0] * N)
    rising = one({"us10y": series(linear(N, 3.5, 0.40 / 63)), "us3m": bills}, "rates")
    assert (rising.state, rising.state_label, rising.tone) == (
        "rising",
        "rentowności rosną",
        "warn",
    )
    assert texts(rising)["3 mies. zmiana"] == "+40 bp"
    falling = one({"us10y": series(linear(N, 6.0, -0.40 / 63)), "us3m": bills}, "rates")
    assert (falling.state, falling.state_label, falling.tone) == (
        "falling",
        "rentowności spadają",
        "pos",
    )
    stable = one({"us10y": series(linear(N, 3.5, 0.399 / 63)), "us3m": bills}, "rates")
    assert (stable.state, stable.state_label, stable.tone) == (
        "stable",
        "rentowności stabilne",
        "",
    )
    assert one({"us10y": series(linear(N, 6.0, -0.399 / 63))}, "rates").state == "stable"


def test_rates_metrics():
    regime = one({"us10y": series([4.231] * N), "us3m": series([4.0] * N)}, "rates")
    assert [(m.label, m.text, m.unit) for m in regime.metrics] == [
        ("USA 10 lat", "4,23 %", "level"),
        ("3 mies. zmiana", "0 bp", "bp"),
        ("krzywa 10l-3m", "+13 bp", "bp"),  # 4,231 % - 4,097 % (bond-equivalent of 4,0 % discount)
    ]
    assert regime.flags == () and not any(m.stale for m in regime.metrics)
    # without the bill yield: no curve metric, never inverted
    alone = one({"us10y": series([4.231] * N)}, "rates")
    assert [m.label for m in alone.metrics] == ["USA 10 lat", "3 mies. zmiana"]


def test_inverted_curve_flag_with_its_own_hysteresis():
    dates = days(N)
    long_ = series([4.0] * N, dates)

    def bills(inverted_sessions: int):
        return series([3.5] * (N - inverted_sessions) + [4.2] * inverted_sessions, dates)

    four = one({"us10y": long_, "us3m": bills(4)}, "rates")
    assert four.flags == () and four.state_label == "rentowności stabilne" and four.tone == ""
    five = one({"us10y": long_, "us3m": bills(5)}, "rates")
    assert five.flags == (rg.INVERTED,) and five.tone == "warn"
    assert five.state_label == "rentowności stabilne · krzywa odwrócona"
    assert five.state == "stable"  # the flag never changes the machine state
    assert five.meaning.endswith(rg.INVERTED_MEANING)
    assert texts(five)["krzywa 10l-3m"] == "-30 bp"  # 4,0 % - 4,304 % (bond-equivalent of 4,2 %)
    # an exactly flat curve is not inverted (3,90625 % discount = 4,0 % bond-equivalent)
    flat = one({"us10y": long_, "us3m": series([3.90625] * N, dates)}, "rates")
    assert flat.flags == () and texts(flat)["krzywa 10l-3m"] == "0 bp"


# --------------------------------------------------------------------------- #
# Hysteresis and history
# --------------------------------------------------------------------------- #


def jump(total: int, at: int = 280) -> list[float]:
    """US 10y flat at 4.0, then 4.5 from session ``at`` (raw state rising from there)."""
    return [4.0] * at + [4.5] * (total - at)


def test_four_sessions_do_not_switch_five_do():
    four = one({"us10y": series(jump(284))}, "rates")
    assert four.state == "stable" and four.since is None and four.since_open
    assert four.since_min == days(284)[259]
    five = one({"us10y": series(jump(285))}, "rates")
    assert five.state == "rising" and five.since == days(285)[280]
    assert not five.since_open and five.since_min is None
    d = days(285)
    assert [(h.date, h.state, h.confirmed, h.open) for h in five.history] == [
        (d[259], "stable", d[259], True),
        (d[280], "rising", d[284], False),  # visible on the 5th session
    ]


def test_a_short_flip_back_never_switches():
    values = [4.0] * 280 + [4.5] * 3 + [4.0] * 30  # rising for 3 sessions only
    regime = one({"us10y": series(values)}, "rates")
    assert regime.state == "stable" and len(regime.history) == 1


def test_history_keeps_the_last_12_runs_newest_last():
    values = [4.0] * 260
    level = 4.0
    for _ in range(15):  # 15 alternating 70-session blocks: rising / stable runs
        level += 0.5
        values += [level] * 70
    from cashu.modules.investments.macro.service import regime_dict

    regime = one({"us10y": series(values)}, "rates")
    assert len(regime.history) > rg.HISTORY_MAX  # the regime keeps every run
    shown = regime_dict(regime)["history"]
    assert len(shown) == rg.HISTORY_MAX and not any(h["open"] for h in shown)
    dates = [h["date"] for h in shown]
    assert dates == sorted(dates) and shown[-1]["date"] == regime.since.isoformat()
    assert shown[-1]["state"] == regime.state


def test_runs_helper():
    d = days(12)
    raw = ["a", "b", "b", "b", "b", "b", "a", "a", "c", "c", "c", "c"]
    runs = rg._runs(raw, d)
    assert [(r.date, r.state, r.confirmed, r.open) for r in runs] == [
        (d[0], "a", d[0], True),
        (d[1], "b", d[5], False),
    ]
    assert rg._runs([], []) == []


# --------------------------------------------------------------------------- #
# Text
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("metric", "text"),
    [
        (rg.Metric("x", 0.0412, "pct"), "+4,1 %"),
        (rg.Metric("x", -0.0412, "pct"), "-4,1 %"),
        (rg.Metric("x", -0.0004, "pct"), "0,0 %"),
        (rg.Metric("x", 0.0, "pct"), "0,0 %"),
        (rg.Metric("x", 6.25, "pp"), "+6,2 pp"),
        (rg.Metric("x", -0.04, "pp"), "0,0 pp"),
        (rg.Metric("x", 45.4, "bp", decimals=0), "+45 bp"),
        (rg.Metric("x", -12.6, "bp", decimals=0), "-13 bp"),
        (rg.Metric("x", -0.4, "bp", decimals=0), "0 bp"),
        (rg.Metric("x", 1234.5, "bp", decimals=0), "+1 234 bp"),
        (rg.Metric("x", 98.44, "level"), "98,4"),
        (rg.Metric("x", 5.231, "level", decimals=2, suffix=" %"), "5,23 %"),
        (rg.Metric("x", -0.051, "level", decimals=2, suffix=" %"), "-0,05 %"),
    ],
)
def test_metric_text(metric, text):
    assert metric.text == text == rg.format_metric(metric)


def test_every_state_has_a_label_and_a_factual_meaning():
    forbidden = re.compile(r"wzro[sś]nie|spadnie|będzie|będą|kupuj|sprzedaj|" + "\u2014")
    for key in rg.ORDER:
        assert set(rg.STATES[key]) == set(rg.MEANINGS[key])
        for state, (label, tone) in rg.STATES[key].items():
            assert 1 <= len(label.split()) <= 3 and tone in ("pos", "neg", "warn", "")
            assert rg.state_label(key, state) == label
            meaning = rg.MEANINGS[key][state]
            assert meaning.endswith(".") and not forbidden.search(meaning), (key, state)
    assert not forbidden.search(rg.INVERTED_MEANING + rg.UNKNOWN_MEANING)
    assert rg.state_label("rates", "unknown") == "brak danych"


# --------------------------------------------------------------------------- #
# Fix pass: stable since, per-metric staleness, bill yield basis
# --------------------------------------------------------------------------- #


def test_since_does_not_move_with_as_of():
    """A state that started inside the data keeps its start date whatever the request day; one that
    held since the first evaluated session stays open-ended with the same lower bound."""
    n = 700
    dates = days(n)
    acwi = series([100.0] * 350 + [100 * 1.002**i for i in range(n - 350)], dates)
    closes = {"acwi": acwi, "dxy": series([100.0] * n, dates)}
    seen = set()
    for back in (0, 1, 21):  # today, a day earlier, a month earlier
        risk, dollar = rg.evaluate(closes, dates[-1 - back])[:2]
        assert risk.state == "bull" and not risk.since_open
        seen.add(risk.since)
        assert dollar.since is None and dollar.since_open and dollar.since_min == dates[259]
    assert len(seen) == 1 and seen.pop() > dates[350]


def test_secondary_metrics_and_the_flag_carry_their_own_staleness():
    dates = days(N)
    last = dates[-1]
    spx = series([5000.0] * (N - 10), dates[:-10])
    risk = one({"acwi": series([100.0] * N, dates), "spx": spx}, "risk", last)
    assert not risk.stale
    assert [(m.label, m.stale) for m in risk.metrics] == [
        ("ACWI wobec 200 sesji", False),
        ("od szczytu", False),
        ("S&P 500 od szczytu", True),
    ]
    # bills stop updating while inverted: the flag is dropped, the curve metric marked stale
    rates = one(
        {"us10y": series([4.0] * N, dates), "us3m": series([4.5] * (N - 10), dates[:-10])},
        "rates",
        last,
    )
    assert rates.flags == () and rates.tone == "" and not rates.stale
    assert [(m.label, m.stale) for m in rates.metrics][-1] == ("krzywa 10l-3m", True)
    # a stale regime marks its own metrics
    old = one({"acwi": series([100.0] * N, dates)}, "risk", last + dt.timedelta(days=9))
    assert old.stale and all(m.stale for m in old.metrics)


def test_bill_discount_yield_to_bond_equivalent():
    assert rg.bond_equivalent(0.0) == 0.0
    assert rg.bond_equivalent(4.043) == pytest.approx(4.1415, abs=1e-4)
    assert rg.bond_equivalent(3.90625) == pytest.approx(4.0, abs=1e-12)


def test_flat_dollar_meaning_makes_no_pln_claim():
    assert "zł" not in rg.MEANINGS["dollar"]["flat"]
    assert rg.MEANINGS["dollar"]["flat"].startswith("Indeks dolara nie ma wyraźnego trendu")
