"""Stable codes on backend messages the app shows: strategy issues (``code`` + ``params``), import
warnings (``import.<kind>``), and the frontend label map covering every backend code
(``frontend/src/core/messages.ts``)."""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from finanse.modules.investments.importing.contract import ImportWarning, ImportWarningKind
from finanse.modules.investments.service import files as inv_files
from finanse.modules.investments.service import strategy as strategy_service
from finanse.modules.investments.strategy import load_strategy
from finanse.modules.investments.strategy.codes import CODES, OTHER, classify
from finanse.modules.investments.strategy.issues import IssueSeverity, StrategyIssue

ROOT = Path(__file__).resolve().parents[1]
MESSAGES_TS = ROOT / "frontend" / "src" / "core" / "messages.ts"

H = "version: 1\nbase_currency: PLN\n"
B2 = H + "buckets:\n  - { id: eq, match: { asset_class: etf } }\n  - { id: cash, match: { asset_class: cash } }\n"
T2 = B2 + "allocation:\n  targets: { eq: 0.8, cash: 0.2 }\n"

# (expected code, strategy.yaml, strategy.md): each message comes from the real loader, so a reworded
# message that no longer matches its template fails here instead of silently losing its code.
CORPUS: list[tuple[str, str, str | None]] = [
    ("yaml_too_large", "# " + "x" * 512_100, None),
    ("yaml_duplicate_key", "version: 1\nversion: 1\n", None),
    ("yaml_too_deep", "a: " + "[" * 40 + "]" * 40 + "\n", None),
    ("yaml_invalid", "rules: [\n", None),
    ("yaml_alias", "a: &x 1\nb: *x\n", None),
    ("yaml_merge_key", "base: { a: 1 }\nother:\n  <<: { a: 2 }\n", None),
    ("yaml_tag", "a: !!python/object:os.system x\n", None),
    ("yaml_key_not_text", "? [a]\n: 1\n", None),
    ("empty", "", None),
    ("not_mapping", "- a\n- b\n", None),
    ("md_empty", H, "   "),
    ("version_unsupported", "version: 2\nbase_currency: PLN\n", None),
    ("base_currency_required", "version: 1\n", None),
    ("currency_invalid", "version: 1\nbase_currency: zloty\n", None),
    ("base_currency_not_pln", "version: 1\nbase_currency: EUR\n", None),
    ("buckets_not_list", H + "buckets: 5\n", None),
    ("bucket_not_mapping", H + "buckets:\n  - 5\n", None),
    ("bucket_id_required", H + "buckets:\n  - { match: {} }\n", None),
    ("id_invalid", H + "buckets:\n  - { id: bad id, match: {} }\n", None),
    ("id_duplicate", H + "buckets:\n  - { id: a, match: {} }\n  - { id: a, match: {} }\n", None),
    ("match_required", H + "buckets:\n  - { id: a }\n", None),
    ("bucket_catch_all", H + "buckets:\n  - { id: all, match: {} }\n  - { id: c, match: { asset_class: cash } }\n", None),
    ("no_cash_bucket", H + "buckets:\n  - { id: eq, match: { asset_class: etf } }\nallocation:\n  targets: { eq: 1 }\n", None),
    ("targets_missing", B2, None),
    ("allocation_not_mapping", B2 + "allocation: 5\n", None),
    ("targets_required", B2 + "allocation: {}\n", None),
    ("targets_not_mapping", B2 + "allocation:\n  targets: 5\n", None),
    ("target_unknown_bucket", B2 + "allocation:\n  targets: { e: 0.8, cash: 0.2 }\n", None),
    ("target_invalid", B2 + "allocation:\n  targets: { eq: 1.5, cash: 0.2 }\n", None),
    ("targets_sum", B2 + "allocation:\n  targets: { eq: 0.5, cash: 0.2 }\n", None),
    ("target_missing", B2 + "allocation:\n  targets: { eq: 1 }\n", None),
    ("rules_not_list", H + "rules: 5\n", None),
    ("rule_not_mapping", H + "rules:\n  - 5\n", None),
    ("rule_id_required", H + "rules:\n  - { kind: cash_level, params: { max_weight: 0.2 } }\n", None),
    ("rule_kind_required", H + "rules:\n  - { id: r }\n", None),
    ("rule_kind_unknown", H + "rules:\n  - { id: r, kind: cash_levl }\n", None),
    ("params_not_mapping", H + "rules:\n  - { id: r, kind: cash_level, params: 5 }\n", None),
    ("rebalance_without_drift", B2 + "allocation:\n  targets: { eq: 0.8, cash: 0.2 }\n  rebalance: { absolute_band_pp: 5 }\n", None),
    ("drift_needs_targets", H + "rules:\n  - { id: d, kind: allocation_drift }\n", None),
    ("custom_bucket_needs_targets", H + "rules:\n  - { id: s, kind: custom, params: { scope: bucket, when: drift_pp > 5 } }\n", None),
    ("unknown_bucket", T2 + "rules:\n  - { id: d, kind: allocation_drift, params: { buckets: [eqq] } }\n", None),
    ("contribution_gap_needs_plan", H + "rules:\n  - { id: g, kind: contribution_gap }\n", None),
    ("when_required", H + "rules:\n  - { id: c, kind: custom }\n", None),
    ("expression_invalid", H + "rules:\n  - { id: c, kind: custom, params: { when: cash_weight > } }\n", None),
    ("message_empty", H + "rules:\n  - { id: c, kind: custom, params: { when: cash_weight > 1%, message: ' ' } }\n", None),
    ("message_too_long", H + "rules:\n  - { id: c, kind: custom, params: { when: cash_weight > 1%, message: " + "x" * 300 + " } }\n", None),
    ("scope_only", H + "rules:\n  - { id: c, kind: custom, params: { when: cash_weight > 1%, tags: [a] } }\n", None),
    ("tags_required", H + "rules:\n  - { id: t, kind: tagged_weight, params: { max_weight: 0.2 } }\n", None),
    ("cash_level_needs_bound", H + "rules:\n  - { id: c, kind: cash_level, params: {} }\n", None),
    ("min_below_max", H + "rules:\n  - { id: c, kind: cash_level, params: { min_weight: 0.5, max_weight: 0.2 } }\n", None),
    ("benchmark_id_required", H + "benchmark:\n  proxy: VWCE.DE\n", None),
    ("benchmark_proxy_required", H + "benchmark:\n  id: acwi\n", None),
    ("benchmark_proxy_empty", H + "benchmark:\n  id: acwi\n  proxy: ' '\n", None),
    ("benchmark_one_currency", H + "benchmark:\n  id: acwi\n  proxy: VWCE.DE\n  currency: [EUR, USD]\n", None),
    ("unknown_choice", H + "notifications:\n  digest_weekday: sundy\n", None),
    ("watchlist_not_mapping", H + "watchlist: 5\n", None),
    ("criteria_not_mapping", H + "watchlist:\n  criteria: 5\n", None),
    ("criterion_unknown", H + "watchlist:\n  criteria:\n    max_pee: 5\n", None),
    ("unknown_key", H + "horizon_yaers: 5\n", None),
    ("unknown_asset_class", H + "buckets:\n  - { id: b, match: { asset_class: bnd } }\n", None),
    ("unknown_value", H + "rules:\n  - { id: c, kind: cash_level, severity: urgent, params: { max_weight: 0.2 } }\n", None),
    ("required", H + "contributions:\n  day_of_month: 5\n", None),
    ("not_number", H + "watchlist:\n  criteria:\n    max_pe: low\n", None),
    ("not_whole_number", H + "horizon_years: 1.5\n", None),
    ("not_finite", H + "data:\n  max_stale_weight: .nan\n", None),
    ("not_text_list", H + "buckets:\n  - { id: b, match: { tags: { a: 1 } } }\n", None),
    ("not_text", "version: 1\nbase_currency: [PLN]\n", None),
    ("not_mapping_key", H + "data: 5\n", None),
    ("out_of_range", H + "data:\n  max_stale_weight: 2\n", None),
]


