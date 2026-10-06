"""Synthetic data for the MCP tests: one profile with every module, filled with values the privacy
layer must never send in strict mode (IBANs and account numbers, person names, distinctive absolute
amounts), plus export files (CSV with a preamble, XLSX) carrying the same kind of values. Every value
here is invented; the IBANs and ISINs are checksum-valid synthetic examples.
"""

from __future__ import annotations

import datetime as dt
import io
import json
import math
import re
import zipfile
from decimal import Decimal
from pathlib import Path

from conftest import seed_demo

from cashu.core import accounts, profiles
from cashu.core.db import get_session
from cashu.core.models import Source, utcnow
from cashu.modules.investments.domain import Currency, FxRate, Instrument, PriceBar
from cashu.modules.investments.importing import ImportFile
from cashu.modules.investments.market import PriceHistory, PriceSource
from cashu.modules.investments.service import accounts as inv_accounts
from cashu.modules.investments.service import daily, files, imports
from cashu.modules.investments.service.daily import MarketSources

TODAY = dt.date.today()  # noqa: DTZ011 - the views value portfolios as of today

# --------------------------------------------------------------------------- #
# What must never leave in strict mode (and identifiers never in any mode)
# --------------------------------------------------------------------------- #

IBAN_P2P = "PL61109010140000071219812874"
IBAN_P2P_SPACED = "PL61 1090 1014 0000 0712 1981 2874"
IBAN_RICH = "PL27114020040000300201355387"
IBANS = [IBAN_P2P, IBAN_RICH, "99114000000000000000000001", "99109000000000000000000003"]
PROFILE_NAME = "Marta Kowalczyk"
PERSON_P2P = "ZOFIA WISNIEWSKA"
PERSON_OWNER = "MARTA KOWALCZYK"
INV_ACCOUNT_NAME = "IKE Grzegorza Brzeczyszczykiewicza"
RICH_ACCOUNT_NAME = "Konto Marty Kowalczyk"
PERSON_ADDRESS = "ANNA NOWAK UL. POLNA 5 WARSZAWA"
BLIK_TITLE = "BLIK NA TELEFON DO PIOTR ZIELINSKI"
CLAIM_NAME = "Pozyczka Adam Nowak"
CLAIM_SYMBOL = "ADAM NOWAK 950"
PERSON_TOKENS = [
    "KOWALCZYK",
    "WISNIEWSKA",
    "BRZECZYSZCZYKIEWICZ",
    "BRZECZYSZCZYKIEWICZA",
    "ZOFIA",
    "NOWAK",
    "ZIELINSKI",
    "POLNA",
]
# Distinctive absolute amounts placed in the data (balances, transactions, deposits, quantities).
AMOUNTS = [
    Decimal("987654.32"),
    Decimal("76543.21"),
    Decimal("12345.67"),
    Decimal("4321.09"),
    Decimal("5667.69"),
    Decimal("2602.50"),
    Decimal("9127.49"),
]


def amount_renderings(value: Decimal) -> list[str]:
    """How an amount could show up in JSON or text."""
    text = f"{value:.2f}"
    whole, frac = text.split(".")
    grouped = f"{int(whole):,}".replace(",", " ")
    out = {
        text,
        text.replace(".", ","),
        f"{grouped},{frac}",
        f"{grouped}.{frac}",
        str(float(value)),
    }
    if int(whole) >= 10000:
        out.add(whole)
    return sorted(out)


# --------------------------------------------------------------------------- #
# Market data fakes (deterministic price paths, no network)
# --------------------------------------------------------------------------- #

BASES = {"PKO.WA": 45.0, "AAPL": 200.0, "EUNL.DE": 90.0}
FX = {"EUR": Decimal("4.3"), "USD": Decimal("4.0")}


def weekdays(start: dt.date, end: dt.date):
    day = start
    while day <= end:
        if day.weekday() < 5:
            yield day
        day += dt.timedelta(days=1)


def price_on(symbol: str, day: dt.date) -> Decimal:
    base = BASES[symbol]
    t = (day - dt.date(2024, 1, 1)).days
    return Decimal(str(round(base * (1 + 0.25 * math.sin(t / 70)) * (1 + t / 3000), 2)))


