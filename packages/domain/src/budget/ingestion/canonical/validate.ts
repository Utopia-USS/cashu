/**
 * `canonical._validate`: the model, then the cross-field checks (decimal places per currency, duplicate
 * transaction ids, currency mismatches, an unknown institution, no transactions), then the statement.
 * Model errors become value-free issues as `_issue_from_error` / `_loc_to_place` map them.
 */

import type { InstitutionRegistry } from "../../../core/index.js";
import { DEFAULT_CONTEXT, type Decimal } from "../../../decimal.js";
import { getCloseMatches } from "../../../difflib.js";
import type { ParsedStatement, RawTransaction, TxnSource } from "../types.js";
import {
  ACCOUNT_FIELDS,
  BALANCE_FIELDS,
  BUDGET_IMPORT_FORMAT,
  BUDGET_IMPORT_FORMAT_VERSION,
  CSV_FILE_COLUMNS,
  DEFAULT_BANK,
  LEGACY_BUDGET_IMPORT_FORMAT,
  THREE_DECIMAL_CURRENCIES,
  TOP_LEVEL_KEYS,
  TRANSACTION_FIELDS,
} from "./constants.js";
import { type BudgetIssue, budgetIssue, dedupeIssues } from "./issues.js";
import type { JsonObject, JsonValue } from "./json.js";
import { type BudgetImportDocument, type Loc, type PlacedError, validateModel } from "./model.js";

export type Variant = "json" | "csv";

/** What `parseBudgetDocument` extracted: the statement (null when anything blocks), issues, counts. */
export interface CanonicalResult {
  readonly statement: ParsedStatement | null;
  readonly issues: readonly BudgetIssue[];
  readonly variant: Variant;
  readonly source: string | null;
  readonly institution: string | null;
  readonly transactions: number;
  readonly balances: number;
}

export function canonicalOk(r: CanonicalResult): boolean {
  return r.statement !== null && !r.issues.some((i) => i.blocking);
}

export function fileError(message: string, variant: Variant): CanonicalResult {
  return {
    statement: null,
    issues: [budgetIssue("file_format", message)],
    variant,
    source: null,
    institution: null,
    transactions: 0,
    balances: 0,
  };
}

/** `_did_you_mean`. */
export function didYouMean(name: string, known: readonly string[]): string {
  const [match] = getCloseMatches(name, known, 1, 0.75);
  return match === undefined ? "" : ` (did you mean "${match}"?)`;
}

/** `_loc_to_place`: a pydantic location -> (1-based transaction row, field path). */
function place(loc: Loc, rows: readonly number[] | null): [number | null, string | null] {
  const [head, index] = loc;
  if (loc.length >= 2 && head === "transactions" && typeof index === "number") {
    const row = rows !== null && index < rows.length ? (rows[index] as number) : index + 1;
    return [row, loc.slice(2).join(".") || null];
  }
  if (loc.length >= 2 && head === "balances" && typeof index === "number") {
    return [
      null,
      `balances[${index + 1}]${loc
        .slice(2)
        .map((p) => `.${p}`)
        .join("")}`,
    ];
  }
  return [null, loc.join(".") || null];
}

const KNOWN_BY_PARENT: Readonly<Record<string, readonly string[]>> = {
  "": TOP_LEVEL_KEYS,
  account: ACCOUNT_FIELDS,
  transactions: TRANSACTION_FIELDS,
  balances: BALANCE_FIELDS,
};

/** `_issue_from_error`. */
function issueFromError(
  error: PlacedError,
  rows: readonly number[] | null,
  variant: Variant,
): BudgetIssue {
  const { loc, type } = error;
  let [row, name] = place(loc, rows);
  if (variant === "csv" && name?.startsWith("account.")) {
    const attr = name.slice("account.".length);
    name = CSV_FILE_COLUMNS.find(([, target]) => target === attr)?.[0] ?? name;
  }
  switch (type) {
    case "missing":
      return budgetIssue("missing_value", "is required", row, name);
    case "extra_forbidden": {
      const parent = loc.length > 1 ? String(loc[0]) : "";
      const hint = didYouMean(String(loc[loc.length - 1]), KNOWN_BY_PARENT[parent] ?? []);
      return budgetIssue("unknown_field", `unknown field${hint}`, row, name);
    }
    case "literal_error":
      if (loc.length === 1 && loc[0] === "format") {
        return budgetIssue("file_format", `must be "${BUDGET_IMPORT_FORMAT}"`, null, "format");
      }
      if (loc.length === 1 && loc[0] === "format_version") {
        return budgetIssue(
          "file_format",
          `must be the number ${BUDGET_IMPORT_FORMAT_VERSION}`,
          null,
          "format_version",
        );
      }
      break;
    case "model_type":
      return budgetIssue(
        row === null ? "file_format" : "invalid_value",
        "must be an object",
        row,
        name,
      );
    case "list_type":
      return budgetIssue("file_format", "must be an array", row, name);
    case "too_long":
      return budgetIssue("file_format", `more than ${error.ctx?.max_length} entries`, row, name);
    case "string_too_long":
      return budgetIssue(
        "invalid_value",
        `longer than ${error.ctx?.max_length} characters`,
        row,
        name,
      );
    case "string_pattern_mismatch":
      return budgetIssue("invalid_value", `must match ${error.ctx?.pattern}`, row, name);
    case "string_type":
      return budgetIssue("invalid_value", "must be a string", row, name);
    case "date_format":
    case "decimal_format":
    case "currency_format":
    case "iban_format":
      return budgetIssue("invalid_value", error.msg, row, name);
  }
  return budgetIssue("invalid_value", "invalid value", row, name);
}