def _issues(yaml_text: str, md: str | None) -> list[StrategyIssue]:
    result = load_strategy(yaml_text, md)
    out = list(result.issues)
    for rule in result.inactive_rules:
        out.extend(rule.issues)
    return out


@pytest.mark.parametrize(("code", "yaml_text", "md"), CORPUS, ids=[c[0] for c in CORPUS])
def test_loader_messages_carry_their_code(code, yaml_text, md):
    issues = _issues(yaml_text, md)
    codes = {i.code for i in issues}
    assert f"strategy.{code}" in codes, [(i.code, i.message) for i in issues]
    assert OTHER not in codes, [i.message for i in issues if i.code == OTHER]


def test_every_code_is_pinned_by_the_corpus():
    pinned = {f"strategy.{code}" for code, _y, _m in CORPUS}
    assert set(CODES) - {OTHER} == pinned


def test_params_hold_the_variable_parts():
    issues = _issues(T2 + "rules:\n  - { id: d, kind: allocation_drift, params: { buckets: [eqq] } }\n", None)
    issue = next(i for i in issues if i.code == "strategy.unknown_bucket")
    assert issue.params == {"bucket": "eqq", "suggestion": "eq"}
    issue = _issues(H + "data:\n  max_stale_weight: 2\n", None)[0]
    assert issue.params == {
        "key": "max_stale_weight", "range": "at least 0 and at most 1", "value": "2",
        "fraction_hint": " (fractions: 0.15 = 15%)",
    }


