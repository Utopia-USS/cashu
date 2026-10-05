"""scripts/demo_data.py: seeds two invented profiles into a temp data dir, twice; the second run changes
nothing. Runs the script in a fresh interpreter (it sets FINANSE_DATA_DIR before importing finanse)
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
        k: v for k, v in os.environ.items() if k not in ("FINANSE_DATA_DIR", "FINANSE_DATABASE_URL")
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
    before = dump(data / "finanse.db")
    second = run("--data-dir", str(data))
    assert second.returncode == 0, second.stdout + second.stderr
    return data, before, dump(data / "finanse.db"), second.stdout


def test_key_counts(seeded):
    data, rows, _after, _out = seeded
    assert count(rows, "profiles") == 2
    assert count(rows, "loans") == 2 and count(rows, "depreciations") == 2
    assert count(rows, "transactions") >= 150
    assert count(rows, "inv_transactions") >= 80
    assert count(rows, "inv_price_bars") >= 3000 and count(rows, "inv_fx_rates") >= 500
    assert count(rows, "alerts") == 5 and count(rows, "watchlist_items") == 3
    assert count(rows, "research_runs") == 2 and count(rows, "research_notes") == 8
    assert count(rows, "inv_planned_deposits") == 2 and count(rows, "inv_decisions") == 2
    assert count(rows, "proposals") == 1 and count(rows, "inv_theses") == 3
    assert count(rows, "inv_rule_runs") == 2 and count(rows, "inv_signals") >= 2
    with sqlite3.connect(f"file:{data / 'finanse.db'}?mode=ro", uri=True) as con:
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
    for slug in ("demo-anna", "demo-piotr"):
        assert (data / "profiles" / slug / "strategy.yaml").is_file()
        assert (data / "profiles" / slug / "budget.json").is_file()


def test_second_run_changes_nothing(seeded):
    _data, before, after, out = seeded
    assert after == before
    assert "created" not in out and "committed" not in out


def test_refuses_the_real_data_dir():
    from finanse.core import paths

    result = run("--data-dir", str(paths.default_data_dir()))
    assert result.returncode != 0
    assert "refusing" in (result.stdout + result.stderr)
