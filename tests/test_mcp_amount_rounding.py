"""Amount-labelled values are rounded at the label layer.

FX-converted values (a USD / EUR position valued in PLN, a fractional unit count) come out of the
views as floats with a 10+ digit fraction (110034.5950716749). Sent as is, the final leak check
takes the fraction for an account number and withholds the whole answer: in ``amounts`` mode
``portfolio_overview``, ``positions`` and ``networth_breakdown`` failed on a real profile. Strict
mode drops amounts, so it must stay clean as before.
"""

from __future__ import annotations

import json
from decimal import Decimal

import mcp_support
import pytest
from mcp_support import TODAY, leaks, seed_profile

from cashu.core.db import get_session
from cashu.core.mcp import labels as L
from cashu.core.mcp.redaction import _LONG_DIGITS
from cashu.core.mcp.server import CashuMcp
from cashu.core.models import Profile

TOOLS = ("portfolio_overview", "positions", "networth_breakdown")
# a fractional unit count bought at an FX rate with many digits
AWKWARD_ROW = (
    "1,txn,2025-07-01,,buy,M-9,EUNL,IE00B4L5Y983,iShares Core MSCI World,XETR,0.3333333,91.13,EUR,"
    "30.38,,,-131.0137,PLN,4.3123457,,"
)


@pytest.fixture
def awkward_host(db_engine, monkeypatch):
    monkeypatch.setitem(mcp_support.FX, "USD", Decimal("3.98765432"))
    monkeypatch.setitem(mcp_support.FX, "EUR", Decimal("4.31234567"))
    monkeypatch.setattr(mcp_support, "ROWS", [*mcp_support.ROWS, AWKWARD_ROW])
    pid, _slug = seed_profile()
    return pid, CashuMcp(pid, today=TODAY)


def _privacy(pid: int, value: str) -> None:
    with get_session() as s:
        p = s.get(Profile, pid)
        p.mcp_privacy = value
        s.add(p)
        s.commit()


def _floats(node, path: str = "$"):
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _floats(value, f"{path}.{key}")
    elif isinstance(node, list):
        for i, value in enumerate(node):
            yield from _floats(value, f"{path}[{i}]")
    elif isinstance(node, float):
        yield path, node


@pytest.mark.parametrize("privacy", ["strict", "amounts"])
@pytest.mark.parametrize("tool", TOOLS)
def test_fx_converted_values_pass_the_leak_check(awkward_host, privacy, tool):
    pid, mcp = awkward_host
    _privacy(pid, privacy)
    result = mcp.call(tool, {})
    assert result.ok, result.error
    assert leaks(result.data, strict=privacy == "strict") == []
    long_floats = [
        (path, value)
        for path, value in _floats(result.data)
        if _LONG_DIGITS.search(json.dumps(value))
    ]
    assert long_floats == []


def test_amounts_mode_sends_rounded_money(awkward_host):
    pid, mcp = awkward_host
    _privacy(pid, "amounts")
    overview = mcp.call("portfolio_overview", {}).data
    assert isinstance(overview["total"], float)
    assert overview["total"] == round(overview["total"], 2)
    (eunl,) = [
        p for p in mcp.call("positions", {}).data["positions"] if p.get("isin") == "IE00B4L5Y983"
    ]
    assert eunl["value"] == round(eunl["value"], 2)
    # unit counts keep their precision (8 places), they are not money
    assert eunl["quantity"] == pytest.approx(31.3333333)
    for currency in mcp.call("networth_breakdown", {}).data["currencies"]:
        for key in ("assets", "liabilities", "net"):
            assert currency[key] == round(currency[key], 2)


def test_label_helpers_round():
    assert L.amount(0.1 + 0.2).value == 0.3
    assert L.amount(Decimal("110034.5950716749")).value == 110034.6
    assert L.amount(Decimal("0.33333333333"), 8).value == 0.33333333
    assert L.amount(1250).value == 1250 and isinstance(L.amount(1250).value, int)
    assert L.amount(None).value is None
    assert L.level(Decimal("187.123456789012")).value == 187.12345679
    assert L.level(None).value is None
