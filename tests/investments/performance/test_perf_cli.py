"""`finanse invest backfill` and `finanse invest performance` (fake sources, synthetic history)."""

from __future__ import annotations

import pytest
from perf_support import AS_OF, household, sources
from rich.console import Console
from typer.testing import CliRunner

from finanse import cli as cli_mod
from finanse.core import cliutil
from finanse.modules.investments.performance import service
from finanse.modules.investments.service import daily, portfolio


@pytest.fixture
def run(monkeypatch, db_engine):
    monkeypatch.setattr(cliutil, "console", Console(width=220, color_system=None))
    monkeypatch.setattr(cliutil, "err_console", Console(width=220, color_system=None, stderr=True))
    monkeypatch.setattr(cliutil, "_profile_slug", None)
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    service.clear_cache()
    runner = CliRunner()

    def _run(*args, ok=True):
        res = runner.invoke(cli_mod.app, [str(a) for a in args])
        if ok:
            assert res.exit_code == 0, res.output + repr(res.exception)
        return res

    return _run


def test_backfill_then_performance(run):
    _pid, slug, aid = household()
    out = run("--profile", slug, "invest", "backfill").output
    assert "benchmark BNCH.DE (inwestor): added" in out
    assert "ABC [sold]: ok history 2024-12-27..2025-09-30" in out
    assert "fx EUR: ok" in out
    again = run("--profile", slug, "invest", "backfill").output
    assert "history" not in again and "BNCH.DE (inwestor): found" in again

    out = run("--profile", slug, "invest", "performance", "--range", "max", "--attribution").output
    assert "max: 2025-01-01 .. 2025-09-30 (PLN)" in out
    assert "13 430.00" in out and "14.30%" in out  # end value, TWR
    assert "benchmark: msci_acwi via BNCH.DE" in out
    assert "ABC" in out and "top 2 share of P/L: 100.00%" in out

    only = run("--profile", slug, "invest", "performance", "--account", aid).output
    assert "1y:" in only
    bad = run("--profile", slug, "invest", "performance", "--range", "5y", ok=False)
    assert bad.exit_code == 2
    assert (
        run("--profile", slug, "invest", "performance", "--account", "999", ok=False).exit_code == 2
    )


def test_no_history(run):
    run("profiles", "add", "Pusty", "--modules", "investments")
    assert "No investments history yet." in run("invest", "performance").output
    assert "Nothing to backfill" in run("invest", "backfill").output
