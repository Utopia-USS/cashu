/**
 * Native importer of the canonical `cashu-import` format (format_version 1), CSV and JSON variants.
 *
 * The specification for converter authors is `docs/import-format.md`. Both variants produce the same
 * records (`txn`, `position`, `rename`, `delisting`) and share one strict record validator: every
 * problem is a blocking warning with its row and field, a row with any error is not emitted,
 * suspicious but importable rows get non-blocking warnings.
 */

import { readCsvLines } from "../../../pycsv.js";
import { PY_WS, pySplitlines } from "../../../text.js";
import {
  type BrokerImporter,
  type ImportFile,
  type ImportParseResult,
  importFileExtension,
} from "../contract.js";
import { decodeImportText, ImportTextEncoding } from "../text.js";
import {
  CANONICAL_BROKER_ID,
  CANONICAL_FORMAT,
  CSV_EXTENSIONS,
  JSON_EXTENSIONS,
  LEGACY_FORMAT,
  SNIFF_BYTES,
} from "./constants.js";
import { headerName, parseCanonicalCsv } from "./csvVariant.js";
import { parseCanonicalJson } from "./jsonVariant.js";

/** Python `str.lstrip()` followed by `startswith("{")` and a bounded look for the format name. */
const LEADING_SPACE = new RegExp(`^[${PY_WS}]+`, "u");
const JSON_NAME_WINDOW = 4096;

/** `BrokerImporter` of the `cashu-import` format (CSV and JSON). */
export class CanonicalImporter implements BrokerImporter {
  static readonly PARSER_VERSION = 1;

  readonly brokerId = CANONICAL_BROKER_ID;
  readonly displayName = "cashU import format";
  readonly version = CanonicalImporter.PARSER_VERSION;

  /**
   * CSV: the header has `format_version` and `record` columns. JSON: an object naming the
   * `cashu-import` format near its start.
   */
  canParse(file: ImportFile): boolean {
    const head = file.content.subarray(0, SNIFF_BYTES);
    const decoded = decodeImportText(head, ImportTextEncoding.UTF8, { lenient: true });
    if (!decoded.ok) return false;
    const text = decoded.text;
    const extension = importFileExtension(file);
    if (JSON_EXTENSIONS.includes(extension)) {
      const stripped = text.replace(LEADING_SPACE, "");
      const window = Array.from(stripped).slice(0, JSON_NAME_WINDOW).join("");
      return (
        stripped.startsWith("{") &&
        [CANONICAL_FORMAT, LEGACY_FORMAT].some((name) => window.includes(`"${name}"`))
      );
    }
    if (CSV_EXTENSIONS.includes(extension)) {
      const firstLine = text === "" ? "" : (pySplitlines(text)[0] ?? "");
      const parsed = readCsvLines([firstLine], { delimiter: "," });
      if (!parsed.ok) return false;
      const names = new Set((parsed.rows[0] ?? []).map(headerName));
      return names.has("format_version") && names.has("record");
    }
    return false;
  }

  parse(file: ImportFile): ImportParseResult {
    return JSON_EXTENSIONS.includes(importFileExtension(file))
      ? parseCanonicalJson(file.content)
      : parseCanonicalCsv(file.content);
  }
}
