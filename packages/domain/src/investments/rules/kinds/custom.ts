/**
 * `custom` (`rules/kinds/custom.py`), the parsing side: a user-defined condition in the safe expression
 * language, compiled for its scope. Params: `when` (required), `scope` (portfolio | instrument |
 * bucket, default portfolio), optional `message`; filters `asset_class` / `tags` / `instrument_ids`
 * for scope instrument; `buckets` for scope bucket.
 */

import type { PyPlainMap } from "../../../pyYaml/plain.js";
import { pyLen, pyStrip } from "../../../text.js";
import {
  type CompiledExpression,
  compileExpression,
  ExpressionError,
  bucketReferences as expressionBuckets,
  SCOPES,
  Scope,
} from "../expr/index.js";
import type { RuleKind } from "../kind.js";
import { type ParamErrors, ParamReader } from "../params.js";
import { SignalPolarity } from "../polarity.js";
import { evaluateCustom } from "./customEvaluate.js";
import { CustomParams } from "./customParams.js";
import { INSTRUMENT_FILTER_KEYS, readInstrumentFilter } from "./support.js";

export const MAX_MESSAGE_LENGTH = 200;

export { CustomParams } from "./customParams.js";

export const CUSTOM = "custom";

/** `CustomParams.bucket_references`: every bucket id the rule names (`buckets` plus literals in `when`). */
export function customBucketReferences(params: CustomParams): readonly string[] {
  const refs = [...params.buckets];
  if (params.expression !== null) {
    for (const [bucket] of expressionBuckets(params.expression)) refs.push(bucket);
  }
  return [...new Set(refs)];
}

export const customRule: RuleKind<CustomParams> = Object.freeze({
  kind: CUSTOM,
  defaultPolarity: SignalPolarity.NEUTRAL, // the owner sets polarity per rule
  paramsType: CustomParams,
  evaluate: evaluateCustom,
  parseParams(raw: PyPlainMap, errors: ParamErrors): CustomParams {
    const reader = new ParamReader(raw, errors);
    const errorCount = errors.errorCount;
    const scope = reader.enumValue("scope", SCOPES, Scope.PORTFOLIO);
    const scopeOk = errors.errorCount === errorCount;
    const when = reader.optionalString("when");
    const message = reader.optionalString("message");
    const filter = readInstrumentFilter(reader);
    const buckets = reader.strings("buckets");
    reader.finish();

    let expression: CompiledExpression | null = null;
    if (when === null) {
      if (!reader.has("when")) {
        errors.error("when", 'when is required: a condition such as "weight > 10%"');
      }
    } else if (scopeOk) {
      try {
        expression = compileExpression(when, scope);
      } catch (error) {
        if (!(error instanceof ExpressionError)) throw error;
        errors.errorAt(
          "when",
          `${error.message} (column ${error.column} of the expression)`,
          error.column - 1,
        );
      }
    }
    if (message !== null) {
      const trimmed = pyStrip(message);
      if (!trimmed) errors.error("message", "message must not be empty");
      else if (pyLen(message) > MAX_MESSAGE_LENGTH || trimmed.includes("\n")) {
        errors.error(
          "message",
          `message must be one line of at most ${MAX_MESSAGE_LENGTH} characters`,
        );
      }
    }
    if (scope !== Scope.INSTRUMENT) {
      for (const key of INSTRUMENT_FILTER_KEYS) {
        if (reader.has(key)) errors.error(key, `${key} only applies to scope instrument`);
      }
    }
    if (scope !== Scope.BUCKET && reader.has("buckets")) {
      errors.error("buckets", "buckets only applies to scope bucket");
    }
    return new CustomParams({
      expression,
      scope,
      message: message ? pyStrip(message) : null,
      filter,
      buckets,
    });
  },
});
