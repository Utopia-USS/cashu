"""Macro regimes over MCP (P6): ``research_context.macro`` (the five cards with metrics as text, stale,
missing, last note) and ``macro_catalog``, identical in strict and amounts mode; macro notes through
``add_research_note`` (P5 segment-note rules), the ``research_notes`` filter and the run scope;
``set_instrument_segment`` refuses macro keys with its own message. Synthetic profile only."""

from __future__ import annotations

import datetime as dt
import json

import pytest
from mcp_support import TODAY, seed_profile

from cashu.core.db import get_session
from cashu.core.mcp.registry import all_tools
from cashu.core.mcp.server import CashuMcp
from cashu.core.models import Profile, utcnow
from cashu.modules.investments.macro import service as macro_service
from cashu.modules.investments.research.segments import MACRO_KEYS, NOT_INSTRUMENT_SEGMENT
from cashu.modules.investments.store import macro as macro_store


def seed_macro() -> list[dt.date]:
    days, day = [], TODAY - dt.timedelta(days=800)
    while day <= TODAY:
        if day.weekday() < 5:
            days.append(day)
        day += dt.timedelta(days=1)
    n = len(days)
    shapes = {
        "acwi": [100 + 0.05 * i for i in range(n)],
        "dxy": [100.0] * n,
        "eem": [(100 + 0.05 * i) / 2 for i in range(n)],
        "us10y": [4.2] * (n - 30) + [4.7] * 30,
        "us3m": [4.9] * n,  # inverted curve
    }
    with get_session() as s:
        for key, values in shapes.items():
            macro_store.upsert(
                s, key, [(d, f"{v:.4f}") for d, v in zip(days, values)], source="t", now=utcnow()
            )
    return days


def source(n: int) -> list[dict]:
    return [
        {
            "url": f"https://example.com/p6/{n}",
            "publisher": "Example Treasury",
            "published_at": TODAY.isoformat(),
        }
    ]


def macro_note(n: int = 1, segment: str = "macro_rates", **extra) -> dict:
    return {
        "kind": "macro",
        "polarity": "neutral",
        "strength": 1,
        "segment": segment,
        "title": f"Rentowności USA w górę {n}",
        "summary": "Rentowność 10-letnich obligacji USA wzrosła w kwartale o 50 pb (dane Treasury).",
        "sources": source(n),
        **extra,
    }


@pytest.fixture
def host(db_engine):
    macro_service.clear_cache()
    pid, _slug = seed_profile()
    days = seed_macro()
    return pid, days, CashuMcp(pid, today=TODAY)


def _privacy(pid: int, level: str) -> None:
    with get_session() as s:
        p = s.get(Profile, pid)
        p.mcp_privacy = level
        s.add(p)


def test_schemas_list_macro_keys_for_notes_only():
    tools = all_tools()
    note_enum = tools["add_research_note"].input_schema["properties"]["segment"]["enum"]
    assert set(MACRO_KEYS) <= set(note_enum)
    assert (
        "macro_rates (Obligacje i stopy)"
        in (tools["add_research_note"].input_schema["properties"]["segment"]["description"])
    )
    assert set(MACRO_KEYS) <= set(
        tools["research_notes"].input_schema["properties"]["segment"]["enum"]
    )
    segment_enum = tools["set_instrument_segment"].input_schema["properties"]["segment"]["enum"]
    assert not set(MACRO_KEYS) & set(segment_enum)
    assert "refused_values" not in json.dumps(tools["set_instrument_segment"].input_schema)
    assert "macro" in tools["research_context"].description


def test_research_context_macro(host):
    _pid, days, mcp = host
    context = mcp.call("research_context", {}).data
    assert [c["segment"] for c in context["macro_catalog"]] == list(MACRO_KEYS)
    assert context["macro_catalog"][0]["label"] == "Rynek akcji"
    cards = {c["key"]: c for c in context["macro"]}
    assert list(cards) == ["risk", "dollar", "em", "commodities", "rates"]
    assert set(cards["rates"]) == {
        "key",
        "note_key",
        "label",
        "state",
        "state_label",
        "since",
        "since_open",
        "since_min",
        "as_of",
        "metrics",
        "stale",
        "missing",
        "last_note_at",
        "note_this_week",
    }
    rates = cards["rates"]
    assert rates["note_key"] == "macro_rates" and rates["state"] == "rising"
    assert rates["state_label"] == "rentowności rosną · krzywa odwrócona"
    assert rates["since"] == days[-30].isoformat() and rates["stale"] is False
    assert rates["metrics"] == [
        {"label": "USA 10 lat", "text": "4,70 %"},
        {"label": "3 mies. zmiana", "text": "+50 bp"},
        {"label": "krzywa 10l-3m", "text": "-33 bp"},  # 4,70 % - 5,03 % (bond-equivalent of 4,9 %)
    ]
    assert rates["since_open"] is False and rates["since_min"] is None
    assert cards["risk"]["state_label"] == "hossa" and cards["risk"]["since"] is None
    assert cards["risk"]["since_open"] is True and cards["risk"]["since_min"] is not None
    assert cards["commodities"]["missing"] is True and cards["commodities"]["metrics"] == []
    assert rates["last_note_at"] is None and rates["note_this_week"] is False


