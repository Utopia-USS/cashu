"""Where cashU keeps its files.

Everything personal (SQLite DB, Open Banking sessions and private key, logs, the
per-launch API token) lives in one per-user data dir outside the repo checkout:

- macOS:   ~/Library/Application Support/cashU
- Windows: %APPDATA%\\cashU
- Linux:   $XDG_DATA_HOME/cashu (default ~/.local/share/cashu)

``CASHU_DATA_DIR`` overrides it (tests, portable setups).

Before the rename to cashU (legacy name) the default dir was ``.../finanse`` with ``finanse.db``
in it; ``core.migrate_legacy`` moves such an install into place at startup.

Legacy layout: earlier versions kept everything in ``<repo>/data/`` (legacy name
``finanse.db``). As long as the data dir has no database yet, ``CASHU_DATA_DIR`` is not set and
``<repo>/data/finanse.db`` exists, cashU keeps using the legacy files
("legacy mode") and prints a notice until ``cashu migrate-data`` copies them
into the data dir. With ``CASHU_DATA_DIR`` set, the legacy files are never
used automatically (only reported), so tests can never touch them.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

from platformdirs import user_data_dir

from .env import env

APP_NAME = "cashU"  # the data dir folder on macOS and Windows
APP_NAME_LINUX = "cashu"  # XDG folders are lower case
LEGACY_APP_NAME = "finanse"  # legacy name: the data dir folder before the rename
DATA_DIR_ENV = "CASHU_DATA_DIR"
# Where the pre-rename default dir is looked for (tests point it into a temp dir, so the startup
# migration can never touch a real install from a test).
LEGACY_DATA_DIR_ENV = "CASHU_LEGACY_DATA_DIR"

# repo root = three levels up (src/cashu/core/paths.py -> repo/). Only meaningful
# for a source checkout; used to find legacy data and the developer .env file.
PROJECT_ROOT = Path(__file__).resolve().parents[3]
LEGACY_DIR = PROJECT_ROOT / "data"

DB_FILENAME = "cashu.db"
LEGACY_DB_FILENAME = "finanse.db"  # legacy name: the DB file before the rename
EB_SESSIONS_FILENAME = "eb_sessions.json"
EB_KEY_FILENAME = "enablebanking_private.pem"
TOKEN_FILENAME = "api-token"
MIGRATION_MARKER = "legacy-migration.json"


def app_dir_name(platform: str | None = None) -> str:
    return APP_NAME_LINUX if (platform or sys.platform).startswith("linux") else APP_NAME


def default_data_dir() -> Path:
    """Platform default per-user data dir (no override applied)."""
    # appauthor=False: %APPDATA%\cashU, not %APPDATA%\cashU\cashU.
    # roaming=True: Windows uses %APPDATA% (Roaming), as documented.
    return Path(user_data_dir(app_dir_name(), appauthor=False, roaming=True))


def legacy_default_data_dir() -> Path:
    """The platform default data dir before the rename (``.../finanse``, legacy name);
    ``CASHU_LEGACY_DATA_DIR`` overrides it (tests)."""
    raw = os.environ.get(LEGACY_DATA_DIR_ENV, "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path(user_data_dir(LEGACY_APP_NAME, appauthor=False, roaming=True))


def data_dir_override() -> Path | None:
    raw = (env(DATA_DIR_ENV) or "").strip()
    return Path(raw).expanduser().resolve() if raw else None


def data_dir() -> Path:
    """The active data dir: ``CASHU_DATA_DIR`` or the platform default."""
    return data_dir_override() or default_data_dir()


def ensure_private_dir(path: Path) -> Path:
    """Create ``path`` (and parents) if missing; a newly created dir is 0700."""
    if not path.exists():
        path.mkdir(parents=True, mode=0o700)
        if os.name == "posix":
            os.chmod(path, 0o700)
    return path


def legacy_db_path() -> Path:
    return LEGACY_DIR / LEGACY_DB_FILENAME


def legacy_mode() -> bool:
    """True when cashU should keep using ``<repo>/data/`` (see module doc)."""
    if data_dir_override() is not None:
        return False
    return not (default_data_dir() / DB_FILENAME).exists() and legacy_db_path().exists()


def storage_dir() -> Path:
    """Directory holding the DB, Open Banking sessions and key."""
    return LEGACY_DIR if legacy_mode() else data_dir()


def db_path() -> Path:
    return legacy_db_path() if legacy_mode() else data_dir() / DB_FILENAME


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


# Copy of the legacy repo-dir DB taken before this version upgrades it in place
# (legacy mode); kept in the data dir, outside the repo's data/ (see legacy_notice).
LEGACY_PRE_UPGRADE_PREFIX = "cashu-legacy-pre-"
# The same copies and the repo-dir ones written before the rename (legacy name).
OLD_PRE_UPGRADE_PREFIX = "finanse-legacy-pre-"
OLD_REPO_PRE_PREFIX = "finanse-pre-"
_STAMP = re.compile(r"(\d{8}-\d{6})\.db$")


def is_legacy_db(file: Path) -> bool:
    """True when ``file`` is the legacy ``<repo>/data/finanse.db`` (legacy name)."""
    return file.resolve() == legacy_db_path().resolve()


def legacy_upgrade_backups(
    legacy_dir: Path | None = None, target_dir: Path | None = None
) -> list[Path]:
    """Copies of the legacy DB from before this version upgraded it in place, oldest
    first: ``<data dir>/backups/cashu-legacy-pre-*.db`` (legacy name: ``finanse-legacy-pre-*.db``
    before the rename), plus the ``<repo>/data/backups/finanse-pre-*.db`` files earlier builds wrote."""
    legacy_dir = legacy_dir or LEGACY_DIR
    backups = (target_dir / "backups") if target_dir else backups_dir()
    found = list(backups.glob(f"{LEGACY_PRE_UPGRADE_PREFIX}*.db"))
    found += list(backups.glob(f"{OLD_PRE_UPGRADE_PREFIX}*.db"))
    found += list((legacy_dir / "backups").glob(f"{OLD_REPO_PRE_PREFIX}*.db"))

    def stamp(path: Path) -> str:
        m = _STAMP.search(path.name)
        return m.group(1) if m else path.name

    return sorted(found, key=stamp)


def legacy_notice() -> str | None:
    """A user-facing notice when legacy data exists and was not migrated."""
    legacy = legacy_db_path()
    if not legacy.exists() or migration_marker_path().exists():
        return None
    target = data_dir()
    if legacy_mode():
        copies = legacy_upgrade_backups()
        if copies:
            return (
                f"Using the legacy database at {legacy}; this version upgraded it in place. "
                f"Its copy from before the upgrade is {copies[0]}. Run `cashu migrate-data` "
                f"to copy your data to {target}."
            )
        return (
            f"Using the legacy database at {legacy}. Run `cashu migrate-data` to copy your "
            f"data to {target}. Until then this version upgrades it in place on first use, "
            f"after saving a copy of it in {backups_dir()}."
        )
    if (target / DB_FILENAME).exists():
        return (
            f"Found a legacy database at {legacy} that was not migrated; cashU uses "
            f"{target / DB_FILENAME}. Run `cashu migrate-data --force` to replace it "
            "with the legacy data (the current database is backed up first)."
        )
    return (
        f"Found a legacy database at {legacy} that was not migrated; cashU uses {target} "
        "(CASHU_DATA_DIR). Run `cashu migrate-data` to copy it there."
    )
