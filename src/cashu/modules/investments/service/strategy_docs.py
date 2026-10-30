"""The profile's strategy documents for the Strategie tab (docs/agents/strategies.md, stage 1).

A strategy is a document the agent writes freely; YAML next to it is optional. Two sources:

- ``main``: the existing ``strategy.md`` + ``strategy.yaml`` in the profile dir, the only one the app
  executes (``service.strategy``); listed even when missing so the tab can offer a template;
- ``strategies/``: ``<id>.md`` (+ ``<id>.yaml``) one-file strategies and ``<id>/`` folder strategies,
  shown read-only and not executed yet.

Read-only: the app never writes these files here. Hidden files, symlinks, other extensions and paths
outside a strategy are ignored; a requested path is resolved and checked against its strategy root.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from . import files

MAIN_ID = "_main"  # cannot collide with a folder id (those start with a letter or digit)
MAIN_FILES = ("strategy.md", "strategy.yaml")
MAX_FILE_BYTES = 512_000
MAX_FILES = 200
MAX_DEPTH = 3
_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_KINDS = {".md": "md", ".markdown": "md", ".yaml": "yaml", ".yml": "yaml", ".txt": "text", ".json": "text"}
_FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?", re.DOTALL)
_HEADING = re.compile(r"^#\s+(.+?)\s*#*\s*$", re.MULTILINE)


class StrategyFileError(LookupError):
    pass


@dataclass
class StrategyDoc:
    id: str
    root: Path
    files: list[str] = field(default_factory=list)
    """Relative POSIX paths, sorted: the main document first."""
    main_md: str | None = None
    single: str | None = None
    """For a one-file strategy: the stem; its files sit next to other strategies in ``strategies/``."""


def strategies_dir(slug: str) -> Path:
    return files.profile_dir(slug) / "strategies"


def _kind(path: Path) -> str | None:
    return _KINDS.get(path.suffix.lower())


def _visible(path: Path) -> bool:
    return not path.name.startswith(".") and not path.is_symlink()


def _walk(root: Path, depth: int = 0) -> list[str]:
    out: list[str] = []
    try:
        entries = sorted(root.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return out
    for p in entries:
        if not _visible(p):
            continue
        if p.is_dir() and depth + 1 < MAX_DEPTH:
            out += [f"{p.name}/{sub}" for sub in _walk(p, depth + 1)]
        elif p.is_file() and _kind(p) is not None:
            out.append(p.name)
        if len(out) >= MAX_FILES:
            break
    return out[:MAX_FILES]


def _pick_main_md(paths: list[str], stem: str | None = None) -> str | None:
    mds = [p for p in paths if _kind(Path(p)) == "md"]
    for preferred in (f"{stem}.md" if stem else None, "strategy.md", "README.md", "index.md"):
        if preferred in mds:
            return preferred
    top = [p for p in mds if "/" not in p]
    return (top or mds or [None])[0]


def discover(slug: str) -> list[StrategyDoc]:
    """``main`` first, then the ``strategies/`` entries by id."""
    pdir = files.profile_dir(slug)
    main = StrategyDoc(MAIN_ID, pdir, [n for n in MAIN_FILES if (pdir / n).is_file()])
    main.main_md = "strategy.md" if "strategy.md" in main.files else None
    docs = [main]
    sdir = strategies_dir(slug)
    if not sdir.is_dir() or sdir.is_symlink():
        return docs
    singles: dict[str, list[str]] = {}
    folders: dict[str, StrategyDoc] = {}
    for p in sorted(sdir.iterdir(), key=lambda p: p.name.lower()):
        if not _visible(p):
            continue
        if p.is_dir() and _ID.match(p.name):
            found = _walk(p)
            folders[p.name] = StrategyDoc(p.name, p, found, _pick_main_md(found))
        elif p.is_file() and _kind(p) in ("md", "yaml") and _ID.match(p.stem.lower()):
            singles.setdefault(p.stem.lower(), []).append(p.name)
    for stem, names in singles.items():
        if stem in folders:
            continue  # a folder of the same id wins
        names.sort(key=lambda n: (_kind(Path(n)) != "md", n))
        folders[stem] = StrategyDoc(stem, sdir, names, _pick_main_md(names, stem), single=stem)
    return docs + [folders[k] for k in sorted(folders)]


def find(slug: str, strategy_id: str) -> StrategyDoc:
    for doc in discover(slug):
        if doc.id == strategy_id:
            return doc
    raise StrategyFileError(f"No strategy {strategy_id!r}")


def read_text(doc: StrategyDoc, rel: str) -> str:
    """One listed file of the strategy; only listed paths are readable, resolved inside its root."""
    if rel not in doc.files:
        raise StrategyFileError(f"No file {rel!r} in strategy {doc.id!r}")
    path = (doc.root / rel).resolve()
    if not path.is_relative_to(doc.root.resolve()) or not path.is_file():
        raise StrategyFileError(f"No file {rel!r} in strategy {doc.id!r}")
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError(f"{path.name} is too large to show")
    return path.read_text(encoding="utf-8", errors="replace")


def frontmatter(md_text: str) -> tuple[dict[str, str], str]:
    """(string fields of a leading ``---`` YAML block, the text after it); a broken block is ignored."""
    m = _FRONTMATTER.match(md_text)
    if not m:
        return {}, md_text
    try:
        data = yaml.safe_load(m.group(1))
    except yaml.YAMLError:
        return {}, md_text
    if not isinstance(data, dict):
        return {}, md_text
    fields = {str(k): str(v).strip() for k, v in data.items() if isinstance(v, (str, int, float)) and str(v).strip()}
    return fields, md_text[m.end():]


def summary(doc: StrategyDoc) -> dict:
    """The list entry: id, title / status / description from the frontmatter (title falls back to the
    first heading, else null for main and the id for the others), files with their kind and the folder
    they are relative to (for "copy path")."""
    meta: dict[str, str] = {}
    heading = None
    if doc.main_md is not None:
        try:
            meta, body = frontmatter(read_text(doc, doc.main_md))
        except (OSError, ValueError, StrategyFileError):
            body = ""
        h = _HEADING.search(body)
        heading = h.group(1).strip() if h else None
    title = meta.get("title") or heading or (None if doc.id == MAIN_ID else doc.id)
    return {
        "id": doc.id,
        "main": doc.id == MAIN_ID,
        "executed": doc.id == MAIN_ID,
        "title": title,
        "status": meta.get("status"),
        "description": meta.get("description"),
        "main_file": doc.main_md,
        "root": str(doc.root),
        "files": [{"path": f, "kind": _kind(Path(f))} for f in doc.files],
    }
