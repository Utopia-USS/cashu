/**
 * `canonical._parse_csv`: one row per transaction, file-level values (account, source) as constant
 * columns. The header is checked first (unknown, duplicate, missing columns), then each row; the
 * rows become the JSON document `_validate` checks. An unknown column is named only when it looks
 * like a column name, so a value from a header-less export never shows in an issue.
 */

import { decodeStrict } from "../../../codecs.js";
import type { InstitutionRegistry } from "../../../core/index.js";
import { looksLikePerson } from "../../../core/index.js";
import { readCsv } from "../../../pycsv.js";
import { pyIsDigit, pyLower, pySplit, pyStrip, pyStripChars, pyUpper } from "../../../text.js";
import type { TxnSource } from "../types.js";
import {
  BUDGET_IMPORT_FORMAT,
  BUDGET_IMPORT_FORMAT_VERSION,
  CSV_COLUMNS,
  CSV_FILE_COLUMNS,
  REQUIRED_CSV_COLUMNS,
} from "./constants.js";
import { type BudgetIssue, budgetIssue } from "./issues.js";
import type { JsonValue } from "./json.js";
import { type CanonicalResult, didYouMean, fileError, validateDocument } from "./validate.js";

/** `_header_name`. */
export function headerName(cell: string): string {
  return pyLower(pyStrip(pyStripChars(pyStrip(cell), "﻿", "left")));
}

const FIELD_LIKE = /^[a-z][a-z0-9_ ]{0,40}$/;

/** `_column_label`: the column's name when it looks like one, else its position. */
function columnLabel(name: string, index: number): string {
  const digits = Array.from(name).filter((c) => pyIsDigit(c.codePointAt(0) as number)).length;
  if (FIELD_LIKE.test(name) && digits < 4 && pySplit(name).length <= 3 && !looksLikePerson(name))
    return name;
  return `column ${index + 1}`;
}

const isBlankRow = (cells: readonly string[]) => cells.every((c) => !pyStrip(c));

export function parseCsvDocument(
  content: Uint8Array,
  source: TxnSource,
  registry: InstitutionRegistry,
): CanonicalResult {
  const decoded = decodeStrict(content, "utf-8-sig");
  if (!decoded.ok) return fileError(`file is not valid UTF-8 (byte ${decoded.start})`, "csv");
  const parsed = readCsv(decoded.text, { delimiter: ",", strict: true, lines: "universal" });
  if (!parsed.ok) return fileError(`file is not valid CSV (line ${parsed.lineNum})`, "csv");
  const records = parsed.rows;
  const first = records[0];
  if (first === undefined || isBlankRow(first))
    return fileError("file is empty (expected a header line)", "csv");

  const header = first.map(headerName);
  if (!header.some((h) => (REQUIRED_CSV_COLUMNS as readonly string[]).includes(h))) {
    // A raw export or a header-less file: its first line is data, never echoed as column names.
    return fileError(
      `no cashu-budget-import header line (expected the columns ${REQUIRED_CSV_COLUMNS.join(", ")})`,
      "csv",
    );
  }
  const issues: BudgetIssue[] = [];
  const seen = new Set<string>();
  header.forEach((column, index) => {
    if (!CSV_COLUMNS.includes(column)) {
      const label = columnLabel(column, index);
      const hint = label === column ? didYouMean(column, CSV_COLUMNS) : "";
      issues.push(budgetIssue("unknown_field", `unknown column${hint}`, null, label));
    } else if (seen.has(column)) {
      issues.push(budgetIssue("file_format", "duplicate column", null, column));
    }
    seen.add(column);
  });
  for (const column of REQUIRED_CSV_COLUMNS) {
    if (!seen.has(column))
      issues.push(budgetIssue("missing_column", "required column is missing", null, column));
  }
  if (issues.length) {
    return {
      statement: null,
      issues,
      variant: "csv",
      source: null,
      institution: null,
      transactionCount: 0,
      closingCount: 0,
    };
  }

  const fileColumns = [...CSV_FILE_COLUMNS.map(([column]) => column), "source"];
  const transactions: Map<string, JsonValue>[] = [];
  const fileValues = new Map<string, string | null>();
  const rowNumbers: number[] = [];
  records.slice(1).forEach((cells, i) => {
    const r = i + 1;
    if (isBlankRow(cells)) return;
    if (cells.length !== header.length) {
      issues.push(
        budgetIssue("file_format", "row has a different number of cells than the header", r),
      );
      return;
    }
    const values = new Map(header.map((h, j) => [h, pyStrip(cells[j] as string)]));
    const version = values.get("format_version");
    values.delete("format_version");
    if (version !== String(BUDGET_IMPORT_FORMAT_VERSION)) {
      issues.push(
        budgetIssue("file_format", `must be ${BUDGET_IMPORT_FORMAT_VERSION}`, r, "format_version"),
      );
      return;
    }
    for (const column of fileColumns) {
      if (!values.has(column)) continue;
      const value = values.get(column) || null;
      values.delete(column);
      if (fileValues.has(column) && fileValues.get(column) !== value) {
        issues.push(budgetIssue("inconsistent_file", "differs from the first row", r, column));
      }
      if (!fileValues.has(column)) fileValues.set(column, value);
    }
    transactions.push(new Map([...values].map(([k, v]) => [k, v || null])));
    rowNumbers.push(r);
  });

  const account = new Map<string, JsonValue>();
  for (const [column, target] of CSV_FILE_COLUMNS) {
    const value = fileValues.get(column);
    if (value !== undefined && value !== null) account.set(target, value);
  }
  if (!account.has("currency")) {
    const currencies = new Set(
      transactions
        .map((t) => pyUpper(pyStrip(String(t.get("currency") ?? ""))))
        .filter((c) => c !== ""),
    );
    if (currencies.size === 1) account.set("currency", [...currencies][0] as string);
    else if (transactions.length) {
      issues.push(
        budgetIssue(
          "missing_column",
          "required when the rows use more than one currency",
          null,
          "account_currency",
        ),
      );
    }
  }
  const document = new Map<string, JsonValue>([
    ["format", BUDGET_IMPORT_FORMAT],
    ["format_version", BigInt(BUDGET_IMPORT_FORMAT_VERSION)],
    ["account", account],
    ["transactions", transactions],
  ]);
  const docSource = fileValues.get("source");
  if (docSource !== undefined && docSource !== null) document.set("source", docSource);
  const result = validateDocument(document, { source, variant: "csv", rows: rowNumbers, registry });
  const blocked = issues.some((i) => i.blocking);
  return {
    ...result,
    issues: [...issues, ...result.issues],
    statement: blocked ? null : result.statement,
  };
}
