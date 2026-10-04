"""One-time move of legacy repo-dir data (``<repo>/data/``) into the data dir.

``finanse migrate-data`` copies (never moves) the SQLite database with the SQLite
backup API (a consistent snapshot, WAL content included), keeps a timestamped
backup next to it, verifies the copy, upgrades its schema, copies the Open
Banking sessions file and private key, and writes a marker so the legacy notice
stops. The original files are left untouched for the user to delete.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from . import paths

AUX_FILES = (paths.EB_SESSIONS_FILENAME, paths.EB_KEY_FILENAME)


class MigrationError(RuntimeError):
    """The legacy data could not be migrated (nothing was switched)."""


@dataclass
class MigrationResult:
    source: Path
    database: Path
    backup: Path
    replaced_backup: Path | None
    tables: dict[str, int]
    copied: list[Path] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def _chmod_private(path: Path) -> None:
    if os.name == "posix":
        os.chmod(path, 0o600)


def backup_sqlite(src: Path, dest: Path) -> Path:
    """Consistent copy of a (possibly live, WAL-mode) SQLite database."""
    paths.ensure_private_dir(dest.parent)
    src_conn = sqlite3.connect(src)
    try:
        dst_conn = sqlite3.connect(dest)
        try:
            src_conn.backup(dst_conn)
        finally:
            dst_conn.close()
    finally:
        src_conn.close()
    _chmod_private(dest)
    return dest


def table_counts(db: Path) -> dict[str, int]:
    conn = sqlite3.connect(db)
    try:
        names = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        ]
        return {n: conn.execute(f'SELECT COUNT(*) FROM "{n}"').fetchone()[0] for n in names}
    finally:
        conn.close()


def _integrity_ok(db: Path) -> bool:
    conn = sqlite3.connect(db)
    try:
        return conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        conn.close()


def _remove_db(path: Path) -> None:
    for suffix in ("", "-wal", "-shm", "-journal"):
        Path(f"{path}{suffix}").unlink(missing_ok=True)


def migrate_legacy_data(
    *,
    force: bool = False,
    legacy_dir: Path | None = None,
    target_dir: Path | None = None,
    now: dt.datetime | None = None,
) -> MigrationResult:
    legacy_dir = legacy_dir or paths.LEGACY_DIR
    target = target_dir or paths.data_dir()
    src = legacy_dir / paths.DB_FILENAME
    if not src.exists():
        raise MigrationError(f"No legacy database at {src}; nothing to migrate.")
    if target.resolve() == legacy_dir.resolve():
        raise MigrationError(f"The data dir is the legacy dir ({target}); nothing to do.")

    dst = target / paths.DB_FILENAME
    backups = target / "backups"
    stamp = (now or dt.datetime.now(dt.UTC)).strftime("%Y%m%d-%H%M%S")
    replaced_backup = None
    if dst.exists():
        if not force:
            raise MigrationError(
                f"{dst} already exists. Re-run with --force to replace it "
                "(the current database is backed up first)."
            )
        replaced_backup = backup_sqlite(dst, backups / f"finanse-replaced-{stamp}.db")

    paths.ensure_private_dir(target)
    backup = backup_sqlite(src, backups / f"finanse-legacy-{stamp}.db")
    tmp = dst.with_name(dst.name + ".migrating")
    _remove_db(tmp)
    backup_sqlite(backup, tmp)
    counts = table_counts(tmp)
    if not _integrity_ok(tmp) or counts != table_counts(backup):
        _remove_db(tmp)
        raise MigrationError(f"Verification of the copied database failed; kept {backup}.")
    _remove_db(dst)
    os.replace(tmp, dst)

    from . import migrations
    from .db import make_engine

    engine = make_engine(f"sqlite:///{dst}")
    try:
        migrations.upgrade_to_head(engine)
    finally:
        engine.dispose()

    result = MigrationResult(
        source=src, database=dst, backup=backup, replaced_backup=replaced_backup, tables=counts
    )
    for name in AUX_FILES:
        legacy_file, new_file = legacy_dir / name, target / name
        if not legacy_file.exists():
            continue
        if new_file.exists() and not force:
            result.skipped.append(f"{name} (already in the data dir)")
            continue
        shutil.copyfile(legacy_file, new_file)
        _chmod_private(new_file)
        result.copied.append(new_file)

    marker = target / paths.MIGRATION_MARKER
    marker.write_text(
        json.dumps(
            {
                "source": str(src),
                "migrated_at": (now or dt.datetime.now(dt.UTC)).isoformat(),
                "backup": str(backup),
                "copied": [p.name for p in result.copied],
            },
            indent=2,
        )
    )
    _chmod_private(marker)
    return result
