"""Where finanse keeps its files.

Everything personal (SQLite DB, Open Banking sessions and private key, logs, the
per-launch API token) lives in one per-user data dir outside the repo checkout:

- macOS:   ~/Library/Application Support/finanse
- Windows: %APPDATA%\\finanse
- Linux:   $XDG_DATA_HOME/finanse (default ~/.local/share/finanse)

``FINANSE_DATA_DIR`` overrides it (tests, portable setups).

Legacy layout: earlier versions kept everything in ``<repo>/data/``. As long as
the data dir has no database yet, ``FINANSE_DATA_DIR`` is not set and
``<repo>/data/finanse.db`` exists, finanse keeps using the legacy files
("legacy mode") and prints a notice until ``finanse migrate-data`` copies them
into the data dir. With ``FINANSE_DATA_DIR`` set, the legacy files are never
used automatically (only reported), so tests can never touch them.
"""

from __future__ import annotations

import os
from pathlib import Path

from platformdirs import user_data_dir

APP_NAME = "finanse"
DATA_DIR_ENV = "FINANSE_DATA_DIR"

# repo root = three levels up (src/finanse/core/paths.py -> repo/). Only meaningful
# for a source checkout; used to find legacy data and the developer .env file.
PROJECT_ROOT = Path(__file__).resolve().parents[3]
LEGACY_DIR = PROJECT_ROOT / "data"

DB_FILENAME = "finanse.db"
EB_SESSIONS_FILENAME = "eb_sessions.json"
EB_KEY_FILENAME = "enablebanking_private.pem"
TOKEN_FILENAME = "api-token"
MIGRATION_MARKER = "legacy-migration.json"


def default_data_dir() -> Path:
    """Platform default per-user data dir (no override applied)."""
    # appauthor=False: %APPDATA%\finanse, not %APPDATA%\finanse\finanse.
    # roaming=True: Windows uses %APPDATA% (Roaming), as documented.
    return Path(user_data_dir(APP_NAME, appauthor=False, roaming=True))


def data_dir_override() -> Path | None:
    raw = os.environ.get(DATA_DIR_ENV, "").strip()
    return Path(raw).expanduser().resolve() if raw else None


def data_dir() -> Path:
    """The active data dir: ``FINANSE_DATA_DIR`` or the platform default."""
    return data_dir_override() or default_data_dir()


def ensure_private_dir(path: Path) -> Path:
    """Create ``path`` (and parents) if missing; a newly created dir is 0700."""
    if not path.exists():
        path.mkdir(parents=True, mode=0o700)
        if os.name == "posix":
            os.chmod(path, 0o700)
    return path


def legacy_db_path() -> Path:
    return LEGACY_DIR / DB_FILENAME


def legacy_mode() -> bool:
    """True when finanse should keep using ``<repo>/data/`` (see module doc)."""
    if data_dir_override() is not None:
        return False
    return not (default_data_dir() / DB_FILENAME).exists() and legacy_db_path().exists()


def storage_dir() -> Path:
    """Directory holding the DB, Open Banking sessions and key."""
    return LEGACY_DIR if legacy_mode() else data_dir()


def db_path() -> Path:
    return storage_dir() / DB_FILENAME


def eb_sessions_path() -> Path:
    return storage_dir() / EB_SESSIONS_FILENAME


def eb_key_path() -> Path:
    return storage_dir() / EB_KEY_FILENAME


def logs_dir() -> Path:
    return data_dir() / "logs"


def backups_dir() -> Path:
    return data_dir() / "backups"


def token_path() -> Path:
    # Always in the data dir (never the legacy dir) so the Vite dev proxy finds it.
    return data_dir() / TOKEN_FILENAME


def migration_marker_path() -> Path:
    return data_dir() / MIGRATION_MARKER


def legacy_notice() -> str | None:
    """A user-facing notice when legacy data exists and was not migrated."""
    legacy = legacy_db_path()
    if not legacy.exists() or migration_marker_path().exists():
        return None
    target = data_dir()
    if legacy_mode():
        return (
            f"Using the legacy database at {legacy}. Run `finanse migrate-data` to copy "
            f"your data to {target} (the original stays untouched as a backup)."
        )
    if (target / DB_FILENAME).exists():
        return (
            f"Found a legacy database at {legacy} that was not migrated; finanse uses "
            f"{target / DB_FILENAME}. Run `finanse migrate-data --force` to replace it "
            "with the legacy data (the current database is backed up first)."
        )
    return (
        f"Found a legacy database at {legacy} that was not migrated; finanse uses {target} "
        "(FINANSE_DATA_DIR). Run `finanse migrate-data` to copy it there."
    )
