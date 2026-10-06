"""Every MCP tool against one synthetic profile full of sensitive values (IBANs, account numbers,
person names in accounts / payees / free text / export files, distinctive absolute amounts).

Strict mode: no answer of any tool may contain an IBAN, an account number, a person name or one of
the absolute amounts (in any rendering). Amounts mode: amounts appear, identifiers and names still
never. Every registered tool is exercised (the test fails when a new tool is not added here)."""

from __future__ import annotations

import datetime as dt
import json

import pytest
from mcp_support import (
    INV_ACCOUNT_NAME,
    PERSON_P2P,
    STRATEGY_YAML,
    TODAY,
    leaks,
    seed_profile,
    write_canonical,
    write_export_csv,
    write_export_xlsx,
)

from finanse.core.db import get_session
from finanse.core.mcp import redaction
from finanse.core.mcp.labels import Sensitivity
from finanse.core.mcp.registry import all_tools
from finanse.core.mcp.server import FinanseMcp
from finanse.core.models import Profile

MAPPING = """\
delimiter: ";"
header_row: 4
"""


def _set_privacy(pid: int, level: str) -> None:
    with get_session() as s:
        p = s.get(Profile, pid)
        p.mcp_privacy = level
        s.add(p)


def _calls(host: FinanseMcp, tmp_path) -> list[tuple[str, dict]]:
    canonical = write_canonical(tmp_path)
    export_csv = write_export_csv(tmp_path)
    export_xlsx = write_export_xlsx(tmp_path)
    signals = host.call("signals", {}).data["signals"]
    label = host.call("portfolio_overview", {}).data["accounts"][0]["account"]
    note = f"Rozmowa: {PERSON_P2P}, kwota 4321.09 PLN, konto PL61109010140000071219812874"
    # Alerts / watchlist (F5): an agent alert and a watched instrument, then a daily run checks them.
    added = host.call(
        "add_alert",
        {
            "kind": "price_above",
            "params": {"level": 10},
            "instrument": "PKO",
            "polarity": "positive",
            "severity": "action",
            "title": "PKO above 10",
            "note": note,
        },
    )
    assert added.ok, added.error
    watched = host.call("add_to_watchlist", {"symbol_or_isin": "CDR.WA", "note": note})
    assert watched.ok, watched.error
    from mcp_support import sources

    from finanse.modules.investments.service import daily

    daily.run_daily_check("manual", as_of=TODAY, sources=sources())
    # Research (F6): a run in progress; notes below carry names / amounts / an IBAN in free text.
    started = host.call(
        "start_research_run", {"scope": {"themes": [f"Banki {PERSON_P2P}"], "scheduled": True}}
    )
    assert started.ok, started.error
    run_id = started.data["run_id"]

    def source(n: int) -> list[dict]:
        return [
            {
                "url": f"https://example.com/news/1234567890{n}/artykul",
                "publisher": f"Portal {PERSON_P2P}",
                "published_at": TODAY.isoformat(),
                "title": note[:150],
            }
        ]

    return [
        ("profile_overview", {}),
        ("setup_status", {"module": "investments"}),
        ("setup_status", {"module": "budget"}),
        ("networth_breakdown", {}),
        ("spending_breakdown", {}),
        ("spending_breakdown", {"period": "2026"}),
        ("cashflow_summary", {"months": 24}),
        ("recurring_payments", {}),
        ("uncategorized_merchants", {}),
        ("loans_summary", {}),
        ("portfolio_overview", {}),
        ("positions", {}),
        (
            "set_recommendation",
            {
                "instrument": "PKO",
                "recommendation": "hold",
                "reason": "Teza pozostaje aktualna; model czeka na kolejny punkt kontrolny.",
            },
        ),
        ("signals", {"status": "all"}),
        ("strategy_status", {}),
        ("history_metrics", {}),
        ("inspect_export", {"path": str(export_csv)}),
        ("inspect_export", {"path": str(export_xlsx), "max_samples": 20}),
        ("validate_import", {"path": str(canonical)}),
        ("validate_import", {"path": str(export_csv)}),
        (
            "record_decision",
            {"signal_id": signals[0]["signal_id"], "action": "held", "reason": note},
        ),
        (
            "upsert_thesis",
            {
                "instrument": "PKO",
                "entry_type": "trend",
                "thesis": note,
                "invalidation": f"{INV_ACCOUNT_NAME} 987654.32",
                "exit_plan": "x",
            },
        ),
        ("theses", {}),
        ("theses", {"instrument": "US0378331005"}),
        ("research_context", {}),
        (
            "add_research_note",
            {
                "run_id": run_id,
                "kind": "news",
                "polarity": "negative",
                "strength": 3,
                "instrument": "PKO",
                "thesis_relation": "invalidates",
                "thesis_field": "invalidation",
                "title": f"Bank {PERSON_P2P} 4321.09 PLN",
                "summary": note,
                "sources": source(1),
                "details": {
                    "event": "wyniki Q3",
                    "event_date": (TODAY + dt.timedelta(days=20)).isoformat(),
                    "context": note,
                },
            },
        ),
        (
            "add_research_note",
            {
                "kind": "community",
                "polarity": "positive",
                "strength": 2,
                "theme": f"Banki {PERSON_P2P}",
                "title": "Forum o bankach",
                "summary": note,
                "sources": source(2),
                "details": {"scale": "small"},
            },
        ),
        (
            "add_research_note",
            {
                "kind": "candidate",
                "polarity": "positive",
                "strength": 2,
                "title": f"Kandydat Newco {PERSON_P2P}",
                "summary": note,
                "sources": source(3),
                "candidate": {"symbol_or_isin": "NEWCO.WA", "name": f"Newco {PERSON_P2P}"},
                "details": {
                    "entry_type": "trend",
                    "criteria": [
                        {"text": f"C/Z 9,8 {PERSON_P2P}", "met": True, "threshold": "max 15"}
                    ],
                    "bucket": "stocks",
                    "context": note,
                },
            },
        ),
        ("research_notes", {}),
        ("research_notes", {"since": TODAY.isoformat(), "kind": "candidate"}),
        (
            "finish_research_run",
            {"run_id": run_id, "counts": {"sources_checked": 12}, "reason": note},
        ),
        ("start_research_run", {"scope": {"held": False, "themes": ["Energia"]}}),
        ("research_context", {}),
        ("signals", {"status": "open"}),
        ("set_merchant_category", {"merchant": "SKLEP NIEZNANY TEST", "category": "groceries"}),
        ("mark_review_done", {"notes": note}),
        (
            "propose_strategy",
            {
                "yaml": STRATEGY_YAML.replace("min_trade_value: 100", "min_trade_value: 200"),
                "md": f"# Strategia\n\n{note}\n",
                "reason": note,
            },
        ),
        (
            "propose_custom_rule",
            {
                "kind_or_expression": "weight > 15%",
                "params": {"scope": "instrument", "message": "Za duza pozycja"},
                "dry_run": True,
            },
        ),
        (
            "propose_custom_rule",
            {
                "kind_or_expression": "drawdown_from_high",
                "params": {"threshold": 0.1, "window_days": 120},
                "reason": note,
            },
        ),
        ("propose_import", {"path": str(canonical), "account": label, "reason": note}),
        ("alerts", {}),
        ("alerts", {"status": "all"}),
        ("watchlist", {}),
        (
            "add_alert",
            {
                "kind": "custom",
                "params": {"expression": "cash_weight >= 5%"},
                "polarity": "negative",
                "severity": "info",
                "title": f"Gotowka {PERSON_P2P}",
                "note": note,
                "expires_in_days": 30,
            },
        ),
        ("add_to_watchlist", {"symbol_or_isin": "AAPL", "note": note}),
        ("mute_alert", {"id": added.data["alert"]["alert_id"]}),
        ("remove_from_watchlist", {"id": watched.data["item"]["item_id"]}),
        ("signals", {"status": "all"}),
        ("profile_overview", {}),
    ]


