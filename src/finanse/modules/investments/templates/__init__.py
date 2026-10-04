"""Shipped templates of the investments module (generic, no personal numbers).

``strategy/<name>.yaml`` + ``strategy/<name>.md``: default strategy files a new profile copies and edits;
``strategy/README.md`` is the strategy.yaml reference.
"""

from __future__ import annotations

from dataclasses import dataclass
from importlib.resources import files

STRATEGY_TEMPLATE_NAMES = ("passive_etf", "blank")
"""Strategy templates in display order."""


@dataclass(frozen=True, slots=True)
class StrategyTemplate:
    name: str
    yaml: str
    """strategy.yaml text (comments in English)."""
    markdown: str
    """strategy.md text (prose, in Polish)."""


def strategy_template(name: str) -> StrategyTemplate:
    """The template ``name`` (one of ``STRATEGY_TEMPLATE_NAMES``); raises ``KeyError`` otherwise."""
    if name not in STRATEGY_TEMPLATE_NAMES:
        raise KeyError(
            f"Unknown strategy template {name!r}; known: {', '.join(STRATEGY_TEMPLATE_NAMES)}"
        )
    folder = files(__name__).joinpath("strategy")
    return StrategyTemplate(
        name=name,
        yaml=folder.joinpath(f"{name}.yaml").read_text(encoding="utf-8"),
        markdown=folder.joinpath(f"{name}.md").read_text(encoding="utf-8"),
    )


def strategy_reference() -> str:
    """The strategy.yaml reference (``strategy/README.md``)."""
    return files(__name__).joinpath("strategy", "README.md").read_text(encoding="utf-8")
