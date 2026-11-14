/** Parsed custom parameters shared by parsing and pure evaluation. */
import { Scope } from "../expr/catalogTypes.js";
import type { CompiledExpression } from "../expr/compiled.js";
import { EMPTY_INSTRUMENT_FILTER, type InstrumentFilter } from "../instrumentFilter.js";

export class CustomParams {
  /** null only when parsing failed (the loader then discards the rule). */
  readonly expression: CompiledExpression | null;
  readonly scope: Scope;
  readonly message: string | null;
  /** Scope instrument only. */
  readonly filter: InstrumentFilter;
  /** Scope bucket only: bucket ids to check; empty = every bucket. */
  readonly buckets: readonly string[];
  constructor(init: {
    readonly expression: CompiledExpression | null;
    readonly scope?: Scope;
    readonly message?: string | null;
    readonly filter?: InstrumentFilter;
    readonly buckets?: readonly string[];
  }) {
    this.expression = init.expression;
    this.scope = init.scope ?? Scope.PORTFOLIO;
    this.message = init.message ?? null;
    this.filter = init.filter ?? EMPTY_INSTRUMENT_FILTER;
    this.buckets = init.buckets ?? [];
  }
}