class WavePrices(PriceSource):
    @property
    def id(self) -> str:
        return "yahoo"

    def history(self, instrument: Instrument, start: dt.date, end: dt.date) -> list[PriceBar]:
        return list(self.fetch(instrument, start, end).bars)

    def fetch(self, instrument: Instrument, start: dt.date, end: dt.date) -> PriceHistory:
        symbol = instrument.alias("yahoo") or ""
        if symbol not in BASES:
            return PriceHistory()
        now = utcnow()
        bars = tuple(
            PriceBar(
                instrument_id=instrument.id,
                date=day,
                close=price_on(symbol, day),
                source="yahoo",
                fetched_at=now,
                currency=instrument.currency,
            )
            for day in weekdays(start, end)
        )
        return PriceHistory(bars=bars, currency=instrument.currency)


class FlatFx:
    @property
    def id(self) -> str:
        return "nbp"

    def rates(self, quote: Currency, start: dt.date, end: dt.date) -> list[FxRate]:
        rate = FX.get(str(quote))
        if rate is None:
            return []
        return [
            FxRate(quote=Currency(quote), date=d, rate=rate, source="nbp")
            for d in weekdays(start, end)
        ]


def sources() -> MarketSources:
    return MarketSources(WavePrices(), FlatFx())


# --------------------------------------------------------------------------- #
# Investments history (cashU import format)
# --------------------------------------------------------------------------- #

HEADER = (
    "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,"
    "currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source"
)
ROWS = [
    "1,txn,2024-01-03,,deposit,M-1,,,,,,,PLN,,,,76543.21,,,,",
    "1,txn,2024-01-10,,buy,M-2,PKO,PLPKO0000016,PKO Bank Polski,XWAR,137,41.37,PLN,5667.69,4.11,,-5671.80,,,,",
    "1,txn,2024-01-15,,buy,M-3,AAPL,US0378331005,Apple Inc,XNAS,23,187.13,USD,4303.99,,,-17904.60,PLN,4.16,,",
    "1,txn,2024-02-01,,buy,M-4,EUNL,IE00B4L5Y983,iShares Core MSCI World,XETR,31,88.17,EUR,2733.27,,,-11780.39,PLN,4.31,,",
    "1,txn,2025-03-14,,sell,M-5,PKO,PLPKO0000016,PKO Bank Polski,XWAR,50,52.11,PLN,2605.50,3.00,,2602.50,,,,",
    "1,txn,2025-06-02,,deposit,M-6,,,,,,,PLN,,,,12345.67,,,,",
    "1,txn,2025-06-05,,buy,M-7,PKO,PLPKO0000016,PKO Bank Polski,XWAR,40,47.89,PLN,1915.60,,,-1915.60,,,,",
    "1,txn,2025-11-20,,sell,M-8,AAPL,US0378331005,Apple Inc,XNAS,10,225.37,USD,2253.70,,,9127.49,PLN,4.05,,",
]


def canonical_csv() -> bytes:
    return ("\n".join([HEADER, *ROWS]) + "\n").encode("utf-8")


STRATEGY_YAML = """\
version: 1
base_currency: PLN
# owner's note: the IKE account at the broker (comments stay when rules are merged)
contributions:
  monthly_amount: 4321.09
  day_of_month: 10
data:
  max_price_age_days: 5
  max_stale_weight: 1.0
  max_unclassified_weight: 1.0
buckets:
  - id: stocks
    match: { asset_class: [equity, etf] }
  - id: cash
    match: { asset_class: cash }
allocation:
  targets: { stocks: 0.8, cash: 0.2 }
  rebalance:
    absolute_band_pp: 5
    relative_band: 0.25
    min_trade_value: 100
rules:
  - id: rebalance_check
    kind: allocation_drift
    severity: action
  - id: concentration
    kind: position_concentration
    severity: action
    params: { max_weight: 0.20 }
  - id: idle_cash
    kind: cash_level
    params: { max_weight: 0.15 }
  - id: missed_deposit
    kind: contribution_gap
    params: { period_days: 31, grace_days: 10 }
  - id: cash_waiting
    kind: custom
    params:
      scope: portfolio
      when: 'cash_weight > 10%'
      message: Cash is waiting

# trailing comment block
notifications:
  immediate: [action]
  digest_weekday: sunday
"""


