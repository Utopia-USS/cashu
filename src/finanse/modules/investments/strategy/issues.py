"""Validation results of strategy.yaml / strategy.md."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING

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
class StrategyLoadResult:
    """A ``config`` when there is no error, plus every issue (warnings may accompany a valid config)."""

    config: StrategyConfig | None = None
    issues: tuple[StrategyIssue, ...] = ()

    @property
    def is_valid(self) -> bool:
        return self.config is not None

    @property
    def errors(self) -> list[StrategyIssue]:
        return [issue for issue in self.issues if issue.is_error]

    @property
    def warnings(self) -> list[StrategyIssue]:
        return [issue for issue in self.issues if not issue.is_error]
