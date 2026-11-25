/**
 * Transaction rows an agent typed in from chat, turned into a canonical `cashu-import` JSON document
 * (docs/import-format.md), so they go through the same preview, dedup and pending-import proposal as
 * a file. Rows never carry `external_ref`: dedup uses the content key (date, type, instrument,
 * quantity, price, gross and cash amount). Messages name a row index and a fixed field name, never a
 * value.
 */
import { pyLen, pyStrip } from "@cashu/domain";
import { type ToolArgs, ToolError } from "../registry.js";

const MAX_ROWS = 500;
const MAX_TEXT = 1000;
const ROW_TYPES = [
  "buy",
  "sell",
  "dividend",
  "interest",
  "deposit",
  "withdrawal",
  "fee",
  "tax",
  "fx_conversion",
  "split",
  "transfer_in",
  "transfer_out",
  "adjustment",
] as const;
const DECIMALS = [
  "quantity",
  "price",
  "gross_amount",
  "fee",
  "tax",
  "cash_amount",
  "fx_rate",
  "split_ratio",
] as const;
const TEXTS = [
  "date",
  "time",
  "settle_date",
  "type",
  "symbol",
  "isin",
  "name",
  "exchange",
  "currency",
  "cash_currency",
  "note",
] as const;
const ROW_FIELDS: readonly string[] = [...TEXTS, ...DECIMALS];
const SOURCE_RE = /^[a-z][a-z0-9_]{0,31}$/u;
/** The name the archived document and the import batch carry. */
export const ROWS_FILE_NAME = "chat-transactions.json";

/** The row schema the tools list (the handler checks every row again). */
const ROW_SCHEMA = {
  type: "object",
  properties: {
    date: { type: "string", description: "trade date YYYY-MM-DD" },
    time: { type: "string", description: "HH:MM or HH:MM:SS; orders rows of the same date" },
    settle_date: { type: "string" },
    type: { type: "string", enum: [...ROW_TYPES] },
    symbol: { type: "string", maxLength: 64 },
    isin: { type: "string", maxLength: 12 },
    name: { type: "string", maxLength: 200 },
    exchange: {
      type: "string",
      maxLength: 32,
      description: "ISO 10383 MIC (XWAR, XNAS) or crypto",
    },
    quantity: { type: "string", description: 'decimal >= 0, e.g. "12.5"' },
    price: { type: "string", description: "price per unit in currency" },
    currency: { type: "string", description: "ISO 4217 quote currency" },
    gross_amount: { type: "string" },
    fee: { type: "string", description: "commission in currency, default 0" },
    tax: { type: "string" },
    cash_amount: { type: "string", description: "signed net cash effect in cash_currency" },
    cash_currency: { type: "string" },
    fx_rate: { type: "string", description: "cash_currency per 1 currency" },
    split_ratio: { type: "string" },
    note: { type: "string", maxLength: MAX_TEXT },
  },
  required: ["date", "type", "currency"],
  additionalProperties: false,
} as const;

export const ROWS_PROPERTY = {
  type: "array",
  minItems: 1,
  maxItems: MAX_ROWS,
  description:
    "Transactions in the cashU import format (record txn): {date, time?, type, symbol? / isin? / name? / exchange?, quantity?, price?, currency, fee?, tax?, gross_amount?, cash_amount?, cash_currency?, fx_rate?, note?}. Decimals as strings with a dot. No external_ref: duplicates are found by date, type, instrument, quantity, price and amounts.",
  items: ROW_SCHEMA,
} as const;

export const SOURCE_PROPERTY = {
  type: "string",
  maxLength: 32,
  description:
    "symbol namespace ([a-z][a-z0-9_]*): default the account's broker id; use the source of the account's earlier imports",
} as const;

const invalid = (message: string) => new ToolError(message, "invalid_arguments", { system: true });

function decimal(raw: unknown, at: string): string {
  if (typeof raw === "string") return pyStrip(raw);
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const out = String(raw);
    if (/e/iu.test(out)) throw invalid(`${at}: write this number as a decimal string`);
    return out;
  }
  if (typeof raw === "bigint") return raw.toString();
  throw invalid(`${at} must be a decimal string`);
}

/** The checked rows as canonical `txn` records (field order fixed, so equal rows give equal bytes). */
export function canonicalRows(raw: unknown): Record<string, string>[] {
  if (!Array.isArray(raw)) throw invalid("rows must be an array of transaction objects");
  if (raw.length === 0) throw invalid("rows is empty: give at least one transaction");
  if (raw.length > MAX_ROWS) throw invalid(`too many rows (max ${MAX_ROWS}); split them`);
  return raw.map((row, index) => {
    const at = `rows[${index}]`;
    if (typeof row !== "object" || row === null || Array.isArray(row))
      throw invalid(`${at} must be an object`);
    const keys = Object.keys(row);
    if (keys.includes("external_ref"))
      throw invalid(
        `${at}: external_ref is not accepted for typed-in rows (only a broker's own id belongs there)`,
      );
    if (keys.some((key) => !ROW_FIELDS.includes(key)))
      throw invalid(`${at} has an unknown field; allowed: ${ROW_FIELDS.join(", ")}`);
    const record: Record<string, string> = { record: "txn" };
    for (const field of ROW_FIELDS) {
      const value = (row as Record<string, unknown>)[field];
      if (value === undefined || value === null) continue;
      const cell = (DECIMALS as readonly string[]).includes(field)
        ? decimal(value, `${at}.${field}`)
        : typeof value === "string"
          ? pyStrip(value)
          : (() => {
              throw invalid(`${at}.${field} must be a string`);
            })();
      if (pyLen(cell) > MAX_TEXT) throw invalid(`${at}.${field} is too long (max ${MAX_TEXT})`);
      if (cell !== "") record[field] = cell;
    }
    for (const field of ["date", "type", "currency"])
      if (record[field] === undefined) throw invalid(`${at}: missing ${field}`);
    if (!(ROW_TYPES as readonly string[]).includes(record.type as string))
      throw invalid(`${at}.type must be one of: ${ROW_TYPES.join(", ")}`);
    return record;
  });
}

/** The symbol namespace: the explicit `source`, else the account's broker id when it is a valid one. */
export function rowsSource(args: ToolArgs, broker: string | null): string | null {
  if (typeof args.source === "string" && pyStrip(args.source) !== "") {
    const source = pyStrip(args.source);
    if (!SOURCE_RE.test(source))
      throw invalid(
        "source must be lower-case letters, digits and _ (max 32), starting with a letter",
      );
    return source;
  }
  return broker !== null && SOURCE_RE.test(broker) ? broker : null;
}

/** The canonical JSON document of `rows` (deterministic bytes). */
export function rowsDocument(
  rows: readonly Record<string, string>[],
  source: string | null,
): { readonly name: string; readonly bytes: Uint8Array } {
  const document = {
    format: "cashu-import",
    format_version: 1,
    ...(source === null ? {} : { source }),
    records: rows,
  };
  return {
    name: ROWS_FILE_NAME,
    bytes: new TextEncoder().encode(`${JSON.stringify(document, null, 1)}\n`),
  };
}
