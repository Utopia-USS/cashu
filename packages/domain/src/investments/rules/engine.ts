/** Configured order, runtime parameter classes, and whole-rule isolation of broken evaluators. */
import { RuleCatalog } from "./catalog.js";
import type { RuleContext } from "./context.js";
import type { RuleSpec } from "./kind.js";
import { Fired, NotFired, type RuleOutcome, Skipped } from "./outcomes.js";

function parameterType(value: unknown): string {
  if (value == null) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  return value.constructor?.name === "Object" ? "dict" : (value.constructor?.name ?? typeof value);
}
export class RulesEngine {
  readonly rules: readonly RuleSpec[];
  readonly #catalog: RuleCatalog;
  constructor(rules: readonly RuleSpec[], catalog: RuleCatalog = RuleCatalog.builtIn()) {
    this.rules = [...rules];
    this.#catalog = catalog;
  }
  evaluate(ctx: RuleContext): RuleOutcome[] {
    return this.rules.flatMap((spec) => this.#evaluateOne(ctx, spec));
  }
  #evaluateOne(ctx: RuleContext, spec: RuleSpec): RuleOutcome[] {
    const kind = this.#catalog.get(spec.kind);
    if (kind === null) return [new Skipped(spec.id, `Unknown rule kind "${spec.kind}"`)];
    if (!(spec.params instanceof kind.paramsType))
      return [
        new Skipped(
          spec.id,
          `Rule params have the wrong type (${parameterType(spec.params)}, expected ${kind.paramsType.name})`,
        ),
      ];
    let outcomes: RuleOutcome[];
    try {
      outcomes = [...kind.evaluate(ctx, spec)];
    } catch (error) {
      return [
        new Skipped(
          spec.id,
          `Rule failed: ${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ];
    }
    if (!outcomes.length) return [new NotFired(spec.id, null, { scopes: 0 })];
    const foreign = outcomes.find((outcome) => outcome.ruleId !== spec.id);
    if (foreign)
      return [new Skipped(spec.id, `Rule returned an outcome for rule "${foreign.ruleId}"`)];
    return outcomes.map((outcome) =>
      outcome instanceof Fired
        ? new Fired({ ...outcome.candidate, polarity: spec.polarity ?? kind.defaultPolarity })
        : outcome,
    );
  }
}
