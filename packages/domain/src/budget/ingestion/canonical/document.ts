/**
 * The `cashu-budget-import` v1 reader (Python `canonical.py`): dispatch between the JSON and CSV
 * variants, the detection used by importer auto-detection, and the value-free validation report.
 * Format spec: `docs/budget-import-format.md`.
 */

import { decodeReplace, decodeStrict } from "../../../codecs.js";
import type { InstitutionRegistry } from "../../../core/index.js";
import type { IsoDate } from "../../../dates.js";
import { readCsvLines } from "../../../pycsv.js";
import { PY_WHITESPACE, pyLower, pySplitlines, pyStripChars, pyUpper } from "../../../text.js";
import type { TxnSource } from "../types.js";
import {
  BUDGET_IMPORT_FORMAT,
  BUDGET_IMPORT_FORMAT_VERSION,
  JSON_EXTENSIONS,
  LEGACY_BUDGET_IMPORT_FORMAT,
  SNIFF_BYTES,
} from "./constants.js";
import { headerName, parseCsvDocument } from "./csvVariant.js";
import { type BudgetIssue, formatIssue, issueAsDict } from "./issues.js";
import { lineColumn, parseJson } from "./json.js";
import {
  type CanonicalResult,
  canonicalOk,
  fileError,
  type Variant,
  validateDocument,
} from "./validate.js";

/** `_extension`: the lower-cased text after the last dot, "" without a dot. */
function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : pyLower(name.slice(dot + 1));
}

const BOM_BYTES = new Set([0xef, 0xbb, 0xbf]);
const ASCII_WS_BYTES = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

/** `content[:SNIFF_BYTES].lstrip(b"\xef\xbb\xbf").lstrip()` starts with `{`. */
function startsLikeJson(content: Uint8Array): boolean {
  const head = content.subarray(0, SNIFF_BYTES);
  let i = 0;
  while (i < head.length && BOM_BYTES.has(head[i] as number)) i++;
  while (i < head.length && ASCII_WS_BYTES.has(head[i] as number)) i++;
  return head[i] === 0x7b;
}

function parseJsonDocument(
  content: Uint8Array,
  source: TxnSource,
  registry: InstitutionRegistry,
): CanonicalResult {
  const decoded = decodeStrict(content, "utf-8-sig");
  if (!decoded.ok) return fileError(`file is not valid UTF-8 (byte ${decoded.start})`, "json");
  const parsed = parseJson(decoded.text);
  if (!parsed.ok) {
    if (parsed.kind === "decode") {
      const { line, column } = lineColumn(decoded.text, parsed.pos);
      return fileError(`file is not valid JSON (line ${line}, column ${column})`, "json");
    }
    if (parsed.kind === "duplicate_key")
      return fileError("file is not valid JSON (a key repeats within one object)", "json");
    return fileError("file is not valid JSON", "json");
  }
  if (!(parsed.value instanceof Map))
    return fileError("the JSON document must be an object", "json");
  return validateDocument(parsed.value, { source, variant: "json", rows: null, registry });
}

/**
 * `parse_budget_document`: JSON when the content starts with `{` (after a BOM and whitespace) or the
 * name ends in `.json`, else CSV. `source` marks the transactions (`"connector"` for a connector's
 * output, `"csv"` for a file the owner uploads).
 */
export function parseBudgetDocument(
  content: Uint8Array,
  name: string,
  opts: { readonly registry: InstitutionRegistry; readonly source?: TxnSource },
): CanonicalResult {
  const source = opts.source ?? "csv";
  if (startsLikeJson(content) || JSON_EXTENSIONS.includes(extension(name))) {
    return parseJsonDocument(content, source, opts.registry);
  }
  return parseCsvDocument(content, source, opts.registry);
}

const PY_WS_CHARS = String.fromCodePoint(...PY_WHITESPACE);

/**
 * `looks_like_budget_document`: JSON naming the format near its start, or a CSV whose first line has
 * the `format_version` and `booking_date` columns. Never throws.
 */
export function looksLikeBudgetDocument(content: Uint8Array, name: string): boolean {
  const head = pyStripChars(decodeReplace(content.subarray(0, SNIFF_BYTES), "utf-8"), "﻿", "left");
  const stripped = pyStripChars(head, PY_WS_CHARS, "left");
  if (stripped.startsWith("{")) {
    const start = Array.from(stripped).slice(0, 4096).join("");
    return [BUDGET_IMPORT_FORMAT, LEGACY_BUDGET_IMPORT_FORMAT].some((f) =>
      start.includes(`"${f}"`),
    );
  }
  if (JSON_EXTENSIONS.includes(extension(name))) return false;
  const firstLine = stripped ? (pySplitlines(stripped)[0] ?? "") : "";
  const parsed = readCsvLines([firstLine], { delimiter: "," });
  if (!parsed.ok) return false;
  const names = new Set((parsed.rows[0] ?? []).map(headerName));
  return names.has("format_version") && names.has("booking_date");
}

/** Value-free validation report of a budget document (Python `BudgetValidationReport`). */
export interface BudgetValidationReport {
  readonly ok: boolean;
  readonly format: string;
  readonly variant: Variant;
  readonly transactions: number;
  readonly balances: number;
  readonly issues: readonly BudgetIssue[];
  readonly dateRange: readonly [IsoDate, IsoDate] | null;
  readonly currencies: readonly string[];
}

/** `validate_budget_document`: parse with the default source, report counts, dates and currencies. */
export function validateBudgetDocument(
  content: Uint8Array,
  name: string,
  registry: InstitutionRegistry,
): BudgetValidationReport {
  const result = parseBudgetDocument(content, name, { registry });
  const txns = result.statement?.transactions ?? [];
  const dates = txns.map((t) => t.bookingDate).sort();
  return {
    ok: canonicalOk(result),
    format: BUDGET_IMPORT_FORMAT,
    variant: result.variant,
    transactions: result.transactions,
    balances: result.balances,
    issues: result.issues,
    dateRange: dates.length ? [dates[0] as IsoDate, dates[dates.length - 1] as IsoDate] : null,
    currencies: [...new Set(txns.map((t) => pyUpper(t.currency)))].sort(),
  };
}

/** `BudgetValidationReport.as_dict()` (snake_case keys as in Python). */
export function reportAsDict(r: BudgetValidationReport): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const issue of r.issues) counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
  return {
    ok: r.ok,
    format: r.format,
    variant: r.variant,
    transactions: r.transactions,
    balances: r.balances,
    date_range: r.dateRange === null ? null : { from: r.dateRange[0], to: r.dateRange[1] },
    currencies: r.currencies,
    issue_counts: counts,
    issues: r.issues.map(issueAsDict),
  };
}

/** `BudgetValidationReport.summary()`: plain value-free lines for a CLI. */
export function reportSummary(r: BudgetValidationReport): string {
  const head =
    `${BUDGET_IMPORT_FORMAT} v${BUDGET_IMPORT_FORMAT_VERSION} (${r.variant}): ${r.ok ? "OK" : "BLOCKED"}, ` +
    `${r.transactions} transactions, ${r.balances} balances`;
  return [
    head,
    ...r.issues.map((i) => `  ${i.blocking ? "error" : "warning"} [${i.kind}] ${formatIssue(i)}`),
  ].join("\n");
}
