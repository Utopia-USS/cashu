/** The `cashu-budget-import` v1 format's names, limits, field lists and patterns (Python `canonical.py`). */

export const BUDGET_IMPORT_FORMAT = "cashu-budget-import";
export const BUDGET_IMPORT_FORMAT_VERSION = 1;
export const BUDGET_IMPORTER_ID = "cashu-budget";
/** The pre-rename format id (deprecated, still read). */
export const LEGACY_BUDGET_IMPORT_FORMAT = "finanse-budget-import";
export const LEGACY_BUDGET_IMPORTER_ID = "finanse-budget";
/** The statement's bank when the document names neither an institution nor a source. */
export const DEFAULT_BANK = "other";

/** How much of a file the format sniffing reads. */
export const SNIFF_BYTES = 64 * 1024;
export const MAX_TEXT = 500;
export const MAX_ID = 200;
export const MAX_ACCOUNT_NAME = 120;
export const MAX_TRANSACTIONS = 200_000;
export const MAX_BALANCES = 10_000;
export const IBAN_MIN = 8;
export const IBAN_MAX = 34;
export const THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BHD",
  "IQD",
  "JOD",
  "KWD",
  "LYD",
  "OMR",
  "TND",
]);
export const JSON_EXTENSIONS: readonly string[] = ["json"];

/** Python `re` patterns (`\d` = any Unicode decimal digit); values are stripped before matching. */
export const DATE_RE = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u;
export const NUMBER_RE = /^[+-]?\p{Nd}+(\.\p{Nd}+)?$/u;
export const CURRENCY_RE = /^[A-Za-z]{3}$/;
/** pydantic `StringConstraints(pattern=...)` sources (shown in messages as they are). */
export const SOURCE_PATTERN = "^[a-z][a-z0-9_]{0,31}$";
export const INSTITUTION_PATTERN = "^[a-z][a-z0-9_-]{0,31}$";

/** Model field orders (pydantic validates and reports in this order). */
export const TRANSACTION_FIELDS = [
  "booking_date",
  "amount",
  "currency",
  "value_date",
  "counterparty_name",
  "counterparty_iban",
  "description",
  "reference",
  "transaction_id",
  "balance_after",
] as const;
export const ACCOUNT_FIELDS = ["currency", "iban", "name", "institution"] as const;
export const BALANCE_FIELDS = ["date", "amount"] as const;
export const TOP_LEVEL_KEYS = [
  "format",
  "format_version",
  "account",
  "transactions",
  "source",
  "balances",
] as const;

/** CSV variant: the file-level columns and the account field each fills. */
export const CSV_FILE_COLUMNS: readonly (readonly [string, (typeof ACCOUNT_FIELDS)[number]])[] = [
  ["account_iban", "iban"],
  ["account_currency", "currency"],
  ["account_name", "name"],
  ["account_institution", "institution"],
];
export const REQUIRED_CSV_COLUMNS = [
  "format_version",
  "booking_date",
  "amount",
  "currency",
] as const;
export const CSV_COLUMNS: readonly string[] = [
  "format_version",
  ...TRANSACTION_FIELDS,
  ...CSV_FILE_COLUMNS.map(([column]) => column),
  "source",
];
