/** The JSON variant of the canonical format (`parse_canonical_json`). */

import { Decimal } from "../../../decimal.js";
import { type JsonValue, lineColumn, parseJson } from "../../../pyJson.js";
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
import {
  CANONICAL_FORMAT,
  CANONICAL_FORMAT_VERSION,
  FILE_FIELDS,
  JSON_TOP_LEVEL_KEYS,
  LEGACY_FORMAT,
} from "./constants.js";
import { fileError } from "./csvVariant.js";
import { rawText, type Value } from "./recordReader.js";
import { ResultBuilder } from "./resultBuilder.js";

const isObject = (value: JsonValue | undefined): value is ReadonlyMap<string, JsonValue> =>
  value instanceof Map;
const isArray = (value: JsonValue | undefined): value is readonly JsonValue[] =>
  Array.isArray(value);

/** A single JSON value as a field value: text is trimmed, empty text is "no value". */
function scalar(
  value: Exclude<JsonValue, ReadonlyMap<string, JsonValue> | readonly JsonValue[]>,
): Value {
  if (typeof value === "string") return pyStrip(value) || null;
  // `integers: "decimal"` never yields a bigint; the branch keeps the type total.
  return typeof value === "bigint" ? Decimal.fromInt(value) : value;
}

/** Parse a canonical JSON file (see `docs/import-format.md`). */
export function parseCanonicalJson(content: Uint8Array): ImportParseResult {
  const decoded = decodeImportText(content, ImportTextEncoding.UTF8);
  if (!decoded.ok) {
    return fileError(`File is not valid UTF-8 (${decoded.reason} at byte ${decoded.start})`);
  }
  // `parse_int=Decimal`: every number is read exactly, integers included.
  const parsed = parseJson(decoded.text, { integers: "decimal" });
  if (!parsed.ok) {
    switch (parsed.kind) {
      case "decode": {
        const { line, column } = lineColumn(decoded.text, parsed.pos);
        return fileError(`File is not valid JSON (line ${line}, column ${column}: ${parsed.msg})`);
      }
      case "duplicate_key":
        return fileError(`File is not valid JSON (duplicate key "${parsed.key}")`);
      case "value":
        return fileError(
          `File is not valid JSON (${parsed.reason === "constant" ? `${parsed.detail} is not a valid number` : parsed.detail})`,
        );
    }
  }
  const document = parsed.value;
  if (!isObject(document)) return fileError("The JSON document must be an object");

  const problems: ImportWarning[] = [];
  for (const key of document.keys()) {
    if (!JSON_TOP_LEVEL_KEYS.includes(key)) {
      problems.push(
        blockingWarning(
          null,
          `Unknown key "${key}"${didYouMean(key, JSON_TOP_LEVEL_KEYS)}`,
          ImportWarningKind.UNKNOWN_FIELD,
        ),
      );
    }
  }
  const format = document.get("format");
  if (format !== CANONICAL_FORMAT && format !== LEGACY_FORMAT) {
    // legacy name accepted
    problems.push(
      blockingWarning(null, `format: must be "${CANONICAL_FORMAT}"`, ImportWarningKind.FILE_FORMAT),
    );
  }
  const version = document.get("format_version");
  if (!(version instanceof Decimal) || !version.eq(Decimal.fromInt(CANONICAL_FORMAT_VERSION))) {
    problems.push(
      blockingWarning(
        null,
        `format_version: must be the number ${CANONICAL_FORMAT_VERSION}`,
        ImportWarningKind.FILE_FORMAT,
      ),
    );
  }
  const records = document.get("records");
  if (!isArray(records)) {
    problems.push(
      blockingWarning(
        null,
        "records: must be an array of record objects",
        ImportWarningKind.FILE_FORMAT,
      ),
    );
  }
  const builder = new ResultBuilder();
  for (const key of ["source", "account_hint"]) {
    const value = document.get(key);
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") problems.push(blockingWarning(null, `${key}: must be a string`));
    else builder.fileValue(null, key, pyStrip(value) || null);
  }
  if (problems.length > 0 || !isArray(records)) return importParseResult({ warnings: problems });

  records.forEach((record, row) => {
    if (!isObject(record)) {
      builder.error(row, "Record must be a JSON object", ImportWarningKind.FILE_FORMAT);
      return;
    }
    const values = new Map<string, Value>();
    let bad = false;
    for (const [key, value] of record) {
      if (FILE_FIELDS.includes(key)) {
        builder.error(
          row,
          `${key}: belongs at the top level of the document`,
          ImportWarningKind.UNKNOWN_FIELD,
        );
        bad = true;
        continue;
      }
      if (isObject(value) || isArray(value)) {
        builder.error(row, `${key}: must be a single value`);
        bad = true;
        continue;
      }
      values.set(key, scalar(value));
    }
    if (bad) return;
    builder.record(row, values, new Map([...values].map(([key, value]) => [key, rawText(value)])));
  });
  return builder.result();
}