const minorDigits = (currency: string) => (THREE_DECIMAL_CURRENCIES.has(currency) ? 3 : 2);
/** `_decimals`: decimal places of the value without trailing zeros. */
const decimals = (value: Decimal) => Math.max(0, -value.normalize(DEFAULT_CONTEXT).exp);

function statementOf(doc: BudgetImportDocument, source: TxnSource): ParsedStatement {
  const transactions: RawTransaction[] = doc.transactions.map((t, index) => ({
    bookingDate: t.booking_date,
    valueDate: t.value_date,
    amount: t.amount,
    currency: t.currency,
    counterpartyName: t.counterparty_name,
    counterpartyIban: t.counterparty_iban,
    description: t.description,
    reference: t.reference,
    bankTransactionId: t.transaction_id,
    source,
    raw: { format: BUDGET_IMPORT_FORMAT, row: index + 1, source: doc.source },
  }));
  return {
    bank: doc.account.institution ?? doc.source ?? DEFAULT_BANK,
    accountNumber: doc.account.iban,
    accountNumberOrigin: doc.account.iban === null ? null : "document",
    accountName: doc.account.name,
    currency: doc.account.currency,
    transactions,
    balances: doc.transactions.flatMap((t) =>
      t.balance_after === null ? [] : [{ date: t.booking_date, amount: t.balance_after }],
    ),
    closingBalances: doc.balances.map((b) => ({ date: b.date, amount: b.amount })),
    skippedRows: 0,
  };
}

function lengthOf(v: JsonValue | undefined): number {
  return Array.isArray(v) ? v.length : 0;
}

/** `_validate(document, source, variant, rows)`. */
export function validateDocument(
  input: JsonObject,
  opts: {
    readonly source: TxnSource;
    readonly variant: Variant;
    readonly rows: readonly number[] | null;
    readonly registry: InstitutionRegistry;
  },
): CanonicalResult {
  const document = new Map(input);
  if (typeof document.get("format_version") === "boolean") document.set("format_version", null); // true == 1
  if (document.get("format") === LEGACY_BUDGET_IMPORT_FORMAT)
    document.set("format", BUDGET_IMPORT_FORMAT);
  const validated = validateModel(document);
  if (!validated.ok) {
    return {
      statement: null,
      issues: dedupeIssues(validated.errors.map((e) => issueFromError(e, opts.rows, opts.variant))),
      variant: opts.variant,
      source: null,
      institution: null,
      transactions: lengthOf(document.get("transactions")),
      balances: lengthOf(document.get("balances")),
    };
  }
  const { doc } = validated;
  const rowOf = (index: number) => (opts.rows !== null ? (opts.rows[index] as number) : index + 1);
  const issues: BudgetIssue[] = [];
  const accountCurrency = doc.account.currency;
  const seenIds = new Map<string, number>();
  let otherCurrency = 0;
  doc.transactions.forEach((t, index) => {
    const row = rowOf(index);
    const limit = minorDigits(t.currency);
    if (decimals(t.amount) > limit) {
      issues.push(
        budgetIssue(
          "invalid_value",
          `more than ${limit} decimal places for its currency`,
          row,
          "amount",
        ),
      );
    }
    if (t.balance_after !== null && decimals(t.balance_after) > minorDigits(accountCurrency)) {
      issues.push(
        budgetIssue(
          "invalid_value",
          "more decimal places than the account currency allows",
          row,
          "balance_after",
        ),
      );
    }
    if (t.transaction_id !== null) {
      const first = seenIds.get(t.transaction_id) ?? row;
      seenIds.set(t.transaction_id, first);
      if (first !== row)
        issues.push(
          budgetIssue("duplicate_id", `the same id as row ${first}`, row, "transaction_id"),
        );
    }
    if (t.currency !== accountCurrency) {
      otherCurrency++;
      if (otherCurrency <= 20) {
        issues.push(
          budgetIssue(
            "currency_mismatch",
            "differs from the account currency",
            row,
            "currency",
            false,
          ),
        );
      }
    }
  });
  doc.balances.forEach((b, index) => {
    if (decimals(b.amount) > minorDigits(accountCurrency)) {
      issues.push(
        budgetIssue(
          "invalid_value",
          "more decimal places than the account currency allows",
          null,
          `balances[${index + 1}].amount`,
        ),
      );
    }
  });
  const institution = doc.account.institution;
  if (institution !== null && opts.registry.find(institution) === undefined) {
    issues.push(
      budgetIssue(
        "unknown_institution",
        "names no known institution; kept as the new account's institution id",
        null,
        opts.variant === "csv" ? "account_institution" : "account.institution",
        false,
      ),
    );
  }
  if (doc.transactions.length === 0)
    issues.push(budgetIssue("empty", "no transactions", null, "transactions", false));
  const blocked = issues.some((i) => i.blocking);
  return {
    statement: blocked ? null : statementOf(doc, opts.source),
    issues,
    variant: opts.variant,
    source: doc.source,
    institution,
    transactions: doc.transactions.length,
    balances: doc.balances.length,
  };
}
