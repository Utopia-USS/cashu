/**
 * Stable machine-readable codes for strategy issues (`strategy/codes.py`): every issue carries a code
 * (`strategy.<name>`) and the variable parts of its English sentence as `params`, derived here from the
 * sentence templates in one place. The patterns are Python's, translated by `pyRegex` (a digit class
 * is a Unicode digit, `$` also matches before a final newline); Python's inline `(?s:...)` group is
 * written out as `(?:.|\n)`.
 * An issue that matches no template gets `strategy.other`.
 */

import { pyRegex } from "../../pyRegex.js";

export const OTHER = "strategy.other";

const HINT = String.raw`(?: \(did you mean "(?<suggestion>[^"]*)"\?\))?`;
const KEY = String.raw`(?<key>[A-Za-z0-9_.\[\]-]+)`;

/** (code, Python pattern) in match order: specific templates before the generic ones they overlap. */
const TEMPLATES: readonly (readonly [string, string])[] = [
  [
    "yaml_too_large",
    String.raw`strategy\.yaml is too large \((?<chars>\d+) characters, max (?<max>\d+)\)$`,
  ],
  [
    "yaml_duplicate_key",
    String.raw`Invalid YAML: duplicate mapping key "(?<key>[^"]*)" \(first defined on line (?<first_line>\d+)\)`,
  ],
  ["yaml_too_deep", "Invalid YAML: the document is nested too deeply$"],
  ["yaml_too_deep", String.raw`strategy\.yaml is nested too deeply \(max (?<max>\d+) levels\)$`],
  ["yaml_invalid", String.raw`Invalid YAML: (?<problem>[^\n]+)(?:\n(?:.|\n)*)?$`],
  ["yaml_alias", String.raw`YAML anchors and aliases \(& and \*\) are not supported$`],
  ["yaml_merge_key", String.raw`YAML merge keys \(<<\) are not supported$`],
  ["yaml_tag", String.raw`Unsupported YAML tag (?<tag>\S+)$`],
  ["yaml_key_not_text", "Mapping keys must be plain text$"],
  ["empty", String.raw`strategy\.yaml is empty`],
  ["not_mapping", String.raw`strategy\.yaml must be a mapping`],
  ["md_empty", String.raw`strategy\.md is empty`],
  [
    "version_unsupported",
    String.raw`Unsupported version (?<version>\S+) \(supported: (?<supported>[^)]*)\)$`,
  ],
  ["base_currency_required", "base_currency is required"],
  ["currency_invalid", '"(?<value>[^"]*)" is not a three-letter ISO currency code$'],
  ["base_currency_not_pln", "Only PLN is fully supported as base currency"],
  ["buckets_not_list", String.raw`buckets must be a list of \{id, match\} entries$`],
  ["bucket_not_mapping", "Each bucket must be a mapping with id and match$"],
  ["bucket_id_required", "Bucket id is required$"],
  ["id_invalid", '(?<what>Bucket|Rule|Benchmark) id "(?<id>[^"]*)" may only contain'],
  [
    "id_duplicate",
    String.raw`Duplicate (?<what>bucket|rule) id "(?<id>[^"]*)" \(first defined on line (?<first_line>\d+)\)$`,
  ],
  ["match_required", "match is required"],
  ["bucket_catch_all", 'Bucket "(?<bucket>[^"]*)" matches every instrument'],
  ["no_cash_bucket", "No bucket matches asset_class: cash"],
  ["targets_missing", String.raw`Buckets are defined but allocation\.targets is missing$`],
  ["allocation_not_mapping", "allocation must be a mapping with targets and rebalance$"],
  ["targets_required", String.raw`allocation\.targets is required`],
  [
    "targets_not_mapping",
    String.raw`allocation\.targets must be a mapping of bucket id -> weight$`,
  ],
  ["target_unknown_bucket", `Target references undefined bucket "(?<bucket>[^"]*)"${HINT}`],
  [
    "target_invalid",
    String.raw`Target of (?<bucket>\S+) must be a number between 0 and 1 \(0\.6 = 60%\), got (?<value>.*)$`,
  ],
  ["targets_sum", String.raw`Targets sum to (?<sum>[\d.]+), expected 1`],
  ["target_missing", String.raw`Bucket "(?<bucket>[^"]*)" has no target in allocation\.targets`],
  ["rules_not_list", String.raw`rules must be a list of \{id, kind, params\} entries$`],
  ["rule_not_mapping", "Each rule must be a mapping with id, kind and optional params$"],
  ["rule_id_required", "Rule id is required$"],
  ["rule_kind_required", "Rule kind is required; known: (?<known>.*)$"],
  ["rule_kind_unknown", `Unknown rule kind "(?<kind>[^"]*)"${HINT}; known: (?<known>.*)$`],
  ["params_not_mapping", "params must be a mapping$"],
  ["rebalance_without_drift", "Rebalance bands are only checked by an allocation_drift rule"],
  ["drift_needs_targets", String.raw`allocation_drift needs buckets and allocation\.targets$`],
  ["custom_bucket_needs_targets", "custom rules with scope bucket need buckets"],
  [
    "unknown_bucket",
    String.raw`Unknown bucket "(?<bucket>[^"]*)"(?: \(did you mean "(?<suggestion>[^"]*)"\?\)| \(no buckets are defined\))?(?: \(column (?<column>\d+) of the expression\))?$`,
  ],
  ["contribution_gap_needs_plan", "contribution_gap needs a contributions: plan"],
  ["when_required", "when is required"],
  ["expression_invalid", String.raw`(?<detail>.+) \(column (?<column>\d+) of the expression\)$`],
  ["message_empty", "message must not be empty$"],
  ["message_too_long", String.raw`message must be one line of at most (?<max>\d+) characters$`],
  ["scope_only", String.raw`(?<key>\S+) only applies to scope (?<scope>\w+)$`],
  ["tags_required", "tags is required"],
  ["cash_level_needs_bound", "cash_level needs min_weight, max_weight or both$"],
  ["min_below_max", String.raw`(?<key>\S+) must be below (?<other>\S+)$`],
  ["benchmark_id_required", String.raw`benchmark\.id is required`],
  ["benchmark_proxy_required", String.raw`benchmark\.proxy is required`],
  ["benchmark_proxy_empty", String.raw`benchmark\.proxy must not be empty$`],
  ["benchmark_one_currency", String.raw`benchmark\.currency must be one currency code$`],
  [
    "unknown_choice",
    `Unknown (?<what>severity|weekday) "(?<value>[^"]*)"${HINT}; allowed: (?<allowed>.*)$`,
  ],
  ["watchlist_not_mapping", "watchlist must be a mapping with criteria$"],
  [
    "criteria_not_mapping",
    String.raw`watchlist\.criteria must be a mapping of criterion -> number$`,
  ],
  ["criterion_unknown", `Unknown criterion "(?<key>[^"]*)"${HINT}; it is kept`],
  ["unknown_key", `Unknown key "(?<key>[^"]*)"${HINT}; it is ignored$`],
  ["unknown_asset_class", `Unknown asset class "(?<value>[^"]*)"${HINT}; known: (?<allowed>.*)$`],
  ["unknown_value", `Unknown value "(?<value>[^"]*)" for ${KEY}${HINT}; allowed: (?<allowed>.*)$`],
  ["required", `${KEY} is required$`],
  ["not_number", `${KEY} must be a number, got (?<value>.*)$`],
  ["not_whole_number", `${KEY} must be a whole number, got (?<value>.*)$`],
  ["not_finite", `${KEY} must be a finite number$`],
  ["not_text_list", `${KEY} must be text or a list of texts, got (?<value>.*)$`],
  ["not_text", `${KEY} must be text, got (?<value>.*)$`],
  ["not_mapping_key", `${KEY} must be a mapping$`],
  [
    "out_of_range",
    String.raw`${KEY} must be (?<range>(?:at least|greater than|at most|less than) .+?), got (?<value>\S+?)(?<fraction_hint> \(fractions: 0\.15 = 15%\))?$`,
  ],
];

const COMPILED: readonly (readonly [string, RegExp])[] = TEMPLATES.map(
  ([code, pattern]) => [`strategy.${code}`, pyRegex(`^(?:${pattern})`)] as const,
);

/** Every code an issue can carry (the app's label map covers these). */
export const CODES: readonly string[] = [...new Set(COMPILED.map(([code]) => code)), OTHER];

/** `classify`: (code, params) of one issue message; `[OTHER, {}]` when no template matches. */
export function classify(message: string): readonly [string, Readonly<Record<string, string>>] {
  for (const [code, pattern] of COMPILED) {
    const match = pattern.exec(message);
    if (match === null) continue;
    const params: Record<string, string> = {};
    for (const [name, value] of Object.entries(match.groups ?? {})) {
      if (value !== undefined) params[name] = value;
    }
    return [code, params];
  }
  return [OTHER, {}];
}
