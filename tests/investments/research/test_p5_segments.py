"""Market segments (P5), pure parts: the catalog, the automatic assignment (asset class, stablecoins,
the fund table with exchange suffixes), precedence of the profile's own value, segment-note
validation (kinds, relation, 400-character summary, no candidate / theme), the run scope's segments
and the signal dedup key. Synthetic input only."""

from __future__ import annotations

import datetime as dt
import re

import pytest

from cashu.modules.investments.domain import AssetClass, Instrument, InstrumentAlias
from cashu.modules.investments.research import keys
from cashu.modules.investments.research.segments import (
    FUND_SEGMENTS,
    SEGMENT_KEYS,
    SEGMENTS,
    UNASSIGNED,
    auto_segment,
    bare_symbol,
    catalog,
    catalog_order,
    is_segment,
    segment_label,
    segment_of,
)
from cashu.modules.investments.research.validation import (
    SEGMENT_ONLY,
    SEGMENT_SUMMARY_MAX,
    ResearchInputError,
    validate_counts,
    validate_note,
    validate_scope,
)

NOW = dt.datetime(2026, 10, 8, 12, tzinfo=dt.UTC)


def inst(symbol: str | None, asset_class: AssetClass = AssetClass.ETF, aliases=()) -> Instrument:
    return Instrument(
        id="1",
        name="Example fund",
        currency="USD",
        asset_class=asset_class,
        symbol=symbol,
        aliases=tuple(aliases),
    )


def test_catalog_integrity():
    assert len(SEGMENTS) == 18 and len(set(SEGMENT_KEYS)) == 18
    assert SEGMENT_KEYS[0] == "equity_global" and SEGMENT_KEYS[-1] == "quantum"
    assert all(re.fullmatch(r"[a-z_]+", k) for k in SEGMENT_KEYS)
    assert {s.group for s in SEGMENTS} == {"asset", "sector"}
    assert all(s.label and s.label.strip() == s.label for s in SEGMENTS)
    assert UNASSIGNED not in SEGMENT_KEYS
    assert set(FUND_SEGMENTS.values()) <= set(SEGMENT_KEYS)
    assert segment_label("gold") == "Złoto i górnicy"
    assert segment_label(UNASSIGNED) == "Bez tematu"
    assert is_segment("semis_ai") and not is_segment("Gold") and not is_segment(None)
    assert catalog_order("equity_global") == 0 and catalog_order("nope") == len(SEGMENTS)
    assert catalog()[3] == {"segment": "bonds", "label": "Obligacje i stopy", "group": "asset"}


@pytest.mark.parametrize(
    ("symbol", "expected"),
    [
        ("GDXJ", "gdxj"),
        ("GDXJ.L", "gdxj"),
        ("gdxj.us", "gdxj"),
        ("XETR:SXR8", "sxr8"),
        (" vwce.de ", "vwce"),
        (None, ""),
    ],
)
def test_bare_symbol(symbol, expected):
    assert bare_symbol(symbol) == expected.upper()


def test_auto_segment_table_with_suffixes():
    assert auto_segment(inst("GDXJ")) == "gold"
    assert auto_segment(inst("GDXJ.L")) == "gold"
    assert auto_segment(inst("URNM")) == "power"
    assert auto_segment(inst("SXR8.DE")) == "equity_global"
    assert auto_segment(inst("EIMI.L")) == "equity_em"
    assert auto_segment(inst("SMH")) == "semis_ai"
    assert auto_segment(inst("COPX")) == "metals"
    assert auto_segment(inst("XLE")) == "energy"
    assert auto_segment(inst("IPRP.L")) == "real_estate"
    assert auto_segment(inst("TLT")) == "bonds"
    assert auto_segment(inst("CDR", AssetClass.EQUITY)) is None
    # no display symbol: the price alias decides
    assert auto_segment(inst(None, aliases=[InstrumentAlias("yahoo", "SIL")])) == "gold"
    assert auto_segment(inst("XYZ", aliases=[InstrumentAlias("xtb", "GDX.US")])) is None


