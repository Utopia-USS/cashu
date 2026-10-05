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

from finanse.core.db import get_session
from finanse.core.mcp.server import FinanseMcp
from finanse.core.models import Profile
from finanse.modules.investments.rules.expr.privacy import scrub_amount_literals
from finanse.modules.investments.service import daily

BUFFER = "cash_value > 7 and cash_weight < 99%"


@pytest.fixture
def host(db_engine):
    pid, _slug = seed_profile()
    return pid, FinanseMcp(pid, today=TODAY)


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

    from finanse.modules.investments.models import InvInstrument, InvProfileInstrument

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
    from finanse.core.mcp.names import NameGuard
    from finanse.core.mcp.redaction import scrub_text

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