@pytest.fixture
def fuzz(db_engine):
    pid, slug = seed_profile()
    return pid, slug, FinanseMcp(pid, today=TODAY)


def _record_labels(monkeypatch) -> list[tuple[Sensitivity, object]]:
    seen: list[tuple[Sensitivity, object]] = []
    original = redaction.Redactor._leaf

    def leaf(self, node, path):
        seen.append((node.label, node.value))
        return original(self, node, path)

    monkeypatch.setattr(redaction.Redactor, "_leaf", leaf)
    return seen


def test_strict_mode_never_sends_identifiers_names_or_amounts(fuzz, tmp_path, monkeypatch):
    _pid, _slug, host = fuzz
    seen = _record_labels(monkeypatch)
    calls = _calls(host, tmp_path)
    assert {name for name, _ in calls} == set(all_tools()), "every tool must be fuzzed"
    problems = []
    for name, args in calls:
        result = host.call(name, args)
        assert result.ok, (name, result.error, result.error_kind)
        found = leaks(result.data, strict=True)
        if found:
            problems.append((name, found))
    assert not problems, problems
    # Every number that left came from a percent / count / ref label, never an amount.
    assert any(label is Sensitivity.AMOUNT for label, _ in seen)  # amounts existed in the trees
    numeric_amounts = {int(a) for a in (987654, 76543, 12345, 4321, 5667, 2602, 9127)}
    for label, value in seen:
        if label is Sensitivity.COUNT and isinstance(value, int):
            assert abs(value) not in numeric_amounts, value
        if label is Sensitivity.PERCENT and value is not None:
            assert abs(value) <= 100, value


