/**
 * Shared pieces of the rule kinds (`rules/kinds/support.py`), the parsing side: the per-instrument
 * filter as the params read it, and the canonical text of a Decimal. Evaluation helpers arrive with
 * the rules engine (S15b).
 */

import type { Decimal } from "../../../decimal.js";
import type { AssetClass } from "../../domain/enums.js";
import { asInstrumentId, type InstrumentId } from "../../domain/values.js";
import type { ParamReader } from "../params.js";

/**
 * Per-instrument rule filters (`asset_class`, `tags`, `instrument_ids`), combined by AND (same
 * semantics as bucket `match`). Cash-like instruments are left out unless `asset_class` names `cash`.
 */
export interface InstrumentFilter {
  readonly assetClasses: ReadonlySet<AssetClass>;
  readonly tags: readonly string[];
  readonly instrumentIds: ReadonlySet<InstrumentId>;
}

export const INSTRUMENT_FILTER_KEYS = ["asset_class", "tags", "instrument_ids"] as const;

export const EMPTY_INSTRUMENT_FILTER: InstrumentFilter = Object.freeze({
  assetClasses: new Set<AssetClass>(),
  tags: [],
  instrumentIds: new Set<InstrumentId>(),
});

/** `InstrumentFilter.read`. */
export function readInstrumentFilter(reader: ParamReader): InstrumentFilter {
  return {
    assetClasses: reader.assetClasses("asset_class"),
    tags: reader.strings("tags"),
    instrumentIds: new Set(reader.strings("instrument_ids").map(asInstrumentId)),
  };
}

/** `decimal_text`: canonical plain text of a Decimal (`7000`, `0.1`: no exponent, no trailing 0). */
export function decimalText(value: Decimal): string {
  if (value.isZero()) return "0";
  return value.normalize().format("f");
}
