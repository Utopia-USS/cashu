// An agent's proposed rule written into the owner's strategy.yaml: the rendered entry reads back as
// the same data, the merge keeps the owner's comments and other keys, ids are generated and checked,
// and the resulting strategy is refused when it breaks a rule. Synthetic text only.
import { loadStrategy } from "@cashu/domain/investments/strategy";
import { safeLoadYaml } from "@cashu/domain/pyYaml";
import { describe, expect, it } from "vitest";
import {
  checkResultingStrategy,
  existingProposalRuleIds,
  mergeProposalRule,
  proposalRuleEntry,
  renderProposalRule,
  StrategyProposalError,
} from "./proposalRuleText.js";

const entry = (message: string) => ({
  id: "new_rule",
  kind: "custom",
  params: { scope: "portfolio", when: "cash_weight > 0.1", message },
});

/** The YAML text as plain data (mappings as objects). */
function load(text: string): unknown {
  const out = safeLoadYaml(text);
  if (!out.ok) throw new Error("synthetic YAML does not load");
  const plain = (value: unknown): unknown =>
    value instanceof Map
      ? Object.fromEntries([...value].map(([k, v]) => [String(k), plain(v)]))
      : Array.isArray(value)
        ? value.map(plain)
        : value;
  return plain(out.value);
}

const BASE = `version: 1
base_currency: PLN
buckets: [{id: cash, match: {asset_class: cash}}]
allocation: {targets: {cash: 1.0}}
`;

function refusal(after: string, before: string, own?: string) {
  try {
    checkResultingStrategy(loadStrategy(after, null), loadStrategy(before, null), own);
  } catch (error) {
    expect(error).toBeInstanceOf(StrategyProposalError);
    return (error as StrategyProposalError).code;
  }
  throw new Error("expected a refusal");
}

describe("proposal rule text", () => {
  it.each([
    "plain text",
    "a: b",
    "yes",
    "two\nlines",
    "apostrophe's text",
    "",
    "trailing\n",
    "zażółć gęślą jaźń",
  ])("a rendered rule reads back as the same entry: %j", (message) => {
    expect(load(renderProposalRule(entry(message)))).toEqual([entry(message)]);
  });

  it("merges into the rules list and keeps the owner's comments and keys", () => {
    const rule = entry("plain text");
    const cases = [
      "version: 1\n",
      "version: 1\nrules: [] # synthetic\n# footer\n",
      "version: 1\nrules:\n  # retain\n  - id: old\n    kind: cash_level\n\nother: null\n",
      "version: 1\nrules: [{id: old, kind: cash_level}]\n",
    ];
    for (const yaml of cases) {
      const merged = mergeProposalRule(yaml, rule);
      const parsed = load(merged) as { rules: unknown[]; other?: unknown };
      expect(parsed.rules.at(-1)).toEqual(rule);
      expect(parsed.rules).toHaveLength(yaml.includes("id: old") ? 2 : 1);
      for (const comment of ["# retain", "# footer"])
        if (yaml.includes(comment)) expect(merged).toContain(comment);
      if (yaml.includes("other:")) expect(parsed).toHaveProperty("other", null);
    }
    expect([...existingProposalRuleIds(cases[2] ?? "")]).toEqual(["old"]);
    expect([...existingProposalRuleIds(cases[1] ?? "")]).toEqual([]);
  });

  it("generates the next free id, refuses a taken one and turns an expression into a custom rule", () => {
    expect(proposalRuleEntry(" cash_level ", { max_weight: 0.2 }, new Set())).toMatchObject({
      entry: { id: "agent_cash_level_1", kind: "cash_level", params: { max_weight: 0.2 } },
      expression: null,
    });
    expect(() =>
      proposalRuleEntry(
        "cash_level",
        { id: "agent_cash_level_1", max_weight: 0.2 },
        new Set(["agent_cash_level_1"]),
      ),
    ).toThrow("a rule with id agent_cash_level_1 already exists; choose another id");
    expect(
      proposalRuleEntry(
        "cash_weight > 0",
        { scope: "portfolio", severity: "warning", cooldown_days: 7 },
        new Set(),
      ),
    ).toMatchObject({
      entry: {
        id: "agent_custom_1",
        kind: "custom",
        severity: "warning",
        cooldown_days: 7,
        params: { scope: "portfolio", when: "cash_weight > 0" },
      },
      expression: "cash_weight > 0",
    });
  });

  it("refuses a resulting strategy that breaks rules, warns about rules already broken", () => {
    const bad = `${BASE}rules:\n  - id: old_bad\n    kind: not_a_kind\n`;
    const clean = `${BASE}rules: []\n`;
    expect(
      checkResultingStrategy(loadStrategy(clean, null), loadStrategy(clean, null), undefined),
    ).toEqual([]);
    expect(
      checkResultingStrategy(loadStrategy(bad, null), loadStrategy(bad, null), undefined),
    ).toEqual([
      {
        code: "inactive_rule",
        rule_id: "old_bad",
        message: "rule old_bad was already inactive before this change; fix it in strategy.yaml",
      },
    ]);
    expect(refusal(bad, clean)).toBe("rules_made_inactive");
    expect(refusal(bad, clean, "old_bad")).toBe("rule_invalid");
    expect(refusal(clean.replace("version: 1", "version: 99"), clean)).toBe("invalid_strategy");
  });
});