def test_amounts_mode_sends_amounts_but_never_identifiers_or_names(fuzz, tmp_path):
    pid, _slug, host = fuzz
    _set_privacy(pid, "amounts")
    calls = _calls(host, tmp_path)
    problems = []
    answers = {}
    for name, args in calls:
        result = host.call(name, args)
        assert result.ok, (name, result.error, result.error_kind)
        answers.setdefault(name, result.data)
        found = leaks(result.data, strict=False)
        if found:
            problems.append((name, found))
    assert not problems, problems
    nw = next(c for c in answers["networth_breakdown"]["currencies"] if c["currency"] == "PLN")
    assert nw["assets"] > 900000  # the 987654.32 balance is in there
    assert all("value" in p for p in answers["positions"]["positions"])
    assert answers["strategy_status"]["facts"]["contributions"]["monthly_amount"] == 4321.09


def test_private_payees_are_refs_and_categorizable(fuzz):
    _pid, _slug, host = fuzz
    spending = host.call("spending_breakdown", {}).data
    refs = [m["merchant"] for m in spending["top_merchants"] if m["merchant"].startswith("payee:")]
    assert refs, spending["top_merchants"]
    # The card merchant carrying the owner's surname is masked too (known name).
    assert not any("KOWALCZYK" in m["merchant"] for m in spending["top_merchants"])
    result = host.call("set_merchant_category", {"merchant": refs[0], "category": "housing"})
    assert result.ok, result.error
    assert result.data["merchant"] == refs[0]
    assert result.data["updated_transactions"] >= 1
    unknown = host.call(
        "set_merchant_category", {"merchant": "payee:0000000000", "category": "housing"}
    )
    assert not unknown.ok and unknown.error_kind == "not_found"


def test_strict_answers_carry_shares_with_stated_bases(fuzz):
    _pid, _slug, host = fuzz
    spending = host.call("spending_breakdown", {"period": "2026-09"}).data
    assert "total" not in spending and "base_note" in spending
    assert abs(sum(c["share"] for c in spending["categories"]) - 1) < 1e-4
    overview = host.call("portfolio_overview", {}).data
    assert "total" not in overview
    assert abs(overview["holdings_weight"] + overview["cash_weight"] - 1) < 1e-4
    positions = host.call("positions", {}).data["positions"]
    assert all("value" not in p and "quantity" not in p and "price" not in p for p in positions)
    assert all(p["weight"] is not None for p in positions)
    loans = host.call("loans_summary", {}).data["loans"]
    assert loans and "outstanding" not in loans[0] and loans[0]["remaining_months"] > 0