def test_auto_segment_by_asset_class_and_stablecoins():
    assert auto_segment(inst("EDO0336", AssetClass.TREASURY_BOND)) == "bonds"
    assert auto_segment(inst("CORP", AssetClass.BOND)) == "bonds"
    assert auto_segment(inst("BTC", AssetClass.CRYPTO)) == "crypto"
    assert auto_segment(inst("ETH-USD", AssetClass.CRYPTO)) == "crypto"
    for coin in ("USDC", "usdt", "DAI", "EURC", "FDUSD", "PYUSD", "USDT-USD"):
        assert auto_segment(inst(coin, AssetClass.CRYPTO)) is None, coin
    assert auto_segment(inst(None, AssetClass.CRYPTO)) == "crypto"


def test_precedence_set_over_auto_over_none():
    gold = inst("GDXJ")
    assert segment_of(gold, None) == ("gold", "auto")
    assert segment_of(gold, "metals") == ("metals", "owner")  # unknown setter: the owner
    assert segment_of(gold, "metals", "agent") == ("metals", "agent")
    assert segment_of(gold, "metals", "owner") == ("metals", "owner")
    assert segment_of(inst("CDR", AssetClass.EQUITY), None) == (None, None)
    assert segment_of(inst("CDR", AssetClass.EQUITY), "games_media", "agent") == (
        "games_media",
        "agent",
    )
    # a value dropped from the catalog is ignored
    assert segment_of(gold, "old_key") == ("gold", "auto")


def raw(**changes) -> dict:
    data = {
        "kind": "macro",
        "polarity": "negative",
        "strength": 2,
        "segment": "gold",
        "title": "Zloto tanieje po danych z USA",
        "summary": "Przykladowe dane: cena zlota spadla w tygodniu; GDXJ -4,4 %.",
        "sources": [
            {
                "url": "https://example.com/gold/1",
                "publisher": "Example News",
                "published_at": "2026-10-07",
            }
        ],
    }
    data.update(changes)
    return {k: v for k, v in data.items() if v is not None}


def problems(**changes) -> str:
    with pytest.raises(ResearchInputError) as e:
        validate_note(raw(**changes), now=NOW)
    return str(e.value)


def test_segment_note_validation():
    ok = validate_note(raw(), now=NOW)
    assert ok.segment == "gold" and ok.theme is None
    for kind in ("trend", "news"):
        assert validate_note(raw(kind=kind), now=NOW).kind == kind
    assert "segment: must be one of" in problems(segment="Gold")
    assert "a segment note is one of: macro, trend, news" in problems(kind="earnings")
    assert "kind: a segment note" in problems(kind="community", details={"scale": "small"})
    assert "a segment note has no thesis" in problems(thesis_relation="supports")
    assert SEGMENT_ONLY in problems(candidate={"symbol_or_isin": "GDXJ.US"})
    assert "segment note has no theme" in problems(theme="Zloto")
    long = "x" * (SEGMENT_SUMMARY_MAX + 1)
    assert "too long for a segment note (max 400" in problems(summary=long)
    assert validate_note(raw(summary="x" * SEGMENT_SUMMARY_MAX), now=NOW).segment == "gold"
    # an instrument note keeps the general limit
    assert validate_note(raw(segment=None, summary=long), now=NOW).segment is None


def test_scope_segments_and_counts():
    scope = validate_scope({"held": False, "segments": ["gold", "gold", "crypto"]})
    assert scope.segments == ("gold", "crypto") and scope.held is False
    with pytest.raises(ResearchInputError, match=r"scope.segments\[0\]"):
        validate_scope({"segments": ["Złoto"]})
    with pytest.raises(ResearchInputError, match="scope.segments"):
        validate_scope({"segments": "gold"})
    assert validate_counts({"segments_covered": 4, "themes_covered": 1}) == {
        "segments_covered": 4,
        "themes_covered": 1,
    }


def test_signal_dedup_key_scopes():
    week = "2026-W41"
    assert keys.research_dedup_key(week, segment="gold") == "research:2026-W41|s:gold"
    assert keys.research_dedup_key(week, instrument_id=3, segment="gold") == (
        "research:2026-W41|i:3"
    )
    assert keys.research_dedup_key(week, theme="energia") == "research:2026-W41|t:energia"