def test_macro_notes_scope_and_filter(host):
    _pid, _days, mcp = host
    run = mcp.call("start_research_run", {"scope": {"segments": ["macro_rates", "macro_dollar"]}})
    assert run.ok, run.error
    assert run.data["scope"]["segments"] == ["macro_rates", "macro_dollar"]
    assert run.data["scope"]["held"] is False
    added = mcp.call("add_research_note", macro_note(1))
    assert added.ok, added.error
    assert added.data["segment"] == "macro_rates" and added.data["instrument_id"] is None
    again = mcp.call("add_research_note", macro_note(2))
    assert again.error_kind == "conflict" and "already has a note this week" in again.error
    with_instrument = mcp.call("add_research_note", macro_note(3, "macro_em", instrument="PKO"))
    assert not with_instrument.ok
    earnings = mcp.call("add_research_note", macro_note(4, "macro_em", kind="earnings"))
    assert not earnings.ok and "segment note is one of" in earnings.error
    listed = mcp.call("research_notes", {"segment": "macro_rates"}).data["notes"]
    assert [n["segment"] for n in listed] == ["macro_rates"]
    assert listed[0]["segment_label"] == "Obligacje i stopy"
    rates = mcp.call("research_context", {}).data["macro"][4]
    assert rates["note_this_week"] is True and rates["last_note_at"] is not None
    # never a market segment row
    segments = mcp.call("research_context", {}).data["segments"]
    assert all(not r["segment"].startswith("macro_") for r in segments)


def test_set_instrument_segment_refuses_macro_keys(host):
    _pid, _days, mcp = host
    refused = mcp.call("set_instrument_segment", {"instrument": "PKO", "segment": "macro_rates"})
    assert refused.error_kind == "invalid_arguments" and refused.error == NOT_INSTRUMENT_SEGMENT


def test_macro_is_the_same_in_strict_and_amounts_mode(host):
    pid, _days, mcp = host
    assert mcp.call("add_research_note", macro_note(1, "macro_dollar")).ok

    def macro_parts() -> str:
        context = mcp.call("research_context", {}).data
        return json.dumps(
            [context["macro"], context["macro_catalog"]], ensure_ascii=False, sort_keys=True
        )

    strict = macro_parts()
    assert "4,70 %" in strict and "100,0" in strict
    _privacy(pid, "amounts")
    assert macro_parts() == strict


def test_market_label_is_never_scrubbed_as_an_amount():
    from cashu.core.mcp import labels as L
    from cashu.core.mcp.redaction import Redactor

    tree = {"a": L.market("USA 10 lat"), "b": L.market("98,4"), "c": L.text("98,4")}
    assert Redactor("strict").apply(tree) == {"a": "USA 10 lat", "b": "98,4", "c": "[amount]"}
    assert Redactor("amounts").apply(tree) == {"a": "USA 10 lat", "b": "98,4", "c": "98,4"}
    for ok in ("+4,1 %", "-6,2 pp", "+45 bp", "0 bp", "4,23 %", "+1 234 bp", "-0,05 %"):
        assert L.market_ok(ok), ok


@pytest.mark.parametrize(
    "value",
    [
        "12 400 zł",
        "PL61109010140000071219812874",
        "1234567",
        "Jan Kowalski",
        "4,2 EUR",
        "USA 10 lat i coś",
        "x" * 50,
    ],
)
def test_market_label_refuses_anything_but_metric_labels_and_numbers(value):
    from cashu.core.mcp import labels as L
    from cashu.core.mcp.redaction import Redactor, UnlabelledValue

    with pytest.raises(ValueError):
        L.market(value)
    with pytest.raises(UnlabelledValue):  # built by hand: the redactor fails closed too
        Redactor("strict").apply({"x": L.Labelled(value, L.Sensitivity.MARKET)})


def test_market_labels_match_the_regime_metric_labels():
    from cashu.core.mcp import labels as L
    from cashu.modules.investments.macro import regimes

    assert L.MARKET_LABELS == regimes.METRIC_LABELS


def test_only_the_research_tools_use_the_market_label():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "src" / "cashu"
    users = sorted(
        str(p.relative_to(root)) for p in root.rglob("*.py") if "L.market(" in p.read_text()
    )
    assert users == ["core/mcp/tools/research.py"]
