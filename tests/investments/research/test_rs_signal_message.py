"""Research signal messages are Polish (F7-INT I3): the plural of sources, the note kind and thesis
relation labels (the dashboard's, frontend ``v2/research/logic.ts``), and the message shape."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from cashu.core import i18n
from cashu.modules.investments.models import RESEARCH_NOTE_KINDS
from cashu.modules.investments.research.signals import (
    KIND_LABEL,
    KIND_LABEL_EN,
    RELATION_LABEL,
    RELATION_LABEL_EN,
    research_message,
    sources_phrase,
)

FRONTEND_LOGIC = (
    Path(__file__).resolve().parents[3]
    / "frontend/src/modules/investments/v2/research/logic.strings.ts"
)


@pytest.mark.parametrize(
    ("count", "text"),
    [
        (0, "0 źródeł"),
        (1, "1 źródło"),
        (2, "2 źródła"),
        (4, "4 źródła"),
        (5, "5 źródeł"),
        (11, "11 źródeł"),
        (12, "12 źródeł"),
        (14, "14 źródeł"),
        (21, "21 źródeł"),
        (22, "22 źródła"),
        (112, "112 źródeł"),
        (124, "124 źródła"),
    ],
)
def test_sources_plural(count, text):
    assert sources_phrase(count) == text


def test_message_shape_with_kind_and_relation_labels():
    assert research_message("news", "invalidates", "Premiera przesunięta", 3, 2) == (
        "Analiza (wiadomość, podważa tezę): Premiera przesunięta; siła 3/3, 2 źródła"
    )
    assert research_message("earnings", "weakens", "Słabszy kwartał", 2, 1) == (
        "Analiza (wyniki, osłabia tezę): Słabszy kwartał; siła 2/3, 1 źródło"
    )
    assert research_message("community", "supports", "Forum o bankach", 3, 5) == (
        "Analiza (społeczność · szum, wzmacnia tezę): Forum o bankach; siła 3/3, 5 źródeł"
    )


def test_neutral_or_no_relation_and_unknown_kind():
    assert research_message("macro", "neutral", "Stopy w górę", 3, 1) == (
        "Analiza (makro): Stopy w górę; siła 3/3, 1 źródło"
    )
    assert research_message("trend", "none", "Miedź", 3, 3) == (
        "Analiza (trend): Miedź; siła 3/3, 3 źródła"
    )
    assert research_message("trend", None, "Miedź", 3, 3).startswith("Analiza (trend): ")
    assert research_message("other", "weakens", "X", 3, 1).startswith(
        "Analiza (other, osłabia tezę)"
    )


def test_every_note_kind_has_a_label():
    assert set(KIND_LABEL) == set(RESEARCH_NOTE_KINDS)


@pytest.mark.skipif(not FRONTEND_LOGIC.exists(), reason="frontend sources not present")
def test_labels_match_the_dashboard():
    source = FRONTEND_LOGIC.read_text(encoding="utf-8")

    def labels(name: str, lang: str) -> dict[str, str]:
        block = re.search(rf"export const {name}\b[^=]*=\s*catalog\(\{{(.*?)\}}\);", source, re.DOTALL)
        assert block, name
        return dict(
            re.findall(rf'(\w+):\s*\{{[^}}]*\b{lang}:\s*"([^"]*)"', block.group(1))
        )

    assert labels("KIND_LABEL", "pl") == KIND_LABEL
    assert labels("KIND_LABEL", "en") == KIND_LABEL_EN
    for lang, ours in (("pl", RELATION_LABEL), ("en", RELATION_LABEL_EN)):
        dashboard = labels("RELATION_LABEL", lang)
        assert {key: dashboard[key] for key in ours} == ours


def test_english_message():
    with i18n.use_language("en"):
        assert sources_phrase(1) == "1 source"
        assert sources_phrase(2) == "2 sources"
        assert research_message("news", "invalidates", "Guidance cut", 3, 2) == (
            "Analysis (news, invalidates the thesis): Guidance cut; strength 3/3, 2 sources"
        )
