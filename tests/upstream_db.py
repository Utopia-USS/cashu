"""Upstream-shaped SQLite databases for migration tests.

The schema is the one of the last upstream release (what its ``create_all``
produced, before Alembic and before profiles), built from the baseline revision's
own DDL; enums are stored by member NAME as upstream did. Every row is synthetic
(fake ``99...`` account numbers, names ending in "Test").
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import sqlalchemy as sa
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext

from finanse.core import migrations


def create_upstream_schema(path: Path) -> None:
    """Empty upstream schema at ``path`` (no ``alembic_version`` table)."""
    engine = sa.create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as conn:
            baseline = migrations.script_directory().get_revision(migrations.BASELINE)
            baseline.module.create_schema(Operations(MigrationContext.configure(conn)))
    finally:
        engine.dispose()


# One small household, the way the upstream app stored it.
UPSTREAM_ROWS = {
    "accounts": [
        (
            "(1, 'MBANK', 'mKonto Test', '99114000000000000000000001', 'csv:99114000000000000000000001', "
            "'PLN', 'CHECKING', 1, '2026-01-01 10:00:00')"
        ),
        (
            "(2, 'ERSTE', 'Erste Test', '99109000000000000000000003', 'csv:99109000000000000000000003', "
            "'PLN', 'SAVINGS', 1, '2026-01-01 10:00:00')"
        ),
        (
            "(3, 'MANUAL', 'Mieszkanie Test', NULL, 'manual:Mieszkanie Test', 'PLN', 'PROPERTY', 1, "
            "'2026-01-02 10:00:00')"
        ),
        (
            "(4, 'MANUAL', 'Kredyt hipoteczny Test', NULL, 'manual:Kredyt hipoteczny Test', 'PLN', "
            "'MORTGAGE', 1, '2026-01-02 10:00:00')"
        ),
        (
            "(5, 'MANUAL', 'Auto Test', NULL, 'vehicle:Auto Test', 'PLN', 'VEHICLE', 1, "
            "'2026-01-02 10:00:00')"
        ),
        "(6, 'MANUAL', 'Gotówka', NULL, 'cash:PLN', 'PLN', 'CASH', 1, '2026-01-03 10:00:00')",
    ],
    "import_batches": [
        "(1, 'CSV', 'MBANK', 1, 'mbank.csv', '2026-02-01 10:00:00', '2026-02-01 10:00:01', 3, 3, 0, NULL)",
    ],
    "transactions": [
        (
            "(1, 1, '2026-01-10', NULL, '9000.00', 'PLN', NULL, '99102000000000000000000777', NULL, "
            "'WYNAGRODZENIE TEST', NULL, 'CSV', 'h1', 0, NULL, 0, 'income_salary', 'keyword', '{}', 1, "
            "'2026-02-01 10:00:00')"
        ),
        (
            "(2, 1, '2026-01-12', NULL, '-120.50', 'PLN', NULL, NULL, NULL, 'BIEDRONKA 123 TEST', NULL, "
            "'CSV', 'h2', 0, NULL, 0, 'groceries', 'keyword', '{}', 1, '2026-02-01 10:00:00')"
        ),
        (
            "(3, 1, '2026-01-15', NULL, '-300.00', 'PLN', NULL, NULL, NULL, 'WYPLATA W BANKOMACIE TEST', "
            "NULL, 'CSV', 'h3', 0, NULL, 0, 'cash_withdrawal', 'manual_txn', '{}', 1, '2026-02-01 10:00:00')"
        ),
        (
            "(4, 6, '2026-01-15', NULL, '300.00', 'PLN', 'Wypłata gotówki', NULL, NULL, 'Wypłata gotówki', "
            "NULL, 'MANUAL', 'cashleg:3', 0, NULL, 0, 'cash_withdrawal', 'cash_leg', "
            "'{\"cash_leg_of\": 3}', NULL, '2026-02-01 10:00:00')"
        ),
    ],
    "balances": [
        "(1, 1, '2026-01-31', '5000.00', 'PLN', 'CSV', '2026-02-01 10:00:00')",
        "(2, 2, '2026-01-31', '24000.00', 'PLN', 'CSV', '2026-02-01 10:00:00')",
        "(3, 3, '2026-01-02', '600000', 'PLN', 'MANUAL', '2026-01-02 10:00:00')",
        "(4, 4, '2026-01-02', '390000', 'PLN', 'MANUAL', '2026-01-02 10:00:00')",
    ],
    "category_rules": [
        "(1, 'SKLEP NIEZNANY TEST', 'shopping', 'manual', 1, '2026-02-02 10:00:00')",
    ],
    "loans": [
        "(1, 4, '400000', '6.0', 300, '2025-01-05', '2024-12-10', '2026-01-02 10:00:00')",
    ],
    "depreciations": [
        "(1, 5, '80000', '2025-05-01', '15', '10000', '2026-01-02 10:00:00')",
    ],
}


def insert_upstream_rows(path: Path) -> dict[str, int]:
    """Fill an upstream-shaped database with ``UPSTREAM_ROWS``; returns row counts."""
    conn = sqlite3.connect(path)
    try:
        for table in ("accounts", "import_batches", "transactions", "balances",
                      "category_rules", "loans", "depreciations"):
            for values in UPSTREAM_ROWS[table]:
                conn.execute(f"INSERT INTO {table} VALUES {values}")
        conn.commit()
    finally:
        conn.close()
    return {t: len(rows) for t, rows in UPSTREAM_ROWS.items()}


def make_upstream_db(path: Path, *, rows: bool = True, wal: bool = False) -> Path:
    create_upstream_schema(path)
    if rows:
        insert_upstream_rows(path)
    if wal:
        conn = sqlite3.connect(path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.close()
    return path
