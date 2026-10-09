"""Topics and macro texts over MCP (P7): ``research_context.segments`` rows carry the topic trend
(``trend_1w`` / ``trend_4w`` / ``members``), the macro summary passes only as summary-builder text, and
large candidate-criteria thresholds (``min_market_cap_pln: 1000000000``) come out as compact Polish
text, so the privacy leak check never withholds the context, in strict and amounts mode. Synthetic
profile only."""

from __future__ import annotations

import pytest
from mcp_support import STRATEGY_YAML, TODAY, seed_profile, write_strategy

from cashu.core.db import get_session
from cashu.core.mcp import labels as L
from cashu.core.mcp.server import CashuMcp
from cashu.core.models import Profile

CRITERIA = """\
watchlist:
  criteria:
    min_market_cap_pln: 1000000000
    max_pe: 25
    min_dividend_yield: 0.03
"""


@pytest.fixture
def host(db_engine):
    pid, slug = seed_profile()
    return pid, slug, CashuMcp(pid, today=TODAY)


def _privacy(pid: int, level: str) -> None:
    with get_session() as s:
        p = s.get(Profile, pid)
        p.mcp_privacy = level
        s.add(p)


@pytest.mark.parametrize("level", ["strict", "amounts"])
def test_a_billion_market_cap_criterion_never_trips_the_leak_check(host, level):
    pid, slug, mcp = host
    write_strategy(slug, STRATEGY_YAML + CRITERIA)
    _privacy(pid, level)
    result = mcp.call("research_context", {})
    assert result.ok, result.error
    criteria = {
        c["criterion"]: c["threshold"] for c in result.data["strategy"]["candidate_criteria"]
    }
    assert criteria == {"max_pe": 25.0, "min_dividend_yield": 0.03, "min_market_cap_pln": "1 mld"}


def test_compact_numbers():
    cases = {
        1_000_000: "1 mln",
        1_500_000_000: "1,5 mld",
        500_000_000: "500 mln",
        1_234_567_890: "1,23 mld",
        999_999_999: "1 mld",
        2_500_000_000_000: "2 500 mld",
        -30_000_000: "-30 mln",
    }
    for value, text in cases.items():
        assert L.compact_number(value) == text
        assert L.market_ok(text)


def test_research_context_segments_carry_the_topic_trend(host):
    _pid, _slug, mcp = host
    rows = mcp.call("research_context", {}).data["segments"]
    assert rows, "the seeded profile has segment rows"
    for row in rows:
        assert {"trend_1w", "trend_4w", "members"} <= set(row)
        assert isinstance(row["members"], int)


def test_macro_summary_only_passes_as_summary_text():
    assert L.market_ok("Akcje na świecie rosną od maja 2025: są 1,7 % pod rocznym szczytem.")
    assert not L.market_ok("Jan Kowalski rosną od maja 2025.")
    assert not L.market_ok("Dolar słabnie od maja 2025: konto 12345678901.")
    with pytest.raises(ValueError):
        L.market("Akcje na świecie rosną, a Jan Kowalski kupił 12 400 zł.")
