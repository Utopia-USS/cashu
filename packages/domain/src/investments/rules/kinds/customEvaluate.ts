/** All three custom-rule scopes over the real typed expression evaluator and metrics. */
import { isGenericBucket } from "../../domain/buckets.js";
import type { RuleContext } from "../context.js";
import { Scope } from "../expr/catalogTypes.js";
import { normalized } from "../expr/compiled.js";
import { evaluateExpression } from "../expr/evaluator.js";
import { MetricEnv } from "../expr/metrics.js";
import type { RuleSpec } from "../kind.js";
import {
  candidate,
  Fired,
  NotFired,
  type RuleOutcome,
  Skipped,
  signalDedupKey,
} from "../outcomes.js";
import type { CustomParams } from "./customParams.js";
import { jsonValues, privateLabels, shownValues } from "./customValues.js";
import { kindStrings as s } from "./evaluate.strings.js";
import {
  bucketWord,
  type InstrumentPosition,
  noAllocationProblem,
  noAllocations,
  positionsByInstrument,
} from "./support.js";

function outcome(
  ctx: RuleContext,
  spec: RuleSpec<CustomParams>,
  env: MetricEnv,
  key: string,
  position: InstrumentPosition | null,
  payload: Readonly<Record<string, unknown>>,
): RuleOutcome {
  const expression = spec.params.expression;
  if (expression === null) throw new Error("custom expression missing");
  const evaluation = evaluateExpression(expression, (ref) => env.resolve(ref), ctx.lang);
  if (evaluation.result === null) return new Skipped(spec.id, evaluation.reasons.join("; "), key);
  const details = {
    ...payload,
    scope: spec.params.scope,
    when: normalized(expression),
    values: jsonValues(evaluation),
  };
  if (!evaluation.result) return new NotFired(spec.id, key, details);
  const hidden = privateLabels(expression);
  const condition = hidden.size
    ? s.conditionMet[ctx.lang]
    : `${s.conditionMet[ctx.lang]}: ${normalized(expression)}`;
  let text = spec.params.message || condition;
  if (position !== null) text = `${position.label}: ${text}`;
  else if (env.bucketId !== null && isGenericBucket(env.bucketId))
    text = `${bucketWord(ctx.lang)} ${env.bucketId}: ${text}`;
  const shown = shownValues(evaluation, ctx.portfolio.baseCurrency, hidden, ctx.lang);
  return new Fired(
    candidate(spec, key, shown ? `${text} (${shown}).` : `${text}.`, details, position?.id ?? null),
  );
}
export function evaluateCustom(ctx: RuleContext, spec: RuleSpec<CustomParams>): RuleOutcome[] {
  const params = spec.params;
  if (params.expression === null) return [new Skipped(spec.id, s.compileFailed[ctx.lang])];
  switch (params.scope) {
    case Scope.PORTFOLIO:
      return [outcome(ctx, spec, new MetricEnv(ctx), signalDedupKey(spec.id), null, {})];
    case Scope.INSTRUMENT:
      return positionsByInstrument(ctx, params.filter).map((p) =>
        outcome(
          ctx,
          spec,
          new MetricEnv(ctx, { position: p }),
          signalDedupKey(spec.id, { instrumentId: p.id }),
          p,
          p.payload(),
        ),
      );
    case Scope.BUCKET: {
      if (!ctx.allocations.length) return [new Skipped(spec.id, noAllocations(ctx.lang))];
      const ids = params.buckets.length ? params.buckets : ctx.allocations.map((a) => a.bucketId);
      const byId = new Map(ctx.allocations.map((a) => [a.bucketId, a]));
      return ids.map((id): RuleOutcome => {
        const key = signalDedupKey(spec.id, { scope: id });
        const allocation = byId.get(id);
        return allocation === undefined
          ? new Skipped(spec.id, noAllocationProblem(id, ctx.lang), key)
          : outcome(ctx, spec, new MetricEnv(ctx, { bucketId: id, allocation }), key, null, {
              bucket_id: id,
            });
      });
    }
  }
}
