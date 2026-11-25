/** Rule tests use the same parsed parameter classes and pure evaluator entry points as strategies. */
import { expect } from "vitest";
import type { PyPlain } from "../../../pyYaml/plain.js";
import { SignalSeverity } from "../../domain/enums.js";
import type { RuleContext } from "../context.js";
import type { RuleKind, RuleSpec } from "../kind.js";
import { Fired, type RuleOutcome, Skipped } from "../outcomes.js";
import { ParamErrors } from "../params.js";
export function spec<P>(kind: string, params: P, id = "r"): RuleSpec<P> {
  return { id, kind, params, severity: SignalSeverity.INFO, cooldownDays: null, polarity: null };
}
export function parse<P>(kind: RuleKind<P>, raw: Record<string, PyPlain>): P {
  const errors = new ParamErrors();
  const result = kind.parseParams(new Map(Object.entries(raw)), errors);
  expect(errors.issues).toEqual([]);
  expect(result).toBeInstanceOf(kind.paramsType);
  return result;
}
export function runKind<P>(kind: RuleKind<P>, ctx: RuleContext, params: P): RuleOutcome[] {
  return [...kind.evaluate(ctx, spec(kind.kind, params))];
}
export function fired(outcome: RuleOutcome | undefined) {
  expect(outcome).toBeInstanceOf(Fired);
  if (!(outcome instanceof Fired)) throw new Error("expected fired outcome");
  return outcome.candidate;
}
export function skipped(outcome: RuleOutcome | undefined): string {
  expect(outcome).toBeInstanceOf(Skipped);
  if (!(outcome instanceof Skipped)) throw new Error("expected skipped outcome");
  return outcome.reason;
}
export const describe = (outcomes: readonly RuleOutcome[]): string[] =>
  outcomes.map((o) => `${o.type} ${o.dedupKey ?? o.ruleId}`);
