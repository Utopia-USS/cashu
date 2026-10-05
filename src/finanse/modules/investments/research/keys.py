"""Identity of research signals (no imports beyond the stdlib, so the daily check and the views can use
it without loading the research service).

A research signal has ``rule_id = kind = "research:<note kind>"`` and ``dedup_key =
"research:<ISO week>|i:<instrument id>"`` or ``"research:<ISO week>|t:<theme key>"`` (one signal per
instrument or theme and week). Strategy rule ids cannot contain ``:``, so the prefix never clashes.
"""

from __future__ import annotations

RESEARCH_PREFIX = "research:"


def is_research_key(value: str | None) -> bool:
    """True for the rule id / dedup key / kind of a research signal."""
    return bool(value) and value.startswith(RESEARCH_PREFIX)


def research_rule_id(kind: str) -> str:
    return f"{RESEARCH_PREFIX}{kind}"


def research_dedup_key(
    week: str, *, instrument_id: int | None = None, theme: str | None = None
) -> str:
    """``research:2026-W40|i:12`` or ``research:2026-W40|t:semiconductors`` (theme = its key)."""
    scope = f"i:{instrument_id}" if instrument_id is not None else f"t:{theme}"
    return f"{RESEARCH_PREFIX}{week}|{scope}"
