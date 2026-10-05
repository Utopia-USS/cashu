"""The parts of the owner's ``strategy.md`` a research run needs for candidates and theses: what the
owner believes (approach / philosophy), the entry and exit rules, and what the owner avoids. Pure:
markdown in, sections out. The MCP layer labels the text as ``text`` (identifiers always scrubbed,
money amounts in strict mode), so this module only selects and bounds it.

A section is a markdown heading (any level) and the lines up to the next heading of the same or a
higher level. Headings are matched case- and accent-insensitively by keywords (Polish and English):
the template headings ``Zasady wejścia i wyjścia`` and ``Czego unikam`` match, and an owner's own
``Przekonania`` / ``W co wierzę`` / ``Filozofia`` / ``Beliefs`` match ``beliefs``.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

SECTION_MAX = 1500
"""Characters kept per section (longer text is cut at a line end with ``...``)."""

_KEYWORDS: dict[str, tuple[str, ...]] = {
    "beliefs": (
        "przekonan",
        "wierze",
        "filozof",
        "podejscie",
        "teza inwestycyjna",
        "belief",
        "philosophy",
        "approach",
    ),
    "entry_exit": ("wejsci", "wyjsci", "entry", "exit", "kupuj", "sprzedaj"),
    "avoid": ("unikam", "unikac", "wyklucz", "czego nie", "avoid", "exclude"),
}
SECTION_KINDS = tuple(_KEYWORDS)
_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_FENCE = re.compile(r"^\s*(```|~~~)")


@dataclass(frozen=True, slots=True)
class StrategySection:
    kind: str  # beliefs | entry_exit | avoid
    heading: str
    text: str


def _fold(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.replace("ł", "l").replace("Ł", "L"))
    return "".join(c for c in text if not unicodedata.combining(c)).casefold()


def _kind(heading: str) -> str | None:
    folded = _fold(heading)
    for kind, words in _KEYWORDS.items():
        if any(w in folded for w in words):
            return kind
    return None


def _bounded(text: str) -> str:
    text = text.strip()
    if len(text) <= SECTION_MAX:
        return text
    cut = text[:SECTION_MAX]
    end = cut.rfind("\n")
    return (cut[:end] if end > SECTION_MAX // 2 else cut).rstrip() + "\n..."


def strategy_sections(markdown: str | None) -> list[StrategySection]:
    """The beliefs / entry-exit / avoid sections of ``markdown``, in file order (a kind may occur
    more than once; empty sections are skipped)."""
    if not markdown:
        return []
    lines = markdown.replace("\r\n", "\n").split("\n")
    headings: list[tuple[int, int, str]] = []  # (line index, level, title)
    fenced = False
    for i, line in enumerate(lines):
        if _FENCE.match(line):
            fenced = not fenced
            continue
        m = None if fenced else _HEADING.match(line)
        if m:
            headings.append((i, len(m.group(1)), m.group(2).strip()))
    out: list[StrategySection] = []
    covered_until = -1  # a heading inside a selected section is part of its text
    for n, (index, level, title) in enumerate(headings):
        kind = _kind(title)
        if kind is None or index < covered_until:
            continue
        end = len(lines)
        for later_index, later_level, _ in headings[n + 1 :]:
            if later_level <= level:
                end = later_index
                break
        covered_until = end
        body = _bounded("\n".join(lines[index + 1 : end]))
        if body:
            out.append(StrategySection(kind, title[:120], body))
    return out
