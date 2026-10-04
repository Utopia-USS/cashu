"""CLI: the root --profile option, `finanse profiles ...`, module sub-apps."""

from __future__ import annotations

import pytest
from rich.console import Console
from sqlmodel import Session, select
from test_cli import _write_mbank
from typer.testing import CliRunner

from finanse import cli as cli_mod
from finanse.core import cliutil
from finanse.models import Account, Loan, Profile


@pytest.fixture
def run(monkeypatch):
    monkeypatch.setattr(cliutil, "console", Console(width=200, color_system=None))
    monkeypatch.setattr(cliutil, "err_console", Console(width=200, color_system=None, stderr=True))
    monkeypatch.setattr(cliutil, "_profile_slug", None)
    runner = CliRunner()

    def _run(*args, ok=True):
        res = runner.invoke(cli_mod.app, [str(a) for a in args])
        if ok:
            assert res.exit_code == 0, res.output + repr(res.exception)
        return res

    return _run


def _accounts(engine) -> list[tuple[str, str]]:
    with Session(engine) as s:
        rows = s.exec(select(Account, Profile).where(Account.profile_id == Profile.id)).all()
        return sorted((p.slug, a.name) for a, p in rows)


def test_profiles_add_and_list(run, db_engine):
    assert "No profiles yet" in run("profiles", "list").output
    out = run("profiles", "add", "Jan Kowalski").output
    assert "slug jan-kowalski" in out and "budget, assets, loans" in out
    out = run("profiles", "add", "Marta", "--modules", "budget", "--privacy", "amounts").output
    assert "slug marta" in out
    listing = run("profiles", "list").output
    assert "jan-kowalski" in listing and "marta" in listing and "amounts" in listing
    assert "*" in listing.split("jan-kowalski")[0].splitlines()[-1]  # oldest = default
    dup = run("profiles", "add", "JAN KOWALSKI", ok=False)
    assert dup.exit_code == 2 and "already exists" in dup.output
    bad = run("profiles", "add", "Ola", "--modules", "budget,nope", ok=False)
    assert bad.exit_code == 2 and "unknown module" in bad.output


def test_profile_option_scopes_every_command(run, db_engine, tmp_path):
    run("profiles", "add", "Jan")
    run("profiles", "add", "Marta")
    f = _write_mbank(tmp_path / "mbank_test.csv")
    out = run("--profile", "marta", "import-csv", f).output
    assert "inserted 3" in out
    run("-p", "jan", "import-csv", f)  # the same statement in the other profile: no dedup across
    run("-p", "jan", "add-position", "Mieszkanie Test", "--type", "property", "--value", "1")
    assert _accounts(db_engine) == [
        ("jan", "Mieszkanie Test"), ("jan", "mbank 0042"), ("marta", "mbank 0042"),
    ]
    marta_out = run("-p", "marta", "accounts").output
    assert "Mieszkanie Test" not in marta_out and "99114000000000000000000042" in marta_out
    # an account of another profile is "not found"
    with Session(db_engine) as s:
        jan_flat = s.exec(select(Account).where(Account.name == "Mieszkanie Test")).one().id
    bad = run("-p", "marta", "set-account-name", jan_flat, "x", ok=False)
    assert bad.exit_code == 2 and f"No account with id {jan_flat}" in bad.output


def test_unknown_profile_exits_with_the_list(run, db_engine):
    run("profiles", "add", "Jan")
    res = run("--profile", "nope", "accounts", ok=False)
    assert res.exit_code == 1 and "No profile 'nope'" in res.stderr and "jan" in res.stderr


def test_without_profile_a_fresh_db_gets_the_default_profile(run, db_engine, tmp_path):
    assert "No cash pool" in run("cash").output  # read-only: creates nothing
    with Session(db_engine) as s:
        assert s.exec(select(Profile)).all() == []
    run("import-csv", _write_mbank(tmp_path / "mbank_test.csv"))
    assert _accounts(db_engine) == [("default", "mbank 0042")]


def test_configured_default_profile_is_strict(run, db_engine, monkeypatch):
    from finanse.config import settings

    run("profiles", "add", "Jan")
    monkeypatch.setattr(settings, "profile", "marta")
    res = run("add-position", "X Test", "--type", "property", "--value", "1", ok=False)
    assert res.exit_code == 1 and "No profile 'marta'" in res.stderr
    assert _accounts(db_engine) == []


