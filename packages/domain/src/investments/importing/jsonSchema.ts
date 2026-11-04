/**
 * The JSON Schema of the `cashu-import` document, JSON variant (`docs/schemas/cashu-import.v1.json`).
 *
 * It is built from the importer's field tables (there is no model to derive it from): the top-level
 * keys, the record fields allowed per record kind, value formats and limits. `importSchemaText()` is
 * byte for byte the file in `docs/schemas/`; `importing/jsonSchema.test.ts` checks that, and
 * `apps/host/scripts/genConnectorSchemas.ts` writes it.
 */

import { InvariantError, TXN_TYPES } from "../domain/index.js";
import {
  CANONICAL_FORMAT,
  CANONICAL_FORMAT_VERSION,
  MAX_ACCOUNT_HINT,
  MAX_NAME,
  MAX_NOTE,
  MAX_REF,
  MAX_SOURCE,
  MAX_SYMBOL,
  RECORD_FIELDS,
  RECORD_KINDS,
} from "./canonical/index.js";

export const SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";
/** The published file name of the schema, as its `$id`. */
export const IMPORT_SCHEMA_FILE = "cashu-import.v1.json";

type SchemaNode = { readonly [key: string]: unknown };

const DECIMAL: SchemaNode = {
  description: "a decimal number: a JSON number or a string with '.' as decimal separator",
  anyOf: [{ type: "number" }, { type: "string", pattern: "^-?[0-9]+(\\.[0-9]+)?$" }],
};
const DATE: SchemaNode = { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" };
const CURRENCY: SchemaNode = { type: "string", pattern: "^[A-Z]{3}$" };
const ISIN: SchemaNode = { type: "string", pattern: "^[A-Z]{2}[A-Z0-9]{9}[0-9]$" };

const text = (limit: number): SchemaNode => ({ type: "string", maxLength: limit });

/** A JSON Schema `if` / `then` pair. */
function ifThen(condition: SchemaNode, consequence: SchemaNode): SchemaNode {
  return {
    if: condition,
    // biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema keyword of a plain data object, never awaited
    then: consequence,
  };
}

/** The schema of every record field, in the order of `RECORD_FIELDS`. */
function recordFields(): Record<string, SchemaNode> {
  const fields: Record<string, SchemaNode> = {
    record: { enum: [...RECORD_KINDS] },
    date: DATE,
    time: { type: "string", pattern: "^[0-9]{2}:[0-9]{2}(:[0-9]{2})?$" },
    settle_date: DATE,
    type: { enum: [...TXN_TYPES] },
    external_ref: text(MAX_REF),
    symbol: text(MAX_SYMBOL),
    isin: ISIN,
    name: text(MAX_NAME),
    exchange: text(MAX_SYMBOL),
    quantity: DECIMAL,
    price: DECIMAL,
    currency: CURRENCY,
    gross_amount: DECIMAL,
    fee: DECIMAL,
    tax: DECIMAL,
    cash_amount: DECIMAL,
    cash_currency: CURRENCY,
    fx_rate: DECIMAL,
    split_ratio: DECIMAL,
    avg_price: DECIMAL,
    market_value: DECIMAL,
    new_symbol: text(MAX_SYMBOL),
    new_isin: ISIN,
    new_exchange: text(MAX_SYMBOL),
    new_name: text(MAX_NAME),
    frozen: { anyOf: [{ type: "boolean" }, { enum: ["true", "false"] }] },
    note: text(MAX_NOTE),
  };
  const missing = [...RECORD_FIELDS.keys()].filter((name) => !(name in fields));
  if (missing.length > 0) {
    // A new field in the importer must get a schema entry here.
    throw new InvariantError(`no schema for record fields: ${missing.join(", ")}`);
  }
  return fields;
}

/** The `cashu-import` JSON Schema as an object (key order is the file's). */
export function importSchema(): SchemaNode {
  const perKind = RECORD_KINDS.map((kind) =>
    ifThen(
      { properties: { record: { const: kind } } },
      {
        propertyNames: {
          enum: [...RECORD_FIELDS].filter(([, kinds]) => kinds.has(kind)).map(([name]) => name),
        },
      },
    ),
  );
  return {
    $schema: SCHEMA_DRAFT,
    $id: IMPORT_SCHEMA_FILE,
    title: "cashU investments import document (cashu-import), format_version 1",
    description:
      "Built from the importer's field tables (packages/domain/src/investments/importing/canonical) by apps/host/scripts/genConnectorSchemas.ts; see docs/import-format.md (also the CSV variant). The app also enforces what a schema cannot express: real calendar dates, the instrument and quantity rules per transaction type, cash sign rules, gross / fee / tax / cash consistency.",
    type: "object",
    additionalProperties: false,
    required: ["format", "format_version", "records"],
    properties: {
      format: { const: CANONICAL_FORMAT },
      format_version: { const: CANONICAL_FORMAT_VERSION },
      source: { type: "string", pattern: "^[a-z][a-z0-9_]*$", maxLength: MAX_SOURCE },
      account_hint: text(MAX_ACCOUNT_HINT),
      records: { type: "array", items: { $ref: "#/$defs/record" } },
    },
    $defs: {
      record: {
        type: "object",
        required: ["record", "date"],
        properties: recordFields(),
        additionalProperties: false,
        allOf: perKind,
      },
    },
  };
}

/**
 * The file text of the schema (two-space indent, non-ASCII kept, a final newline). The schema holds
 * only plain ASCII keys, strings and integers, where `JSON.stringify` prints the published bytes.
 */
export function importSchemaText(): string {
  return `${JSON.stringify(importSchema(), null, 2)}\n`;
}
