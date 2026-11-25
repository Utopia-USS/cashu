/**
 * The JSON Schema of the `cashu-budget-import` document, JSON variant
 * (`docs/schemas/cashu-budget-import.v1.json`).
 *
 * Built from the validator's tables in `constants.ts` (field orders, limits, patterns) in the shape the
 * file was first published in (pydantic's: every field titled, schema keys sorted, optional fields as
 * `anyOf [value, null]` with `default: null`). `budgetImportSchemaText()` is byte for byte the file in
 * `docs/schemas/`; `jsonSchema.test.ts` beside this file checks that, and
 * `apps/host/scripts/genConnectorSchemas.ts` writes it.
 */

import {
  ACCOUNT_FIELDS,
  BALANCE_FIELDS,
  BUDGET_IMPORT_FORMAT,
  BUDGET_IMPORT_FORMAT_VERSION,
  CURRENCY_RE,
  DATE_RE,
  INSTITUTION_PATTERN,
  MAX_ACCOUNT_NAME,
  MAX_BALANCES,
  MAX_ID,
  MAX_TEXT,
  MAX_TRANSACTIONS,
  NUMBER_RE,
  SOURCE_PATTERN,
  THREE_DECIMAL_CURRENCIES,
  TOP_LEVEL_KEYS,
  TRANSACTION_FIELDS,
} from "./constants.js";

const SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";
/** The published file name of the schema, as its `$id`. */
export const BUDGET_IMPORT_SCHEMA_FILE = "cashu-budget-import.v1.json";
/**
 * The schema's cap on an account number as written (the validator drops spaces and punctuation, then
 * wants `IBAN_MIN`..`IBAN_MAX` characters).
 */
const IBAN_TEXT_MAX = 64;

type SchemaNode = { readonly [key: string]: unknown };

/**
 * A validator pattern in the schema's spelling: the validator matches any Unicode decimal digit
 * (`\p{Nd}`, the meaning of Python's `\d`), the schema keeps the `\d` it was published with.
 */
const schemaPattern = (re: RegExp): string => re.source.replaceAll("\\p{Nd}", "\\d");

/** pydantic's field title: `booking_date` -> `Booking Date`. */
const title = (name: string): string =>
  name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

const DATE: SchemaNode = { format: "date", pattern: schemaPattern(DATE_RE), type: "string" };
const CURRENCY: SchemaNode = { pattern: CURRENCY_RE.source, type: "string" };
const AMOUNT: SchemaNode = {
  description: 'Signed decimal, "." separator (a string is preferred: no float rounding).',
  pattern: schemaPattern(NUMBER_RE),
  type: ["string", "number"],
};
const maxText = (limit: number): SchemaNode => ({ maxLength: limit, type: "string" });
const patterned = (pattern: string): SchemaNode => ({ pattern, type: "string" });

/** A required field. */
const field = (name: string, schema: SchemaNode, description?: string): SchemaNode => ({
  ...schema,
  ...(description === undefined ? {} : { description }),
  title: title(name),
});

/** An optional field: the value or null, null when absent. */
const optional = (name: string, schema: SchemaNode, description?: string): SchemaNode => ({
  anyOf: [schema, { type: "null" }],
  default: null,
  ...(description === undefined ? {} : { description }),
  title: title(name),
});

/** A model (`extra="forbid"`): its properties in the validator's field order. */
function model<Field extends string>(
  name: string,
  description: string,
  order: readonly Field[],
  properties: Readonly<Record<Field, SchemaNode>>,
  required: readonly Field[],
): SchemaNode {
  return {
    additionalProperties: false,
    description,
    properties: Object.fromEntries(order.map((key) => [key, properties[key]])),
    required: [...required],
    title: name,
    type: "object",
  };
}

const ACCOUNT = model(
  "DocAccount",
  "The account the statement belongs to.",
  ACCOUNT_FIELDS,
  {
    currency: field("currency", CURRENCY, "ISO 4217 code of the account."),
    iban: optional(
      "iban",
      maxText(IBAN_TEXT_MAX),
      "Matches an existing account of the profile (any bank); otherwise the owner picks the account in the preview.",
    ),
    name: optional(
      "name",
      maxText(MAX_ACCOUNT_NAME),
      "Name of a newly created account (never renames one).",
    ),
    institution: optional(
      "institution",
      patterned(INSTITUTION_PATTERN),
      'Institution id of a newly created account ("mbank", "pekao", ...); default: the document\'s source.',
    ),
  },
  ["currency"],
);

