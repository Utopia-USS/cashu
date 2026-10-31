/** The CSV variant of the canonical format (`parse_canonical_csv`). */

import { csvErrorMessage, readCsv } from "../../../pycsv.js";
import { pyStrip } from "../../../text.js";
import {
  blockingWarning,
  type ImportParseResult,
  type ImportWarning,
  ImportWarningKind,
  importParseResult,
} from "../contract.js";
import { didYouMean } from "../didYouMean.js";
import { decodeImportText, ImportTextEncoding } from "../text.js";
import { CANONICAL_FORMAT_VERSION, CSV_COLUMNS, REQUIRED_CSV_COLUMNS } from "./constants.js";
import type { Value } from "./recordReader.js";
import { ResultBuilder } from "./resultBuilder.js";

/** `_header_name`: a header cell without BOM characters and surrounding whitespace. */
export function headerName(cell: string): string {
  return pyStrip(cell.replaceAll("﻿", ""));
}

/** `_file_error`: a file that cannot be read at all. */
export function fileError(message: string): ImportParseResult {
  return importParseResult({
    warnings: [blockingWarning(null, message, ImportWarningKind.FILE_FORMAT)],
  });
}

/** Parse a canonical CSV file (see `docs/import-format.md`). */
export function parseCanonicalCsv(content: Uint8Array): ImportParseResult {
  const decoded = decodeImportText(content, ImportTextEncoding.UTF8);
  if (!decoded.ok) {
    return fileError(`File is not valid UTF-8 (${decoded.reason} at byte ${decoded.start})`);
  }
  const parsed = readCsv(decoded.text, { delimiter: ",", strict: true, lines: "universal" });
  if (!parsed.ok) {
    return fileError(
      `File is not valid CSV (line ${parsed.lineNum}: ${csvErrorMessage(parsed.reason, ",")})`,
    );
  }
  const records = parsed.rows;
  const first = records[0];
  if (first === undefined || first.every((cell) => pyStrip(cell) === "")) {
    return fileError("File is empty (expected a header line)");
  }

  const header = first.map(headerName);
  const problems: ImportWarning[] = [];
  const seen = new Set<string>();
  for (const name of header) {
    if (!CSV_COLUMNS.includes(name)) {
      problems.push(
        blockingWarning(
          null,
          `Unknown column "${name}"${didYouMean(name, CSV_COLUMNS)}`,
          ImportWarningKind.UNKNOWN_FIELD,
        ),
      );
    } else if (seen.has(name)) {
      problems.push(
        blockingWarning(null, `Duplicate column "${name}"`, ImportWarningKind.FILE_FORMAT),
      );
    }
    seen.add(name);
  }
  for (const required of REQUIRED_CSV_COLUMNS) {
    if (!seen.has(required)) {
      problems.push(
        blockingWarning(
          null,
          `Missing required column "${required}"`,
          ImportWarningKind.MISSING_COLUMN,
        ),
      );
    }
  }
  if (problems.length > 0) return importParseResult({ warnings: problems });

  const builder = new ResultBuilder();
  records.slice(1).forEach((cells, row) => {
    if (cells.every((cell) => pyStrip(cell) === "")) return;
    if (cells.length !== header.length) {
      builder.error(
        row,
        `Row has ${cells.length} cells but the header has ${header.length}`,
        ImportWarningKind.FILE_FORMAT,
      );
      return;
    }
    const values = new Map<string, Value>();
    let version: string | null = null;
    for (const [index, name] of header.entries()) {
      const value = pyStrip(cells[index] as string) || null;
      if (name === "format_version") version = value;
      else if (name === "source") builder.fileValue(row, "source", value);
      else if (name === "account_hint") builder.fileValue(row, "account_hint", value);
      else values.set(name, value);
    }
    if (version !== String(CANONICAL_FORMAT_VERSION)) {
      const got = version === null ? "empty" : `"${version}"`;
      builder.error(
        row,
        `format_version: must be ${CANONICAL_FORMAT_VERSION} (got ${got})`,
        ImportWarningKind.FILE_FORMAT,
      );
      return;
    }
    builder.record(
      row,
      values,
      new Map(header.map((name, index) => [name, cells[index] as string])),
    );
  });
  return builder.result();
}