def test_issue_code_is_derived_unless_given_and_stays_out_of_equality():
    derived = StrategyIssue(IssueSeverity.ERROR, "version", "version is required", 1, 1)
    assert (derived.code, derived.params) == ("strategy.required", {"key": "version"})
    given = StrategyIssue(IssueSeverity.ERROR, "", "anything", code="strategy.custom", params={"a": "1"})
    assert (given.code, given.params) == ("strategy.custom", {"a": "1"})
    unknown = StrategyIssue(IssueSeverity.WARNING, "", "a brand new sentence")
    assert (unknown.code, unknown.params) == (OTHER, {})
    assert derived == StrategyIssue(IssueSeverity.ERROR, "version", "version is required", 1, 1,
                                    code="x", params={"other": "y"})
    assert hash(derived)  # still hashable (params are not part of the hash)
    assert classify("") == (OTHER, {})


def test_issue_dict_and_the_strategy_endpoint_carry_codes(api):
    d = strategy_service.issue_dict(_issues(H + "horizon_yaers: 5\n", None)[0])
    assert d["code"] == "strategy.unknown_key"
    assert d["params"] == {"key": "horizon_yaers", "suggestion": "horizon_years"}
    assert {"severity", "path", "message", "line", "column"} <= set(d)

    api.put("/api/profiles/default/modules",
            json={"modules": ["budget", "assets", "loans", "investments"]})
    path = inv_files.strategy_yaml_path("default")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(H + "horizon_yaers: 5\nrules:\n  - { id: r, kind: cash_levl }\n", encoding="utf-8")
    body = api.get("/api/p/default/investments/strategy").json()
    assert [(i["code"], i["params"].get("key")) for i in body["issues"]
            if i["code"] == "strategy.unknown_key"] == [("strategy.unknown_key", "horizon_yaers")]
    [inactive] = body["inactive_rules"]
    assert [i["code"] for i in inactive["issues"]] == ["strategy.rule_kind_unknown"]
    assert inactive["issues"][0]["params"]["kind"] == "cash_levl"


def test_import_warning_code_follows_its_kind():
    w = ImportWarning(message="x", kind=ImportWarningKind.INVALID_VALUE)
    assert w.code == "import.invalid_value"
    assert ImportWarning(message="x").code == "import.other"


# --------------------------------------------------------------------------- #
# The frontend label map covers every backend code
# --------------------------------------------------------------------------- #

def _label_keys() -> set[str]:
    text = MESSAGES_TS.read_text(encoding="utf-8")
    return set(re.findall(r'^\s*"([a-z_]+(?:\.[a-z_]+)+)":', text, re.MULTILINE))


def _proposal_error_codes() -> set[str]:
    """Every literal code passed to ProposalError / NotPending in the backend."""
    codes: set[str] = set()
    for path in (ROOT / "src" / "finanse").rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
            if name not in ("ProposalError", "NotPending"):
                continue
            args = [*node.args[1:2], *(k.value for k in node.keywords if k.arg == "code")]
            codes |= {a.value for a in args if isinstance(a, ast.Constant) and isinstance(a.value, str)}
    return codes | {"invalid", "not_pending"}  # the defaults of the two exception classes


def test_frontend_labels_cover_every_backend_code():
    keys = _label_keys()
    assert set(CODES) - {OTHER} <= keys, sorted(set(CODES) - {OTHER} - keys)
    kinds = {f"import.{k.value}" for k in ImportWarningKind if k != ImportWarningKind.OTHER}
    assert kinds <= keys, sorted(kinds - keys)
    from finanse.core import proposals

    summary_kinds = {f"proposal.{k}" for k in proposals.kinds()}
    assert summary_kinds <= keys, sorted(summary_kinds - keys)
    errors = {f"proposal.error.{c}" for c in _proposal_error_codes()}
    assert len(errors) > 10 and errors <= keys, sorted(errors - keys)
