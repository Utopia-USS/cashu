"""The community connector catalog: the repository's top-level ``connectors/`` (``connectors/README.md``).

A catalog entry is a normal connector directory ``connectors/<id>/`` plus the catalog's own rules: the
directory name is the manifest id, the manifest names its ``maintainer`` and ``last_verified`` date, a
``README.md`` and synthetic ``fixtures/`` (inputs ``cashu connectors test`` runs) are present. An entry
whose ``last_verified`` is older than :data:`STALE_AFTER_DAYS` is ``stale`` (shown as unmaintained).

Reading an entry never resolves its interpreter and never runs anything: the catalog is listed the same
on every platform, and only an installed connector the owner approved ever runs.

In the app the catalog is read-only package data (:func:`catalog_dir`): ``<bundle>/connectors`` in the
packaged app (PyInstaller datas, ``packaging/cashu.spec``), ``cashu/connector_catalog`` in an installed
wheel (hatch ``force-include``), else the checkout's ``connectors/``. :func:`install` copies an entry
into the data dir with the same code path as ``cashu connectors add`` / MCP ``propose_connector``
(``service.install``): it is ``pending`` (or ``changed`` over an approved copy with other content) until
the owner approves exactly that content hash in the app. Nothing here approves or runs anything.
"""

from __future__ import annotations

import datetime as dt
import os
import re
import shutil
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from . import manifest as mf

if TYPE_CHECKING:
    from sqlmodel import Session

    from .service import Installed

STALE_AFTER_DAYS = 180
FIXTURES_DIR = "fixtures"
README_NAME = "README.md"
FETCH_FIXTURE_EXTENSION = "json"
BUNDLED_CATALOG = "connectors"  # PyInstaller data folder (packaging/cashu.spec)
PACKAGE_CATALOG = "connector_catalog"  # inside the cashu package of a wheel (pyproject force-include)


@dataclass(frozen=True, slots=True)
class CatalogEntry:
    """One ``connectors/<id>/`` directory as read from disk. ``problems`` is empty for a valid entry;
    ``manifest`` is None when the manifest or the directory itself is invalid."""

    id: str
    path: Path
    manifest: mf.Manifest | None
    content_sha256: str | None
    fixtures: tuple[Path, ...]
    problems: tuple[str, ...]

    @property
    def valid(self) -> bool:
        return self.manifest is not None and not self.problems

    def stale(self, today: dt.date | None = None) -> bool:
        return is_stale(self.manifest.last_verified if self.manifest else None, today)


def _today() -> dt.date:
    return dt.datetime.now(dt.UTC).astimezone().date()  # the local calendar day


def is_stale(last_verified: dt.date | None, today: dt.date | None = None) -> bool:
    """No verification date, or one older than :data:`STALE_AFTER_DAYS` days."""
    if last_verified is None:
        return True
    today = today or _today()
    return (today - last_verified).days > STALE_AFTER_DAYS


def fixture_files(root: Path, manifest: mf.Manifest) -> list[Path]:
    """The fixtures ``connectors test`` runs: files directly in ``fixtures/`` with an extension the
    manifest reads (kind file), or recorded synthetic API responses ``*.json`` (kind fetch)."""
    folder = root / FIXTURES_DIR
    if not folder.is_dir() or folder.is_symlink():
        return []
    wanted = set(manifest.extensions) if manifest.kind == "file" else {FETCH_FIXTURE_EXTENSION}
    return sorted(
        p for p in folder.iterdir()
        if p.is_file() and not p.is_symlink() and p.suffix[1:].lower() in wanted
    )


CACHE_DIR = "__pycache__"


@contextmanager
def clean_source(root: Path) -> Iterator[Path]:
    """``root`` itself, or, when it holds ``__pycache__`` folders, a temporary copy without them. pip
    byte-compiles the ``.py`` files of an installed wheel (the catalog is package data there), and
    those caches are no part of the connector: never hashed, never installed."""
    root = Path(root)
    if next(root.rglob(CACHE_DIR), None) is None:
        yield root
        return
    with tempfile.TemporaryDirectory(prefix="cashu-catalog-") as tmp:
        copy = Path(tmp) / root.name
        shutil.copytree(root, copy, symlinks=True, ignore=shutil.ignore_patterns(CACHE_DIR))
        yield copy


def read_entry(root: Path, *, today: dt.date | None = None) -> CatalogEntry:
    """Read and check one catalog directory (see the module doc). Never raises for a bad entry."""
    root = Path(root)
    with clean_source(root) as source:
        return _read_entry(root, source, today)


def _read_entry(root: Path, source: Path, today: dt.date | None) -> CatalogEntry:
    name = root.name
    problems: list[str] = []
    try:
        files = mf.scan_dir(source)
    except mf.ManifestError as e:
        return CatalogEntry(name, root, None, None, (), tuple(e.issues))
    digest = mf.content_sha256(files)
    try:
        manifest = mf.parse_manifest((source / mf.MANIFEST_NAME).read_text(encoding="utf-8"))
    except (mf.ManifestError, UnicodeDecodeError) as e:
        issues = e.issues if isinstance(e, mf.ManifestError) else ("connector.yaml is not UTF-8",)
        return CatalogEntry(name, root, None, digest, (), tuple(issues))
    if manifest.id != name:
        problems.append(f"the directory name must be the connector id ({manifest.id})")
    if not manifest.maintainer:
        problems.append("maintainer: required in the catalog")
    if manifest.last_verified is None:
        problems.append("last_verified: required in the catalog")
    elif manifest.last_verified > (today or _today()) + dt.timedelta(days=1):
        problems.append("last_verified: lies in the future")
    readme = root / README_NAME
    if not readme.is_file() or not readme.read_text(encoding="utf-8", errors="replace").strip():
        problems.append(f"{README_NAME}: required in the catalog")
    first = manifest.run[0]
    if first.startswith("./") and not any(e.path == first[2:] for e in files):
        problems.append(f"run[0]: {first} is not a file of the connector")
    fixtures = fixture_files(root, manifest)
    if not fixtures:
        kinds = (
            ", ".join(f".{x}" for x in manifest.extensions) if manifest.kind == "file"
            else f".{FETCH_FIXTURE_EXTENSION}"
        )
        problems.append(f"{FIXTURES_DIR}/: needs at least one synthetic fixture ({kinds})")
    return CatalogEntry(name, root, manifest, digest, tuple(fixtures), tuple(problems))


