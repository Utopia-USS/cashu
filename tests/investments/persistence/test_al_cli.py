"""`finanse invest alerts ...` and `finanse invest watchlist ...` (F5)."""

from __future__ import annotations

import pytest
from invp_support import AS_OF, STRATEGY_YAML, canonical_csv, sources
from rich.console import Console
from typer.testing import CliRunner

from finanse import cli as cli_mod
from finanse.core import cliutil
from finanse.modules.investments.service import daily, files, portfolio


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


def test_alert_and_watchlist_commands(run, tmp_path):
    run("profiles", "add", "Jan", "--modules", "investments")
    run("invest", "accounts", "add", "DIF", "--broker", "dif")
    path = tmp_path / "history.csv"
    path.write_bytes(canonical_csv())
    run("invest", "import", path, "--account", "1")
    files.write_text_private(files.strategy_yaml_path("jan"), STRATEGY_YAML)

    assert "price_above [instrument] (level)" in run("invest", "alerts", "kinds").output
    assert "No alerts." in run("invest", "alerts", "list").output
    out = run(
        "invest",
        "alerts",
        "add",
        "price_above",
        "--title",
        "XMPL over 90",
        "--instrument",
        "XMPL",
        "--param",
        "level=90",
        "--polarity",
        "positive",
        "--severity",
        "action",
    ).output
    assert "Alert 1 added" in out
    bad = run(
        "invest", "alerts", "add", "price_above", "--title", "x", "--param", "levle=1", ok=False
    )
    assert bad.exit_code == 2 and "params.levle" in bad.output
    assert (
        run("invest", "alerts", "add", "x", "--title", "t", "--param", "bad", ok=False).exit_code
        == 2
    )
    run("invest", "run")  # fake sources (no network)
    listed = run("invest", "alerts", "list", "--status", "live").output
    assert "triggered" in listed and "XMPL over 90" in listed and "positive" in listed
    assert "snoozed for 3 days" in run("invest", "alerts", "snooze", "1", "--days", "3").output
    assert "muted" in run("invest", "alerts", "mute", "1").output
    assert "active again" in run("invest", "alerts", "unmute", "1").output
    assert "deleted" in run("invest", "alerts", "delete", "1").output
    assert run("invest", "alerts", "delete", "1", ok=False).exit_code == 2
    assert run("invest", "alerts", "list", "--status", "nope", ok=False).exit_code == 2

    added = run("invest", "watchlist", "add", "VWCE.DE", "--note", "core idea").output
    assert "Watching VWCE.DE (item 1)" in added and "price symbol guessed as VWCE.DE" in added
    assert run("invest", "watchlist", "add", "VWCE.DE", ok=False).exit_code == 2
    table = run("invest", "watchlist", "list").output
    assert "VWCE" in table and "core idea" in table
    assert "removed" in run("invest", "watchlist", "remove", "1").output
    assert "The watchlist is empty." in run("invest", "watchlist", "list").output
    assert run("invest", "watchlist", "remove", "1", ok=False).exit_code == 2
