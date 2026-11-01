"""F6 review V3 / V6 through the MCP layer on the synthetic sensitive profile.

V3: in strict mode the number literals of a custom alert's expression that are compared with amounts
are scrubbed in ``alerts`` (params and signal message) and ``signals`` (condition and message), while
percentages, ratios, window arguments and public price levels stay; amounts mode sends them as written.
V6: a profile's display-name override of a market instrument never reaches the agent in strict mode
(the shared market name is sent instead); amounts mode sends the owner's label.
"""

from __future__ import annotations

import json

import pytest
from mcp_support import TODAY, seed_profile, sources

from cashu.core.db import get_session
from cashu.core.mcp.server import CashuMcp
from cashu.core.models import Profile
from cashu.modules.investments.rules.expr.privacy import scrub_amount_literals
from cashu.modules.investments.service import daily

BUFFER = "cash_value > 7 and cash_weight < 99%"


@pytest.fixture
def host(db_engine):
    pid, _slug = seed_profile()
    return pid, CashuMcp(pid, today=TODAY)


def _privacy(pid: int, value: str) -> None:
    with get_session() as s:
        p = s.get(Profile, pid)
        p.mcp_privacy = value
        s.add(p)
        s.commit()


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("cash_value > 735", "cash_value > [amount]"),
        ("weight < 0.03 and value > 800", "weight < 0.03 and value > [amount]"),
        ("drawdown_from_high(252) >= 20% and weight < 3%", None),
        ("days_since_last_deposit > 45", None),
        ("last_close > 120", None),  # a public price level
        ("cash_value / total_value > 0.1", "cash_value / total_value > [amount]"),  # conservative
        ("total_value - cash_value < -50", "total_value - cash_value < -[amount]"),
        ("cash_value >", "cash_value >"),  # does not parse: bare numbers only, none here
        ("broken ( 500 and 5%", "broken ( [amount] and 5%"),
        # F7 review R7: a literal scaled into an amount
        ("last_close * 40 > 5000", "last_close * [amount] > [amount]"),
        ("weight * 120000 > 900", "weight * [amount] > [amount]"),
        ("last_close + 15 > 120", "last_close + [amount] > [amount]"),
        ("40 * last_close > 5000", "[amount] * last_close > [amount]"),
        ("weight * 100 > 5", None),  # a percent conversion keeps the ratio
        ("drawdown_from_high(252) / 2 > 0.1", "drawdown_from_high(252) / [amount] > [amount]"),
        # F7 re-review B4: a literal fraction on the other side
        ("weight > 900 / 120000", "weight > [amount] / [amount]"),
        ("last_close > 5000 / 40", "last_close > [amount] / [amount]"),
        ("weight > 5 * 0.01", "weight > [amount] * [amount]"),  # conservative
        ("weight > 5% / 100", None),  # a percent and 1 / 100 stay
        ("weight > 1 / 100", None),
    ],
)
def test_amount_literals(source, expected):
    assert scrub_amount_literals(source) == (source if expected is None else expected)


def test_owner_named_prices_are_amounts():
    assert scrub_amount_literals("last_close > 120", private_prices=True) == "last_close > [amount]"


def _custom_alert(mcp) -> dict:
    created = mcp.call(
        "add_alert",
        {
            "kind": "custom",
            "params": {"expression": BUFFER},
            "polarity": "negative",
            "severity": "info",
            "title": "idle cash",
        },
    )
    assert created.ok, created.error
    return created.data["alert"]


