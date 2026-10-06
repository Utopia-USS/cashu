#!/usr/bin/env python3
"""Synthetic demo data for finanse: two invented profiles seeded through the app's service layer.

    .venv/bin/python scripts/demo_data.py --data-dir /tmp/finanse-demo
    FINANSE_DATA_DIR=/tmp/finanse-demo .venv/bin/finanse serve

Everything is invented: profile names ("Demo Anna", "Demo Piotr"), account numbers (a fake "99"
prefix), merchants, instruments (ISINs with "DEMO" in them), prices and FX rates (a deterministic
random walk per instrument, no network). Dates are relative to the day the script runs (about six
months of budget history, about two years of investment history), so the dashboard always looks
current.

What each profile gets: budget accounts with categorised transactions (salary, rent, groceries,
subscriptions, internal transfers to savings, a cash withdrawal into the cash pool) and a cushion
setting for the month close; a loan (Anna: a mortgage, Piotr: a car loan); assets (Anna: a flat and a
car, Piotr: a car), with depreciation; a brokerage account filled through the import path (a
canonical ``finanse-import`` CSV, preview + commit) with synthetic price bars and FX rates written
through the market data store; a strategy from the passive ETF template; watchlist items; owner and
agent alerts; theses, a finished research run with notes; a planned deposit; a decision journal
entry; one daily check (offline, on the stored data). Anna also gets a pending agent import proposal.

Safety: ``--data-dir`` is required and becomes ``FINANSE_DATA_DIR`` before finanse is imported; the
platform default data dir (the real one) is refused unless ``--force``; the database must live inside
the given data dir. Idempotent: every section checks whether its data is already there, so a second
run on the same day changes nothing (a later day only adds that day's price bars and FX rates).

``synthetic_sources()`` exposes the same price / FX generator as market sources, so a test server can
run the daily check ("Uruchom reguły") without touching the network (frontend/e2e/serve_offline.py).
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import math
import os
import sys
from dataclasses import dataclass, field
from decimal import ROUND_DOWN, Decimal
from pathlib import Path

# --------------------------------------------------------------------------- #
# Synthetic market (pure: no finanse imports at module level)
# --------------------------------------------------------------------------- #

EPOCH = dt.date(2020, 1, 6)  # a Monday; the random walks start here
BAR_SOURCE = "demo"


def isin(prefix11: str) -> str:
    """``prefix11`` (2 letters + 9 alphanumerics) plus its ISIN check digit."""
    digits = "".join(str(int(c, 36)) for c in prefix11.upper())
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 0:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return prefix11.upper() + str((10 - total % 10) % 10)


@dataclass(frozen=True)
class DemoInstrument:
    key: str  # ISIN, or the ticker for watchlist-only instruments
    symbol: str
    name: str
    exchange: str  # MIC
    currency: str
    p0: float
    drift: float  # per session (log)
    vol: float  # per session (log)
    asset_class: str = "etf"
    tags: tuple[str, ...] = ()


GLBA = DemoInstrument(
    isin("IE0DEMOGLBA"),
    "GLBA",
    "Demo Global Equity UCITS ETF",
    "XETR",
    "EUR",
    82.0,
    0.00035,
    0.009,
    "etf",
    ("global_equity",),
)
BNDA = DemoInstrument(
    isin("IE0DEMOBNDA"),
    "BNDA",
    "Demo Euro Government Bond UCITS ETF",
    "XETR",
    "EUR",
    47.0,
    0.00005,
    0.003,
    "etf",
    ("bonds",),
)
DMEN = DemoInstrument(
    isin("PL0DEMOENRG"),
    "DMEN",
    "Demo Energia SA",
    "XWAR",
    "PLN",
    31.0,
    0.0002,
    0.016,
    "equity",
)
DMBK = DemoInstrument(
    isin("PL0DEMOBANK"),
    "DMBK",
    "Demo Bank Polski SA",
    "XWAR",
    "PLN",
    118.0,
    0.0003,
    0.014,
    "equity",
)
DMTC = DemoInstrument(
    isin("US0DEMOTECH"),
    "DMTC",
    "Demo US Technology ETF",
    "XNAS",
    "USD",
    145.0,
    0.0005,
    0.012,
    "etf",
    ("global_equity",),
)
# Watchlist-only (created by the watchlist from a ticker with its market suffix).
WATCH = {
    "DMWA": DemoInstrument("DMWA", "DMWA", "Demo Wodociągi SA", "XWAR", "PLN", 54.0, 0.0001, 0.012),
    "DMSE": DemoInstrument(
        "DMSE", "DMSE", "Demo Semiconductor UCITS ETF", "XETR", "EUR", 31.0, 0.0006, 0.018
    ),
    "DMHC": DemoInstrument(
        "DMHC", "DMHC", "Demo Health Care ETF", "XNYS", "USD", 88.0, 0.0002, 0.008
    ),
}
ALL_INSTRUMENTS = {i.key: i for i in (GLBA, BNDA, DMEN, DMBK, DMTC, *WATCH.values())}

FX_BASE = {"EUR": 4.30, "USD": 3.92}


def session_index(day: dt.date) -> int:
    """Weekday number since EPOCH (weekend days map to the following Monday's index)."""
    weeks, rem = divmod((day - EPOCH).days, 7)
    return weeks * 5 + min(rem, 5)


def is_session(day: dt.date) -> bool:
    return day.weekday() < 5


def sessions(start: dt.date, end: dt.date):
    day = start
    while day <= end:
        if is_session(day):
            yield day
        day += dt.timedelta(days=1)


def _noise(key: str, i: int) -> float:
    """Deterministic, roughly standard normal."""
    h = hashlib.sha256(f"{key}:{i}".encode()).digest()
    return (sum(h[j] / 255 for j in range(6)) - 3.0) / math.sqrt(6 / 12)


_walks: dict[str, list[float]] = {}


def _spec_for(key: str) -> DemoInstrument:
    known = ALL_INSTRUMENTS.get(key)
    if known is not None:
        return known
    seed = int(hashlib.sha256(key.encode()).hexdigest()[:6], 16)
    return DemoInstrument(key, key, key, "", "PLN", 20 + seed % 180, 0.0002, 0.012)


def close_on(key: str, day: dt.date) -> Decimal:
    """Close of the synthetic instrument ``key`` on a session ``day``."""
    spec = _spec_for(key)
    walk = _walks.setdefault(key, [0.0])
    i = max(session_index(day), 0)
    while len(walk) <= i:
        n = len(walk)
        walk.append(walk[-1] + spec.drift + spec.vol * _noise(key, n))
    return Decimal(f"{spec.p0 * math.exp(walk[i]):.2f}")


def fx_on(currency: str, day: dt.date) -> Decimal:
    """PLN per 1 unit of ``currency`` on ``day`` (a slow wave plus a little noise)."""
    i = session_index(day)
    base = FX_BASE[currency]
    value = base * (1 + 0.025 * math.sin(i / 70) + 0.002 * _noise("fx" + currency, i))
    return Decimal(f"{value:.4f}")


def synthetic_sources():
    """MarketSources over the synthetic generator (``daily.default_sources`` stand-in for tests)."""
    from finanse.modules.investments.domain import Currency, FxRate, PriceBar
    from finanse.modules.investments.market import PriceHistory, PriceSource
    from finanse.modules.investments.service.daily import MarketSources

    class DemoPrices(PriceSource):
        @property
        def id(self) -> str:
            return BAR_SOURCE

        def history(self, instrument, start, end):
            return list(self.fetch(instrument, start, end).bars)

        def fetch(self, instrument, start, end):
            key = instrument.isin or instrument.symbol or str(instrument.id)
            if instrument.isin and instrument.isin not in ALL_INSTRUMENTS and instrument.symbol:
                key = instrument.symbol if instrument.symbol in WATCH else instrument.isin
            bars = tuple(
                PriceBar(
                    instrument_id=instrument.id,
                    date=day,
                    close=close_on(key, day),
                    source=BAR_SOURCE,
                    currency=instrument.currency,
                )
                for day in sessions(max(start, EPOCH), end)
            )
            return PriceHistory(bars=bars, currency=instrument.currency)

    class DemoFx:
        @property
        def id(self) -> str:
            return BAR_SOURCE

        def rates(self, quote, start, end):
            code = str(quote)
            if code not in FX_BASE:
                return []
            return [
                FxRate(quote=Currency(code), date=day, rate=fx_on(code, day), source=BAR_SOURCE)
                for day in sessions(max(start, EPOCH), end)
            ]

    return MarketSources(DemoPrices(), DemoFx())


# --------------------------------------------------------------------------- #
# Profile plans (all values invented)
# --------------------------------------------------------------------------- #


@dataclass
class Plan:
    name: str
    modules: tuple[str, ...]
    iban_main: str
    iban_savings: str
    iban_eur: str | None
    bank_main: str
    bank_savings: str
    salary: int
    rent: tuple[str, str, str, int]  # reference, counterparty, iban, amount
    installment: tuple[str, str, str, int]
    savings_transfer: int
    subscriptions: tuple[tuple[int, str, str], ...]  # day, reference, amount (PLN)
    eur_subscription: tuple[str, str] | None
    balances: tuple[str, str, str | None]
    loan: dict
    flat: tuple[str, int] | None
    car: tuple[str, int, dt.date, str, int]
    broker: str
    wrapper: str
    account_name: str
    months_invested: int
    deposit: int
    buys: tuple[tuple[DemoInstrument, int, int], ...]  # instrument, PLN budget, every n months
    dividend: tuple[DemoInstrument, str] | None
    watch: tuple[tuple[str, str, str], ...]  # symbol with market, name, note
    owner_alerts: tuple[dict, ...]
    agent_alerts: tuple[dict, ...]
    theses: tuple[tuple[DemoInstrument, str, str, str], ...]
    planned_deposit: int
    proposal: bool = False
    extra: dict = field(default_factory=dict)


ANNA = Plan(
    name="Demo Anna",
    modules=("budget", "assets", "loans", "investments"),
    iban_main="99114000000000000000100001",
    iban_savings="99109000000000000000100002",
    iban_eur="99114000000000000000100003",
    bank_main="mbank",
    bank_savings="erste",
    salary=11800,
    rent=("CZYNSZ", "WSPOLNOTA MIESZKANIOWA DEMO", "99105000000000000000100333", 780),
    installment=(
        "RATA KREDYTU HIPOTECZNEGO",
        "BANK HIPOTECZNY DEMO",
        "99160000000000000000100555",
        2950,
    ),
    savings_transfer=1500,
    subscriptions=((2, "KLUB SPORTOWY DEMO", "139.00"), (7, "NETFLIX.COM", "43.00")),
    eur_subscription=("SPOTIFY DEMO", "10.99"),
    balances=("6400.00", "32000.00", "380.00"),
    loan={
        "name": "Kredyt hipoteczny Demo",
        "type": "mortgage",
        "principal": "420000",
        "annual_rate": "6.2",
        "term_months": 300,
        "start_date": dt.date(2022, 4, 5),
        "origination_date": dt.date(2022, 3, 14),
    },
    flat=("Mieszkanie Demo", 690000),
    car=("Samochód Demo", 95000, dt.date(2023, 3, 15), "15", 12000),
    broker="dif",
    wrapper="ike",
    account_name="IKE Demo",
    months_invested=24,
    deposit=2500,
    buys=((GLBA, 1700, 1), (BNDA, 700, 2), (DMEN, 600, 3)),
    dividend=(DMEN, "1.20"),
    watch=(
        ("DMWA.WA", "Demo Wodociągi SA", "Stabilna spółka infrastrukturalna, do obserwacji."),
        ("DMSE.DE", "Demo Semiconductor UCITS ETF", "Ekspozycja sektorowa, sprawdzić koszty."),
    ),
    owner_alerts=(
        {
            "kind": "price_below",
            "instrument": DMEN,
            "title": "Demo Energia poniżej poziomu",
            "level_factor": 0.85,
            "note": "Sprawdzić tezę przy spadku.",
        },
        {
            "kind": "weight_above",
            "instrument": GLBA,
            "title": "Udział ETF globalnego",
            "threshold": 0.5,
        },
    ),
    agent_alerts=(
        {
            "kind": "change_pct",
            "instrument": GLBA,
            "title": "Duży ruch ETF globalnego",
            "window_days": 5,
            "threshold": 0.04,
        },
    ),
    theses=(
        (
            GLBA,
            "trend",
            "Szeroki rynek akcji rośnie razem z gospodarką światową.",
            "Wieloletni rynek niedźwiedzia bez odbicia.",
        ),
        (
            DMEN,
            "special_situation",
            "Program inwestycyjny w OZE poprawi marże.",
            "Program inwestycyjny zostaje wstrzymany.",
        ),
    ),
    planned_deposit=2500,
    proposal=True,
)

PIOTR = Plan(
    name="Demo Piotr",
    modules=("budget", "assets", "loans", "investments"),
    iban_main="99124000000000000000200001",
    iban_savings="99124000000000000000200002",
    iban_eur=None,
    bank_main="pekao",
    bank_savings="pekao",
    salary=8600,
    rent=("NAJEM MIESZKANIA", "WYNAJEM DEMO", "99105000000000000000200333", 2400),
    installment=(
        "RATA KREDYTU SAMOCHODOWEGO",
        "BANK AUTO DEMO",
        "99160000000000000000200555",
        1240,
    ),
    savings_transfer=800,
    subscriptions=((4, "SPOTIFY DEMO", "23.99"), (9, "KLUB SPORTOWY DEMO", "119.00")),
    eur_subscription=None,
    balances=("4100.00", "15500.00", None),
    loan={
        "name": "Kredyt samochodowy Demo",
        "type": "loan",
        "principal": "60000",
        "annual_rate": "8.9",
        "term_months": 60,
        "start_date": dt.date(2024, 11, 10),
        "origination_date": dt.date(2024, 10, 20),
    },
    flat=None,
    car=("Auto Demo", 72000, dt.date(2024, 10, 20), "14", 9000),
    broker="xtb",
    wrapper="regular",
    account_name="Konto maklerskie Demo",
    months_invested=18,
    deposit=2200,
    buys=((GLBA, 800, 1), (DMTC, 900, 1), (DMBK, 450, 3)),
    dividend=(DMBK, "4.10"),
    watch=(("DMHC.US", "Demo Health Care ETF", "Defensywny sektor, do obserwacji."),),
    owner_alerts=(
        {
            "kind": "price_above",
            "instrument": DMTC,
            "title": "Demo US Technology powyżej poziomu",
            "level_factor": 1.15,
        },
    ),
    agent_alerts=(
        {
            "kind": "drawdown_from_high",
            "instrument": DMBK,
            "title": "Spadek od szczytu Demo Bank",
            "threshold": 0.12,
        },
    ),
    theses=(
        (
            DMBK,
            "trend",
            "Wysokie stopy wspierają wynik odsetkowy banku.",
            "Szybkie obniżki stóp procentowych.",
        ),
    ),
    planned_deposit=2200,
)

PLANS = (ANNA, PIOTR)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def log(msg: str) -> None:
    print(msg, flush=True)


def add_months(day: dt.date, months: int, dom: int | None = None) -> dt.date:
    m = day.month - 1 + months
    year, month = day.year + m // 12, m % 12 + 1
    last = (dt.date(year + (month == 12), month % 12 + 1, 1) - dt.timedelta(days=1)).day
    return dt.date(year, month, min(dom or day.day, last))


def next_session(day: dt.date) -> dt.date:
    while not is_session(day):
        day += dt.timedelta(days=1)
    return day


def prev_session(day: dt.date) -> dt.date:
    while not is_session(day):
        day -= dt.timedelta(days=1)
    return day


def last_bar_day(today: dt.date) -> dt.date:
    """Newest stored bar: the session before today's (today's close arrives with the next daily
    check, so "Uruchom reguły" on the e2e server adds one bar and moves the value)."""
    return prev_session(today - dt.timedelta(days=1))


def money(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.01'))}"


CANONICAL_HEADER = (
    "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,"
    "currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source"
)


def _row(**f) -> str:
    cols = CANONICAL_HEADER.split(",")
    values = {"format_version": "1", **{k: "" if v is None else str(v) for k, v in f.items()}}
    return ",".join(values.get(c, "") for c in cols)


def investment_history(plan: Plan, slug: str, today: dt.date) -> tuple[bytes, dt.date]:
    """The canonical CSV of the plan's brokerage history (deposits, buys, dividends, positions)
    up to yesterday, and the last trade date."""
    rows: list[str] = []
    cash = Decimal(0)
    held: dict[str, int] = {}
    n = 0
    last = None
    first = add_months(today, -plan.months_invested, 10)
    for k in range(plan.months_invested):
        deposit_day = next_session(add_months(first, k, 10))
        if deposit_day >= today:
            break
        n += 1
        rows.append(
            _row(
                record="txn",
                date=deposit_day,
                time="08:30",
                type="deposit",
                external_ref=f"DEMO-{slug}-{n}",
                currency="PLN",
                cash_amount=money(Decimal(plan.deposit)),
            )
        )
        cash += plan.deposit
        last = deposit_day
        trade_day = next_session(deposit_day + dt.timedelta(days=1))
        if trade_day >= today:
            break
        for inst, budget, every in plan.buys:
            if k % every:
                continue
            price = close_on(inst.key, trade_day)
            fx = Decimal(1) if inst.currency == "PLN" else fx_on(inst.currency, trade_day)
            qty = int((Decimal(budget) / (price * fx)).to_integral_value(ROUND_DOWN))
            if qty <= 0:
                continue
            gross = price * qty
            n += 1
            common = {
                "record": "txn",
                "date": trade_day,
                "time": "10:15",
                "type": "buy",
                "external_ref": f"DEMO-{slug}-{n}",
                "symbol": inst.symbol,
                "isin": inst.key,
                "name": inst.name,
                "exchange": inst.exchange,
                "quantity": qty,
                "price": price,
                "currency": inst.currency,
                "gross_amount": money(gross),
            }
            if inst.currency == "PLN":
                fee = max(Decimal(5), (gross * Decimal("0.0039")).quantize(Decimal("0.01")))
                cost = gross + fee
                rows.append(_row(**common, fee=money(fee), cash_amount=money(-cost)))
            else:
                cost = (gross * fx).quantize(Decimal("0.01"))
                rows.append(
                    _row(**common, cash_amount=money(-cost), cash_currency="PLN", fx_rate=fx)
                )
            if cost > cash:  # never overdraw the synthetic account
                rows.pop()
                n -= 1
                continue
            cash -= cost
            held[inst.key] = held.get(inst.key, 0) + qty
            last = trade_day
        if plan.dividend is not None:
            inst, per_share = plan.dividend
            pay_day = next_session(add_months(first, k, 20))
            if pay_day.month == 6 and held.get(inst.key) and pay_day < today:
                gross = Decimal(per_share) * held[inst.key]
                tax = (gross * Decimal("0.19")).quantize(Decimal("0.01"))
                n += 1
                rows.append(
                    _row(
                        record="txn",
                        date=pay_day,
                        type="dividend",
                        external_ref=f"DEMO-{slug}-{n}",
                        symbol=inst.symbol,
                        isin=inst.key,
                        name=inst.name,
                        exchange=inst.exchange,
                        currency=inst.currency,
                        gross_amount=money(gross),
                        tax=money(tax),
                        cash_amount=money(gross - tax),
                    )
                )
                cash += gross - tax
                last = max(last, pay_day)
    assert last is not None
    by_key = {i.key: i for i, _b, _e in plan.buys}
    for key, qty in sorted(held.items()):
        inst = by_key[key]
        rows.append(
            _row(
                record="position",
                date=last,
                symbol=inst.symbol,
                isin=inst.key,
                name=inst.name,
                exchange=inst.exchange,
                quantity=qty,
                currency=inst.currency,
            )
        )
    return ("\n".join([CANONICAL_HEADER, *rows]) + "\n").encode("utf-8"), last


def proposal_file(plan: Plan, slug: str, today: dt.date) -> bytes:
    """A later deposit plus one buy: the pending agent import proposal (Anna)."""
    day = last_bar_day(today)
    price = close_on(GLBA.key, day)
    fx = fx_on("EUR", day)
    qty = 10
    gross = price * qty
    rows = [
        _row(
            record="txn",
            date=day,
            time="08:00",
            type="deposit",
            external_ref=f"DEMO-{slug}-P1",
            currency="PLN",
            cash_amount="4000.00",
        ),
        _row(
            record="txn",
            date=day,
            time="11:00",
            type="buy",
            external_ref=f"DEMO-{slug}-P2",
            symbol=GLBA.symbol,
            isin=GLBA.key,
            name=GLBA.name,
            exchange=GLBA.exchange,
            quantity=qty,
            price=price,
            currency="EUR",
            gross_amount=money(gross),
            cash_amount=money(-(gross * fx).quantize(Decimal("0.01"))),
            cash_currency="PLN",
            fx_rate=fx,
        ),
    ]
    return ("\n".join([CANONICAL_HEADER, *rows]) + "\n").encode("utf-8")


def strategy_yaml(template: str, plan: Plan) -> str:
    """The passive ETF template adapted to the demo holdings: a bucket for single stocks, targets
    that sum to 1, the benchmark proxy on the demo global ETF, a monthly amount matching the plan."""
    text = template.replace(
        "  - id: cash\n    match: { asset_class: cash }",
        "  # Single stocks (demo addition).\n"
        "  - id: stocks\n    match: { asset_class: equity }\n"
        "  - id: cash\n    match: { asset_class: cash }",
    )
    text = text.replace(
        "    global_equity: 0.70\n    bond_etfs: 0.10\n    treasury_bonds: 0.15\n    cash: 0.05",
        "    global_equity: 0.65\n    bond_etfs: 0.15\n    treasury_bonds: 0.05\n"
        "    stocks: 0.10\n    cash: 0.05",
    )
    text = text.replace("monthly_amount: 1000", f"monthly_amount: {plan.deposit}")
    text = text.replace("proxy: VWCE.DE", f"proxy: {GLBA.key}")
    return text


# --------------------------------------------------------------------------- #
# Seeding (finanse is imported only after FINANSE_DATA_DIR is set)
# --------------------------------------------------------------------------- #


class Seeder:
    def __init__(self, today: dt.date) -> None:
        self.today = today
        self.summary: dict[str, dict[str, str]] = {}

    def note(self, slug: str, section: str, state: str) -> None:
        self.summary.setdefault(slug, {})[section] = state
        log(f"  {section}: {state}")

    # -- profile ---------------------------------------------------------------------------- #
    def profile(self, plan: Plan):
        from finanse.core import profiles
        from finanse.core.db import get_session

        with get_session() as s:
            row = next((p for p in profiles.list_profiles(s) if p.name == plan.name), None)
            if row is not None:
                self.note(row.slug, "profile", "exists")
                return row
            row = profiles.create_profile(s, name=plan.name, modules_=list(plan.modules))
            self.note(row.slug, "profile", "created")
            return row

    # -- budget ----------------------------------------------------------------------------- #
    def budget(self, plan: Plan, profile) -> None:
        from sqlmodel import select

        from finanse.core import accounts
        from finanse.core.db import get_session
        from finanse.models import AccountType, Source, Transaction
        from finanse.modules.budget import cash
        from finanse.modules.budget import service as budget
        from finanse.modules.budget import settings as budget_settings
        from finanse.modules.budget.ingestion.normalize import RawTransaction
        from finanse.modules.budget.ingestion.transfers import match_internal_transfers

        pid = profile.id
        with get_session() as s:
            ids = [a.id for a in accounts.profile_accounts(s, pid)]
            has = (
                ids
                and s.exec(select(Transaction.id).where(Transaction.account_id.in_(ids))).first()
            )
        if has:
            self.note(profile.slug, "budget", "exists")
        else:
            with get_session() as s:
                main = accounts.get_or_create_account(
                    s,
                    bank=plan.bank_main,
                    iban=plan.iban_main,
                    name="Konto osobiste Demo",
                    profile_id=pid,
                )
                sav = accounts.get_or_create_account(
                    s,
                    bank=plan.bank_savings,
                    iban=plan.iban_savings,
                    name="Konto oszczędnościowe Demo",
                    type=AccountType.SAVINGS,
                    profile_id=pid,
                )
                eur = None
                if plan.iban_eur:
                    eur = accounts.get_or_create_account(
                        s,
                        bank=plan.bank_main,
                        iban=plan.iban_eur,
                        name="Konto walutowe EUR Demo",
                        currency="EUR",
                        profile_id=pid,
                    )

                def raw(d, amount, *, ref=None, cp=None, iban=None, desc=None, currency="PLN"):
                    return RawTransaction(
                        booking_date=d,
                        amount=Decimal(amount),
                        currency=currency,
                        counterparty_name=cp,
                        counterparty_iban=iban,
                        description=desc,
                        reference=ref,
                        source=Source.CSV,
                    )

                main_rows, sav_rows, eur_rows = [], [], []
                start = add_months(self.today.replace(day=1), -6)
                if eur is not None:
                    eur_rows.append(raw(start, "500.00", ref="ZASILENIE KONTA", currency="EUR"))
                month = start
                atm_days = []
                while month <= self.today:
                    m = month.month

                    def d(day: int, month=month) -> dt.date:
                        return month.replace(day=day)

                    rref, rcp, riban, ramount = plan.rent
                    iref, icp, iiban, iamount = plan.installment
                    rows = [
                        (
                            3,
                            raw(
                                d(3),
                                f"-{ramount}.00",
                                ref=rref,
                                cp=rcp,
                                iban=riban,
                                desc="PRZELEW WYCHODZACY",
                            ),
                        ),
                        (
                            5,
                            raw(
                                d(5),
                                f"-{iamount}.00",
                                ref=iref,
                                cp=icp,
                                iban=iiban,
                                desc="PRZELEW WYCHODZACY",
                            ),
                        ),
                        (
                            6,
                            raw(
                                d(6),
                                f"-{160 + 9 * m}.45",
                                ref="BIEDRONKA 1001 DEMO",
                                desc="ZAKUP PRZY UZYCIU KARTY",
                            ),
                        ),
                        (
                            10,
                            raw(
                                d(10),
                                f"{plan.salary}.00",
                                ref=f"WYNAGRODZENIE ZA {add_months(month, -1).month:02d}/"
                                f"{add_months(month, -1).year}",
                                cp="PRACODAWCA DEMO SP Z O O",
                                iban="99102000000000000000900777",
                                desc="PRZELEW PRZYCHODZACY",
                            ),
                        ),
                        (
                            11,
                            raw(
                                d(11),
                                f"-{plan.savings_transfer}.00",
                                ref="OSZCZEDNOSCI",
                                cp="Konto oszczędnościowe Demo",
                                iban=plan.iban_savings,
                                desc="PRZELEW WYCHODZACY",
                            ),
                        ),
                        (
                            15,
                            raw(
                                d(15),
                                "-300.00",
                                ref="WYPLATA W BANKOMACIE DEMO",
                                desc="WYPLATA W BANKOMACIE",
                            ),
                        ),
                        (
                            17,
                            raw(
                                d(17),
                                f"-{70 + 3 * m}.90",
                                ref="ROSSMANN 220 DEMO",
                                desc="ZAKUP PRZY UZYCIU KARTY",
                            ),
                        ),
                        (
                            20,
                            raw(
                                d(20),
                                f"-{110 + 4 * m}.25",
                                ref="LIDL 314 DEMO",
                                desc="ZAKUP PRZY UZYCIU KARTY",
                            ),
                        ),
                        (
                            21,
                            raw(
                                d(21),
                                f"-{230 + 2 * m}.00",
                                ref="ORLEN STACJA 77 DEMO",
                                desc="ZAKUP PRZY UZYCIU KARTY",
                            ),
                        ),
                        (
                            24,
                            raw(
                                d(24),
                                f"-{60 + m}.00",
                                ref="PIZZERIA DEMO",
                                desc="ZAKUP PRZY UZYCIU KARTY",
                            ),
                        ),
                        (28, raw(d(28), "-7.00", ref="OPLATA ZA KARTE", desc="OPLATA")),
                    ]
                    for day, ref, amount in plan.subscriptions:
                        rows.append(
                            (
                                day,
                                raw(d(day), f"-{amount}", ref=ref, desc="ZAKUP PRZY UZYCIU KARTY"),
                            )
                        )
                    for day, row in rows:
                        if d(day) <= self.today:
                            main_rows.append(row)
                    if d(11) <= self.today:
                        sav_rows.append(
                            raw(
                                d(11),
                                f"{plan.savings_transfer}.00",
                                ref="OSZCZEDNOSCI",
                                cp="Konto osobiste Demo",
                                iban=plan.iban_main,
                            )
                        )
                    if d(15) <= self.today:
                        atm_days.append(d(15))
                    if eur is not None and plan.eur_subscription and d(14) <= self.today:
                        ref, amount = plan.eur_subscription
                        eur_rows.append(raw(d(14), f"-{amount}", ref=ref, currency="EUR"))
                    month = add_months(month, 1, 1)
                budget.ingest_transactions(
                    s, main, main_rows, source=Source.CSV, filename="demo-konto.csv"
                )
                budget.ingest_transactions(
                    s, sav, sav_rows, source=Source.CSV, filename="demo-oszczednosci.csv"
                )
                if eur is not None:
                    budget.ingest_transactions(
                        s, eur, eur_rows, source=Source.CSV, filename="demo-eur.csv"
                    )
                bal_main, bal_sav, bal_eur = plan.balances
                accounts.upsert_balance(s, main, self.today, Decimal(bal_main), source=Source.CSV)
                accounts.upsert_balance(s, sav, self.today, Decimal(bal_sav), source=Source.CSV)
                if eur is not None and bal_eur:
                    accounts.upsert_balance(s, eur, self.today, Decimal(bal_eur), source=Source.CSV)
                s.flush()
                match_internal_transfers(s, profile_id=pid)
                budget.categorize_all(s, profile_id=pid)
                # The newest ATM withdrawal goes to the cash pool; one cash expense from it.
                if atm_days:
                    atm = s.exec(
                        select(Transaction).where(
                            Transaction.account_id == main.id,
                            Transaction.reference == "WYPLATA W BANKOMACIE DEMO",
                            Transaction.booking_date == atm_days[-1],
                        )
                    ).one()
                    budget.set_transaction_category(s, atm.id, "cash_withdrawal", profile_id=pid)
                    cash.add_cash_expense(
                        s,
                        amount="45.00",
                        title="Targ Demo",
                        category="groceries",
                        on_date=min(atm_days[-1] + dt.timedelta(days=1), self.today),
                        profile_id=pid,
                    )
                savings_id = sav.id
            self.note(profile.slug, "budget", f"created ({len(main_rows) + len(sav_rows)} rows)")
            settings_file = budget_settings.settings_path(profile.slug)
            if not settings_file.exists():
                budget_settings.save(
                    profile.slug,
                    budget_settings.parse(
                        {
                            "cushion": {
                                "enabled": True,
                                "target_months": 3,
                                "account_ids": [savings_id],
                                "monthly_max": 2000,
                            }
                        }
                    ),
                )
                self.note(profile.slug, "budget settings", "created")

    # -- loans and assets ------------------------------------------------------------------- #
    def loans_assets(self, plan: Plan, profile) -> None:
        from finanse.core import accounts
        from finanse.core.db import get_session
        from finanse.models import AccountType
        from finanse.modules.assets import service as assets
        from finanse.modules.loans import service as loans

        pid = profile.id
        with get_session() as s:
            if loans.list_loans(s, profile_id=pid):
                self.note(profile.slug, "loan", "exists")
            else:
                loan = dict(plan.loan)
                loans.add_loan(
                    s,
                    principal=loan["principal"],
                    annual_rate=loan["annual_rate"],
                    term_months=loan["term_months"],
                    start_date=loan["start_date"],
                    name=loan["name"],
                    type=loan["type"],
                    origination_date=loan["origination_date"],
                    payment_iban=plan.installment[2],
                    profile_id=pid,
                )
                self.note(profile.slug, "loan", "created")
        with get_session() as s:
            names = {a.name for a in accounts.profile_accounts(s, pid)}
            if plan.flat and plan.flat[0] not in names:
                # Valued at purchase (with the mortgage) and again two months ago.
                for on_date, value in (
                    (plan.loan["origination_date"], plan.flat[1] - 80000),
                    (add_months(self.today, -2, 1), plan.flat[1]),
                ):
                    assets.add_manual_position(
                        s,
                        name=plan.flat[0],
                        type=AccountType.PROPERTY,
                        value=str(value),
                        on_date=on_date,
                        profile_id=pid,
                    )
                self.note(profile.slug, "flat", "created")
            car_name, price, bought, rate, floor = plan.car
            if car_name not in names:
                assets.set_vehicle(
                    s,
                    name=car_name,
                    purchase_price=str(price),
                    purchase_date=bought,
                    annual_rate=rate,
                    floor=str(floor),
                    profile_id=pid,
                )
                self.note(profile.slug, "car", "created")

    # -- investments ------------------------------------------------------------------------ #
    def brokerage(self, plan: Plan, profile) -> int:
        from finanse.core.db import get_session
        from finanse.modules.investments.importing import ImportFile
        from finanse.modules.investments.service import accounts, imports
        from finanse.modules.investments.store import instruments
        from finanse.modules.investments.store import transactions as txn_store

        pid = profile.id
        with get_session() as s:
            existing = [
                a for a in txn_store.brokerage_accounts(s, pid) if a.name == plan.account_name
            ]
            if existing:
                account_id = existing[0].id
                self.note(profile.slug, "brokerage account", "exists")
            else:
                account_id = accounts.add_account(
                    s, pid, name=plan.account_name, broker=plan.broker, wrapper=plan.wrapper
                ).id
                self.note(profile.slug, "brokerage account", "created")
        with get_session() as s:
            if txn_store.transactions(s, pid):
                self.note(profile.slug, "import", "exists")
                return account_id
        content, _last = investment_history(plan, profile.slug, self.today)
        with get_session() as s:
            preview = imports.preview(
                s,
                s.get(type(profile), pid),
                imports.ImportRequest(ImportFile("demo-historia.csv", content), account_id),
            )
        if not preview.can_commit:
            raise SystemExit(f"demo import preview refused: {[str(e) for e in preview.errors]}")
        imports.commit(preview)
        self.note(profile.slug, "import", f"committed ({content.count(b'\n') - 1} records)")
        # Classify the imported instruments for the strategy buckets.
        with get_session() as s:
            ids = instruments.profile_instrument_ids(s, pid)
            loaded = instruments.load(s, ids, profile_id=pid)
            for iid, inst in loaded.items():
                spec = ALL_INSTRUMENTS.get(inst.isin or "")
                if spec is None:
                    continue
                instruments.classify(
                    s,
                    int(iid),
                    profile_id=pid,
                    asset_class=spec.asset_class,
                    tags=list(spec.tags),
                )
                if inst.symbol == "GLBA":
                    instruments.set_plan(
                        s,
                        int(iid),
                        "hold",
                        profile_id=pid,
                        held=True,
                        reason="Teza pozostaje aktualna, a pozycja mieści się w docelowej konstrukcji portfela.",
                    )
        return account_id

    def strategy(self, plan: Plan, profile) -> None:
        from finanse.core.db import get_session
        from finanse.modules.investments.service import files
        from finanse.modules.investments.service import strategy as strategy_service
        from finanse.modules.investments.templates import strategy_template

        if files.strategy_yaml_path(profile.slug).exists():
            self.note(profile.slug, "strategy", "exists")
            return
        tpl = strategy_template("passive_etf")
        files.write_text_private(
            files.strategy_yaml_path(profile.slug), strategy_yaml(tpl.yaml, plan)
        )
        files.write_text_private(files.strategy_md_path(profile.slug), tpl.markdown)
        with get_session() as s:
            state = strategy_service.load(s, s.get(type(profile), profile.id), record=True)
            errors = [str(i) for i in state.issues if i.is_error]
        if errors:
            raise SystemExit(f"demo strategy invalid: {errors}")
        self.note(profile.slug, "strategy", "created (passive_etf template, demo targets)")

    def watchlist(self, plan: Plan, profile) -> None:
        from finanse.core.db import get_session
        from finanse.modules.investments.service import watchlist
        from finanse.modules.investments.store import alerts as alert_store
        from finanse.modules.investments.store import instruments

        with get_session() as s:
            prof = s.get(type(profile), profile.id)
            if alert_store.watchlist(s, profile.id):
                self.note(profile.slug, "watchlist", "exists")
                return
            for index, (symbol, name, note) in enumerate(plan.watch):
                added = watchlist.add(s, prof, symbol, name=name, note=note, tags=["demo"])
                if index == 0:
                    instruments.set_plan(
                        s,
                        added.item.instrument_id,
                        "buy",
                        profile_id=profile.id,
                        held=False,
                        reason="Kandydat pasuje do strategii; przed zakupem model czeka na potwierdzenie warunków wejścia.",
                    )
        self.note(profile.slug, "watchlist", f"created ({len(plan.watch)})")

    def market_data(self, profile) -> None:
        """Synthetic bars for every instrument the profile references (held and watched) and the
        FX rates of their currencies, through the market data store."""
        from finanse.core.db import get_session
        from finanse.core.models import utcnow
        from finanse.modules.investments.domain import Currency, FxRate, PriceBar
        from finanse.modules.investments.store import convert, instruments, market

        last = last_bar_day(self.today)
        start = add_months(self.today, -26, 1)
        with get_session() as s:
            ids = instruments.profile_instrument_ids(s, profile.id)
            loaded = instruments.load(s, ids, profile_id=profile.id)
            have = market.last_bar_dates(s, [int(i) for i in loaded])
            now = utcnow()
            written = 0
            currencies: set[str] = set()
            for iid, inst in loaded.items():
                key = inst.isin if inst.isin in ALL_INSTRUMENTS else (inst.symbol or "")
                if key not in ALL_INSTRUMENTS:
                    continue
                currencies.add(str(inst.currency))
                newest = have.get(int(iid))
                if newest is not None and newest >= last:
                    continue
                since = start if newest is None else newest + dt.timedelta(days=1)
                bars = [
                    PriceBar(
                        instrument_id=convert.sid(int(iid)),
                        date=day,
                        close=close_on(key, day),
                        source=BAR_SOURCE,
                        fetched_at=now,
                        currency=inst.currency,
                    )
                    for day in sessions(since, last)
                ]
                written += market.upsert_bars(s, bars, now=now)
            fx_written = 0
            for code in sorted(currencies & set(FX_BASE)):
                stored = self._fx_dates(s, code)
                rates = [
                    FxRate(
                        quote=Currency(code),
                        date=day,
                        rate=fx_on(code, day),
                        source=BAR_SOURCE,
                        fetched_at=now,
                    )
                    for day in sessions(start, last)
                    if day not in stored
                ]
                if rates:
                    fx_written += market.upsert_rates(s, rates, now=now)
        self.note(profile.slug, "market data", f"{written} bars, {fx_written} FX rates written")

    @staticmethod
    def _fx_dates(s, code: str) -> set[dt.date]:
        from sqlmodel import select

        from finanse.modules.investments.models import InvFxRate

        return set(s.exec(select(InvFxRate.date).where(InvFxRate.quote == code)).all())

    def theses_alerts(self, plan: Plan, profile) -> None:
        from sqlmodel import select

        from finanse.core.db import get_session
        from finanse.modules.investments.alerts.catalog import AlertSource
        from finanse.modules.investments.models import InvAlert, InvInstrument
        from finanse.modules.investments.service import alerts as alert_service
        from finanse.modules.investments.store import journal

        pid = profile.id

        def iid(s, inst: DemoInstrument) -> int:
            return s.exec(select(InvInstrument.id).where(InvInstrument.isin == inst.key)).one()

        with get_session() as s:
            if journal.theses(s, pid):
                self.note(profile.slug, "theses", "exist")
            else:
                for inst, entry, thesis, invalidation in plan.theses:
                    journal.create_thesis(
                        s,
                        pid,
                        iid(s, inst),
                        {
                            "entry_type": entry,
                            "thesis": thesis,
                            "invalidation": invalidation,
                            "exit_plan": "Sprzedaż przy unieważnieniu tezy.",
                            "size_plan": "Do 10% portfela.",
                        },
                    )
                self.note(profile.slug, "theses", f"created ({len(plan.theses)})")
        with get_session() as s:
            prof = s.get(type(profile), pid)
            if s.exec(select(InvAlert.id).where(InvAlert.profile_id == pid)).first():
                self.note(profile.slug, "alerts", "exist")
                return
            last = last_bar_day(self.today)
            for spec, source in [(a, AlertSource.USER) for a in plan.owner_alerts] + [
                (a, AlertSource.AGENT) for a in plan.agent_alerts
            ]:
                inst = spec["instrument"]
                params: dict = {}
                if spec["kind"] in ("price_above", "price_below"):
                    params["level"] = float(
                        (close_on(inst.key, last) * Decimal(str(spec["level_factor"]))).quantize(
                            Decimal("0.01")
                        )
                    )
                elif spec["kind"] == "change_pct":
                    params = {"window_days": spec["window_days"], "threshold": spec["threshold"]}
                else:
                    params = {"threshold": spec["threshold"]}
                alert_service.create(
                    s,
                    prof,
                    alert_service.AlertInput(
                        kind=spec["kind"],
                        title=spec["title"],
                        params=params,
                        instrument_id=iid(s, inst),
                        note=spec.get("note"),
                    ),
                    source=source,
                    created_by="app" if source == AlertSource.USER else "mcp",
                )
            n_owner, n_agent = len(plan.owner_alerts), len(plan.agent_alerts)
            self.note(profile.slug, "alerts", f"created ({n_owner} owner, {n_agent} agent)")

    def daily_check(self, profile) -> None:
        from sqlmodel import select

        from finanse.core.db import get_session
        from finanse.modules.investments.models import InvRuleRun
        from finanse.modules.investments.service import daily

        with get_session() as s:
            if s.exec(select(InvRuleRun.id).where(InvRuleRun.profile_id == profile.id)).first():
                self.note(profile.slug, "daily check", "exists")
                return
        report = daily.run_daily_check(
            "demo", profile_ids=[profile.id], as_of=self.today, offline=True, lock_wait=30
        )
        run = report.profiles[0]
        self.note(profile.slug, "daily check", f"{run.status} ({len(run.new_signals)} new signals)")

    def research(self, plan: Plan, profile) -> None:
        from sqlmodel import select

        from finanse.core.db import get_session
        from finanse.core.models import utcnow
        from finanse.modules.investments.models import InvResearchRun
        from finanse.modules.investments.research import service
        from finanse.modules.investments.research.validation import validate_note, validate_scope

        with get_session() as s:
            if s.exec(
                select(InvResearchRun.id).where(InvResearchRun.profile_id == profile.id)
            ).first():
                self.note(profile.slug, "research", "exists")
                return
        now = utcnow()
        published = (self.today - dt.timedelta(days=2)).isoformat()

        def src(n: int) -> list[dict]:
            return [
                {
                    "url": f"https://example.com/demo-research/{profile.slug}/{n}",
                    "publisher": "Example News",
                    "published_at": published,
                    "title": f"Przykładowy artykuł {n}",
                }
            ]

        held = plan.theses[0][0]
        notes = [
            (
                {
                    "kind": "news",
                    "polarity": "positive",
                    "strength": 2,
                    "thesis_relation": "supports",
                    "thesis_field": "thesis",
                    "title": f"{held.symbol}: napływy do funduszu rosną",
                    "summary": "Przykładowe źródło opisuje wyższe napływy netto do funduszu w ostatnim "
                    "kwartale. Fakt bez rekomendacji.",
                    "sources": src(1),
                },
                held.key,
            ),
            (
                {
                    "kind": "community",
                    "polarity": "neutral",
                    "strength": 1,
                    "title": f"{held.symbol}: dyskusja na forum inwestorów",
                    "summary": "Wątek na forum (szum, mała społeczność) o kosztach funduszu; brak nowych "
                    "faktów.",
                    "details": {"scale": "small"},
                    "sources": src(2),
                },
                held.key,
            ),
            (
                {
                    "kind": "trend",
                    "polarity": "neutral",
                    "strength": 1,
                    "theme": "stopy procentowe",
                    "title": "Rynek oczekuje stabilnych stóp procentowych",
                    "summary": "Przykładowe dane rynkowe pokazują stabilne oczekiwania co do stóp "
                    "procentowych w najbliższych miesiącach.",
                    "sources": src(3),
                },
                None,
            ),
            (
                {
                    "kind": "candidate",
                    "polarity": "neutral",
                    "strength": 1,
                    "title": "Kandydat: Demo Infrastructure UCITS ETF",
                    "summary": "Nowy fundusz infrastrukturalny w przykładowym źródle; do oceny według "
                    "kryteriów strategii.",
                    "candidate": {
                        "symbol_or_isin": "DMIF.DE",
                        "name": "Demo Infrastructure UCITS ETF",
                        "currency": "EUR",
                    },
                    "details": {
                        "entry_type": "trend",
                        "criteria": [
                            {"text": "Niskie koszty (TER)", "met": True, "threshold": "do 0,3%"},
                            {"text": "Fundusz akumulujący", "met": False},
                        ],
                    },
                    "sources": src(4),
                },
                None,
            ),
        ]
        with get_session() as s:
            prof = s.get(type(profile), profile.id)
            run = service.start_run(
                s, prof, validate_scope({"held": True, "watchlist": True}), now=now
            )
            for raw, ref in notes:
                raw = {k: v for k, v in raw.items() if v is not None}
                data = validate_note(raw, now=now)
                instrument_id = service.resolve_reference(s, profile.id, ref) if ref else None
                service.add_note(s, prof, data, instrument_id=instrument_id, run_id=run.id, now=now)
            service.finish_run(s, prof, run.id, status="done", now=now + dt.timedelta(minutes=12))
        self.note(profile.slug, "research", f"run done ({len(notes)} notes)")

    def journal_and_plans(self, plan: Plan, profile, account_id: int) -> None:
        from sqlmodel import select

        from finanse.core.db import get_session
        from finanse.modules.investments.models import InvInstrument
        from finanse.modules.investments.service import planned
        from finanse.modules.investments.store import journal

        pid = profile.id
        with get_session() as s:
            prof = s.get(type(profile), pid)
            if planned.planned_deposits(s, pid):
                self.note(profile.slug, "planned deposit", "exists")
            else:
                planned.create(
                    s,
                    prof,
                    planned.PlannedInput(
                        amount=str(plan.planned_deposit),
                        planned_date=add_months(self.today, 1, 10),
                        account_id=account_id,
                        note="Wpłata z nadwyżki miesiąca",
                    ),
                    today=self.today,
                )
                self.note(profile.slug, "planned deposit", "created")
        with get_session() as s:
            if journal.decisions(s, pid):
                self.note(profile.slug, "decision", "exists")
                return
            inst = plan.theses[0][0]
            iid = s.exec(select(InvInstrument.id).where(InvInstrument.isin == inst.key)).one()
            journal.record_decision(
                s,
                pid,
                action="held",
                instrument_id=iid,
                account_id=account_id,
                reason="Trzymam zgodnie z planem, bez zmian po przeglądzie.",
            )
            self.note(profile.slug, "decision", "created")

    def proposal(self, plan: Plan, profile, account_id: int) -> None:
        from finanse.core import proposals
        from finanse.core.db import get_session
        from finanse.core.mcp.registry import ToolContext
        from finanse.core.mcp.tools import investments_proposals
        from finanse.modules.investments.service import files

        if not plan.proposal:
            return
        with get_session() as s:
            if proposals.list_proposals(s, profile.id):
                self.note(profile.slug, "import proposal", "exists")
                return
        target = files.profile_dir(profile.slug) / "agent-inbox" / "demo-uzupelnienie.csv"
        files.ensure_dir(target.parent)
        files.write_private(target, proposal_file(plan, profile.slug, self.today))
        with get_session() as s:
            prof = s.get(type(profile), profile.id)
            ctx = ToolContext(session=s, profile=prof, privacy=prof.mcp_privacy, today=self.today)
            out = investments_proposals.propose_import(
                ctx,
                str(target),
                str(account_id),
                reason="Nowa wpłata i zakup z ostatniego wyciągu (dane demo).",
            )
        stored = getattr(out.get("stored"), "value", out.get("stored"))
        self.note(profile.slug, "import proposal", f"pending (stored={stored})")

    # -- all -------------------------------------------------------------------------------- #
    def run(self) -> dict:
        for plan in PLANS:
            log(f"{plan.name}:")
            profile = self.profile(plan)
            self.budget(plan, profile)
            self.loans_assets(plan, profile)
            account_id = self.brokerage(plan, profile)
            self.strategy(plan, profile)
            self.watchlist(plan, profile)
            self.market_data(profile)
            self.theses_alerts(plan, profile)
            self.daily_check(profile)
            self.research(plan, profile)
            self.journal_and_plans(plan, profile, account_id)
            self.proposal(plan, profile, account_id)
        return self.summary


def _check_target(data_dir: Path, force: bool) -> None:
    from finanse.core import paths

    real = paths.default_data_dir().expanduser().resolve()
    if data_dir == real and not force:
        raise SystemExit(
            f"refusing to write demo data into the real data dir {real}; pass another "
            "--data-dir (or --force if you really mean it)"
        )
    if data_dir == paths.LEGACY_DIR.resolve():
        raise SystemExit("refusing to write demo data into the repository data/ folder")
    from finanse import db

    file = db.sqlite_file(str(db.engine.url))
    if file is None or not file.resolve().is_relative_to(data_dir):
        raise SystemExit(
            f"the database ({db.engine.url}) is not inside {data_dir}; unset "
            "FINANSE_DATABASE_URL (environment or .env) before seeding demo data"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data-dir", required=True, help="Target data dir (FINANSE_DATA_DIR).")
    parser.add_argument(
        "--force", action="store_true", help="Allow the platform default data dir (the real one)."
    )
    parser.add_argument(
        "--today",
        type=dt.date.fromisoformat,
        default=None,
        help="Reference day (YYYY-MM-DD) for the generated history; default today.",
    )
    args = parser.parse_args(argv)

    data_dir = Path(args.data_dir).expanduser().resolve()
    os.environ["FINANSE_DATA_DIR"] = str(data_dir)
    os.environ.pop("FINANSE_DATABASE_URL", None)
    if "finanse" in sys.modules:
        raise SystemExit("demo_data must be run before finanse is imported (fresh interpreter)")
    _check_target(data_dir, args.force)

    from finanse.core import paths
    from finanse.core.db import init_db

    paths.ensure_private_dir(data_dir)
    init_db()
    log(f"Demo data -> {data_dir}")
    Seeder(args.today or dt.date.today()).run()  # noqa: DTZ011 - local calendar day
    log("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