def write_strategy(slug: str, text: str = STRATEGY_YAML) -> None:
    files.write_text_private(files.strategy_yaml_path(slug), text)
    files.write_text_private(files.strategy_md_path(slug), "# Strategia\n\nPasywnie.\n")


# --------------------------------------------------------------------------- #
# The fuzz profile
# --------------------------------------------------------------------------- #


def _raw(day, amount, *, cp=None, iban=None, ref=None, desc=None):
    from cashu.modules.budget.ingestion.normalize import RawTransaction

    return RawTransaction(
        booking_date=day,
        amount=Decimal(amount),
        currency="PLN",
        counterparty_name=cp,
        counterparty_iban=iban,
        reference=ref,
        description=desc,
        source=Source.CSV,
    )


def seed_profile(name: str = PROFILE_NAME, *, run_daily: bool = True) -> tuple[int, str]:
    """A profile with budget, assets, loans and investments, full of sensitive synthetic values."""
    from cashu.modules.budget import service as budget

    with get_session() as s:
        p = profiles.create_profile(
            s, name=name, modules_=["budget", "assets", "loans", "investments"]
        )
        pid, slug = p.id, p.slug
    with get_session() as s:
        seed_demo(s, pid)
    with get_session() as s:
        rich = accounts.get_or_create_account(
            s, bank="mbank", iban=IBAN_RICH, name=RICH_ACCOUNT_NAME, profile_id=pid
        )
        rows = []
        for m in (6, 7, 8, 9):
            rows += [
                _raw(
                    dt.date(2026, m, 4),
                    "-4321.09",
                    cp=PERSON_P2P,
                    iban=IBAN_P2P,
                    ref=f"CZYNSZ DLA {PERSON_P2P} {IBAN_P2P_SPACED}",
                    desc="PRZELEW WYCHODZACY",
                ),
                _raw(
                    dt.date(2026, m, 12),
                    "12345.67",
                    cp=PERSON_OWNER,
                    iban="99114000000000000000000001",
                    ref="PRZELEW WLASNY",
                    desc="PRZELEW PRZYCHODZACY",
                ),
                _raw(
                    dt.date(2026, m, 18),
                    "-260.00",
                    cp=None,
                    iban=None,
                    ref="SKLEP OSIEDLOWY KOWALCZYK",
                    desc="ZAKUP PRZY UZYCIU KARTY",
                ),
                # a payee with the address appended (common in Polish exports)
                _raw(
                    dt.date(2026, m, 20),
                    "-1850.00",
                    cp=PERSON_ADDRESS,
                    iban="PL10105000997603123456789123",
                    ref="ZA LEKCJE",
                    desc="PRZELEW WYCHODZACY",
                ),
                # transfers known only by their title, with and without an account number
                _raw(
                    dt.date(2026, m, 22),
                    "-95.00",
                    cp=None,
                    iban="PL83101010230000261395100000",
                    ref=BLIK_TITLE,
                    desc="PRZELEW WYCHODZACY",
                ),
                _raw(
                    dt.date(2026, m, 23),
                    "-45.00",
                    cp=None,
                    iban=None,
                    ref="PRZELEW BLIK DO MAREK ZIELINSKI",
                    desc="BLIK",
                ),
            ]
        budget.ingest_transactions(s, rich, rows, source=Source.CSV)
        accounts.upsert_balance(
            s, rich, dt.date(2026, 9, 30), Decimal("987654.32"), source=Source.CSV
        )
        budget.categorize_all(s, profile_id=pid)
    with get_session() as s:
        account_id = inv_accounts.add_account(
            s, pid, name=INV_ACCOUNT_NAME, broker="dif", wrapper="ike"
        ).id
    with get_session() as s:
        profile = s.get(profiles.Profile, pid)
        preview = imports.preview(
            s,
            profile,
            imports.ImportRequest(ImportFile("history.csv", canonical_csv()), account_id),
        )
    imports.commit(preview)
    add_claim(pid, account_id)
    write_strategy(slug)
    if run_daily:
        daily.run_daily_check("manual", profile_ids=[pid], as_of=TODAY, sources=sources())
    return pid, slug


