"""R-13: the developer `alembic` CLI takes the same pre-upgrade backup as the app.

env.py resolves the app's own engine when run from the repo root; a schema
change (upgrade/downgrade) on a database with data first copies it to
``backups/`` next to it, like ``upgrade_to_head`` on the startup path. Reading
commands (``current``) take no copy; ``-x no-backup=1`` is the explicit opt-out.
Everything runs on synthetic databases in tmp_path."""

from __future__ import annotations

from pathlib import Path

import pytest
from alembic import command
from alembic.config import main as alembic_main
from upstream_db import make_upstream_db

from cashu import db
from cashu.core import migrations

ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"


@pytest.fixture
def baseline_db(tmp_path, monkeypatch):
    """An upstream household stamped at the baseline, wired in as the app engine."""
    monkeypatch.setenv("CASHU_DATA_DIR", str(tmp_path / "data"))
    path = make_upstream_db(tmp_path / "dev.db")
    engine = db.make_engine(f"sqlite:///{path}")
    with engine.begin() as conn:
        command.stamp(migrations.alembic_config(conn), migrations.BASELINE)
    monkeypatch.setattr(db, "engine", engine)
    yield path
    engine.dispose()


def _alembic(*args: str) -> None:
    alembic_main(argv=["-c", str(ALEMBIC_INI), *args])


def _backups(path: Path) -> list[Path]:
    return sorted((path.parent / "backups").glob("cashu-pre-*.db"))


def test_alembic_upgrade_backs_up_first(baseline_db):
    _alembic("upgrade", "head")
    (copy,) = _backups(baseline_db)
    assert copy.name.startswith(f"cashu-pre-{migrations.head_revision()}-")
    engine = db.make_engine(f"sqlite:///{copy}")
    assert migrations.current_revision(engine) == migrations.BASELINE  # the state before
    engine.dispose()
    assert migrations.current_revision(db.engine) == migrations.head_revision()


def test_alembic_current_takes_no_backup(baseline_db):
    _alembic("current")
    assert _backups(baseline_db) == []


def test_alembic_upgrade_without_backup_needs_the_explicit_flag(baseline_db):
    _alembic("-x", "no-backup=1", "upgrade", "head")
    assert _backups(baseline_db) == []
    assert migrations.current_revision(db.engine) == migrations.head_revision()


def test_alembic_refuses_when_the_backup_fails(baseline_db, monkeypatch):
    def broken(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(migrations, "backup_before_upgrade", broken)
    with pytest.raises(migrations.BackupError, match="no-backup=1"):
        _alembic("upgrade", "head")
    assert migrations.current_revision(db.engine) == migrations.BASELINE
