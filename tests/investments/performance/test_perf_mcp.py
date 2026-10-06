"""The MCP ``history_metrics`` performance block: return vs a benchmark, drawdowns, profit
concentration and rolling relative performance as fractions / dates / counts only, in both privacy
modes, on the fuzz profile full of sensitive values (``tests/mcp_support.py``)."""

from __future__ import annotations

import pytest
from mcp_support import STRATEGY_YAML, TODAY, leaks, seed_profile, write_strategy

from cashu.core.db import get_session
from cashu.core.mcp.labels import Labelled, Sensitivity
from cashu.core.mcp.registry import ToolContext
from cashu.core.mcp.server import CashuMcp
from cashu.core.mcp.tools.investments import _performance_metrics
from cashu.core.models import Profile
from cashu.modules.investments.performance import service

ALLOWED = {
    Sensitivity.PERCENT,
    Sensitivity.DATE,
    Sensitivity.COUNT,
    Sensitivity.CATEGORY,
    Sensitivity.SYMBOL,
    Sensitivity.FLAG,
    Sensitivity.TEXT,
}
BENCHMARK = "\nbenchmark:\n  id: msci_world\n  proxy: EUNL.DE\n"


@pytest.fixture
def fuzz(db_engine):
    service.clear_cache()
    pid, slug = seed_profile()
    write_strategy(slug, STRATEGY_YAML + BENCHMARK)
    yield pid, slug
    service.clear_cache()


def _leaves(node, path=""):
    if isinstance(node, Labelled):
        yield path, node
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from _leaves(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _leaves(v, f"{path}[{i}]")
    else:
        raise TypeError(f"unlabelled leaf at {path}: {node!r}")


def test_labels_are_never_amounts_or_identifiers(fuzz):
    pid, _slug = fuzz
    with get_session() as s:
        ctx = ToolContext(session=s, profile=s.get(Profile, pid), privacy="strict", today=TODAY)
        tree = _performance_metrics(ctx)
    leaves = list(_leaves(tree))
    assert leaves
    bad = [(p, n.label) for p, n in leaves if n.label not in ALLOWED]
    assert not bad, bad
    for path, node in leaves:
        if node.label is Sensitivity.PERCENT and node.value is not None:
            assert abs(node.value) <= 100, path


@pytest.mark.parametrize("privacy", ["strict", "amounts"])
def test_history_metrics_performance_block(fuzz, privacy):
    pid, _slug = fuzz
    with get_session() as s:
        p = s.get(Profile, pid)
        p.mcp_privacy = privacy
        s.add(p)
    host = CashuMcp(pid, today=TODAY)
    result = host.call("history_metrics", {})
    assert result.ok, (result.error, result.error_kind)
    data = result.data
    assert "not_measured" not in data
    perf = data["performance"]
    assert not leaks(data, strict=privacy == "strict")
    b = perf["benchmark"]
    assert (b["status"], b["proxy"], b["id"]) == ("ok", "EUNL.DE", "msci_world")
    assert b["twr"] is not None and b["simulation_money_weighted"] is not None
    assert perf["return"]["twr"] is not None and perf["return"]["days"] > 900
    assert perf["max_drawdown"]["portfolio"] <= 0
    assert perf["max_drawdown"]["benchmark"] <= 0
    pc = perf["profit_concentration"]
    assert pc["instruments_positive"] + pc["instruments_negative"] == 3
    assert 0 < pc["top2_share"] <= pc["top3_share"]
    assert [r["months"] for r in perf["rolling_relative"]] == [12, 24, 36]
    assert perf["rolling_relative"][0]["windows"] > 0
    assert perf["rolling_relative"][0]["latest_excess"] is not None
    assert [y["year"] for y in perf["per_year"]] == list(range(2024, TODAY.year + 1))


def test_same_block_in_both_modes(fuzz):
    pid, _slug = fuzz
    host = CashuMcp(pid, today=TODAY)
    strict = host.call("history_metrics", {}).data["performance"]
    with get_session() as s:
        p = s.get(Profile, pid)
        p.mcp_privacy = "amounts"
        s.add(p)
    amounts = host.call("history_metrics", {}).data["performance"]
    assert strict == amounts  # nothing in it is an amount the strict mode would drop
