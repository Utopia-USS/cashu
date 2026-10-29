"""The review deck's agenda reaches the research agent: ``research_context.owner_review`` carries the
owner's last investments review (note + the cards sent to the agent with their notes). Synthetic only."""

from __future__ import annotations

from mcp_support import TODAY, seed_profile

from cashu.core import reviews
from cashu.core.db import get_session
from cashu.core.mcp.server import CashuMcp


def test_owner_review_agenda_reaches_the_agent(db_engine):
    pid, _slug = seed_profile(run_daily=False)
    mcp = CashuMcp(pid, today=TODAY)
    assert mcp.call("research_context", {}).data["owner_review"] is None

    with get_session() as s:
        reviews.mark_done(
            s,
            pid,
            "investments",
            notes="Spokojny tydzień",
            stats={
                "deck": {
                    "cards": [{"id": "world", "verdict": "flag"}],
                    "agenda": [
                        {"card": "world", "title": "Czy świat się wali", "note": "sprawdź spółki chmurowe"},
                        {"card": "sectors", "title": "Sektory", "note": None},
                        "garbage",
                    ],
                }
            },
        )

    review = mcp.call("research_context", {}).data["owner_review"]
    assert review["notes"] == "Spokojny tydzień"
    assert review["agenda"] == [
        {"card": "world", "title": "Czy świat się wali", "note": "sprawdź spółki chmurowe"},
        {"card": "sectors", "title": "Sektory", "note": None},
    ]


def test_review_context_and_a_chat_review_with_an_agenda(db_engine):
    pid, _slug = seed_profile(run_daily=False)
    mcp = CashuMcp(pid, today=TODAY)
    context = mcp.call("review_context", {}).data
    review = context["review"]
    assert review["name"] == "Przegląd tygodnia" and review["every"] == "week"
    assert review["cards"] == ["world", "sectors", "positions", "events", "decide", "ideas", "calendar"]
    assert review["due"] is True and context["last_review"] is None
    assert context["calendar"]["stale"] is True  # tests never fetch the public feeds
    assert set(context["card_sources"]) == set(review["cards"])

    done = mcp.call("mark_review_done", {"notes": "z czatu", "agenda": [{"card": "events", "note": "sprawdź Fed"}]}).data
    assert done["module"] == "investments"
    after = mcp.call("review_context", {}).data
    assert after["review"]["due"] is False
    assert after["last_review"]["agenda"] == [{"card": "events", "note": "sprawdź Fed"}]
    owner = mcp.call("research_context", {}).data["owner_review"]
    assert owner["agenda"] == [{"card": "events", "title": None, "note": "sprawdź Fed"}]


def test_a_note_carries_a_plain_headline(db_engine):
    pid, _slug = seed_profile(run_daily=False)
    mcp = CashuMcp(pid, today=TODAY)
    base = {
        "kind": "macro", "polarity": "neutral", "strength": 1, "segment": "macro_rates",
        "title": "Rentowności USA 10 lat 4,2 % (+30 pb w kwartale)",
        "summary": "Rentowność 10-letnich obligacji USA wzrosła w kwartale o 30 pb (dane Treasury).",
        "sources": [{"url": "https://example.com/rates", "publisher": "Example Treasury", "published_at": TODAY.isoformat()}],
    }
    ok = mcp.call("add_research_note", {**base, "details": {"headline": "Obligacje w USA płacą coraz więcej"}})
    assert ok.ok, ok.error
    notes = mcp.call("research_notes", {}).data["notes"]
    assert notes[0]["details"]["headline"] == "Obligacje w USA płacą coraz więcej"
    bad = mcp.call("add_research_note", {**base, "title": base["title"] + " 2", "details": {"headline": "Kupuj obligacje zanim stanieją"}})
    assert not bad.ok and "details.headline" in (bad.error or "")
