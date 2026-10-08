"""Market segments over MCP (P5): ``set_instrument_segment`` (held / watched only, owner-named refused,
clearing), ``add_research_note`` with a segment (``theme`` is gone from the schema and refused),
``start_research_run`` scope segments, ``research_context`` segments / currency / unassigned /
segment catalog / position and watchlist segments / limits, ``research_notes`` segment filter, and
the same segment output in strict and amounts mode. Synthetic profile only."""

from __future__ import annotations

import json

import pytest
from mcp_support import CLAIM_SYMBOL, TODAY, seed_profile

from cashu.core.db import get_session
from cashu.core.mcp.registry import all_tools
from cashu.core.mcp.server import CashuMcp
from cashu.core.models import Profile


def source(n: int) -> list[dict]:
    return [
        {
            "url": f"https://example.com/p5/{n}",
            "publisher": "Example News",
            "published_at": TODAY.isoformat(),
        }
    ]


def segment_note(n: int = 1, segment: str = "equity_global", **extra) -> dict:
    return {
        "kind": "macro",
        "polarity": "positive",
        "strength": 2,
        "segment": segment,
        "title": f"Indeksy globalne wyzej {n}",
        "summary": "Szerokie indeksy akcji zakonczyly tydzien wyzej; EUNL rosnie z rynkiem.",
        "sources": source(n),
        **extra,
    }


@pytest.fixture
def host(db_engine):
    pid, slug = seed_profile()
    return pid, slug, CashuMcp(pid, today=TODAY)


def _privacy(pid: int, level: str) -> None:
    with get_session() as s:
        p = s.get(Profile, pid)
        p.mcp_privacy = level
        s.add(p)


def _position(context: dict, symbol: str) -> dict:
    return next(p for p in context["positions"] if p["symbol"] == symbol)


def test_schemas_drop_theme_and_list_segments():
    tools = all_tools()
    note_schema = tools["add_research_note"].input_schema["properties"]
    assert "theme" not in note_schema and len(note_schema["segment"]["enum"]) == 18 + 5  # P6 macro
    assert "Złoto i górnicy" in note_schema["segment"]["description"]
    assert tools["set_instrument_segment"].write is True
    schema = tools["set_instrument_segment"].input_schema
    assert schema["required"] == ["instrument", "segment"]
    assert schema["properties"]["segment"]["type"] == ["string", "null"]
    assert schema["properties"]["segment"]["enum"][-1] is None
    assert "segment" in tools["research_notes"].input_schema["properties"]


def test_set_instrument_segment(host):
    _pid, _slug, mcp = host
    context = mcp.call("research_context", {}).data
    eunl = _position(context, "EUNL")
    assert (eunl["segment"], eunl["segment_source"]) == ("equity_global", "auto")
    assert _position(context, "PKO")["segment"] is None
    done = mcp.call("set_instrument_segment", {"instrument": "PKO", "segment": "financials"})
    assert done.ok, done.error
    assert (done.data["segment"], done.data["segment_source"]) == ("financials", "agent")
    pko = _position(mcp.call("research_context", {}).data, "PKO")
    assert (pko["segment"], pko["segment_source"]) == ("financials", "agent")
    changed = mcp.call("set_instrument_segment", {"instrument": "PKO", "segment": "consumer"})
    assert changed.ok and changed.data["segment"] == "consumer"  # the agent may change its own
    forgot = mcp.call("set_instrument_segment", {"instrument": "PKO"})
    assert forgot.error_kind == "invalid_arguments" and "null clears it" in forgot.error
    cleared = mcp.call("set_instrument_segment", {"instrument": "PKO", "segment": None})
    assert cleared.ok and cleared.data["segment"] is None and cleared.data["segment_source"] is None
    assert mcp.call("add_to_watchlist", {"symbol_or_isin": "CDR.WA"}).ok
    watched = mcp.call("set_instrument_segment", {"instrument": "CDR.WA", "segment": "games_media"})
    assert watched.ok, watched.error
    cdr = next(
        w for w in mcp.call("research_context", {}).data["watchlist"] if w["symbol"] == "CDR"
    )
    assert (cdr["segment"], cdr["segment_source"]) == ("games_media", "agent")
    claim = mcp.call("set_instrument_segment", {"instrument": CLAIM_SYMBOL, "segment": "crypto"})
    assert not claim.ok and "owner-named" in claim.error
    unknown = mcp.call("set_instrument_segment", {"instrument": "PKO", "segment": "Gold"})
    assert not unknown.ok and unknown.error_kind == "invalid_arguments"
    missing = mcp.call("set_instrument_segment", {"instrument": "NOPE", "segment": "gold"})
    assert missing.error_kind == "not_found"


def test_the_agent_never_changes_the_owner_segment(host):
    pid, _slug, mcp = host
    from cashu.modules.investments.store import instruments as instrument_store

    pko = _position(mcp.call("research_context", {}).data, "PKO")["instrument_id"]
    with get_session() as s:
        instrument_store.set_segment(s, pko, "financials", profile_id=pid, by="owner")
    assert _position(mcp.call("research_context", {}).data, "PKO")["segment_source"] == "owner"
    for value in ("consumer", None):
        refused = mcp.call("set_instrument_segment", {"instrument": "PKO", "segment": value})
        assert refused.error_kind == "conflict"
        assert "the owner set this segment; leave it" in refused.error
    same = mcp.call("set_instrument_segment", {"instrument": "PKO", "segment": "financials"})
    assert same.ok and same.data["segment_source"] == "owner"  # unchanged