def test_strict_mode_scrubs_amount_literals_of_custom_alerts(host):
    pid, mcp = host
    alert = _custom_alert(mcp)
    assert alert["params"]["expression"] == "cash_value > [amount] and cash_weight < 99%"

    daily.run_daily_check("manual", as_of=TODAY, sources=sources())
    (listed,) = [a for a in mcp.call("alerts", {}).data["alerts"] if a["title"] == "idle cash"]
    assert listed["status"] == "triggered"
    message = listed["signal"]["message"]
    assert "cash_value > [amount] and cash_weight < 99%" in message
    assert "> 7" not in message

    signals = mcp.call("signals", {}).data["signals"]
    (sig,) = [s for s in signals if s["kind"] == "alert:custom"]
    assert sig["condition"] == "cash_value > [amount] and cash_weight < 99%"
    assert "> 7" not in sig["message"] and "> 7" not in json.dumps(sig)
    assert any(v["metric"] == "cash_weight" for v in sig["values"])  # the ratio is still measured

    _privacy(pid, "amounts")
    (listed,) = [a for a in mcp.call("alerts", {}).data["alerts"] if a["title"] == "idle cash"]
    assert listed["params"]["expression"] == BUFFER
    (sig,) = [s for s in mcp.call("signals", {}).data["signals"] if s["kind"] == "alert:custom"]
    assert sig["condition"] == BUFFER and BUFFER in sig["message"]


LABEL = "Na mieszkanie dla Tomka Lis"


def _rename(pid: int, symbol: str, name: str) -> tuple[int, str]:
    from sqlmodel import select

    from cashu.modules.investments.models import InvInstrument, InvProfileInstrument

    with get_session() as s:
        inst = s.exec(select(InvInstrument).where(InvInstrument.symbol == symbol)).one()
        s.add(InvProfileInstrument(profile_id=pid, instrument_id=inst.id, name=name))
        s.commit()
        return inst.id, inst.name


def test_display_name_override_never_reaches_the_agent_in_strict_mode(host):
    pid, mcp = host
    _iid, market_name = _rename(pid, "PKO", LABEL)
    assert market_name and market_name != LABEL
    created = mcp.call(
        "add_alert",
        {
            "kind": "price_above",
            "params": {"level": 10},
            "instrument": "PKO",
            "polarity": "positive",
            "severity": "action",
            "title": "PKO above 10",
        },
    )
    assert created.ok, created.error
    daily.run_daily_check("manual", as_of=TODAY, sources=sources())

    outputs = {}
    for tool in ("positions", "alerts", "signals", "instruments"):
        result = mcp.call(tool, {})
        if result.ok:
            outputs[tool] = json.dumps(result.data, ensure_ascii=False)
    assert "positions" in outputs and "alerts" in outputs
    for tool, text in outputs.items():
        assert "Tomka" not in text and "mieszkanie" not in text, tool
    positions = mcp.call("positions", {}).data
    assert market_name in json.dumps(positions, ensure_ascii=False)

    _privacy(pid, "amounts")
    shown = json.dumps(mcp.call("positions", {}).data, ensure_ascii=False)
    assert LABEL in shown  # amounts mode: the owner's own label


# F7 review R6: labels with a number (a goal year, a target amount) must be swapped too; the strict
# number scrub used to rewrite them before the alias swap looked for the owner's label.
DIGIT_LABELS = [
    "Wesele 45000 Kasi",
    "IKE Oli 2030",
    "Mieszkanie 300 000 Oli",
    "Studia Ani 1 200 zł",
    "Cel 50k Tomek",
]


@pytest.mark.parametrize("label", DIGIT_LABELS)
def test_scrub_text_swaps_aliases_with_numbers_before_the_number_scrub(label):
    from cashu.core.mcp.names import NameGuard
    from cashu.core.mcp.redaction import scrub_text

    guard = NameGuard(1, strict_aliases=((label, "Public Market Name"),))
    out = scrub_text(f"Pozycja {label} spadła o 5%", strict=True, guard=guard)
    assert out == "Pozycja Public Market Name spadła o 5%"
    assert guard.public_name(f"  {label.upper()} ") == "Public Market Name"
    assert guard.public_name("Inna nazwa") == "Inna nazwa"
    # amounts mode keeps the owner's label
    assert label in scrub_text(f"Pozycja {label}", strict=False, guard=guard)


