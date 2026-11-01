/** Portfolio/bucket weights and reviewed custom expressions, reusing the pure rule machinery. */
import { D, floatRepr } from "../../decimal.js";
import { ASSET_CLASSES } from "../domain/index.js";
import {
  bucketNamed,
  bucketWord,
  CustomParams,
  customRule,
  expr,
  Fired,
  formatPct,
  InstrumentPosition,
  noAllocationProblem,
  portfolioDataProblem,
  RATIO_EPSILON,
  Skipped,
  unclassifiedProblem,
} from "../rules/index.js";
import { alertStrings as s } from "./evaluate.strings.js";
import { basePayload, fired, label, language, notFired, skip } from "./evaluateSupport.js";
import { floatParameter, parameter, parameterText } from "./parameters.js";
import {
  type AlertCheck,
  type AlertData,
  type AlertDefinition,
  alertRuleId,
  alertSignalKind,
} from "./types.js";

export function portfolioEvaluate(alert: AlertDefinition, data: AlertData): AlertCheck {
  const lang = language(data);
  if (data.ctx == null) return skip(alert, s.notValued[lang]);
  const ctx = { ...data.ctx, lang };
  if (alert.kind === "custom") {
    const expression = expr.compileExpression(
      parameterText(parameter(alert, "expression")),
      alert.scope,
    );
    if (alert.scope === "instrument" && alert.instrument == null)
      return skip(alert, s.noInstrument[lang]);
    const params = new CustomParams({
      expression,
      scope: alert.scope,
      ...(alert.scope === "instrument"
        ? {
            filter: {
              assetClasses: new Set(ASSET_CLASSES),
              tags: [],
              instrumentIds: new Set(alert.instrument == null ? [] : [alert.instrument.id]),
            },
          }
        : {}),
      ...(alert.scope === "bucket" ? { buckets: [parameterText(alert.params.bucket)] } : {}),
    });
    const outcomes = [
      ...customRule.evaluate(ctx, {
        id: alertRuleId(alert.id),
        kind: "custom",
        params,
        severity: alert.severity ?? "info",
        cooldownDays: null,
        polarity: null,
      }),
    ];
    const outcome = outcomes[0];
    if (outcome === undefined) return notFired(alert, { ...basePayload(alert), held: false }, null);
    if (outcome instanceof Skipped) return skip(alert, outcome.reason);
    if (outcome.type === "not_fired")
      return notFired(alert, { ...basePayload(alert), ...outcome.details }, null);
    return {
      outcome: new Fired({
        ...outcome.candidate,
        kind: alertSignalKind(alert.kind),
        dedupKey: alertRuleId(alert.id),
        message: `${alert.title}: ${outcome.candidate.message}`,
        payload: { ...basePayload(alert), ...outcome.candidate.payload },
        polarity: alert.polarity ?? "neutral",
        instrumentId: alert.instrument?.id ?? null,
      }),
      value: null,
    };
  }
  const problem = portfolioDataProblem(ctx);
  if (problem !== null) return skip(alert, problem);
  const threshold = floatParameter(parameter(alert, "threshold")),
    above = alert.kind === "weight_above";
  const payload: Record<string, unknown> = { ...basePayload(alert), threshold, unit: "ratio" };
  let weight: number, subject: string;
  if (alert.scope === "bucket") {
    const bucket = parameterText(alert.params.bucket);
    payload.bucket_id = bucket;
    const issue = unclassifiedProblem(ctx);
    if (issue !== null) return skip(alert, issue);
    const allocation = ctx.allocations.find((a) => a.bucketId === bucket);
    if (allocation === undefined)
      return skip(alert, `${noAllocationProblem(bucket, lang)} ${s.allocationSuffix[lang]}`);
    if (allocation.cashHistoryGap)
      return skip(alert, s.bucketGap[lang](bucketNamed(s.bucketOf[lang], bucket)));
    weight = allocation.weight;
    subject = bucketNamed(bucketWord(lang), bucket);
  } else {
    const inst = alert.instrument;
    if (inst == null) return skip(alert, s.noInstrument[lang]);
    const holdings = ctx.portfolio.valued.filter((h) => h.instrument.id === inst.id);
    subject = label(alert);
    if (holdings.length) {
      const position = new InstrumentPosition(
        inst,
        holdings,
        ctx.portfolio.missingFxCurrencies,
        lang,
      );
      const issue = position.priceProblem;
      if (issue !== null || position.weight === null)
        return skip(alert, issue ?? s.noWeight[lang](subject));
      weight = position.weight;
    } else weight = 0;
    payload.held = holdings.length > 0;
  }
  payload.weight = weight;
  const value = D(floatRepr(weight));
  if (!(above ? weight > threshold + RATIO_EPSILON : weight < threshold - RATIO_EPSILON))
    return notFired(alert, payload, value);
  return fired(
    alert,
    s.weight[lang](subject, formatPct(weight, lang), above, formatPct(threshold, lang)),
    payload,
    value,
  );
}
