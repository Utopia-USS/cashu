"""End to end without a database: importer -> plan_import (in-memory resolver) -> build_snapshot.

Covers the pure ImportService.preview port (plan_import) and the review fixes R5, R8, R9 and R10 on the
real portfolio math.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from pathlib import Path

from imp_support import (
    SIMPLE_HEADER,
    counter_ids,
    csv_file,
    d,
    day,
    instrument,
    pl_export_cp1250,
    pl_export_utf8_bom,
    pl_mapping,
    simple_mapping,
)

from cashu.modules.investments.domain import (
    AssetClass,
    Currency,
    HistoryGap,
    InstrumentAlias,
    InstrumentStatus,
    TxnType,
)
from cashu.modules.investments.importing import (
    CanonicalImporter,
    CsvField,
    CsvMapping,
    GenericCsvImporter,
    ImportFile,
    ImportPlan,
    ImportWarningKind,
    InMemoryInstrumentLookup,
    InstrumentMatch,
    PositionDiffKind,
    effective_broker_id,
    plan_import,
    reconcile,
)
from cashu.modules.investments.portfolio import build_snapshot

ACCOUNT = "acc-1"
NOW = datetime(2026, 2, 1, 12, tzinfo=UTC)
SPEC = Path(__file__).resolve().parents[3] / "docs" / "import-format.md"


def plan(importer, file: ImportFile, lookup=None, existing=frozenset()) -> ImportPlan:
    result = importer.parse(file)
    return plan_import(
        result,
        account_id=ACCOUNT,
        broker_id=effective_broker_id(importer, result),
        lookup=lookup or InMemoryInstrumentLookup(),
        existing_hashes=lambda hashes: [h for h in hashes if h in existing],
        batch_id="batch-1",
        now=NOW,
        txn_id_factory=counter_ids("t"),
        instrument_id_factory=counter_ids("i"),
    )


def holdings_by_symbol(import_plan: ImportPlan, as_of: str, renames=()):
    snapshot = build_snapshot(
        "p", import_plan.transactions_to_insert(), day(as_of), renames=renames
    )
    by_symbol = {}
    for holding in snapshot.holdings:
        symbol = import_plan.instruments[holding.instrument_id].symbol
        by_symbol[symbol] = holding
    return snapshot, by_symbol


def test_generic_csv_to_snapshot_numbers() -> None:
    import_plan = plan(GenericCsvImporter(pl_mapping()), ImportFile("pl.csv", pl_export_utf8_bom()))
    assert import_plan.can_commit
    assert import_plan.new_count == 7 and import_plan.duplicate_count == 0
    assert [w.kind for w in import_plan.warnings] == [ImportWarningKind.IGNORED_ROW]
    zgj, etf = import_plan.new_instruments
    assert (zgj.symbol, zgj.mic, zgj.asset_class, zgj.currency) == (
        "ZGJ",
        "XWAR",
        AssetClass.EQUITY,
        Currency.PLN,
    )
    assert etf.asset_class == AssetClass.ETF and etf.needs_classification
    assert zgj.alias("yahoo") == "ZGJ.WA"

    snapshot, held = holdings_by_symbol(import_plan, "2026-01-31")
    assert held["ZGJ"].quantity == d("15"), "two identical buys of 10, then a sale of 5"
    assert held["ZGJ"].cost_basis == d("942.195")
    assert held["ETFW"].quantity == d("3")
    # OpenLot exposes a unit cost rounded to 10 places, so the derived basis can be off in the 10th.
    assert held["ETFW"].cost_basis.quantize(d("0.01")) == d("3708.50")
    (cash,) = snapshot.cash
    assert (cash.currency, cash.amount) == (Currency.PLN, d("5385.65"))
    (trade,) = snapshot.realized
    assert trade.proceeds == d("348.25") and trade.pnl == d("34.185")
    assert snapshot.warnings == ()

    rows = import_plan.rows
    assert all(row.txn.import_batch_id == "batch-1" for row in rows)
    assert rows[1].match == rows[2].match == InstrumentMatch.CREATED, "same hint, cached"
    assert rows[2].txn.instrument_id == rows[1].txn.instrument_id
    assert rows[5].match == InstrumentMatch.ISIN, "the dividend row finds the planned instrument"
    assert rows[0].match is None
    assert len({row.txn.dedup_hash for row in rows}) == 7
    assert [t.created_at for t in import_plan.transactions_to_insert()] == [
        NOW + timedelta(milliseconds=i) for i in range(7)
    ]


def test_reimport_and_other_encoding_are_all_duplicates_r8() -> None:
    first = plan(GenericCsvImporter(pl_mapping()), ImportFile("pl.csv", pl_export_utf8_bom()))
    stored = {row.txn.dedup_hash for row in first.rows}
    lookup = InMemoryInstrumentLookup(first.new_instruments)
    again = plan(
        GenericCsvImporter(pl_mapping()), ImportFile("pl.csv", pl_export_utf8_bom()), lookup, stored
    )
    assert again.duplicate_count == 7 and again.new_count == 0
    assert again.new_instruments == ()
    cp1250 = plan(
        GenericCsvImporter(pl_mapping("windows-1250")),
        ImportFile("pl_cp1250.csv", pl_export_cp1250()),
        lookup,
        stored,
    )
    assert cp1250.duplicate_count == 7


def test_overlapping_export_with_partial_fills_inserts_only_the_new_fill_r8() -> None:
    importer = GenericCsvImporter(simple_mapping())
    first = plan(
        importer, csv_file(f"{SIMPLE_HEADER}\nO-1,2026-01-05,buy,PKN,,GPW,5,60,PLN,0,-300\n")
    )
    stored = {row.txn.dedup_hash for row in first.rows}
    lookup = InMemoryInstrumentLookup(first.new_instruments)
    second = plan(
        importer,
        csv_file(
            f"{SIMPLE_HEADER}\n"
            "O-1,2026-01-05,buy,PKN,,GPW,7,61,PLN,0,-427\n"
            "O-1,2026-01-05,buy,PKN,,GPW,5,60,PLN,0,-300.00\n"
        ),
        lookup,
        stored,
    )
    assert [row.is_duplicate for row in second.rows] == [False, True]
    combined = list(first.transactions_to_insert()) + list(second.transactions_to_insert())
    snapshot = build_snapshot("p", combined, day("2026-01-31"))
    assert snapshot.holdings[0].quantity == d("12")


def test_cross_currency_trade_books_cash_in_pln_and_cost_in_usd_r5() -> None:
    mapping = CsvMapping(
        default_currency=Currency.PLN,
        columns={
            CsvField.TRADE_DATE: "date",
            CsvField.TYPE: "type",
            CsvField.SYMBOL: "symbol",
            CsvField.EXCHANGE: "exchange",
            CsvField.QUANTITY: "qty",
            CsvField.PRICE: "price",
            CsvField.CURRENCY: "ccy",
            CsvField.FEE: "fee",
            CsvField.CASH_AMOUNT: "cash",
            CsvField.CASH_CURRENCY: "cash_ccy",
            CsvField.FX_RATE: "fx",
        },
    )
    content = (
        "date,type,symbol,exchange,qty,price,ccy,fee,cash,cash_ccy,fx\n"
        "2026-01-02,deposit,,,,,PLN,,10000,,\n"
        "2026-01-05,buy,AAPL,NASDAQ,10,100,USD,1,,PLN,4.0\n"
    )
    import_plan = plan(GenericCsvImporter(mapping), csv_file(content))
    snapshot, held = holdings_by_symbol(import_plan, "2026-01-31")
    assert held["AAPL"].currency == Currency.USD and held["AAPL"].cost_basis == d("1001")
    (cash,) = snapshot.cash
    assert (cash.currency, cash.amount) == (Currency.PLN, d("5996"))
    without_rate = plan(GenericCsvImporter(mapping), csv_file(content.replace(",PLN,4.0", ",PLN,")))
    assert not without_rate.can_commit
    assert without_rate.blocking_errors[0].kind == ImportWarningKind.FX_MISSING


def test_single_day_newest_first_file_is_ordered_by_time_r9() -> None:
    import_plan = plan(
        GenericCsvImporter(simple_mapping()),
        csv_file(
            f"{SIMPLE_HEADER}\n"
            "r2,2026-09-02 15:00,sell,PKN,,GPW,10,71,PLN,0,710\n"
            "r1,2026-09-02 10:00,buy,PKN,,GPW,10,60,PLN,0,-600\n"
        ),
    )
    assert [t.external_ref for t in import_plan.transactions_to_insert()] == ["r1", "r2"]
    snapshot = build_snapshot("p", import_plan.transactions_to_insert(), day("2026-09-02"))
    assert snapshot.holdings == (), "bought, then sold"
    assert not any(isinstance(w, HistoryGap) for w in snapshot.warnings)
    (trade,) = snapshot.realized
    assert trade.pnl == d("110")


def test_newest_first_file_keeps_same_day_order() -> None:
    import_plan = plan(
        GenericCsvImporter(simple_mapping()),
        csv_file(
            f"{SIMPLE_HEADER}\n"
            "r3,2026-01-08,sell,PKN,,GPW,2,71,PLN,0,142\n"
            "r2,2026-01-07,sell,PKN,,GPW,3,70,PLN,0,210\n"
            "r1,2026-01-07,buy,PKN,,GPW,5,60,PLN,0,-300\n"
        ),
    )
    ordered = import_plan.transactions_to_insert()
    assert [t.external_ref for t in ordered] == ["r1", "r2", "r3"]
    assert all(a.created_at < b.created_at for a, b in pairwise(ordered))


def test_new_instrument_currency_from_priced_trades_in_a_newest_first_file_r10() -> None:
    mapping = CsvMapping(
        columns={
            CsvField.TRADE_DATE: "date",
            CsvField.TYPE: "type",
            CsvField.SYMBOL: "symbol",
            CsvField.QUANTITY: "qty",
            CsvField.PRICE: "price",
            CsvField.CURRENCY: "ccy",
            CsvField.CASH_AMOUNT: "cash",
            CsvField.CASH_CURRENCY: "cash_ccy",
            CsvField.FX_RATE: "fx",
        },
    )
    import_plan = plan(
        GenericCsvImporter(mapping),
        csv_file(
            "date,type,symbol,qty,price,ccy,cash,cash_ccy,fx\n"
            "2026-03-10,tax,AAPL.US,,,PLN,-1.5,,\n"
            "2026-03-10,dividend,AAPL.US,,,PLN,10,,\n"
            "2026-01-05,buy,AAPL.US,10,150,USD,-6000,PLN,4.0\n"
            "2026-01-02,deposit,,,,PLN,6000,,\n"
        ),
    )
    (aapl,) = import_plan.new_instruments
    assert aapl.currency == Currency.USD
    assert aapl.alias("yahoo") == "AAPL" and aapl.alias("generic_csv") == "AAPL.US"
    _, held = holdings_by_symbol(import_plan, "2026-03-31")
    assert held["AAPL"].currency == Currency.USD and held["AAPL"].cost_basis == d("1500")


def test_existing_instruments_are_matched_and_learn_aliases() -> None:
    orlen = instrument("orlen", isin=None, aliases=(InstrumentAlias("yahoo", "PKN.WA"),))
    import_plan = plan(
        GenericCsvImporter(simple_mapping()),
        csv_file(f"{SIMPLE_HEADER}\na,2026-01-05,buy,PKN.PL,PLPKN0000018,,5,60,PLN,0,-300\n"),
        InMemoryInstrumentLookup([orlen]),
    )
    assert import_plan.rows[0].match == InstrumentMatch.SYMBOL_EXCHANGE
    assert import_plan.rows[0].txn.instrument_id == "orlen"
    assert import_plan.new_instruments == ()
    assert import_plan.new_aliases == {
        "orlen": (InstrumentAlias("isin", "PLPKN0000018"), InstrumentAlias("generic_csv", "PKN.PL"))
    }


def test_semantic_errors_block_the_plan() -> None:
    import_plan = plan(
        GenericCsvImporter(simple_mapping()),
        csv_file(
            f"{SIMPLE_HEADER}\na,2026-01-05,buy,,,,5,60,PLN,0,-300\nb,2026-01-05,sell,PKN,,GPW,,60,PLN,0,300\n"
        ),
    )
    assert not import_plan.can_commit
    assert {e.kind for e in import_plan.blocking_errors} == {
        ImportWarningKind.MISSING_INSTRUMENT,
        ImportWarningKind.MISSING_QUANTITY,
    }


def test_canonical_spec_example_end_to_end_with_rename_split_and_reconciliation() -> None:
    blocks = re.findall(r"```csv\n(.*?)```", SPEC.read_text(encoding="utf-8"), re.DOTALL)
    content = next(block for block in blocks if "position" in block)
    import_plan = plan(CanonicalImporter(), ImportFile("converted.csv", content.encode()))
    assert import_plan.can_commit
    assert import_plan.broker_id == "examplebroker", "the file source is the alias namespace"
    assert import_plan.account_hint == "Account 12-3456"
    assert [w.kind for w in import_plan.warnings] == [ImportWarningKind.UNKNOWN_INSTRUMENT]
    (planned_rename,) = import_plan.renames
    rename = planned_rename.rename
    old = import_plan.instruments[rename.old_instrument_id]
    new = import_plan.instruments[rename.new_instrument_id]
    assert (old.symbol, new.symbol, new.isin, new.currency) == (
        "ABC",
        "ABCN",
        "PLABCN000012",
        "PLN",
    )
    assert old.alias("examplebroker") == "ABC"
    assert import_plan.status_changes == ()

    snapshot, held = holdings_by_symbol(import_plan, "2026-02-28", renames=[rename])
    assert held["ABCN"].quantity == d("5")
    assert "ABC" not in held
    assert held["XMPL"].quantity == d("40"), "10 units split 4-for-1"
    assert held["XMPL"].cost_basis == d("1001")
    assert held["WRLD"].currency == Currency.EUR
    cash = {balance.currency: balance.amount for balance in snapshot.cash}
    assert cash == {
        Currency.PLN: d("20000.00")
        - d("628.13")
        - d("1281.00")
        - d("4004.000")
        + d("209.00")
        + d("139.45")
        - d("9.99")
        - d("400.00"),
        Currency.USD: d("8.50") + d("100.00"),
    }

    report = reconcile(ACCOUNT, [p.position for p in import_plan.positions], snapshot)
    assert {diff.kind for diff in report.diffs} == {PositionDiffKind.MATCH}
    assert report.is_clean and report.warnings == ()


def test_delisting_of_a_known_instrument_becomes_a_status_change() -> None:
    stored = instrument("zzz", name="Frozen ADR", symbol="ZZZ", mic=None, currency=Currency.USD)
    content = (
        "format_version,record,date,symbol,frozen\n"
        "1,delisting,2026-02-20,ZZZ,true\n"
        "1,delisting,2026-02-21,ZZZ,false\n"
    )
    lookup = InMemoryInstrumentLookup([replace_aliases(stored)])
    import_plan = plan(CanonicalImporter(), ImportFile("x.csv", content.encode()), lookup)
    assert [(s.instrument_id, s.status) for s in import_plan.status_changes] == [
        ("zzz", InstrumentStatus.FROZEN),
        ("zzz", InstrumentStatus.DELISTED),
    ]


def replace_aliases(inst):
    from dataclasses import replace

    return replace(inst, aliases=(InstrumentAlias("cashu", "ZZZ"),))


def test_transactions_carry_every_parsed_field() -> None:
    content = (
        "format_version,record,date,time,settle_date,type,external_ref,symbol,quantity,price,"
        "currency,fee,tax,cash_amount,cash_currency,fx_rate,note\n"
        "1,txn,2026-01-05,10:00,2026-01-07,buy,X-1,ABC,2,10,USD,1,0.5,-86,PLN,4,hello\n"
    )
    import_plan = plan(CanonicalImporter(), ImportFile("x.csv", content.encode()))
    (row,) = import_plan.rows
    txn = row.txn
    assert (txn.id, txn.account_id, txn.type) == ("t-1", ACCOUNT, TxnType.BUY)
    assert (txn.settle_date, txn.external_ref, txn.note) == (day("2026-01-07"), "X-1", "hello")
    assert (txn.quantity, txn.price, txn.fee, txn.tax) == (d("2"), d("10"), d("1"), d("0.5"))
    assert (txn.gross_amount, txn.cash_amount, txn.cash_currency, txn.fx_rate) == (
        d("20"),
        d("-86"),
        Currency.PLN,
        d("4"),
    )
    assert txn.dedup_hash == row.txn.dedup_hash and len(txn.dedup_hash) == 64
