// Helpers of the strategy loader tests, the twins of `load` / `issue_at` in
// tests/investments/strategy/test_strategy_loader.py. Test-only.

import { expect } from "vitest";
import { Decimal } from "../../../decimal.js";
import type { RebalancePolicy } from "../../rules/kinds/allocationDrift.js";
import { ruleById, type StrategyConfig } from "../config.js";
import { issueText, type StrategyIssue, type StrategyLoadResult } from "../issues.js";
import { loadStrategy } from "../loader.js";

export const MINIMAL = "version: 1\nbase_currency: PLN\n";

/** `load(yaml_text, md=None)`. */
export function load(yamlText: string, md: string | null = null): StrategyLoadResult {
  return loadStrategy(yamlText, md);
}

/** `issue_at`: the only issue at `path` (fails when there are none or several). */
export function issueAt(result: StrategyLoadResult, path: string): StrategyIssue {
  const matches = result.issues.filter((issue) => issue.path === path);
  expect(
    matches.length,
    `expected one issue at ${JSON.stringify(path)}, got ${JSON.stringify(result.issues.map(issueText))}`,
  ).toBe(1);
  const [issue] = matches;
  if (issue === undefined) throw new Error(`no issue at ${path}`);
  return issue;
}

/** `result.config` where the Python test dereferences it directly (asserts it is not None). */
export function configOf(result: StrategyLoadResult): StrategyConfig {
  expect(result.config, JSON.stringify(result.issues.map(issueText))).not.toBeNull();
  if (result.config === null) throw new Error("no config");
  return result.config;
}

/** `config.rule(id).params`, typed by the caller (Python reads the attributes without a check). */
export function paramsOf<P>(config: StrategyConfig, ruleId: string): P {
  const rule = ruleById(config, ruleId);
  expect(rule, `rule ${ruleId}`).not.toBeNull();
  if (rule === null) throw new Error(`no rule ${ruleId}`);
  return rule.params as P;
}

/** `policy == RebalancePolicy(absolute, relative, Decimal(minTrade))` (Decimal equality is numeric). */
export function expectRebalance(
  policy: RebalancePolicy,
  absoluteBandPp: number,
  relativeBand: number,
  minTradeValue: string,
): void {
  expect([policy.absoluteBandPp, policy.relativeBand]).toEqual([absoluteBandPp, relativeBand]);
  expect(
    policy.minTradeValue.eq(Decimal.parse(minTradeValue)),
    policy.minTradeValue.toString(),
  ).toBe(true);
}

/** Python `str.splitlines()` for `\n` / `\r\n` / `\r` texts (no trailing empty line). */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
