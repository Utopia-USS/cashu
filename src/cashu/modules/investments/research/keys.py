"""Identity of research signals (no imports beyond the stdlib, so the daily check and the views can use
it without loading the research service).

A research signal has ``rule_id = kind = "research:<note kind>"`` and ``dedup_key =
"research:<ISO week>|i:<instrument id>"``, ``"research:<ISO week>|s:<segment key>"`` (market segment,
P5) or ``"research:<ISO week>|t:<theme key>"`` (old theme notes): one signal per instrument, segment
or theme and week. Strategy rule ids cannot contain ``:``, so the prefix never clashes.
"""

from __future__ import annotations

RESEARCH_PREFIX = "research:"


def is_research_key(value: str | None) -> bool:
    """True for the rule id / dedup key / kind of a research signal."""
    return bool(value) and value.startswith(RESEARCH_PREFIX)


def research_rule_id(kind: str) -> str:
    return f"{RESEARCH_PREFIX}{kind}"


def research_dedup_key(
    week: str,
    *,
    instrument_id: int | None = None,
    segment: str | None = None,
    theme: str | None = None,
) -> str:
    """``research:2026-W40|i:12``, ``research:2026-W40|s:gold`` or
    ``research:2026-W40|t:semiconductors`` (theme = its key); the instrument wins, then the segment."""
    if instrument_id is not None:
        scope = f"i:{instrument_id}"
    elif segment is not None:
        scope = f"s:{segment}"
    else:
        scope = f"t:{theme}"
    return f"{RESEARCH_PREFIX}{week}|{scope}"