def add_claim(profile_id: int, account_id: int) -> int:
    """A private loan held as a claim, named after a person (owner-entered name and symbol)."""
    from cashu.modules.investments.models import InvInstrument, InvTransaction
    from cashu.modules.investments.store.transactions import upsert_manual_valuation

    with get_session() as s:
        inst = InvInstrument(
            name=CLAIM_NAME,
            symbol=CLAIM_SYMBOL,
            currency="PLN",
            asset_class="claim",
            valuation_mode="manual",
            tags=[],
        )
        s.add(inst)
        s.flush()
        s.add(
            InvTransaction(
                account_id=account_id,
                type="buy",
                trade_date=dt.date(2025, 2, 1),
                instrument_id=inst.id,
                quantity=Decimal(1),
                price=Decimal("950.00"),
                currency="PLN",
                gross_amount=Decimal("950.00"),
                fee=Decimal(0),
                tax=Decimal(0),
                cash_amount=Decimal("-950.00"),
                cash_currency="PLN",
                source="manual",
                dedup_hash=f"claim-{inst.id}",
            )
        )
        upsert_manual_valuation(
            s,
            profile_id,
            inst.id,
            dt.date(2025, 2, 1),
            Decimal("950.00"),
            "PLN",
            note=f"umowa z {CLAIM_NAME}",
        )
        return inst.id


def investments_account_id(profile_id: int) -> int:
    from cashu.modules.investments.store.transactions import brokerage_accounts

    with get_session() as s:
        return brokerage_accounts(s, profile_id)[0].id


# --------------------------------------------------------------------------- #
# Export files
# --------------------------------------------------------------------------- #

EXPORT_CSV = (
    f"Rachunek: {IBAN_P2P_SPACED};Wlasciciel: {PROFILE_NAME}\n"
    "Wygenerowano: 2026-03-01;\n"
    "\n"
    "Data;Typ;Instrument;ISIN;Ilosc;Cena;Kwota;Rachunek;Wlasciciel;Opis\n"
    f"03.01.2024;Wplata;;;;;76 543,21;{IBAN_P2P};{PROFILE_NAME};Przelew od {PERSON_P2P}\n"
    f"10.01.2024;Kupno;PKO;PLPKO0000016;137;41,37;-5 667,69;{IBAN_P2P};{PROFILE_NAME};Zlecenie 1\n"
    f"15.01.2024;Kupno;AAPL;US0378331005;23;187,13;-4 303,99;{IBAN_P2P};{PROFILE_NAME};Zlecenie 2\n"
    f"14.03.2025;Sprzedaz;PKO;PLPKO0000016;50;52,11;2 602,50;{IBAN_P2P};{PROFILE_NAME};Zlecenie 3\n"
    f"02.06.2025;Wplata;;;;;12 345,67;{IBAN_P2P};{PROFILE_NAME};Przelew\n"
    f"05.06.2025;Kupno;PKO;PLPKO0000016;40;47,89;-1 915,60;{IBAN_P2P};{PROFILE_NAME};Zlecenie 4\n"
)


def write_export_csv(folder: Path) -> Path:
    path = folder / "export.csv"
    path.write_text(EXPORT_CSV, encoding="utf-8")
    return path


