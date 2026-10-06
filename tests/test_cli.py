"""Characterization tests for the main `cashu` CLI commands (Typer CliRunner)
on a synthetic DB. They pin exit codes, the key output lines and the DB effects
so the wave-2 split of cli.py cannot silently change behaviour. `serve` belongs
to the infrastructure track; `reclassify` and the interactive `eb` login flows
need an LLM / a bank and are not covered here.
"""

from datetime import date
from decimal import Decimal

import pytest
from rich.console import Console
from sqlmodel import Session, select
from typer.testing import CliRunner

from cashu import cli as cli_mod
from cashu.core import cliutil
from cashu.models import Account, AccountType, Balance, Depreciation, Loan, Transaction
from cashu.modules.budget import cli as budget_cli

MBANK_HEADER = [
    "mBank S.A. Bankowość Detaliczna;",
    "Elektroniczne zestawienie operacji;",
    "#Numer rachunku;",
    "99 1140 0000 0000 0000 0000 0042;",
    "#Waluta;",
    "PLN;",
    "",
    "#Data księgowania;#Data operacji;#Opis operacji;#Tytuł;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji;",
]
MBANK_ROWS = [  # newest first, like a real export (all invented)
    '2026-09-12;2026-09-12;ZAKUP PRZY UŻYCIU KARTY;"ORLEN STACJA TEST";"";;-210,00;1 590,00;',
    (
        '2026-09-10;2026-09-10;PRZELEW PRZYCHODZĄCY;"WYNAGRODZENIE ZA 08/2026";"";'
        "'99102000000000000000000777;3 000,00;1 800,00;"
    ),
    '2026-09-05;2026-09-05;ZAKUP PRZY UŻYCIU KARTY;"BIEDRONKA 123 TEST";"";;-200,00;-1 200,00;',
]


def _write_mbank(path):
    path.write_text("\n".join(MBANK_HEADER + MBANK_ROWS) + "\n", encoding="cp1250")
    return path


@pytest.fixture
def run(monkeypatch):
    """Invoke the CLI; rich output goes to a wide console so tables do not wrap."""
    monkeypatch.setattr(cliutil, "console", Console(width=200, color_system=None))
    runner = CliRunner()

    def _run(*args, ok=True):
        res = runner.invoke(cli_mod.app, [str(a) for a in args])
        if ok:
            assert res.exit_code == 0, res.output + repr(res.exception)
        return res

    return _run


def _session(engine) -> Session:
    return Session(engine, expire_on_commit=False)


def test_init_db(run, db_engine):
    assert "Database ready" in run("init-db").output


def test_accounts_lists_seeded_accounts(run, seeded_engine):
    out = run("accounts").output
    for name in ("mKonto Test", "eKonto EUR Test", "Erste Test", "Mieszkanie Test",
                 "Kredyt hipoteczny Test", "Auto Test", "Gotówka"):
        assert name in out
    assert "99114000000000000000000001" in out  # the CLI shows the full account number


def test_set_account_type_and_name(run, seeded_engine):
    assert "Account 3 -> checking" in run("set-account-type", 3, "checking").output
    assert "Account 3 -> 'Oszczędności Test'" in run("set-account-name", 3, "Oszczędności Test").output
    with _session(seeded_engine) as s:
        acc = s.get(Account, 3)
        assert (acc.type, acc.name) == (AccountType.CHECKING, "Oszczędności Test")
    bad = run("set-account-name", 999, "x", ok=False)
    assert bad.exit_code == 2 and "No account with id 999" in bad.output


def test_add_position_set_balance_set_loan(run, db_engine):
    out = run("add-position", "Kredyt samochodowy Test", "--type", "loan", "--value", "50000").output
    assert "loan 'Kredyt samochodowy Test' = 50 000,00 PLN (account id 1)" in out
    out = run("set-balance", 1, "48000", "--date", "2026-09-30").output
    assert "Kredyt samochodowy Test -> 48 000,00 PLN" in out
    out = run("set-loan", 1, "60000", "8.5", "--years", "5", "--start", "2025-06-15",
              "--origination", "2025-05-20").output
    assert "account 1: 60,000 @ 8.5% / 5 yr, 1st installment 2025-06-15, origination 2025-05-20" in out
    with _session(db_engine) as s:
        loan = s.exec(select(Loan)).one()
        assert (loan.principal, loan.annual_rate, loan.term_months) == (Decimal(60000), Decimal("8.5"), 60)
        assert {b.amount for b in s.exec(select(Balance)).all()} >= {Decimal(48000)}


def test_set_vehicle(run, db_engine):
    out = run("set-vehicle", "Auto Test", "80000", "2025-05-01", "--rate", "15", "--floor", "10000").output
    assert "Vehicle 'Auto Test': bought 2025-05-01 for 80 000,00 PLN, depreciation 15.0%/yr" in out
    assert "floor 10 000,00 PLN" in out and "value today" in out
    with _session(db_engine) as s:
        dep = s.exec(select(Depreciation)).one()
        assert (dep.purchase_price, dep.annual_rate, dep.floor) == (
            Decimal(80000), Decimal(15), Decimal(10000))


