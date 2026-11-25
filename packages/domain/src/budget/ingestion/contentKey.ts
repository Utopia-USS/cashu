/**
 * The budget dedup content key and hash v2 (gid.md 4.4): Python `normalize.base_hash` without its
 * leading `str(account_id) + "|"`. Every part is byte-identical to Python's, so a v2 hash can be
 * recomputed from stored columns. Also `merchant_key` (`normalize.merchant_key`).
 */

import { format2 } from "../../decimal.js";
import { ibanKey } from "../../iban.js";
import { sha1Hex } from "../../sha1.js";
import { normalizeText, PY_WS, pyStrip, pyUpper } from "../../text.js";
import { memo, type RawTransaction } from "./types.js";

export type HashInput = Pick<
  RawTransaction,
  | "bookingDate"
  | "amount"
  | "currency"
  | "counterpartyIban"
  | "counterpartyName"
  | "description"
  | "reference"
>;

/**
 * `date|amount .2f|CURRENCY|counterparty|memo`: PARITY(Q10) the amount through `format(d, ".2f")`
 * (half-even, `-0.00` kept); the currency only upper-cased (Q7); the counterparty is the account key,
 * else the normalised name; `source`, bank id and value date are deliberately left out.
 */
export function contentKeyV2(t: HashInput): string {
  return [
    t.bookingDate,
    format2(t.amount),
    pyUpper(t.currency),
    ibanKey(t.counterpartyIban) || normalizeText(t.counterpartyName),
    normalizeText(memo(t)),
  ].join("|");
}

/** sha1 hex of the UTF-8 content key. */
export function dedupHashV2(t: HashInput): string {
  return sha1Hex(contentKeyV2(t));
}

/** Python `$` without MULTILINE: the end, or just before a final `\n`. */
const PY_END = "(?=\\n?(?![\\s\\S]))";

/**
 * `re.compile(r"DATA TRANSAKCJI:.*$", re.IGNORECASE)`. Python's IGNORECASE is not JS `/i` (it also
 * folds `s` with U+017F, `k` with U+212A, `i` with U+0130 / U+0131), so each letter is the explicit
 * class Python matches (pinned by `budget-matching-data.jsonl`). `.` is any code point but `\n`.
 */
/** @package Code points Python's IGNORECASE matches for each character of `DATA TRANSAKCJI:`. */
export const TX_DATE_SUFFIX_CLASSES: readonly (readonly number[])[] = [
  [0x44, 0x64],
  [0x41, 0x61],
  [0x54, 0x74],
  [0x41, 0x61],
  [0x20],
  [0x54, 0x74],
  [0x52, 0x72],
  [0x41, 0x61],
  [0x4e, 0x6e],
  [0x53, 0x73, 0x17f],
  [0x41, 0x61],
  [0x4b, 0x6b, 0x212a],
  [0x43, 0x63],
  [0x4a, 0x6a],
  [0x49, 0x69, 0x130, 0x131],
  [0x3a],
];
const cpClass = (cps: readonly number[]) =>
  `[${cps.map((cp) => `\\u{${cp.toString(16)}}`).join("")}]`;
const TX_DATE_SUFFIX = new RegExp(
  `${TX_DATE_SUFFIX_CLASSES.map(cpClass).join("")}[^\\n]*${PY_END}`,
  "gu",
);
/**
 * Python `re.sub(r"DATA TRANSAKCJI:.*$", "", s, flags=re.IGNORECASE)`: mBank's transaction date
 * suffix removed (Python IGNORECASE folding, `.` not `\n`, `$` also before a final `\n`). Shared
 * by `merchantKey` and the reclassify signature (`reclassify._DATES`).
 */
export function stripTxDateSuffix(s: string): string {
  return s.replace(TX_DATE_SUFFIX, "");
}
const LOCATION_PADDING = new RegExp(`[${PY_WS}]{2,}[^\\n]*${PY_END}`, "gu");

/**
 * A stable merchant identifier from title / counterparty fields: mBank's `DATA TRANSAKCJI: <date>`
 * suffix and the trailing location padding cut, then normalised; the first non-empty result.
 */
export function merchantKey(...fields: readonly (string | null | undefined)[]): string {
  for (const f of fields) {
    if (!f) continue;
    const s = normalizeText(stripTxDateSuffix(f).replace(LOCATION_PADDING, ""));
    if (s) return s;
  }
  return "";
}

const DISPLAY_WS = new RegExp(`[${PY_WS}]+`, "gu");

/**
 * The display name of the field `merchantKey` keys on (same arguments, same order, same field):
 * mBank's `DATA TRANSAKCJI: <date>` suffix and the trailing location padding cut, whitespace runs
 * folded to one space, case and diacritics kept. `normalizeText(merchantName(...f)) === merchantKey(...f)`
 * for every input, so a payee shown with this name is exactly the merchant a rule on its key covers.
 */
export function merchantName(...fields: readonly (string | null | undefined)[]): string {
  for (const f of fields) {
    if (!f) continue;
    const cut = stripTxDateSuffix(f).replace(LOCATION_PADDING, "");
    if (normalizeText(cut)) return pyStrip(cut.replace(DISPLAY_WS, " "));
  }
  return "";
}
