/**
 * The few importing names that readers and hand-entry commands need without the import pipeline: the
 * importer id normalization, the generic CSV broker id, cash amount derivation and the exchange hint
 * lookup. A separate entry (`@cashu/domain/investments/importing/names`) because Metro bundles whole
 * files and the phone does not tree-shake: the `importing` barrel brings the CSV / JSON parsers, the
 * JSON Schema and the plan.
 */

export { canonicalImporterId } from "./canonical/constants.js";
export { deriveAmounts } from "./cash.js";
export { exchangeForHint } from "./exchanges.js";

/** Broker id (and alias namespace) of the generic CSV importer when a mapping sets no `broker_id`. */
export const GENERIC_CSV_BROKER_ID = "generic_csv";
