"""`cashu invest ...`: accounts, import (dry run, commit, duplicates), validate, positions,
signals, strategy init / validate, run."""

from __future__ import annotations

import pytest
from invp_support import AS_OF, STRATEGY_YAML, canonical_csv, sources
from rich.console import Console
from sqlmodel import func, select
from typer.testing import CliRunner

from cashu import cli as cli_mod
from cashu.core import cliutil
from cashu.core.db import get_session
from cashu.modules.investments.models import InvTransaction
from cashu.modules.investments.service import daily, files, portfolio


@pytest.fixture
def run(monkeypatch, db_engine):
    monkeypatch.setattr(cliutil, "console", Console(width=220, color_system=None))
    monkeypatch.setattr(cliutil, "err_console", Console(width=220, color_system=None, stderr=True))
    monkeypatch.setattr(cliutil, "_profile_slug", None)
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    runner = CliRunner()

    def _run(*args, ok=True):
        res = runner.invoke(cli_mod.app, [str(a) for a in args])
        if ok:
            assert res.exit_code == 0, res.output + repr(res.exception)
        return res

    return _run


def txn_count() -> int:
    with get_session() as s:
        return s.exec(select(func.count()).select_from(InvTransaction)).one()


def test_invest_workflow(run, tmp_path):
    run("profiles", "add", "Jan", "--modules", "investments")
    out = run("invest", "accounts", "add", "DIF zwykłe", "--broker", "dif").output
    assert "id 1" in out
    assert run("invest", "accounts", "add", "X", "--broker", "mbank", ok=False).exit_code == 2
    assert "DIF Broker" in run("invest", "accounts", "list").output

    path = tmp_path / "history.csv"
    path.write_bytes(canonical_csv(xmpl_quantity=25))
    assert "OK (cashu)" in run("invest", "validate", path).output
    dry = run("invest", "import", path, "--account", "1", "--dry-run").output
    assert "new: 5" in dry and "Dry run" in dry and "reconciliation XMPL" in dry
    assert txn_count() == 0
    out = run("invest", "import", path, "--account", "1", "--apply-corrections").output
    assert "Imported 5 transaction(s)" in out and "1 correction(s)" in out
    assert txn_count() == 6
    again = run("invest", "import", path, "--account", "1").output
    assert "Imported 0 transaction(s)" in again and "5 duplicate(s)" in again

    assert "No strategy yet" in run("invest", "strategy", "validate", ok=False).output
    out = run("invest", "strategy", "init").output
    assert "strategy.yaml" in out and "strategy.md" in out
    assert run("invest", "strategy", "init", ok=False).exit_code == 2  # exists
    assert "valid (version 1)" in run("invest", "strategy", "validate").output
    files.write_text_private(files.strategy_yaml_path("jan"), STRATEGY_YAML)

    out = run("invest", "run").output
    assert "jan: ok (strategy valid)" in out and "[action] XMPL" in out
    assert "signals new 0" in run("invest", "run", "--offline").output
    assert "concentration" in run("invest", "signals").output
    positions = run("invest", "positions").output
    assert "XMPL" in positions and "ABC" in positions and "total" in positions


def test_validate_reports_errors(run, tmp_path):
    bad = tmp_path / "bad.csv"
    bad.write_text("format_version,record,date\n1,txn,2026-13-01\n")
    res = run("invest", "validate", bad, ok=False)
    assert res.exit_code == 1 and "INVALID" in res.output


def test_import_into_an_unknown_account_fails(run, tmp_path):
    run("profiles", "add", "Jan", "--modules", "investments")
    path = tmp_path / "h.csv"
    path.write_bytes(canonical_csv())
    res = run("invest", "import", path, "--account", "7", ok=False)
    assert res.exit_code == 2 and "No brokerage account 7" in res.output
