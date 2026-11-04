"""Validation results of strategy.yaml / strategy.md."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING

from .codes import classify

if TYPE_CHECKING:
    from .config import StrategyConfig


class IssueSeverity(StrEnum):
    """Errors reject the strategy; warnings are only reported."""

    ERROR = "error"
    WARNING = "warning"


@dataclass(frozen=True, slots=True)
class StrategyIssue:
    """One problem found by the strategy loader."""

    severity: IssueSeverity
    path: str
    """YAML path of the offending node (``rules[2].params.threshold``, ``allocation.targets.bonds``);
    empty for the whole document, ``strategy.md`` for the prose file."""
    message: str
    """English, one sentence, names the key and usually the bad value (and a "did you mean" hint)."""
    line: int | None = None
    """1-based line in strategy.yaml, None when the issue has no YAML location."""
    column: int | None = None
    """1-based column in strategy.yaml, None when the issue has no YAML location."""
    code: str = field(default="", compare=False)
    """Stable machine-readable code (``strategy.<name>``, see ``codes.py``) for a translated label;
    derived from ``message`` when not given. ``strategy.other`` = no template matched."""
    params: dict[str, str] | None = field(default=None, compare=False, hash=False)
    """The variable parts of ``message`` by name (bucket, key, value, suggestion, ...)."""

    def __post_init__(self) -> None:
        if not self.code:
            code, params = classify(self.message)
            object.__setattr__(self, "code", code)
            if self.params is None:
                object.__setattr__(self, "params", params)
        elif self.params is None:
            object.__setattr__(self, "params", {})

    @property
    def is_error(self) -> bool:
        return self.severity == IssueSeverity.ERROR

    def __str__(self) -> str:
        where = " ".join(
            part
            for part in (
                self.path,
                f"(line {self.line}, column {self.column})" if self.line else "",
            )
            if part
        )
        return f"{self.severity}{' ' + where if where else ''}: {self.message}"


@dataclass(frozen=True, slots=True)
class InactiveRule:
    """A rule entry left out of the strategy because of its own errors (``rules[index]``)."""

    index: int
    rule_id: str | None
    """The entry's ``id`` when it is a plain string, else None."""
    kind: str | None
    line: int | None = None
    """1-based line of the entry in strategy.yaml."""
    issues: tuple[StrategyIssue, ...] = ()
    """The errors that made it inactive."""


@dataclass(frozen=True, slots=True)
class StrategyLoadResult:
    """A ``config`` when there is no error, plus every issue (warnings may accompany a valid config).

    ``partial``: when every error belongs to a rule entry (``rules[i]...``), the config built from
    everything else and the valid rules; ``config`` stays None (the strategy is not valid) and the
    left-out entries are listed in ``inactive_rules``. A caller may run the valid rules and report
    the inactive ones (the daily check does).
    """

    config: StrategyConfig | None = None
    issues: tuple[StrategyIssue, ...] = ()
    partial: StrategyConfig | None = None
    inactive_rules: tuple[InactiveRule, ...] = ()

    @property
    def is_valid(self) -> bool:
        return self.config is not None

    @property
    def errors(self) -> list[StrategyIssue]:
        return [issue for issue in self.issues if issue.is_error]

    @property
    def warnings(self) -> list[StrategyIssue]:
        return [issue for issue in self.issues if not issue.is_error]
