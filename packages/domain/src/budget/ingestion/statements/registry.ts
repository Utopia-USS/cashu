/**
 * Bank statement detection and entry points (Python `csv_import/__init__.py`). Which banks have a CSV
 * parser comes from the institution registry (`csvImporter`), passed in so the domain stays pure.
 */

import { decodeFirst, translateNewlines } from "../../../codecs.js";
import type { InstitutionRegistry } from "../../../core/index.js";
import { DEFAULT_ENCODINGS } from "./delimited.js";
import { ersteScore, looksLikeQuotedErsteExport, parseErste } from "./erste.js";
import { mbankScore, parseMbank } from "./mbank.js";
import { parsePekao, pekaoScore } from "./pekao.js";
import { type BankId, refusing, type StatementResult } from "./result.js";

const CSV_PARSERS: Readonly<
  Record<
    BankId,
    { score: (text: string) => number; parse: (bytes: Uint8Array) => ReturnType<typeof parseMbank> }
  >
> = {
  mbank: { score: mbankScore, parse: parseMbank },
  erste: { score: ersteScore, parse: parseErste },
  pekao: { score: pekaoScore, parse: parsePekao },
};

function isBankId(key: string | null): key is BankId {
  return key !== null && Object.hasOwn(CSV_PARSERS, key);
}

/** The parser key of an institution id, or null when it has no CSV parser here. */
function parserOf(registry: InstitutionRegistry, id: string): BankId | null {
  const key = registry.find(id)?.csvImporter ?? null;
  return isBankId(key) ? key : null;
}

/** `importers()`: the CSV parsers of the registry's institutions, in registry order. */
export function csvBankIds(registry: InstitutionRegistry): BankId[] {
  return registry.csvIds().flatMap((id) => {
    const key = parserOf(registry, id);
    return key === null ? [] : [key];
  });
}

/** `importer.match_score(text)`. */
export function matchScore(bank: BankId, text: string): number {
  return CSV_PARSERS[bank].score(text);
}

/**
 * `detect_importer`: the bank with the strictly highest score above 0 (ties: the first in registry
 * order). PARITY(Q13): the text is read with the default encodings, not the bank's own list.
 * FIX(Q4): only when no bank scores, a quoted Erste export (summary row as a csv record) is Erste.
 */
export function detectBank(bytes: Uint8Array, registry: InstitutionRegistry): BankId | null {
  const decoded = decodeFirst(bytes, DEFAULT_ENCODINGS);
  if (!decoded.ok) return null;
  const text = translateNewlines(decoded.text);
  const banks = csvBankIds(registry);
  let best: BankId | null = null;
  let bestScore = 0;
  for (const bank of banks) {
    const score = matchScore(bank, text);
    if (score > bestScore) {
      best = bank;
      bestScore = score;
    }
  }
  if (best === null && banks.includes("erste") && looksLikeQuotedErsteExport(text)) return "erste";
  return best;
}

/** One bank's parser on the file. */
export function parseBankStatement(bytes: Uint8Array, bank: BankId): StatementResult {
  return refusing(() => CSV_PARSERS[bank].parse(bytes));
}

/** `parse_file`: the given institution's parser, else the detected bank's. */
export function parseStatementFile(
  bytes: Uint8Array,
  registry: InstitutionRegistry,
  bank?: string | null,
): StatementResult {
  if (bank) {
    const key = parserOf(registry, bank);
    return key === null ? { ok: false, reason: "unknown_bank" } : parseBankStatement(bytes, key);
  }
  const detected = detectBank(bytes, registry);
  return detected === null
    ? { ok: false, reason: "not_detected" }
    : parseBankStatement(bytes, detected);
}