def test_signal_messages_are_scrubbed_in_strict(fuzz):
    _pid, _slug, host = fuzz
    signals = host.call("signals", {}).data["signals"]
    drift = [s for s in signals if s["kind"] == "allocation_drift"]
    assert drift and all("[amount]" in s["message"] for s in drift)
    assert all(s["unit"] == "pp" and s["threshold"] == 5.0 for s in drift)


def test_agent_category_never_overrides_the_owner(fuzz):
    from sqlmodel import select

    from finanse.modules.budget.categorize.rules import upsert_rule
    from finanse.modules.budget.models import Transaction

    pid, _slug, host = fuzz
    with get_session() as s:
        upsert_rule(s, "NETFLIX.COM", "entertainment", source="manual", profile_id=pid)
        netflix = s.exec(select(Transaction).where(Transaction.reference == "NETFLIX.COM")).all()
        netflix[0].category, netflix[0].category_source = "entertainment", "manual_txn"
        s.add(netflix[0])
    kept = host.call("set_merchant_category", {"merchant": "NETFLIX.COM", "category": "shopping"})
    assert kept.ok and kept.data["category"] == "entertainment"
    assert kept.data["updated_transactions"] == 0
    learned = host.call(
        "set_merchant_category", {"merchant": "ORLEN STACJA TEST", "category": "car"}
    ).data
    assert learned["updated_transactions"] >= 1
    with get_session() as s:
        from finanse.modules.budget.models import CategoryRule

        rule = s.exec(
            select(CategoryRule).where(CategoryRule.merchant_key == "ORLEN STACJA TEST")
        ).one()
        assert rule.source == "llm" and rule.locked is False


def test_thesis_update_keeps_plans_not_given(fuzz):
    from finanse.modules.investments.store import journal

    pid, _slug, host = fuzz
    host.call(
        "upsert_thesis",
        {
            "instrument": "PKO",
            "entry_type": "trend",
            "thesis": "a",
            "invalidation": "b",
            "exit_plan": "c",
            "size_plan": "d",
        },
    )
    host.call("upsert_thesis", {"instrument": "PKO", "entry_type": "trend", "thesis": "a2"})
    with get_session() as s:
        (row,) = journal.theses(s, pid)
        assert (row.thesis, row.invalidation, row.exit_plan, row.size_plan) == ("a2", "b", "c", "d")
        assert row.reviewed_at is None


def test_owner_named_instruments_are_identifiers(fuzz):
    _pid, _slug, host = fuzz
    positions = host.call("positions", {}).data["positions"]
    claim = next(p for p in positions if p["asset_class"] == "claim")
    assert claim["owner_named"] is True and "name" not in claim and "symbol" not in claim
    signals = host.call("signals", {"status": "all"}).data["signals"]
    custom = [s for s in signals if s["kind"] == "custom"]
    assert custom and custom[0]["values"][0]["unit"] == "ratio"


def test_one_word_owner_named_instrument_never_leaks(fuzz):
    from mcp_support import add_claim, investments_account_id

    from finanse.modules.investments.models import InvInstrument

    pid, _slug, host = fuzz
    claim_id = add_claim(pid, investments_account_id(pid))
    with get_session() as s:
        inst = s.get(InvInstrument, claim_id)
        inst.name, inst.symbol = "KOWALSKI", "KOWALSKI"
        s.add(inst)
    for tool in ("portfolio_overview", "positions", "signals", "history_metrics"):
        result = host.call(tool, {"status": "all"} if tool == "signals" else {})
        assert result.ok and "KOWALSKI" not in json.dumps(result.data), tool
