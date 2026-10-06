"""The Claude Code skills a workspace gets: which module brings which skill, and their versions.

The skills ship with cashU (``.claude/skills`` in a checkout, bundled in the packaged app; see
``core/runtime.skills_dir``). Each skill folder is self-contained: its references live in its own
``references/`` folder (copies of package docs are refreshed by ``scripts/sync_skill_references.py``),
so a copy works anywhere. A skill's version is a short hash of its files.
"""

from __future__ import annotations

import hashlib
import os
import shutil
from dataclasses import dataclass, replace
from pathlib import Path

from .. import runtime

# Which skills an enabled module brings into its profile's workspace (missing ones are skipped,
# e.g. market-research before it ships). Every skill folder must be listed here
# (tests/test_workspace.py checks it), so a new skill is a deliberate decision.
MODULE_SKILLS: dict[str, tuple[str, ...]] = {
    # import-builder serves both import modules (broker exports and bank statements, F10).
    "budget": ("budget-setup", "import-builder"),
    "assets": ("assets-setup",),
    "loans": ("loans-setup",),
    "investments": ("investments-setup", "import-builder", "extension-builder", "market-research"),
}

_IGNORED_NAMES = {"__pycache__", ".DS_Store"}
_IGNORED_SUFFIXES = (".pyc", ".pyo")


@dataclass(frozen=True)
class SkillSource:
    name: str
    module: str
    path: Path
    version: str


def source_dir() -> Path | None:
    """Where the shipped skills are (None: this installation has none, e.g. a plain wheel)."""
    return runtime.skills_dir()


def _ignored(name: str) -> bool:
    return name in _IGNORED_NAMES or name.endswith(_IGNORED_SUFFIXES)


def _files(root: Path) -> list[Path]:
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not _ignored(d))
        for name in sorted(filenames):
            if not _ignored(name):
                out.append(Path(dirpath) / name)
    return out


def tree_hash(root: Path) -> str:
    """Short content hash of a skill folder (file names and bytes), the skill's version."""
    digest = hashlib.sha256()
    for file in _files(root):
        rel = file.relative_to(root).as_posix()
        digest.update(rel.encode("utf-8") + b"\0")
        digest.update(hashlib.sha256(file.read_bytes()).digest())
    return digest.hexdigest()[:12]


def module_of(skill: str) -> str | None:
    for module_id, names in MODULE_SKILLS.items():
        if skill in names:
            return module_id
    return None


def available(source: Path | None = None) -> dict[str, SkillSource]:
    """Every shipped skill cashU knows (folder with a SKILL.md, listed in MODULE_SKILLS)."""
    source = source if source is not None else source_dir()
    if source is None or not source.is_dir():
        return {}
    out: dict[str, SkillSource] = {}
    for folder in sorted(p for p in source.iterdir() if p.is_dir()):
        module_id = module_of(folder.name)
        if module_id is None or not (folder / "SKILL.md").is_file():
            continue
        out[folder.name] = SkillSource(folder.name, module_id, folder, tree_hash(folder))
    return out


def wanted(
    enabled_modules: list[str], shipped: dict[str, SkillSource] | None = None
) -> dict[str, SkillSource]:
    """The skills of the enabled modules, in module order (``shipped``: from :func:`available`)."""
    shipped = available() if shipped is None else shipped
    out: dict[str, SkillSource] = {}
    for module_id in enabled_modules:
        for name in MODULE_SKILLS.get(module_id, ()):
            if name in shipped and name not in out:
                # a skill of several modules is labelled with the first enabled one
                out[name] = replace(shipped[name], module=module_id)
    return out


def copy_skill(src: Path, dest: Path) -> None:
    """Replace ``dest`` with a copy of ``src`` (via a temporary sibling, so a failed copy never
    leaves half a skill behind)."""
    tmp = dest.with_name(f".{dest.name}.tmp-{os.getpid()}")
    if tmp.exists():
        shutil.rmtree(tmp)
    shutil.copytree(src, tmp, ignore=lambda _d, names: [n for n in names if _ignored(n)])
    if dest.is_symlink() or dest.is_file():
        dest.unlink()
    elif dest.exists():
        shutil.rmtree(dest)
    os.replace(tmp, dest)
