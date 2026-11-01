/** Custom-rule measured payloads and owner-facing values (`custom.py`). */
import type { UiLang } from "../../../core/i18n.js";
import { isGenericBucket } from "../../domain/buckets.js";
import { Unit } from "../expr/catalogTypes.js";
import {
  bucketReferences,
  type CompiledExpression,
  metricLabel,
  specOf,
} from "../expr/compiled.js";
import { type Evaluation, Unknown, type Value } from "../expr/evaluator.js";
import { kindStrings as s } from "./evaluate.strings.js";
import { decimalText, formatAmount, formatDecimal, formatPct, formatPp } from "./support.js";

function unit(label: string): Unit {
  return specOf(label.split("(", 1)[0] ?? label).unit;
}
function jsonValue(label: string, value: Value): unknown {
  if (value instanceof Unknown) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  switch (unit(label)) {
    case Unit.RATIO:
    case Unit.PP:
      return value.toFloat();
    case Unit.DAYS:
    case Unit.COUNT:
      return Number(value.toBigInt());
    default:
      return decimalText(value);
  }
}
export function jsonValues(evaluation: Evaluation): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    [...evaluation.values].map(([label, value]) => [label, jsonValue(label, value)]),
  );
}
export function privateLabels(expression: CompiledExpression): ReadonlySet<string> {
  const refs = bucketReferences(expression).filter(([bucket]) => !isGenericBucket(bucket));
  return new Set(
    expression.metrics
      .filter((ref) =>
        ref.args.some(
          (arg) =>
            typeof arg === "string" &&
            refs.some(([bucket, column]) => arg === bucket && ref.column === column),
        ),
      )
      .map(metricLabel),
  );
}
function format(label: string, value: Value, currency: string, lang: UiLang): string {
  if (value instanceof Unknown) return s.unknown[lang];
  if (typeof value === "boolean") return value ? s.yes[lang] : s.no[lang];
  if (typeof value === "string") return value;
  switch (unit(label)) {
    case Unit.RATIO:
      return formatPct(value.toFloat(), lang);
    case Unit.PP:
      return formatPp(value.toFloat(), lang);
    case Unit.AMOUNT:
      return `${formatAmount(value, lang)} ${currency}`;
    case Unit.DAYS:
    case Unit.COUNT:
      return formatAmount(value, lang);
    default:
      return formatDecimal(value, lang);
  }
}
export function shownValues(
  evaluation: Evaluation,
  currency: string,
  hide: ReadonlySet<string>,
  lang: UiLang,
): string {
  return [...evaluation.values]
    .filter(([label]) => !hide.has(label))
    .map(([label, value]) => `${label} ${format(label, value, currency, lang)}`)
    .join(", ");
}
