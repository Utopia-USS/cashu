"""Where the investments module keeps files in the data dir (never in the repository).

- ``<data dir>/profiles/<slug>/strategy.yaml`` and ``strategy.md``: the profile's strategy, edited
  by the owner (or written through the app from a template);
- ``<data dir>/imports/<slug>/<sha256>.<ext>``: every committed import file, archived as uploaded;
- ``<data dir>/imports/<slug>/.staging/``: files uploaded for a preview, until committed.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from finanse.core import paths

_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
_EXT = re.compile(r"^[a-z0-9]{1,10}$")
_SHA = re.compile(r"^[0-9a-f]{64}$")


def _checked_slug(slug: str) -> str:
    if not _SLUG.match(slug):
        raise ValueError(f"Not a profile slug: {slug!r}")
    return slug


def profile_dir(slug: str) -> Path:
    return paths.data_dir() / "profiles" / _checked_slug(slug)


def strategy_yaml_path(slug: str) -> Path:
    return profile_dir(slug) / "strategy.yaml"


def strategy_md_path(slug: str) -> Path:
    return profile_dir(slug) / "strategy.md"


def imports_dir(slug: str) -> Path:
    return paths.data_dir() / "imports" / _checked_slug(slug)


def sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def extension(file_name: str) -> str:
    ext = Path(file_name).suffix.lower().lstrip(".")
    return ext if _EXT.match(ext) else "bin"


def staged_path(slug: str, digest: str, file_name: str) -> Path:
    if not _SHA.match(digest):
        raise ValueError("Not a sha256 digest")
    return imports_dir(slug) / ".staging" / f"{digest}.{extension(file_name)}"


def archive_path(slug: str, digest: str, file_name: str) -> Path:
    if not _SHA.match(digest):
        raise ValueError("Not a sha256 digest")
    return imports_dir(slug) / f"{digest}.{extension(file_name)}"


def ensure_dir(path: Path) -> Path:
    """Create ``path`` with owner-only (0700) directories down from the data dir."""
    root = paths.data_dir()
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        return paths.ensure_private_dir(path)
    current = paths.ensure_private_dir(root)
    for part in parts:
        current = paths.ensure_private_dir(current / part)
    return current


def write_private(path: Path, content: bytes) -> Path:
    """Write ``content`` (owner-only dirs and file), atomically via a temp file."""
    ensure_dir(path.parent)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_bytes(content)
    tmp.chmod(0o600)
    tmp.replace(path)
    return path


def write_text_private(path: Path, text: str) -> Path:
    return write_private(path, text.encode("utf-8"))


def relative_to_data_dir(path: Path) -> str:
    try:
        return str(path.relative_to(paths.data_dir()))
    except ValueError:
        return str(path)