def test_import_csv_and_reimport_dedups(run, db_engine, tmp_path):
    f = _write_mbank(tmp_path / "mbank_test.csv")
    out = run("import-csv", f, "--name", "mKonto CSV Test").output
    assert "mbank_test.csv -> mbank 'mKonto CSV Test': seen 3, inserted 3, duplicates 0" in out
    out = run("import-csv", f).output
    assert "seen 3, inserted 0, duplicates 3" in out
    with _session(db_engine) as s:
        acc = s.exec(select(Account)).one()
        assert (acc.iban, acc.currency) == ("99114000000000000000000042", "PLN")
        bal = {b.date: b.amount for b in s.exec(select(Balance)).all()}
        assert bal[date(2026, 9, 12)] == Decimal("1590.00")  # end-of-day balance from the file


def test_import_dir_categorizes(run, db_engine, tmp_path):
    sub = tmp_path / "in" / "mbank"  # the sub-directory name hints the bank
    sub.mkdir(parents=True)
    _write_mbank(sub / "a.csv")
    out = run("import-dir", tmp_path / "in").output
    assert "a.csv -> mbank" in out and "+3 (0 dup)" in out
    assert "Inserted 3 new transaction(s)." in out
    with _session(db_engine) as s:
        cats = {t.reference: t.category for t in s.exec(select(Transaction)).all()}
    assert cats == {"ORLEN STACJA TEST": "fuel", "WYNAGRODZENIE ZA 08/2026": "income_salary",
                    "BIEDRONKA 123 TEST": "groceries"}
    empty = tmp_path / "empty"
    empty.mkdir()
    assert "No .csv files" in run("import-dir", empty).output


def test_match_transfers_and_categorize(run, seeded_engine):
    assert "Matched 0 internal-transfer pair(s)." in run("match-transfers").output
    out = run("match-transfers", "--reset").output
    assert "Cleared 8 previously-grouped transactions." in out
    assert "Matched 4 internal-transfer pair(s)." in out
    assert "Categorized 56 transactions." in run("categorize").output


def test_cash_and_cash_add(run, seeded_engine):
    out = run("cash").output
    assert "Cash: 260,00 PLN" in out and "Targ Test" in out
    out = run("cash-add", "15.5", "Kawa Test", "dining", "--date", "2026-09-21").output
    assert "Cash expense −15.50: Kawa Test (dining)" in out
    assert "Cash: 244,50 PLN" in run("cash").output
    bad = run("cash-add", "1", "x", "nope", ok=False)
    assert bad.exit_code == 2 and "Unknown category" in bad.output


def test_cash_without_pool(run, db_engine):
    assert "No cash pool." in run("cash").output


def test_set_category(run, seeded_engine):
    out = run("set-category", "sklep nieznany test", "shopping").output
    assert "SKLEP NIEZNANY TEST → shopping (1 transactions)" in out
    with _session(seeded_engine) as s:
        t = s.exec(select(Transaction).where(Transaction.reference == "SKLEP NIEZNANY TEST")).one()
        assert (t.category, t.category_source) == ("shopping", "manual")


def test_stats(run, seeded_engine):
    out = run("stats").output
    assert "TOTAL EUR" in out and "460,04 EUR" in out
    assert "TOTAL PLN" in out
    assert "2026-09" in out and "9 000,00 PLN" in out and "4 275,75 PLN" in out
    assert "Recurring payment candidates" in out and "NETFLIX.COM" in out
    assert "Spending by category — 2026-09" in out and "Subskrypcje" in out


def test_eb_reprocess(run, seeded_engine):
    assert "Updated 0 transactions" in run("eb", "reprocess").output


def test_eb_resync_without_sessions(run, db_engine, monkeypatch):
    from cashu.modules.budget.ingestion.enable_banking import state

    monkeypatch.setattr(state, "load_sessions", lambda *_a, **_k: [])
    res = run("eb", "resync", ok=False)
    assert res.exit_code == 1 and "No saved sessions" in res.output


def test_eb_check_not_configured(run, db_engine, monkeypatch):
    from cashu.config import settings

    monkeypatch.setattr(type(settings), "eb_configured", property(lambda self: False))
    res = run("eb", "check", ok=False)
    assert res.exit_code == 1 and "Not configured." in res.output


def test_eb_sync_with_stub_client(run, seeded_engine, monkeypatch, fake_eb, make_eb_txn):
    client = fake_eb({
        "sess-1": {
            "aspsp": {"name": "mBank"},
            "accounts": [{"uid": "uid-main", "account_id": {"iban": "PL99114000000000000000000001"}}],
            "transactions": {"uid-main": [make_eb_txn("2026-10-01", "25.00", "BIEDRONKA 123 TEST",
                                                      ref="eb-1")]},
            "balances": {"uid-main": []},
        },
    })
    monkeypatch.setattr(budget_cli, "_client", lambda: client)
    out = run("eb", "sync", "sess-1").output
    assert "mbank 'mKonto Test': +1 (0 dup)" in out
