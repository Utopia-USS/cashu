"""Strict mode never sends quantities or money inside system messages (F5 R6): portfolio warnings
(history gap: the missing quantity; cash history gap: the negative balance) and strategy / rule
validation issues (a value quoted from the owner's file). Numbers are scrubbed except dates,
percentages, list indexes and file positions; the stable code travels next to the text. Amounts mode
keeps the text (the redactor still runs)."""

from __future__ import annotations

import json
import re

import pytest
from mcp_support import STRATEGY_YAML, TODAY, leaks, seed_profile

from cashu.core.db import get_session
from cashu.core.mcp.server import CashuMcp
from cashu.core.mcp.tools.messages import scrub_numbers
from cashu.core.models import Profile

# Distinctive values: a quantity sold beyond the history (73 units) and the cash balance that leaves
# (3650.00 - 4131.00 = -481.00).
GAP_HISTORY = (
    "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,"
    "currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source\n"
    "1,txn,2025-02-03,,sell,G-1,PKO,PLPKO0000016,PKO Bank Polski,XWAR,73,50.00,PLN,3650.00,,,"
    "3650.00,,,,\n"
    "1,txn,2025-02-04,,withdrawal,G-2,,,,,,,PLN,,,,-4131.00,,,,\n"
)
SECRET_NUMBERS = ("73", "481", "4131", "3650")
STRICT_ALLOWED = re.compile(r"\d{4}-\d{2}-\d{2}|\d+(?:[.,]\d+)?\s?(?:%|pp)|\[\d+\]")


def _gap_account(pid: int) -> None:
    from cashu.modules.investments.importing import ImportFile
    from cashu.modules.investments.service import accounts as inv_accounts
    from cashu.modules.investments.service import imports

    with get_session() as s:
        account_id = inv_accounts.add_account(s, pid, name="IKE 2", broker="dif", wrapper="ike").id
    with get_session() as s:
        profile = s.get(Profile, pid)
        preview = imports.preview(
            s,
            profile,
            imports.ImportRequest(ImportFile("gap.csv", GAP_HISTORY.encode()), account_id),
        )
    imports.commit(preview)


def _set_privacy(pid: int, level: str) -> None:
    with get_session() as s:
        p = s.get(Profile, pid)
        p.mcp_privacy = level
        s.add(p)


@pytest.fixture
def gaps(db_engine):
    pid, slug = seed_profile()  # with the daily check: signals for record_decision
    _gap_account(pid)
    return pid, slug, CashuMcp(pid, today=TODAY)


def _numbers_left(text: str) -> list[str]:
    return re.findall(r"\d+", STRICT_ALLOWED.sub("", text))


BAD_AMOUNT = STRATEGY_YAML.replace("monthly_amount: 4321.09", "monthly_amount: -4131")


def _calls() -> list[tuple[str, dict, str, str]]:
    """(tool, args, where the system messages are, strategy.yaml on disk) for every tool answering
    with them."""
    return [
        ("portfolio_overview", {}, "warnings", STRATEGY_YAML),
        ("strategy_status", {}, "issues", BAD_AMOUNT),
        ("propose_strategy", {"yaml": BAD_AMOUNT, "dry_run": True}, "issues", STRATEGY_YAML),
        (
            "propose_custom_rule",
            {"kind_or_expression": "cash_level", "params": {"max_weight": 73}, "dry_run": True},
            "issues",
            STRATEGY_YAML,
        ),
    ]


def test_strict_system_messages_carry_no_quantities_or_balances(gaps):
    _pid, slug, host = gaps
    from cashu.modules.investments.service import files

    seen_kinds: set[str] = set()
    for tool, args, key, strategy in _calls():
        files.write_text_private(files.strategy_yaml_path(slug), strategy)
        result = host.call(tool, args)
        assert result.ok, (tool, result.error)
        assert not leaks(result.data, strict=True), tool
        messages = [m["message"] for m in result.data.get(key) or []]
        assert messages, (tool, result.data)
        for message in messages:
            assert not _numbers_left(message), (tool, message)
            assert not any(re.search(rf"\b{n}\b", message) for n in SECRET_NUMBERS), message
        if tool == "portfolio_overview":
            seen_kinds |= {w["kind"] for w in result.data["warnings"]}
        if tool in ("strategy_status", "propose_strategy"):  # stable codes next to the text
            assert all(i.get("code") for i in result.data[key]), result.data[key]
    assert {"history_gap", "cash_history_gap"} <= seen_kinds


def test_amounts_mode_keeps_the_numbers_of_system_messages(gaps):
    pid, _slug, host = gaps
    _set_privacy(pid, "amounts")
    warnings = host.call("portfolio_overview", {}).data["warnings"]
    text = json.dumps(warnings)
    assert re.search(r"\b73\b", text) and "-481" in text  # the data produced them


def test_scrub_keeps_dates_percentages_indexes_and_positions():
    assert scrub_numbers("History gap: 412 on 2026-03-02 needs 37 more units of 45") == (
        "History gap: # on 2026-03-02 needs # more units of #"
    )
    assert scrub_numbers("cash of 9 is -480 on 2026-03-02; counted as 0") == (
        "cash of # is # on 2026-03-02; counted as #"
    )
    assert scrub_numbers("XMPL is 37.3% (max 30.0%), drift 5 pp") == (
        "XMPL is 37.3% (max 30.0%), drift 5 pp"
    )
    assert scrub_numbers("rules[3].params: must be at most 1 (got 1.5) at line 12 column 4") == (
        "rules[3].params: must be at most # (got #) at line 12 column 4"
    )
    assert scrub_numbers("IS3N and EUNL: 12 345,67 PLN, 1,234.56") == "IS3N and EUNL: # PLN, #"


def _messages(node) -> list[str]:
    if isinstance(node, dict):
        out = [v for k, v in node.items() if k in ("message", "example") and isinstance(v, str)]
        return out + [m for v in node.values() for m in _messages(v)]
    if isinstance(node, list):
        return [m for v in node for m in _messages(v)]
    return []


def test_fuzz_every_tool_over_the_gap_history(gaps, tmp_path):
    """The full strict fuzz (test_mcp_tools) over a profile whose history has a quantity gap and a
    negative cash balance: no leak, and no system message carries those numbers."""
    from test_mcp_tools import _calls as fuzz_calls

    _pid, _slug, host = gaps
    for name, args in fuzz_calls(host, tmp_path):
        result = host.call(name, args)
        assert result.ok, (name, result.error)
        assert not leaks(result.data, strict=True), name
        for message in _messages(result.data):
            assert not any(re.search(rf"\b{n}\b", message) for n in SECRET_NUMBERS), (name, message)