def write_export_xlsx(folder: Path) -> Path:
    """A minimal XLSX (shared strings, numbers, a date style) written with the standard library."""
    header = ["Date", "Type", "Symbol", "Quantity", "Amount", "Account", "Owner"]
    rows = [
        (45294, "BUY", "PKO", 137, -5667.69, IBAN_P2P, PROFILE_NAME),
        (45299, "BUY", "AAPL", 23, -4303.99, IBAN_P2P, PROFILE_NAME),
        (45730, "SELL", "PKO", 50, 2602.50, IBAN_P2P, PROFILE_NAME),
        (45810, "DEPOSIT", "", 0, 12345.67, IBAN_P2P, PROFILE_NAME),
        (45813, "BUY", "PKO", 40, -1915.60, IBAN_P2P, PROFILE_NAME),
    ]
    strings: list[str] = []

    def sidx(value: str) -> int:
        if value not in strings:
            strings.append(value)
        return strings.index(value)

    def col(i: int) -> str:
        return chr(65 + i)

    sheet_rows = []
    cells = "".join(f'<c r="{col(i)}1" t="s"><v>{sidx(h)}</v></c>' for i, h in enumerate(header))
    sheet_rows.append(f'<row r="1">{cells}</row>')
    for r, row in enumerate(rows, start=2):
        cells = []
        for i, value in enumerate(row):
            ref = f"{col(i)}{r}"
            if isinstance(value, str):
                cells.append(f'<c r="{ref}" t="s"><v>{sidx(value)}</v></c>')
            elif i == 0:
                cells.append(f'<c r="{ref}" s="1"><v>{value}</v></c>')
            else:
                cells.append(f'<c r="{ref}"><v>{value}</v></c>')
        sheet_rows.append(f'<row r="{r}">{"".join(cells)}</row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    rel_ns = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    sst = "".join(f"<si><t>{s}</t></si>" for s in strings)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr(
            "xl/workbook.xml",
            f'<workbook {ns} {rel_ns}><sheets><sheet name="Transakcje {IBAN_P2P[-8:]}" sheetId="1" '
            'r:id="rId1"/></sheets></workbook>',
        )
        z.writestr(
            "xl/_rels/workbook.xml.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Target="worksheets/sheet1.xml" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>'
            "</Relationships>",
        )
        z.writestr("xl/sharedStrings.xml", f"<sst {ns}>{sst}</sst>")
        z.writestr(
            "xl/styles.xml",
            f'<styleSheet {ns}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>'
            "</styleSheet>",
        )
        z.writestr(
            "xl/worksheets/sheet1.xml",
            f"<worksheet {ns}><sheetData>{''.join(sheet_rows)}</sheetData></worksheet>",
        )
    path = folder / "export.xlsx"
    path.write_bytes(buf.getvalue())
    return path


def write_canonical(folder: Path, name: str = "converted.csv") -> Path:
    path = folder / name
    path.write_bytes(canonical_csv())
    return path


# --------------------------------------------------------------------------- #
# Leak assertions
# --------------------------------------------------------------------------- #

_IBAN_LIKE = re.compile(r"[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,8}")
_LONG_DIGITS = re.compile(r"\d(?:[ -]?\d){9,}")
_ISO = re.compile(r"\d{4}-\d{2}-\d{2}(?:T[0-9:.+]+)?")


def fold(text: str) -> str:
    from cashu.core.mcp.names import fold as _fold

    return _fold(text)


def leaks(data, *, strict: bool) -> list[str]:
    """Every forbidden value found in a tool answer (empty = clean)."""
    blob = json.dumps(data, ensure_ascii=False)
    folded = fold(blob)
    found: list[str] = []
    no_dates = _ISO.sub("", blob)
    for iban in IBANS + [IBAN_P2P_SPACED]:
        if iban in blob or iban.replace(" ", "") in blob.replace(" ", ""):
            found.append(f"iban {iban}")
    for m in _IBAN_LIKE.finditer(no_dates):
        from cashu.core.mcp.redaction import isin_valid

        if not isin_valid(m.group(0)):
            found.append(f"iban-like {m.group(0)}")
    from cashu.core.mcp.redaction import isin_valid

    no_isins = re.sub(
        r"[A-Z]{2}[A-Z0-9]{9}\d", lambda m: "" if isin_valid(m.group(0)) else m.group(0), no_dates
    )
    for m in _LONG_DIGITS.finditer(no_isins):
        found.append(f"digits {m.group(0)}")
    for token in PERSON_TOKENS:
        if re.search(rf"(?<![A-Z]){token}(?![A-Z])", folded):
            found.append(f"name {token}")
    for name in (INV_ACCOUNT_NAME, RICH_ACCOUNT_NAME, PROFILE_NAME):
        if fold(name) in folded:
            found.append(f"name {name}")
    if strict:
        for value in AMOUNTS:
            for r in amount_renderings(value):
                if r in blob:
                    found.append(f"amount {r}")
    return found
