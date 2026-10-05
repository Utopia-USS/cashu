"""strategy.md sections for research (beliefs, entry / exit rules, what the owner avoids): heading
keywords in Polish and English, nested headings stay inside their section, code fences are not
headings, long sections are bounded. Synthetic markdown only."""

from __future__ import annotations

from finanse.modules.investments.research.strategy_text import SECTION_MAX, strategy_sections
from finanse.modules.investments.templates import strategy_template


def test_template_sections():
    sections = strategy_sections(strategy_template("passive_etf").markdown)
    assert [s.kind for s in sections] == ["entry_exit", "avoid"]
    assert sections[1].heading == "Czego unikam"


def test_keywords_nesting_fences_and_bounds():
    md = "\n".join(
        [
            "# Strategia",
            "## Cel",
            "Emerytura.",
            "## Moje przekonania",
            "Rynek rosnie dlugoterminowo.",
            "### Szczegoly",
            "Nadal przekonania.",
            "## Entry and exit rules",
            "```",
            "# not a heading",
            "```",
            "Buy on dips.",
            "## Czego unikam",
            "",
            "## Wykluczenia",
            "x" * (SECTION_MAX + 500),
            "## Notatki",
            "Koniec.",
        ]
    )
    sections = strategy_sections(md)
    assert [(s.kind, s.heading) for s in sections] == [
        ("beliefs", "Moje przekonania"),
        ("entry_exit", "Entry and exit rules"),
        ("avoid", "Wykluczenia"),
    ]  # the empty "Czego unikam" is skipped
    assert "### Szczegoly" in sections[0].text and "Nadal" in sections[0].text
    assert "# not a heading" in sections[1].text
    assert len(sections[2].text) <= SECTION_MAX + 4 and sections[2].text.endswith("...")
    assert all("Emerytura" not in s.text and "Koniec" not in s.text for s in sections)
    assert strategy_sections(None) == [] and strategy_sections("") == []