@pytest.mark.parametrize("label", ["Wesele 45000 Kasi", "IKE Oli 2030"])
def test_digit_label_override_never_reaches_the_agent_in_strict_mode(host, label):
    pid, mcp = host
    _iid, market_name = _rename(pid, "PKO", label)
    created = mcp.call(
        "add_alert",
        {
            "kind": "price_above",
            "params": {"level": 10},
            "instrument": "PKO",
            "polarity": "positive",
            "severity": "action",
            "title": "PKO above 10",
        },
    )
    assert created.ok, created.error
    daily.run_daily_check("manual", as_of=TODAY, sources=sources())
    person = label.split()[1] if label.startswith("IKE") else label.split()[-1]
    purpose = label.split()[0]
    for tool in ("positions", "alerts", "signals", "watchlist"):
        result = mcp.call(tool, {})
        if not result.ok:
            continue
        text = json.dumps(result.data, ensure_ascii=False)
        assert person not in text and purpose not in text, tool
    positions = mcp.call("positions", {}).data
    (row,) = [p for p in positions["positions"] if p.get("symbol") == "PKO"]
    assert row["name"] == market_name


@pytest.mark.parametrize(
    ("stored", "ceiling", "effective"),
    [
        ("amounts", "strict", "strict"),
        ("strict", "amounts", "strict"),
        ("amounts", "amounts", "amounts"),
        ("strict", "strict", "strict"),
    ],
)
def test_host_ceiling_clamps_the_same_call_that_creates_a_custom_alert(
    host, stored, ceiling, effective
):
    """The delegated policy must reach the handler and redactor, without changing stored settings."""
    from sqlmodel import select

    from cashu.core.agent_models import McpCall

    pid, mcp = host
    _privacy(pid, stored)
    result = mcp.call(
        "add_alert",
        {
            "kind": "custom",
            "params": {"expression": BUFFER},
            "polarity": "negative",
            "severity": "info",
            "title": "host ceiling",
        },
        privacy_ceiling=ceiling,
    )
    assert result.ok, result.error
    expected = BUFFER if effective == "amounts" else "cash_value > [amount] and cash_weight < 99%"
    assert result.data["alert"]["params"]["expression"] == expected
    assert result.effective_privacy == effective
    with get_session() as s:
        assert s.get(Profile, pid).mcp_privacy == stored
        assert s.exec(select(McpCall).where(McpCall.profile_id == pid)).one().privacy == effective
    # The next ordinary Python call retains its own DB policy, not the previous host ceiling.
    ordinary = mcp.call("profile_overview", {})
    assert ordinary.ok and ordinary.data["privacy"] == stored


def test_host_ceiling_rereads_python_policy_and_applies_name_aliases(host):
    pid, mcp = host
    _rename(pid, "PKO", LABEL)
    _privacy(pid, "amounts")
    hidden = mcp.call("positions", {}, privacy_ceiling="strict")
    assert hidden.ok and LABEL not in json.dumps(hidden.data, ensure_ascii=False)
    shown = mcp.call("positions", {}, privacy_ceiling="amounts")
    assert shown.ok and LABEL in json.dumps(shown.data, ensure_ascii=False)
    _privacy(pid, "strict")
    hidden_again = mcp.call("positions", {}, privacy_ceiling="amounts")
    assert hidden_again.ok and LABEL not in json.dumps(hidden_again.data, ensure_ascii=False)
    assert hidden_again.effective_privacy == "strict"


@pytest.mark.parametrize("ceiling", [None, "relaxed", "", True, 1, [], {"profile": 2}])
def test_malformed_host_ceiling_refuses_before_the_handler(host, ceiling):
    from sqlmodel import select

    from cashu.core.agent_models import McpCall, Review
    from cashu.core.mcp.registry import ToolSpec

    pid, mcp = host
    _privacy(pid, "amounts")

    def must_not_run(_ctx):
        pytest.fail("invalid policy metadata reached a write handler")

    mcp._tools["mark_review_done"] = ToolSpec(
        "mark_review_done", "core", "synthetic", must_not_run, write=True
    )
    result = mcp.call("mark_review_done", {}, privacy_ceiling=ceiling)
    assert not result.ok and result.error_kind == "invalid_privacy_ceiling"
    assert result.effective_privacy == "strict"
    with get_session() as s:
        assert s.exec(select(Review).where(Review.profile_id == pid)).all() == []
        logged = s.exec(select(McpCall).where(McpCall.profile_id == pid)).one()
        assert logged.outcome == "refused" and logged.privacy == "strict"
        assert logged.args == {}  # policy metadata is never an argument or audit value


