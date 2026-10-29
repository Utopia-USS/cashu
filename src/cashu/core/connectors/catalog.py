"""The community connector catalog: the repository's top-level ``connectors/`` (``connectors/README.md``).

A catalog entry is a normal connector directory ``connectors/<id>/`` plus the catalog's own rules: the
directory name is the manifest id, the manifest names its ``maintainer`` and ``last_verified`` date, a
``README.md`` and synthetic ``fixtures/`` (inputs ``cashu connectors test`` runs) are present. An entry
whose ``last_verified`` is older than :data:`STALE_AFTER_DAYS` is ``stale`` (shown as unmaintained).

Reading an entry never resolves its interpreter and never runs anything: the catalog is listed the same
on every platform, and only an installed connector the owner approved ever runs.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass
from pathlib import Path

from . import manifest as mf

STALE_AFTER_DAYS = 180
FIXTURES_DIR = "fixtures"
README_NAME = "README.md"
FETCH_FIXTURE_EXTENSION = "json"


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


def read_entry(root: Path, *, today: dt.date | None = None) -> CatalogEntry:
    """Read and check one catalog directory (see the module doc). Never raises for a bad entry."""
    root = Path(root)
    name = root.name
    problems: list[str] = []
    try:
        files = mf.scan_dir(root)
    except mf.ManifestError as e:
        return CatalogEntry(name, root, None, None, (), tuple(e.issues))
    digest = mf.content_sha256(files)
    try:
        manifest = mf.parse_manifest((root / mf.MANIFEST_NAME).read_text(encoding="utf-8"))
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


__all__ = [
    "FIXTURES_DIR",
    "README_NAME",
    "STALE_AFTER_DAYS",
    "CatalogEntry",
    "entry_dirs",
    "fixture_files",
    "is_stale",
    "read_entry",
]
