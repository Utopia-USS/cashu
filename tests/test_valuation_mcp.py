"""Topic valuation (P/E, forward P/E, expected earnings growth): a segment note's ``details.valuation``
written over MCP, validated, and shown on the topic row of the app and of ``research_context``."""

from __future__ import annotations

from mcp_support import TODAY, seed_profile

from cashu.core.db import get_session
from cashu.core.mcp.server import CashuMcp
from cashu.core.models import Profile
from cashu.modules.investments.research import segment_service


def _note(**details) -> dict:
    return {
        "kind": "trend", "polarity": "neutral", "strength": 2, "segment": "robotics",
        "title": "Robotyka: P/E 60, forward P/E 20 (indeks branżowy)",
        "summary": "Według dostawcy indeksu P/E spółek robotyki wynosi 60, a forward P/E 20 przy oczekiwanym wzroście zysków.",
        "sources": [{"url": "https://example.com/robotics-index", "publisher": "Example Index Provider", "published_at": TODAY.isoformat()}],
        "details": details,
    }


def test_a_topic_valuation_reaches_the_topic_row(db_engine):
    pid, _slug = seed_profile(run_daily=False)
    mcp = CashuMcp(pid, today=TODAY)
    ok = mcp.call("add_research_note", _note(
        headline="Roboty drogie dziś, rozsądne za rok",
        valuation={"pe": 60, "forward_pe": 20, "eps_growth": 0.45, "pe_avg_5y": 32, "basis": "indeks spółek robotyki"},
    ))
    assert ok.ok, ok.error
    with get_session() as s:
        view = segment_service.segments_view(s, s.get(Profile, pid), window="1w")
    row = next(r for r in view["segments"] if r["segment"] == "robotics")
    assert {k: row["valuation"][k] for k in ("pe", "forward_pe", "eps_growth", "pe_avg_5y")} == {"pe": 60.0, "forward_pe": 20.0, "eps_growth": 0.45, "pe_avg_5y": 32.0}
    assert row["valuation"]["sources"] == ["Example Index Provider"]
    context = mcp.call("research_context", {}).data
    seg = next(r for r in context["segments"] if r["segment"] == "robotics")
    assert seg["valuation"]["forward_pe"] == 20.0 and seg["valuation"]["basis"] == "indeks spółek robotyki"


def test_bad_valuations_are_refused(db_engine):
    pid, _slug = seed_profile(run_daily=False)
    mcp = CashuMcp(pid, today=TODAY)
    for details, message in (
        ({"valuation": {"eps_growth": 0.3}}, "needs pe or forward_pe"),
        ({"valuation": {"pe": -5}}, "must be a positive P/E"),
        ({"valuation": {"forward_pe": 20, "eps_growth": 45}}, "decimal fraction"),
        ({"valuation": {"pe": 20, "target": 300}}, "allowed keys"),
    ):
        res = mcp.call("add_research_note", _note(**details))
        assert not res.ok and message in (res.error or ""), (details, res.error)