def test_segment_notes_and_run_scope(host):
    _pid, _slug, mcp = host
    themed = mcp.call("start_research_run", {"scope": {"themes": ["Banki"]}})
    assert not themed.ok and "segments" in themed.error
    run = mcp.call(
        "start_research_run",
        {"scope": {"held": False, "watchlist": False, "candidates": False, "segments": ["gold"]}},
    )
    assert run.ok, run.error
    assert run.data["scope"]["segments"] == ["gold"] and "themes" not in run.data["scope"]
    added = mcp.call("add_research_note", segment_note(1, "gold"))
    assert added.ok, added.error
    assert added.data["segment"] == "gold" and added.data["instrument_id"] is None
    again = mcp.call("add_research_note", segment_note(2, "gold"))
    assert again.error_kind == "conflict" and "already has a note this week" in again.error
    both = mcp.call("add_research_note", segment_note(3, "crypto", instrument="PKO"))
    assert not both.ok and "segment note is about the market segment only" in both.error
    themed_note = mcp.call("add_research_note", {**segment_note(4), "theme": "Banki"})
    assert themed_note.error_kind == "invalid_arguments" and "segment" in themed_note.error
    long = mcp.call("add_research_note", segment_note(5, "crypto", summary="x" * 401))
    assert not long.ok and "max 400" in long.error
    finished = mcp.call(
        "finish_research_run", {"run_id": run.data["run_id"], "counts": {"segments_covered": 1}}
    )
    assert finished.ok and finished.data["counts"]["segments_covered"] == 1
    listed = mcp.call("research_notes", {"segment": "gold"}).data["notes"]
    assert [n["segment"] for n in listed] == ["gold"]
    assert listed[0]["segment_label"] == "Złoto i górnicy"
    assert mcp.call("research_notes", {"segment": "crypto"}).data["notes"] == []


def test_research_context_segments(host):
    _pid, _slug, mcp = host
    assert mcp.call("add_research_note", segment_note(1, "uranium")).ok
    context = mcp.call("research_context", {}).data
    assert "themes" not in context
    assert len(context["segment_catalog"]) == 18
    assert context["segment_catalog"][4] == {
        "segment": "gold",
        "label": "Złoto i górnicy",
        "group": "asset",
    }
    rows = {r["segment"]: r for r in context["segments"]}
    world = rows["equity_global"]
    (eunl,) = world["instruments"]
    assert eunl["symbol"] == "EUNL" and world["weight"] > 0
    assert set(eunl) == {"symbol", "return_1w", "contribution_1w"}
    assert eunl["contribution_1w"] == world["contribution_1w"]
    assert {"contribution_1w", "return_1w", "contribution_4w", "last_note_at"} <= set(world)
    uranium = rows["uranium"]
    assert uranium["weight"] == 0 and uranium["note_this_week"] is True
    assert set(context["currency"]) == {"contribution_1w", "contribution_4w"}
    unassigned = context["unassigned"]
    assert unassigned is not None and "PKO" in unassigned["symbols"]
    assert CLAIM_SYMBOL not in json.dumps(context, ensure_ascii=False)
    limits = context["limits"]
    assert (limits["weekly_instruments_max"], limits["weekly_notes_per_instrument"]) == (6, 2)
    assert (limits["segment_notes_per_week"], limits["segment_summary_max"]) == (1, 400)


def test_segment_output_is_the_same_in_strict_and_amounts_mode(host):
    pid, _slug, mcp = host
    assert mcp.call("add_research_note", segment_note(1, "gold")).ok

    def segment_parts() -> str:
        context = mcp.call("research_context", {}).data
        return json.dumps(
            [
                context["segments"],
                context["currency"],
                context["unassigned"],
                context["segment_catalog"],
                [(p["symbol"], p["segment"], p["segment_source"]) for p in context["positions"]],
            ],
            ensure_ascii=False,
            sort_keys=True,
        )

    strict = segment_parts()
    _privacy(pid, "amounts")
    assert segment_parts() == strict


def test_research_context_segments_are_the_union_of_both_windows(host, monkeypatch):
    _pid, _slug, mcp = host
    from cashu.modules.investments.research import segment_service

    def row(key: str, contribution: float, instruments: list[dict]) -> dict:
        return {
            "segment": key,
            "label": key,
            "weight": 0.1,
            "contribution": contribution,
            "return": 0.02,
            "instruments": instruments,
            "last_note_at": None,
            "note_this_week": False,
        }

    eunl = {"instrument_id": 999999, "label": "EUNL", "return": 0.02, "contribution": 0.002}
    views = {
        "1w": {
            "segments": [row("equity_global", 0.002, [eunl])],
            "currency": {"contribution": 0.0},
            "unassigned": None,
        },
        "4w": {
            "segments": [row("equity_global", 0.004, [eunl]), row("gold", -0.01, [])],
            "currency": {"contribution": -0.001},
            "unassigned": None,
        },
    }
    monkeypatch.setattr(
        segment_service, "segments_view", lambda s, p, *, window, **kw: views[window]
    )
    rows = mcp.call("research_context", {}).data["segments"]
    assert [r["segment"] for r in rows] == ["equity_global", "gold"]
    gold = rows[1]
    assert (gold["weight"], gold["contribution_1w"], gold["return_1w"]) == (0.0, 0.0, None)
    assert gold["contribution_4w"] == -0.01 and gold["instruments"] == []
    assert rows[0]["contribution_4w"] == 0.004
