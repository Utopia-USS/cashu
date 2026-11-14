/**
 * mBank CSV / statement export (Python `csv_import/mbank.py`): Windows-1250, `;`-delimited, a preamble
 * declaring the account (`#Numer rachunku`) and currency (`#Waluta`), then
 * `#Data księgowania;#Data operacji;#Opis operacji;#Tytuł;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji`.
 * Every string below is matching data, byte-identical to Python (checked by `matchingData.test.ts`).
 */

import type { PyCodec } from "../../../codecs.js";
import { pyLower, pySplitlines, pyStrip, pyStripChars } from "../../../text.js";
import { findAccountNumber } from "../plFormats.js";
import type { ParsedStatement } from "../types.js";
import { type ColumnMap, parseDelimited, type StatementMeta } from "./delimited.js";

/** @package PARITY(Q3): cp1250 FIRST, so a UTF-8 mBank file decodes as mojibake, as in Python. */
export const MBANK_ENCODINGS: readonly PyCodec[] = ["cp1250", "utf-8-sig", "iso-8859-2", "utf-8"];
/** @package */
export const MBANK_DELIMITERS: readonly string[] = [";", ","];
/** @package */
export const MBANK_SIGNATURE: readonly string[] = [
  "mbank s.a",
  "#data operacji",
  "elektroniczne zestawienie operacji",
];
/** @package */
export const MBANK_COLMAP: ColumnMap = {
  booking_date: ["data księgowania", "data operacji", "data transakcji"],
  amount: ["kwota operacji", "kwota"],
  value_date: ["data operacji", "data waluty"],
  counterparty: ["nadawca/odbiorca", "kontrahent", "nadawca", "odbiorca"],
  description: ["opis operacji", "opis"],
  title: ["tytuł", "tytul", "szczegóły", "szczegoly"],
  // mBank labels the counterparty account "#Numer konta".
  counterparty_iban: ["numer konta", "numer rachunku kontrahenta", "rachunek kontrahenta"],
  currency: ["waluta"],
  balance: ["saldo po operacji", "saldo"],
  debit: [],
  credit: [],
};
/** @package Case-sensitive line prefixes of the preamble (`startswith` on the stripped line). */
export const MBANK_META_MARKERS = { account: "#Numer rachunku", currency: "#Waluta" } as const;

/**
 * `extract_meta`: the line after `#Numer rachunku` holds the account, the line after `#Waluta` the
 * currency (taken as is, PARITY(Q7)); the last occurrence wins. Evaluated on the whole text.
 */
function extractMeta(text: string): StatementMeta {
  const lines = pySplitlines(text);
  let account: string | null = null;
  let currency = "PLN";
  lines.forEach((line, i) => {
    const s = pyStrip(line);
    const next = lines[i + 1];
    if (next === undefined) return;
    if (s.startsWith(MBANK_META_MARKERS.account)) {
      account = findAccountNumber(next) ?? account;
    } else if (s.startsWith(MBANK_META_MARKERS.currency)) {
      const cur = pyStrip(pyStripChars(pyStrip(next), ";"));
      if (cur) currency = cur;
    }
  });
  return { accountNumber: account, origin: account === null ? null : "preamble", currency };
}

/** How strongly the text looks like an mBank export (signature hits). */
export function mbankScore(text: string): number {
  const low = pyLower(text);
  return MBANK_SIGNATURE.filter((sig) => low.includes(pyLower(sig))).length;
}

export function parseMbank(bytes: Uint8Array): ParsedStatement {
  return parseDelimited(bytes, {
    bank: "mbank",
    encodings: MBANK_ENCODINGS,
    delimiters: MBANK_DELIMITERS,
    colmap: MBANK_COLMAP,
    extractMeta,
  });
}
