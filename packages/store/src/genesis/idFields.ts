// The id-field vocabulary of the genesis guard walker (S26 spec 6.5, R5): JSON object keys that hold
// local row ids in Python data. A copy of the Python app's canonical `FIELD_TABLES` (spec 6.5 puts the
// vocabulary here; idFields.test.ts pins every entry).

/** Key -> the Python table whose local ids it holds (canon.py `FIELD_TABLES`). */
const FIELD_TABLES: ReadonlyMap<string, string> = new Map([
  ["profile_id", "profiles"],
  ["account_id", "accounts"],
  ["account_ids", "accounts"],
  ["instrument_id", "inv_instruments"],
  ["instrument_ids", "inv_instruments"],
  ["old_instrument_id", "inv_instruments"],
  ["new_instrument_id", "inv_instruments"],
  ["signal_id", "inv_signals"],
  ["signal_ids", "inv_signals"],
  ["alert_id", "alerts"],
  ["alert_ids", "alerts"],
  ["thesis_id", "inv_theses"],
  ["topic_thesis_id", "inv_topic_theses"],
  ["note_id", "research_notes"],
  ["note_ids", "research_notes"],
  ["decision_id", "inv_decisions"],
  ["decision_ids", "inv_decisions"],
  ["loan_id", "loans"],
  ["version_id", "inv_strategy_versions"],
  ["strategy_version_id", "inv_strategy_versions"],
  ["proposal_id", "proposals"],
  ["deposit_id", "inv_planned_deposits"],
  ["review_id", "reviews"],
  ["valuation_id", "inv_manual_valuations"],
  ["created_run_id", "inv_rule_runs"],
  ["last_run_id", "inv_rule_runs"],
  ["rule_run_id", "inv_rule_runs"],
  ["research_run_id", "research_runs"],
  ["new_signal_ids", "inv_signals"],
  ["open_txn_id", "inv_transactions"],
  ["close_txn_id", "inv_transactions"],
  ["batch_id", "inv_import_batches"],
  ["import_batch_id", "inv_import_batches"],
  ["item_id", "watchlist_items"],
  ["run_id", "research_runs"],
  ["running_run_id", "research_runs"],
  ["watchlist_item_id", "watchlist_items"],
  ["watch_item_id", "watchlist_items"],
]);

/** Suffixes that make any key an id key (`previous_instrument_id`, `lead_note_ids`, ...). */
const ID_SUFFIXES = ["instrument_id", "signal_id", "account_id", "alert_id", "note_id"] as const;

/**
 * The table whose ids `key` holds, or undefined when `key` is not an id key: the vocabulary, plus
 * any key ending in `_<suffix>` / `_<suffix>s` of the common id suffixes (as the parity guard reads it).
 */
export function idFieldTable(key: string): string | undefined {
  const found = FIELD_TABLES.get(key);
  if (found !== undefined) return found;
  for (const suffix of ID_SUFFIXES) {
    if (key.endsWith(`_${suffix}`) || key.endsWith(`_${suffix}s`)) return FIELD_TABLES.get(suffix);
  }
  return undefined;
}

/** A `|`-separated part of a signal / plan / research key holding a local id (gid.md 6). */
export const KEY_PART_RE = /^(i|a):([0-9]+)$/;
/** A whole alert key or rule id `alert:<id>` (gid.md 6). */
export const ALERT_KEY_RE = /^alert:([0-9]+)$/;

const DIGITS = /^[1-9][0-9]*$/;

/** A JSON object (not an array, not null). */
export function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A local row id inside JSON: an integer, or its digit string without a leading zero (some payloads
 * store ids as text); anything else (booleans, fractions, names) is not an id. Mirrors the parity
 * check's `_row_id`, so genesis and the golden agree on what an id is.
 */
export function rowIdOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value === "string" && DIGITS.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}