def test_loans_sub_app(run, db_engine):
    run("profiles", "add", "Jan")
    out = run("-p", "jan", "loans", "add", "Hipoteka Test", "--type", "mortgage",
              "--principal", "400000", "--rate", "6", "--years", "25",
              "--start", "2025-01-05").output
    assert "Loan 'Hipoteka Test' (loan id 1, account id 1)" in out
    run("-p", "jan", "loans", "add", "Auto Test", "--principal", "60000", "--rate", "9",
        "--months", "72", "--start", "2025-03-01", "--payment-text", "RATA AUTO")
    listing = run("-p", "jan", "loans", "list").output
    assert "Hipoteka Test" in listing and "Auto Test" in listing and "schedule" in listing
    run("-p", "jan", "loans", "set-payment", "1", "--iban", "PL99 1600 0000 0000 0000 0000 0999")
    run("-p", "jan", "loans", "set-balance", "1", "380000", "--date", "2026-06-01")
    assert "recorded" in run("-p", "jan", "loans", "list").output
    with Session(db_engine) as s:
        loans = {loan.id: loan for loan in s.exec(select(Loan)).all()}
        assert loans[1].payment_iban == "PL99160000000000000000000999"
        assert (loans[2].term_months, loans[2].payment_text) == (72, "RATA AUTO")
    out = run("-p", "jan", "loans", "set-loan", "2", "50000", "8", "--months", "18").output
    assert "/ 18 mo" in out


def test_module_sub_apps_mirror_the_top_level_commands(run, db_engine):
    help_out = run("--help").output
    for name in ("budget", "assets", "loans", "profiles"):
        assert name in help_out
    assert "import-csv" in run("budget", "--help").output
    assert "add-position" in run("assets", "--help").output
    assert "Enable Banking" in run("budget", "eb", "--help").output


def test_loans_add_never_takes_over_a_same_named_property(run, db_engine):
    """R-01: a loan named like a property is refused; --account picks an account explicitly."""
    run("profiles", "add", "Jan")
    run("-p", "jan", "add-position", "Dom Test", "--type", "property", "--value", "800000")
    run("-p", "jan", "add-position", "Kredyt Test", "--type", "mortgage", "--value", "1")
    res = run("-p", "jan", "loans", "add", "Dom Test", "--type", "mortgage",
              "--principal", "300000", "--rate", "6", ok=False)
    assert res.exit_code == 2 and "property" in res.output
    with Session(db_engine) as s:
        assert s.exec(select(Loan)).all() == []
    out = run("-p", "jan", "loans", "add", "--account", "Kredyt Test",
              "--principal", "300000", "--rate", "6").output
    assert "Loan 'Kredyt Test' (loan id 1, account id 2)" in out
    res = run("-p", "jan", "loans", "add", "--account", "1", "--principal", "1", "--rate", "1",
              ok=False)
    assert res.exit_code == 2 and "mortgage/loan" in res.output


def test_profile_option_on_a_fresh_db_never_writes_into_default(run, db_engine):
    """R-02: `--profile X` names a profile that must exist; nothing is created."""
    res = run("--profile", "marta", "add-position", "Konto Test", "--type", "savings",
              "--value", "100", ok=False)
    assert res.exit_code == 1
    assert "No profile 'marta'" in res.stderr and "finanse profiles add" in res.stderr
    with Session(db_engine) as s:
        assert s.exec(select(Profile)).all() == []
    assert _accounts(db_engine) == []
    run("profiles", "add", "Marta")
    run("--profile", "marta", "add-position", "Konto Test", "--type", "savings", "--value", "100")
    assert _accounts(db_engine) == [("marta", "Konto Test")]


def test_configured_default_profile_on_a_fresh_db_is_created_under_its_slug(
    run, db_engine, monkeypatch
):
    from finanse.config import settings

    monkeypatch.setattr(settings, "profile", "marta")
    run("add-position", "Konto Test", "--type", "savings", "--value", "100")
    assert _accounts(db_engine) == [("marta", "Konto Test")]