def test_host_ceiling_sdk_negotiation_metadata_and_profile_binding(host):
    import anyio
    from mcp import Client

    from cashu.core.mcp.server import build_server

    pid, mcp = host
    _privacy(pid, "amounts")
    other, _slug = seed_profile("Synthetic second profile")
    _privacy(other, "strict")
    server = build_server(mcp, "synthetic-host-policy")
    assert server.create_initialization_options().capabilities.experimental[
        "cashu/hostPolicyV1"
    ] == {"privacyCeiling": True, "nameGuard": True}

    async def exercise():
        async with Client(server) as client:
            assert client.server_capabilities.experimental["cashu/hostPolicyV1"] == {
                "privacyCeiling": True,
                "nameGuard": True,
            }
            tools = await client.list_tools()
            assert all(
                "cashu/privacyCeiling" not in t.input_schema["properties"] for t in tools.tools
            )
            ordinary = await client.call_tool("profile_overview", {})
            assert ordinary.structured_content["privacy"] == "amounts"
            assert "cashu/effectivePrivacy" not in (ordinary.meta or {})
            strict = await client.call_tool(
                "profile_overview", {}, meta={"cashu/privacyCeiling": "strict"}
            )
            assert strict.structured_content["privacy"] == "strict"
            assert strict.meta["cashu/effectivePrivacy"] == "strict"
            # Extra metadata cannot rebind this server to the other profile.
            same = await client.call_tool(
                "profile_overview",
                {},
                meta={"cashu/privacyCeiling": "amounts", "profile": other},
            )
            assert same.structured_content["privacy"] == "amounts"
            assert same.meta["cashu/effectivePrivacy"] == "amounts"
            _privacy(pid, "strict")
            clamped = await client.call_tool(
                "profile_overview", {}, meta={"cashu/privacyCeiling": "amounts"}
            )
            assert clamped.structured_content["privacy"] == "strict"
            assert clamped.meta["cashu/effectivePrivacy"] == "strict"
            for invalid in ("relaxed", {"profile": other}):
                refused = await client.call_tool(
                    "mark_review_done",
                    {"module": "budget"},
                    meta={"cashu/privacyCeiling": invalid},
                )
                assert refused.is_error
                assert refused.meta["cashu/effectivePrivacy"] == "strict"

    anyio.run(exercise)


def test_host_ceiling_explicit_null_survives_server_params_validation(host):
    """The SDK client omits null extra-meta values; raw host JSON can still supply explicit null."""
    import anyio

    from cashu.core.mcp.registry import ToolSpec
    from cashu.core.mcp.server import build_server

    _pid, mcp = host

    def must_not_run(_ctx):
        pytest.fail("explicit null policy reached a write handler")

    mcp._tools["mark_review_done"] = ToolSpec(
        "mark_review_done", "core", "synthetic", must_not_run, write=True
    )
    server = build_server(mcp, "synthetic-host-policy")
    entry = server._request_handlers["tools/call"]
    params = entry.params_type.model_validate(
        {"name": "mark_review_done", "arguments": {}, "_meta": {"cashu/privacyCeiling": None}},
        by_name=False,
    )
    assert params.meta["cashu/privacyCeiling"] is None

    async def exercise():
        result = await entry.handler(None, params)
        assert result.is_error
        assert result.meta["cashu/effectivePrivacy"] == "strict"

    anyio.run(exercise)
