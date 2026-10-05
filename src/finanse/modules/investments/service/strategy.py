"""A profile's strategy files: reading, validating (with the pure loader), versioning, templates.

States: ``missing`` (no strategy.yaml: valuation only, no rules), ``valid``, ``partial`` (only some
rule entries have errors: the other rules run, the broken ones are inactive), ``invalid`` (the file
cannot be used; rules do not run and open signals stay untouched). A version is stored whenever the
files change (``record=True``: the daily check and an explicit reload).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from sqlmodel import Session, select

from finanse.core.models import Profile

from ..models import InvStrategyVersion
from ..strategy import (
    MAX_STRATEGY_CHARS,
    InactiveRule,
    StrategyConfig,
    StrategyIssue,
    StrategyLoadResult,
    load_strategy,
)
from ..templates import STRATEGY_TEMPLATE_NAMES, strategy_template
from . import files

State = Literal["missing", "valid", "partial", "invalid"]


@dataclass(frozen=True)
class StrategyState:
    state: State
    yaml_path: Path
    md_path: Path
    result: StrategyLoadResult | None = None
    sha256: str | None = None
    version: InvStrategyVersion | None = None
    """The newest stored version (the current files when ``changed`` is False)."""
    changed: bool = False
    """The files differ from the newest stored version (not recorded yet)."""
    read_error: str | None = None

    @property
    def config(self) -> StrategyConfig | None:
        """The usable config: the valid one, or the partial one (valid rules only)."""
        if self.result is None:
            return None
        return self.result.config or self.result.partial

    @property
    def issues(self) -> tuple[StrategyIssue, ...]:
        return () if self.result is None else self.result.issues

    @property
    def inactive_rules(self) -> tuple[InactiveRule, ...]:
        return () if self.result is None else self.result.inactive_rules


def read_files(slug: str) -> tuple[str | None, str | None, str | None]:
    """(yaml, md, error) of the profile's strategy files; None for a missing file."""
    yaml_path, md_path = files.strategy_yaml_path(slug), files.strategy_md_path(slug)

    def read(path: Path) -> str | None:
        if not path.is_file():
            return None
        if path.stat().st_size > MAX_STRATEGY_CHARS * 4:
            raise ValueError(f"{path.name} is too large")
        return path.read_text(encoding="utf-8")

    try:
        return read(yaml_path), read(md_path), None
    except (OSError, UnicodeDecodeError, ValueError) as e:
        return None, None, f"cannot read the strategy files: {e}"


def _digest(yaml_text: str, md_text: str | None) -> str:
    return files.sha256((yaml_text + "\0" + (md_text or "")).encode("utf-8"))


def latest_version(session: Session, profile_id: int) -> InvStrategyVersion | None:
    return session.exec(
        select(InvStrategyVersion)
        .where(InvStrategyVersion.profile_id == profile_id)
        .order_by(InvStrategyVersion.version.desc())
    ).first()


def versions(session: Session, profile_id: int) -> list[InvStrategyVersion]:
    return list(
        session.exec(
            select(InvStrategyVersion)
            .where(InvStrategyVersion.profile_id == profile_id)
            .order_by(InvStrategyVersion.version.desc())
        ).all()
    )


def issue_dict(issue: StrategyIssue) -> dict:
    return {
        "severity": issue.severity.value,
        "path": issue.path,
        "message": issue.message,
        "line": issue.line,
        "column": issue.column,
        "code": issue.code,  # stable code + params: the app shows a translated label
        "params": dict(issue.params or {}),
    }


def load(session: Session, profile: Profile, *, record: bool = False) -> StrategyState:
    """Read and validate the profile's strategy files; with ``record``, store a new version when
    they changed since the newest stored one."""
    yaml_path = files.strategy_yaml_path(profile.slug)
    md_path = files.strategy_md_path(profile.slug)
    latest = latest_version(session, profile.id)
    yaml_text, md_text, error = read_files(profile.slug)
    if error is not None:
        return StrategyState("invalid", yaml_path, md_path, version=latest, read_error=error)
    if yaml_text is None:
        return StrategyState("missing", yaml_path, md_path, version=latest)
    result = load_strategy(yaml_text, md_text)
    state: State = "valid" if result.config else "partial" if result.partial else "invalid"
    digest = _digest(yaml_text, md_text)
    changed = latest is None or latest.sha256 != digest
    if record and changed:
        latest = InvStrategyVersion(
            profile_id=profile.id,
            version=(latest.version + 1) if latest is not None else 1,
            sha256=digest,
            yaml_text=yaml_text,
            md_text=md_text,
            state=state,
            issues=[issue_dict(i) for i in result.issues],
        )
        session.add(latest)
        session.flush()
        changed = False
    if record and result.config is not None and result.config.benchmark is not None:
        # a benchmark proxy nobody holds or watches still needs an instrument row (F7 owner fix)
        from ..performance.proxy import ensure_quietly

        ensure_quietly(session, result.config.benchmark.proxy)
    return StrategyState(state, yaml_path, md_path, result, digest, latest, changed)


class StrategyExists(FileExistsError):
    pass


def init_files(slug: str, template: str = "passive_etf", *, force: bool = False) -> list[Path]:
    """Write strategy.yaml / strategy.md from a shipped template; refuses to overwrite existing files
    unless ``force``. Returns the written paths."""
    if template not in STRATEGY_TEMPLATE_NAMES:
        raise KeyError(
            f"Unknown template {template!r}; known: {', '.join(STRATEGY_TEMPLATE_NAMES)}"
        )
    tpl = strategy_template(template)
    targets = [
        (files.strategy_yaml_path(slug), tpl.yaml),
        (files.strategy_md_path(slug), tpl.markdown),
    ]
    existing = [p for p, _ in targets if p.exists()]
    if existing and not force:
        raise StrategyExists(", ".join(p.name for p in existing) + " already exist(s)")
    return [files.write_text_private(path, text) for path, text in targets]
