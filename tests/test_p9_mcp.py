"""P9 over MCP: ``add_research_note`` with ``details.brief``, ``research_notes`` returning it,
``research_context`` segments (``briefs``, ``thesis``) and macro cards (``brief``, ``plain``) identical in
strict and amounts mode, ``upsert_topic_thesis`` (draft only, never over the owner's thesis, macro keys
refused) and the ``full_refresh`` run scope. Synthetic profile only."""

from __future__ import annotations

import pytest
from mcp_support import TODAY, seed_profile

from cashu.core.db import get_session
from cashu.core.mcp.registry import all_tools
from cashu.core.mcp.server import CashuMcp
from cashu.core.models import Profile
from cashu.modules.investments.research import topic_theses

TOPIC_BRIEF = {
    "headline": "Według nowych badań ludzie grają więcej",
    "why": "Raporty branżowe pokazują dłuższy czas gry na telefonach i konsolach.",
}
MACRO_BRIEF = {
    "headline": "Trwa hossa na giełdach",
    "why": "Spółki zarabiają coraz więcej, a firmy dużo wydają na sztuczną inteligencję.",
    "supports": ["Banki centralne obniżają stopy", "Zyski spółek rosną"],
    "risks": ["Wyceny są wysoko", "Wzrosty opierają się na kilku wielkich spółkach"],
}


@pytest.fixture
def host(db_engine):
    pid, _slug = seed_profile()
    return pid, CashuMcp(pid, today=TODAY)


def _privacy(pid: int, level: str) -> None:
    with get_session() as s:
        p = s.get(Profile, pid)
        p.mcp_privacy = level
        s.add(p)


def note(n: int, segment: str, brief: dict, **changes) -> dict:
    return {
        "kind": "trend" if not segment.startswith("macro_") else "macro",
        "polarity": "positive",
        "strength": 2,
        "segment": segment,
        "title": brief["headline"],
        "summary": brief["why"],
        "sources": [
            {
                "url": f"https://example.com/p9mcp/{n}",
                "publisher": "Example News",
                "published_at": TODAY.isoformat(),
            }
        ],
        "details": {
            "brief": brief,
        },
        "expires_in_days": 60,
        **changes,
    }


def test_briefs_and_topic_thesis_reach_the_context_the_same_in_both_modes(host):
    pid, mcp = host
    games = mcp.call("add_research_note", note(1, "games_media", TOPIC_BRIEF))
    assert games.ok, games.error
    macro = mcp.call("add_research_note", note(2, "macro_risk", MACRO_BRIEF))
    assert macro.ok, macro.error
    drafted = mcp.call(
        "upsert_topic_thesis",
        {
            "segment": "games_media",
            "thesis": "Ludzie grają coraz więcej.",
            "invalidation": "Spadek",
        },
    )
    assert drafted.ok and drafted.data["created"] and drafted.data["draft"]

    contexts = {}
    for level in ("strict", "amounts"):
        _privacy(pid, level)
        result = mcp.call("research_context", {})
        assert result.ok, result.error
        contexts[level] = result.data
    assert contexts["strict"]["segments"] == contexts["amounts"]["segments"]
    assert contexts["strict"]["macro"] == contexts["amounts"]["macro"]

    rows = {r["segment"]: r for r in contexts["strict"]["segments"]}
    row = rows["games_media"]
    assert [b["headline"] for b in row["briefs"]] == [TOPIC_BRIEF["headline"]]
    assert set(row["briefs"][0]) == {
        "note_id",
        "headline",
        "why",
        "observed_at",
        "kind",
        "polarity",
    }
    assert row["thesis"]["text"] == "Ludzie grają coraz więcej."
    assert (row["thesis"]["draft"], row["thesis"]["created_by"]) == (True, "agent")
    assert set(row["thesis"]) == {
        "text",
        "invalidation",
        "assessment",
        "outlook",
        "view_updated_at",
        "view_sources",
        "draft",
        "created_by",
        "updated_at",
    }
    cards = {c["key"]: c for c in contexts["strict"]["macro"]}
    assert cards["risk"]["brief"]["headline"] == MACRO_BRIEF["headline"]
    assert cards["risk"]["brief"]["risks"] == MACRO_BRIEF["risks"]
    assert all(isinstance(c["plain"], str) and c["plain"] for c in cards.values())
    assert cards["dollar"]["brief"] is None
    limits = contexts["strict"]["limits"]
    assert (limits["brief_headline_max"], limits["brief_why_max"]) == (80, 280)
    assert limits["near_duplicate_days"] == 60

    listed = mcp.call("research_notes", {"segment": "macro_risk"}).data["notes"]
    assert listed[0]["details"]["brief"]["supports"] == MACRO_BRIEF["supports"]


def test_a_brief_with_a_forecast_is_refused(host):
    _pid, mcp = host
    bad = {**TOPIC_BRIEF, "headline": "Branża gier będzie rosła"}
    refused = mcp.call("add_research_note", note(3, "games_media", bad))
    assert not refused.ok and "details.brief.headline" in refused.error


def test_upsert_topic_thesis_never_overwrites_the_owner(host):
    pid, mcp = host
    tools = {t.name: t for t in all_tools().values()}
    assert tools["upsert_topic_thesis"].write is True
    with get_session() as s:
        topic_theses.save_owner(s, pid, "crypto", "Teza właściciela o krypto.")
    refused = mcp.call("upsert_topic_thesis", {"segment": "crypto", "thesis": "Teza agenta."})
    assert not refused.ok and refused.error_kind == "conflict"
    assert "never overwrite" in refused.error
    with get_session() as s:
        assert topic_theses.get(s, pid, "crypto").thesis == "Teza właściciela o krypto."
    macro = mcp.call("upsert_topic_thesis", {"segment": "macro_risk", "thesis": "Teza."})
    assert not macro.ok
    updated = mcp.call("upsert_topic_thesis", {"segment": "gold", "thesis": "Szkic o złocie."})
    again = mcp.call("upsert_topic_thesis", {"segment": "gold", "thesis": "Szkic o złocie 2."})
    assert updated.data["created"] and not again.data["created"] and again.data["draft"]


def test_full_refresh_run_scope(host):
    _pid, mcp = host
    started = mcp.call("start_research_run", {"scope": {"full_refresh": True}})
    assert started.ok, started.error
    assert started.data["scope"]["full_refresh"] is True and started.data["scope"]["held"]
    finished = mcp.call("finish_research_run", {"run_id": started.data["run_id"]})
    assert finished.ok
    last = mcp.call("research_context", {}).data["last_run"]
    assert last["full_refresh"] is True


def test_a_deleted_draft_shows_as_a_cooldown_and_is_refused(host):
    pid, mcp = host
    assert mcp.call("upsert_topic_thesis", {"segment": "energy", "thesis": "Szkic o ropie."}).ok
    with get_session() as s:
        assert topic_theses.delete(s, pid, "energy")
    context = mcp.call("research_context", {}).data
    (cooldown,) = context["topic_thesis_cooldown"]
    assert cooldown["segment"] == "energy" and cooldown["until"]
    refused = mcp.call("upsert_topic_thesis", {"segment": "energy", "thesis": "Szkic o ropie 2."})
    assert not refused.ok and refused.error_kind == "conflict"
    assert "deleted the thesis on energy" in refused.error


def test_full_refresh_is_refused_for_a_scheduled_run(host):
    _pid, mcp = host
    refused = mcp.call("start_research_run", {"scope": {"full_refresh": True, "scheduled": True}})
    assert not refused.ok and "scope.full_refresh" in refused.error
