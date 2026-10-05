"""Stable machine-readable codes for strategy issues (``StrategyIssue.code`` / ``.params``).

The loader, the param readers of the rule kinds and the YAML checks write one English sentence per
problem. The app shows these sentences translated, so every issue also carries a stable ``code``
(``strategy.<name>``) and the variable parts of the sentence as ``params`` (bucket ids, keys, values,
did-you-mean hints). The code is derived here from the sentence templates in one place, so the message
sites stay as they are; ``tests/test_message_codes.py`` pins every template below (a reworded message
fails the test instead of silently losing its code). An issue that matches no template gets
``strategy.other`` and the app falls back to the English text.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

OTHER = "strategy.other"

_HINT = r'(?: \(did you mean "(?P<suggestion>[^"]*)"\?\))?'
_KEY = r"(?P<key>[A-Za-z0-9_.\[\]-]+)"

# (code, pattern) in match order: specific templates before the generic ones they overlap with.
_TEMPLATES: tuple[tuple[str, str], ...] = (
    # --- the YAML document --------------------------------------------------------------------
    (
        "yaml_too_large",
        r"strategy\.yaml is too large \((?P<chars>\d+) characters, max (?P<max>\d+)\)$",
    ),
    (
        "yaml_duplicate_key",
        r'Invalid YAML: duplicate mapping key "(?P<key>[^"]*)" \(first defined on line (?P<first_line>\d+)\)',
    ),
    ("yaml_too_deep", r"Invalid YAML: the document is nested too deeply$"),
    ("yaml_too_deep", r"strategy\.yaml is nested too deeply \(max (?P<max>\d+) levels\)$"),
    ("yaml_invalid", r"Invalid YAML: (?P<problem>.+)$"),
    ("yaml_alias", r"YAML anchors and aliases \(& and \*\) are not supported$"),
    ("yaml_merge_key", r"YAML merge keys \(<<\) are not supported$"),
    ("yaml_tag", r"Unsupported YAML tag (?P<tag>\S+)$"),
    ("yaml_key_not_text", r"Mapping keys must be plain text$"),
    ("empty", r"strategy\.yaml is empty"),
    ("not_mapping", r"strategy\.yaml must be a mapping"),
    ("md_empty", r"strategy\.md is empty"),
    # --- header -------------------------------------------------------------------------------
    (
        "version_unsupported",
        r"Unsupported version (?P<version>\S+) \(supported: (?P<supported>[^)]*)\)$",
    ),
    ("base_currency_required", r"base_currency is required"),
    ("currency_invalid", r'"(?P<value>[^"]*)" is not a three-letter ISO currency code$'),
    ("base_currency_not_pln", r"Only PLN is fully supported as base currency"),
    # --- buckets ------------------------------------------------------------------------------
    ("buckets_not_list", r"buckets must be a list of \{id, match\} entries$"),
    ("bucket_not_mapping", r"Each bucket must be a mapping with id and match$"),
    ("bucket_id_required", r"Bucket id is required$"),
    ("id_invalid", r'(?P<what>Bucket|Rule|Benchmark) id "(?P<id>[^"]*)" may only contain'),
    (
        "id_duplicate",
        r'Duplicate (?P<what>bucket|rule) id "(?P<id>[^"]*)" \(first defined on line (?P<first_line>\d+)\)$',
    ),
    ("match_required", r"match is required"),
    ("bucket_catch_all", r'Bucket "(?P<bucket>[^"]*)" matches every instrument'),
    ("no_cash_bucket", r"No bucket matches asset_class: cash"),
    # --- allocation ---------------------------------------------------------------------------
    ("targets_missing", r"Buckets are defined but allocation\.targets is missing$"),
    ("allocation_not_mapping", r"allocation must be a mapping with targets and rebalance$"),
    ("targets_required", r"allocation\.targets is required"),
    ("targets_not_mapping", r"allocation\.targets must be a mapping of bucket id -> weight$"),
    ("target_unknown_bucket", r'Target references undefined bucket "(?P<bucket>[^"]*)"' + _HINT),
    (
        "target_invalid",
        r"Target of (?P<bucket>\S+) must be a number between 0 and 1 \(0\.6 = 60%\), got (?P<value>.*)$",
    ),
    ("targets_sum", r"Targets sum to (?P<sum>[\d.]+), expected 1"),
    ("target_missing", r'Bucket "(?P<bucket>[^"]*)" has no target in allocation\.targets'),
    # --- rules --------------------------------------------------------------------------------
    ("rules_not_list", r"rules must be a list of \{id, kind, params\} entries$"),
    ("rule_not_mapping", r"Each rule must be a mapping with id, kind and optional params$"),
    ("rule_id_required", r"Rule id is required$"),
    ("rule_kind_required", r"Rule kind is required; known: (?P<known>.*)$"),
    (
        "rule_kind_unknown",
        r'Unknown rule kind "(?P<kind>[^"]*)"' + _HINT + r"; known: (?P<known>.*)$",
    ),
    ("params_not_mapping", r"params must be a mapping$"),
    ("rebalance_without_drift", r"Rebalance bands are only checked by an allocation_drift rule"),
    ("drift_needs_targets", r"allocation_drift needs buckets and allocation\.targets$"),
    ("custom_bucket_needs_targets", r"custom rules with scope bucket need buckets"),
    (
        "unknown_bucket",
        r'Unknown bucket "(?P<bucket>[^"]*)"'
        + r'(?: \(did you mean "(?P<suggestion>[^"]*)"\?\)| \(no buckets are defined\))?'
        + r"(?: \(column (?P<column>\d+) of the expression\))?$",
    ),
    ("contribution_gap_needs_plan", r"contribution_gap needs a contributions: plan"),
    ("when_required", r"when is required"),
    ("expression_invalid", r"(?P<detail>.+) \(column (?P<column>\d+) of the expression\)$"),
    ("message_empty", r"message must not be empty$"),
    ("message_too_long", r"message must be one line of at most (?P<max>\d+) characters$"),
    ("scope_only", r"(?P<key>\S+) only applies to scope (?P<scope>\w+)$"),
    ("tags_required", r"tags is required"),
    ("cash_level_needs_bound", r"cash_level needs min_weight, max_weight or both$"),
    ("min_below_max", r"(?P<key>\S+) must be below (?P<other>\S+)$"),
    # --- benchmark, notifications, watchlist --------------------------------------------------
    ("benchmark_id_required", r"benchmark\.id is required"),
    ("benchmark_proxy_required", r"benchmark\.proxy is required"),
    ("benchmark_proxy_empty", r"benchmark\.proxy must not be empty$"),
    ("benchmark_one_currency", r"benchmark\.currency must be one currency code$"),
    (
        "unknown_choice",
        r'Unknown (?P<what>severity|weekday) "(?P<value>[^"]*)"'
        + _HINT
        + r"; allowed: (?P<allowed>.*)$",
    ),
    ("watchlist_not_mapping", r"watchlist must be a mapping with criteria$"),
    ("criteria_not_mapping", r"watchlist\.criteria must be a mapping of criterion -> number$"),
    ("criterion_unknown", r'Unknown criterion "(?P<key>[^"]*)"' + _HINT + r"; it is kept"),
    # --- generic param templates (ParamReader) ------------------------------------------------
    ("unknown_key", r'Unknown key "(?P<key>[^"]*)"' + _HINT + r"; it is ignored$"),
    (
        "unknown_asset_class",
        r'Unknown asset class "(?P<value>[^"]*)"' + _HINT + r"; known: (?P<allowed>.*)$",
    ),
    (
        "unknown_value",
        r'Unknown value "(?P<value>[^"]*)" for ' + _KEY + _HINT + r"; allowed: (?P<allowed>.*)$",
    ),
    ("required", _KEY + r" is required$"),
    ("not_number", _KEY + r" must be a number, got (?P<value>.*)$"),
    ("not_whole_number", _KEY + r" must be a whole number, got (?P<value>.*)$"),
    ("not_finite", _KEY + r" must be a finite number$"),
    ("not_text_list", _KEY + r" must be text or a list of texts, got (?P<value>.*)$"),
    ("not_text", _KEY + r" must be text, got (?P<value>.*)$"),
    ("not_mapping_key", _KEY + r" must be a mapping$"),
    (
        "out_of_range",
        _KEY
        + r" must be (?P<range>(?:at least|greater than|at most|less than) .+?), got (?P<value>\S+?)"
        + r"(?P<fraction_hint> \(fractions: 0\.15 = 15%\))?$",
    ),
)

_COMPILED = tuple((f"strategy.{code}", re.compile(pattern)) for code, pattern in _TEMPLATES)

CODES: tuple[str, ...] = tuple(dict.fromkeys(code for code, _ in _COMPILED)) + (OTHER,)
"""Every code an issue can carry (the app's label map covers these)."""


def classify(message: str) -> tuple[str, dict[str, str]]:
    """(code, params) of one issue message; ``(OTHER, {})`` when no template matches."""
    for code, pattern in _COMPILED:
        match = pattern.match(message or "")
        if match:
            return code, {k: v for k, v in match.groupdict().items() if v is not None}
    return OTHER, {}


def params_dict(params: Mapping[str, str] | None) -> dict[str, str]:
    return dict(params or {})
