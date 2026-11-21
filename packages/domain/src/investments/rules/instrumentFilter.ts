/**
 * Instrument filter types, defaults and parsing (`rules/kinds/support.py`).
 */

import type { AssetClass } from "../domain/enums.js";
import { asInstrumentId, type InstrumentId } from "../domain/values.js";
import type { ParamReader } from "./params.js";

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