def entry_dirs(catalog: Path) -> list[Path]:
    """The entry directories of a catalog folder, sorted (hidden names and loose files skipped)."""
    if not catalog.is_dir():
        return []
    return sorted(
        p for p in catalog.iterdir()
        if p.is_dir() and not p.is_symlink() and not p.name.startswith((".", "_"))
        and re.match(r"^[A-Za-z0-9]", p.name)
    )


# --------------------------------------------------------------------------- #
# The catalog in the app: location, listing, install as pending
# --------------------------------------------------------------------------- #


def catalog_dir() -> Path | None:
    """The read-only catalog shipped with this install (see the module doc), resolved to its real path
    (a packaged app may reach its data through a symlinked folder); None when there is none."""
    from .. import paths, runtime

    candidates: list[Path] = []
    exe = runtime.executable()
    if exe is not None:
        # macOS .app: PyInstaller keeps data in Contents/Resources (Frameworks may only link to it).
        candidates.append(exe.parent.parent / "Resources" / BUNDLED_CATALOG)
    bundle = runtime.bundle_dir()
    if bundle is not None:
        candidates.append(bundle / BUNDLED_CATALOG)
    package = sys.modules["cashu"].__file__
    if package:
        candidates.append(Path(package).parent / PACKAGE_CATALOG)
    candidates.append(paths.PROJECT_ROOT / BUNDLED_CATALOG)
    for candidate in candidates:
        if candidate.is_dir():
            return Path(os.path.realpath(candidate))
    return None


def list_entries(*, today: dt.date | None = None) -> list[CatalogEntry]:
    root = catalog_dir()
    return [read_entry(p, today=today) for p in entry_dirs(root)] if root is not None else []


def get_entry(connector_id: str, *, today: dt.date | None = None) -> CatalogEntry:
    """One catalog entry by id. Raises ``service.NotFound`` (also for an id that is not a connector id)."""
    from . import service

    root = catalog_dir()
    if root is None or not re.match(mf.CONNECTOR_ID, connector_id or ""):
        raise service.NotFound(f"no catalog connector {connector_id!r}")
    path = root / connector_id
    if path not in entry_dirs(root):
        raise service.NotFound(f"no catalog connector {connector_id!r}")
    return read_entry(path, today=today)


def entry_dict(entry: CatalogEntry, installed=None, *, today: dt.date | None = None) -> dict:
    """The owner's / CLI view of one entry. ``installed``: the installed ``Connector`` row of that id."""
    m = entry.manifest
    return {
        "id": entry.id,
        "name": m.name if m else None,
        "version": m.version if m else None,
        "module": m.module if m else None,
        "kind": m.kind if m else None,
        "author": m.author if m else None,
        "description": m.description if m else None,
        "maintainer": m.maintainer if m else None,
        "last_verified": m.last_verified.isoformat() if m and m.last_verified else None,
        "stale": entry.stale(today),
        "extensions": list(m.extensions) if m else [],
        "hosts": list(m.hosts) if m else [],
        "content_sha256": entry.content_sha256,
        "valid": entry.valid,
        "problems": list(entry.problems),
        "installed": None if installed is None else {
            "status": installed.status,
            "same_content": installed.content_sha256 == entry.content_sha256,
        },
    }


def installed_rows(session: Session) -> dict:
    """The installed connectors by id, re-checked from disk (``service.refresh``)."""
    from sqlmodel import select

    from . import service
    from .models import Connector

    rows = {}
    for row in session.exec(select(Connector)).all():
        service.refresh(session, row)
        rows[row.id] = row
    return rows


def list_catalog(session: Session, *, today: dt.date | None = None) -> list[dict]:
    rows = installed_rows(session)
    return [entry_dict(e, rows.get(e.id), today=today) for e in list_entries(today=today)]


def install(connector_id: str, *, replace: bool = False, source: str = "catalog") -> Installed:
    """Install a catalog entry into the data dir through ``service.install`` (the code path of
    ``cashu connectors add`` and ``propose_connector``): ``pending`` until the owner approves it in the
    app. An invalid entry is refused. Raises ``service.ConnectorError``."""
    from . import service

    entry = get_entry(connector_id)
    if not entry.valid:
        raise service.ConnectorError(
            f"catalog connector {connector_id!r} breaks the catalog rules", issues=entry.problems
        )
    with clean_source(entry.path) as directory:
        return service.install(directory, replace=replace, source=source)


__all__ = [
    "BUNDLED_CATALOG",
    "FIXTURES_DIR",
    "PACKAGE_CATALOG",
    "README_NAME",
    "STALE_AFTER_DAYS",
    "CatalogEntry",
    "catalog_dir",
    "entry_dict",
    "entry_dirs",
    "fixture_files",
    "get_entry",
    "install",
    "installed_rows",
    "is_stale",
    "list_catalog",
    "list_entries",
    "read_entry",
]
