"""scripts/demo_data.py: seeds two invented profiles into a temp data dir, twice; the second run changes
nothing. Runs the script in a fresh interpreter (it sets CASHU_DATA_DIR before importing cashU)
and reads the result read-only."""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts" / "demo_data.py"


def run(*args: str) -> subprocess.CompletedProcess:
    env = {
        k: v for k, v in os.environ.items() if k not in ("CASHU_DATA_DIR", "CASHU_DATABASE_URL")
    }
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
        timeout=300,
        check=False,
    )


def dump(db: Path) -> dict[str, list[tuple]]:
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as con:
        tables = [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
        return {t: sorted(map(repr, con.execute(f'select * from "{t}"'))) for t in tables}


def count(rows: dict, table: str) -> int:
    return len(rows[table])


@pytest.fixture(scope="module")
def seeded(tmp_path_factory):
    data = tmp_path_factory.mktemp("demo") / "data"
    first = run("--data-dir", str(data))
    assert first.returncode == 0, first.stdout + first.stderr
    before = dump(data / "cashu.db")
    second = run("--data-dir", str(data))
    assert second.returncode == 0, second.stdout + second.stderr
    return data, before, dump(data / "cashu.db"), second.stdout


def test_key_counts(seeded):
    data, rows, _after, _out = seeded
    assert count(rows, "profiles") == 2
    assert count(rows, "loans") == 2 and count(rows, "depreciations") == 2
    assert count(rows, "transactions") >= 150
    assert count(rows, "inv_transactions") >= 80
    assert count(rows, "inv_price_bars") >= 3000 and count(rows, "inv_fx_rates") >= 500
    assert count(rows, "alerts") == 5 and count(rows, "watchlist_items") == 3
    assert count(rows, "research_runs") == 2 and count(rows, "research_notes") == 12
    assert count(rows, "inv_macro_bars") >= 7 * 500  # P6: ~2 years of every macro series
    assert count(rows, "inv_planned_deposits") == 2 and count(rows, "inv_decisions") == 2
    assert count(rows, "proposals") == 1 and count(rows, "inv_theses") == 3
    assert count(rows, "inv_rule_runs") == 2 and count(rows, "inv_signals") >= 2
    with sqlite3.connect(f"file:{data / 'cashu.db'}?mode=ro", uri=True) as con:
        names = sorted(r[0] for r in con.execute("select name from profiles"))
        sources = dict(con.execute("select source, count(*) from alerts group by source"))
        runs = {r[0] for r in con.execute("select status from research_runs")}
        pending = con.execute("select count(*) from proposals where status = 'pending'").fetchone()
        categorised = con.execute(
            "select count(*) from transactions where category is not null and category != 'other'"
        ).fetchone()[0]
    assert names == ["Demo Anna", "Demo Piotr"]
    assert sources == {"user": 3, "agent": 2}
    assert runs == {"done"} and pending == (1,)
    assert categorised >= 150
    with sqlite3.connect(f"file:{data / 'cashu.db'}?mode=ro", uri=True) as con:
        macro_notes = con.execute(
            "select count(*) from research_notes where segment like 'macro_%'"
        ).fetchone()[0]
        series = {r[0] for r in con.execute("select distinct series from inv_macro_bars")}
    assert macro_notes == 2  # one per profile
    assert series == {"acwi", "spx", "dxy", "eem", "dbc", "us10y", "us3m"}
    for slug in ("demo-anna", "demo-piotr"):
        assert (data / "profiles" / slug / "strategy.yaml").is_file()
        assert (data / "profiles" / slug / "budget.json").is_file()


def test_second_run_changes_nothing(seeded):
    _data, before, after, out = seeded
    assert after == before
    assert "created" not in out and "committed" not in out


def test_refuses_the_real_data_dir():
    from cashu.core import paths

    result = run("--data-dir", str(paths.default_data_dir()))
    assert result.returncode != 0
    assert "refusing" in (result.stdout + result.stderr)


@pytest.mark.parametrize("offset_days", [0, 45, 90, 180, 365])
def test_demo_macro_cards_show_a_state_and_a_change_on_any_run_date(offset_days):
    """The synthetic macro series (pure generator) give five cards with at least one non-flat state
    and at least one state change in the history, whatever day the demo is seeded."""
    import datetime as dt

    sys.path.insert(0, str(REPO / "scripts"))
    import demo_data

    from cashu.modules.investments.macro import regimes
    from cashu.modules.investments.macro.series import SERIES_KEYS, USDPLN

    today = dt.date.today() + dt.timedelta(days=offset_days)  # noqa: DTZ011 - demo dates follow today
    days = list(demo_data.sessions(today - dt.timedelta(days=demo_data.MACRO_DAYS), today))
    closes = {k: [(d, float(demo_data.macro_close(k, d))) for d in days] for k in SERIES_KEYS}
    closes[USDPLN] = [(d, float(demo_data.fx_on("USD", d))) for d in days]
    cards = regimes.evaluate(closes, today)
    assert len(cards) == 5 and not any(c.missing for c in cards)
    assert any(c.state not in ("flat", "inline", "stable") for c in cards)
    assert any(len(c.history) >= 2 for c in cards)
    assert any(m.label == "USD/PLN 6 mies." for m in cards[1].metrics)