const BALANCE = model(
  "DocBalance",
  "A closing balance of the account on a date (wins over ``balance_after`` of that date).",
  BALANCE_FIELDS,
  { date: field("date", DATE), amount: field("amount", AMOUNT) },
  ["date", "amount"],
);

const TRANSACTION = model(
  "DocTransaction",
  "One booked transaction (mirrors ``RawTransaction``).",
  TRANSACTION_FIELDS,
  {
    booking_date: field("booking_date", DATE),
    amount: field("amount", AMOUNT, "Signed: negative = outflow, positive = inflow."),
    currency: field("currency", CURRENCY),
    value_date: optional("value_date", DATE),
    counterparty_name: optional("counterparty_name", maxText(MAX_TEXT)),
    counterparty_iban: optional(
      "counterparty_iban",
      maxText(IBAN_TEXT_MAX),
      "IBAN or Polish NRB; spaces and punctuation are ignored.",
    ),
    description: optional("description", maxText(MAX_TEXT)),
    reference: optional("reference", maxText(MAX_ID)),
    transaction_id: optional(
      "transaction_id",
      maxText(MAX_ID),
      "The bank's stable id of the transaction (deduplication).",
    ),
    balance_after: optional(
      "balance_after",
      AMOUNT,
      "Account balance after this transaction (end-of-day snapshot).",
    ),
  },
  ["booking_date", "amount", "currency"],
);

const listOf = (name: string, definition: string, limit: number): SchemaNode => ({
  items: { $ref: `#/$defs/${definition}` },
  maxItems: limit,
  title: title(name),
  type: "array",
});

/**
 * pydantic's key order: the keys of every schema object sorted, the keys of a `properties` map in
 * field order; `default` values are data and stay as they are.
 */
function sortedKeys(node: unknown, fieldMap = false): unknown {
  if (Array.isArray(node)) return node.map((item) => sortedKeys(item));
  if (node === null || typeof node !== "object") return node;
  const entries = Object.entries(node);
  if (!fieldMap) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      key === "default" && !fieldMap ? value : sortedKeys(value, key === "properties" && !fieldMap),
    ]),
  );
}

/** The `cashu-budget-import` JSON Schema as an object (key order is the file's). */
export function budgetImportSchema(): SchemaNode {
  const document = model(
    "BudgetImportDocument",
    "",
    TOP_LEVEL_KEYS,
    {
      format: field("format", { const: BUDGET_IMPORT_FORMAT, type: "string" }),
      format_version: field("format_version", {
        const: BUDGET_IMPORT_FORMAT_VERSION,
        type: "integer",
      }),
      account: { $ref: "#/$defs/DocAccount" },
      transactions: listOf("transactions", "DocTransaction", MAX_TRANSACTIONS),
      source: optional(
        "source",
        patterned(SOURCE_PATTERN),
        "Who produced the document (connector or converter).",
      ),
      balances: listOf("balances", "DocBalance", MAX_BALANCES),
    },
    ["format", "format_version", "account", "transactions"],
  );
  // The document's own title and description are replaced by the published ones below.
  const { title: _title, description: _description, ...body } = document;
  const threeDecimals = [...THREE_DECIMAL_CURRENCIES].join(", ");
  return {
    $schema: SCHEMA_DRAFT,
    $id: BUDGET_IMPORT_SCHEMA_FILE,
    title: `cashU budget import document (${BUDGET_IMPORT_FORMAT}), format_version ${BUDGET_IMPORT_FORMAT_VERSION}`,
    description: `Generated from the budget import document model (packages/domain/src/budget/ingestion/canonical/model.ts) by apps/host/scripts/genConnectorSchemas.ts; see docs/budget-import-format.md (also the CSV variant). The app also enforces what a schema cannot express: real calendar dates, at most 2 decimal places (3 for ${threeDecimals}), unique transaction_id.`,
    ...(sortedKeys({
      $defs: { DocAccount: ACCOUNT, DocBalance: BALANCE, DocTransaction: TRANSACTION },
      ...body,
    }) as SchemaNode),
  };
}

/**
 * The file text of the schema (two-space indent, non-ASCII kept, a final newline). The schema holds
 * only plain ASCII keys, strings and integers, where `JSON.stringify` prints the published bytes.
 */
export function budgetImportSchemaText(): string {
  return `${JSON.stringify(budgetImportSchema(), null, 2)}\n`;
}
