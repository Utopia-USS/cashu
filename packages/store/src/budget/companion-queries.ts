// Budget reads of the phone companion (`@cashu/store/budget/companion`): the month figures, the
// transaction lists, search and detail, the uncategorized rows, the category picker and the plain
// budget inputs the overview composes (recurring charges, payee histories, account balances). Its own
// entry so the phone, whose bundler (Metro) does not tree-shake, reads it without the budget barrel.
// Budget only: it never reads loans, investments or assets (they meet in `overview/companion.ts`).
//
// Lists, detail and the uncategorized rows are direct SQL over `transactions` (newest first, keyset
// pages), search reads the FTS5 index of the rows (`budget.search`), never the whole `budgetBook`;
// the month figures, the uncategorized count and the cash pool balances read the month aggregates
// (`budget.months`) through the domain's `...FromRows` analytics; the recurring charges read the
// recurring records (`budget.recurring`). Every money value stays a `Decimal` in its own currency;
// nothing is summed across currencies.
//
// Query budget (performance.md, lead decision 2026-11-12): the list reads, the uncategorized count,
// the month figures, the account balances, search and the recurring charges (attention, the month's
// bills, upcoming) hold the 8 ms budget on the 60k workload and `companion-queries.perf.test.ts`
// asserts it.
import {
  addDays,
  addMonths,
  budget,
  core,
  D,
  type Decimal,
  type IsoDate,
  ibanKey,
  monthEnd,
  normalizeText,
  ZERO,
} from "@cashu/domain";
import { profileOf } from "../core/queries.js";
import { defineQuery, type Read } from "../query.js";
import type { SqlValue } from "../sql/driver.js";
import { eventTimestamp } from "../sql/values.js";
import {
  bookingDay,
  FTS_ID_MASK,
  FTS_ROWID_SQL,
  ftsAmountPrefix,
  SEARCH_FTS,
} from "./derive/search.js";
import {
  BOOK_ORDER,
  compareRecords,
  GROUP_ENTRIES_SQL,
  type GroupEntryRow,
  groupRecords,
  type RecurringRecord,
} from "./recurring-groups.js";

// --------------------------------------------------------------------------- rows

export interface CompanionTxnAccount {
  readonly gid: string;
  readonly name: string;
  readonly type: string;
}

export interface CompanionTxnRow {
  readonly gid: string;
  readonly date: IsoDate;
  readonly amount: Decimal;
  readonly currency: string;
  /** The counterparty name, else the cash title, else the description's first 40 characters. */
  readonly payee: string;
  /** The statement text (`reference || description`); null when it equals `payee`. */
  readonly title: string | null;
  /** The effective category key; null when uncategorized (or never categorized). */
  readonly category: string | null;
  readonly categorySource: string;
  /** The category is an LLM answer (`llm`, `llm_full`, `llm_fallback`). */
  readonly suggested: boolean;
  /** An outflow, not an own transfer, the engine could not place (`category_source = 'default'`). */
  readonly uncategorized: boolean;
  readonly internal: boolean;
  /** The row is on a cash pool account. */
  readonly cash: boolean;
  readonly account: CompanionTxnAccount;
  readonly merchantKey: string | null;
}

const SUGGESTED_SOURCES: ReadonlySet<string> = new Set(["llm", "llm_full", "llm_fallback"]);
const PAYEE_DESCRIPTION_CHARS = 40;
const LIST_DEFAULT = 100;
const LIST_MAX = 300;
const SEARCH_DEFAULT = 200;
const UNCATEGORIZED_DEFAULT = 50;
const EARLIER_MAX = 5;
const USES_MONTHS = 12;

/** The SQL form of `CompanionTxnRow.uncategorized` (table alias `t`). */
const UNCATEGORIZED_SQL = `(CAST(t.amount AS REAL) < 0 AND t.is_internal_transfer = 0
  AND t.category_source = 'default')`;

// --------------------------------------------------------------------------- merchant keys

/**
 * A subquery of `(gid, merchantKey)` of the visible rows whose merchant key is one of `count` bound
 * keys, through the `transactions.merchant_key` index (cash legs have none).
 */
function merchantRowsSql(count: number): string {
  return `SELECT t.gid AS gid, t.merchant_key AS merchantKey
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.merchant_key IN (${marks(count)}) AND ${VISIBLE}`;
}

// --------------------------------------------------------------------------- row SQL

const ROW_COLUMNS = `t.gid, t.booking_date AS date, t.amount, t.currency,
    t.counterparty_name AS name, t.description, t.reference, t.category,
    t.category_source AS source, t.is_internal_transfer AS internal,
    a.gid AS accountGid, a.name AS accountName, a.type AS accountType, t.merchant_key AS merchantKey`;
const ROW_FROM = "FROM transactions t JOIN accounts a ON a.id = t.account_id";

/** The row columns over `transactions t JOIN accounts a`, with the row's merchant key. */
const ROW_SELECT = `SELECT ${ROW_COLUMNS} ${ROW_FROM}`;

/** Removed accounts leave the budget (as in `budgetBook`): their rows are never listed. */
const VISIBLE = "a.removed_at IS NULL";
const NEWEST_FIRST = "ORDER BY t.booking_date DESC, t.gid DESC";

interface SqlRow {
  readonly gid: string;
  readonly date: IsoDate;
  readonly amount: string;
  readonly currency: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly reference: string | null;
  readonly category: string | null;
  readonly source: string | null;
  readonly internal: number;
  readonly accountGid: string;
  readonly accountName: string;
  readonly accountType: string;
  readonly merchantKey: string | null;
}

/** The row's display payee: counterparty, else the cash title, else the description's start. */
function payeeOf(
  name: string | null,
  reference: string | null,
  description: string | null,
  cash: boolean,
): string {
  if (name) return name;
  if (cash && reference) return reference;
  if (description) return Array.from(description).slice(0, PAYEE_DESCRIPTION_CHARS).join("");
  return reference ?? "";
}

function toRow(r: SqlRow): CompanionTxnRow {
  const amount = D(r.amount);
  const source = r.source ?? "";
  const internal = r.internal === 1;
  const cash = r.accountType === budget.CASH_ACCOUNT_TYPE;
  const uncategorized = amount.lt(D("0")) && !internal && source === "default";
  const payee = payeeOf(r.name, r.reference, r.description, cash);
  const text = r.reference || r.description || null;
  return {
    gid: r.gid,
    date: r.date,
    amount,
    currency: r.currency,
    payee,
    title: text === payee ? null : text,
    category: uncategorized ? null : r.category,
    categorySource: source,
    suggested: SUGGESTED_SOURCES.has(source),
    uncategorized,
    internal,
    cash,
    account: { gid: r.accountGid, name: r.accountName, type: r.accountType },
    merchantKey: r.merchantKey || null,
  };
}

const clampLimit = (limit: number | null | undefined, fallback: number): number =>
  Math.min(LIST_MAX, Math.max(1, Math.floor(limit ?? fallback)));

function marks(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** The uncategorized rows' scope: a month ("YYYY-MM") and a currency, each optional. */
export type CompanionUncategorizedScope = {
  readonly month?: string | null;
  readonly currency?: string | null;
};

/** The SQL (alias `t`) of an uncategorized scope; throws a RangeError for an invalid month. */
function scopeSql(scope: CompanionUncategorizedScope): { sql: string; params: string[] } {
  let sql = "";
  const params: string[] = [];
  if (scope.month) {
    const parsed = budget.parseMonth(scope.month);
    if (!parsed.ok) throw new RangeError("invalid budget month");
    const start = `${budget.monthLabel(parsed.year, parsed.month)}-01`;
    sql += " AND t.booking_date >= ? AND t.booking_date <= ?";
    params.push(start, monthEnd(start));
  }
  if (scope.currency) {
    sql += " AND t.currency = ?";
    params.push(scope.currency);
  }
  return { sql, params };
}

/**
 * The uncategorized flow outflows of the vault in the scope (visible accounts): the rows the month
 * figures count (`budget.isFlow`, so also no own-account counterparty), summed over the month
 * aggregates.
 */
function uncategorizedTotal(read: Read, scope: CompanionUncategorizedScope = {}): number {
  let sql = "";
  const params: string[] = [];
  if (scope.month) {
    const parsed = budget.parseMonth(scope.month);
    if (!parsed.ok) throw new RangeError("invalid budget month");
    sql += " AND c.month = ?";
    params.push(budget.monthLabel(parsed.year, parsed.month));
  }
  if (scope.currency) {
    sql += " AND c.currency = ?";
    params.push(scope.currency);
  }
  return (
    read<{ n: number }>(
      `SELECT COALESCE(sum(c.uncategorized_n), 0) AS n FROM fold_month_cat c
       JOIN accounts a ON a.id = c.account_id WHERE ${VISIBLE}${sql}`,
      ...params,
    )[0]?.n ?? 0
  );
}

// --------------------------------------------------------------------------- month

export type CompanionMonthArgs = {
  readonly today: IsoDate;
  readonly currency: string;
  /** "YYYY-MM"; default today's month. */
  readonly month?: string | null;
  readonly lang: core.UiLang;
};

export interface CompanionLargest {
  readonly gid: string;
  readonly payee: string;
  readonly date: IsoDate;
  /** Signed (negative: an outflow). */
  readonly amount: Decimal;
}

export interface CompanionCategory {
  readonly category: string;
  readonly label: string;
  /** Positive spending of the month in this category. */
  readonly amount: Decimal;
  /** The usual monthly spending in it (`categoryNorm`); null when the norm months have none. */
  readonly usual: Decimal | null;
  /** Share of the month's spending (0 when nothing was spent). */
  readonly share: number;
}

export interface CompanionMonth {
  readonly month: string;
  readonly currency: string;
  /** The month ended before today. */
  readonly complete: boolean;
  readonly monthEnd: IsoDate;
  readonly daysLeft: number;
  readonly income: Decimal;
  /** Positive magnitude. */
  readonly spent: Decimal;
  /** Known charges still due this month (0 here; the overview's `core.companionMonth` fills it). */
  readonly billsDue: Decimal;
  readonly norm: budget.MonthNorm | null;
  readonly normToDate: Decimal | null;
  readonly usualPayDay: number | null;
  readonly projection: budget.MonthProjection;
  readonly uncategorized: {
    readonly count: number;
    /** Positive magnitude. */
    readonly sum: Decimal;
    readonly largest: CompanionLargest | null;
  };
  /** Largest first. */
  readonly categories: readonly CompanionCategory[];
  /** This month's spending in the vault's other currencies (those with spending only). */
  readonly otherCurrencies: readonly { readonly currency: string; readonly spent: Decimal }[];
}

/** The month a request names (default today's) and the day its figures are taken at. */
export function companionMonthOf(args: {
  readonly today: IsoDate;
  readonly month?: string | null;
}): {
  readonly label: string;
  readonly year: number;
  readonly month: number;
  readonly ref: IsoDate;
} {
  const label = args.month || args.today.slice(0, 7);
  const parsed = budget.parseMonth(label);
  if (!parsed.ok) throw new RangeError("invalid budget month");
  const first = budget.monthLabel(parsed.year, parsed.month);
  const start = `${first}-01`;
  const end = monthEnd(start);
  // A past month is seen from its last day, a future one from its first, the running one from today.
  let ref = args.today;
  if (ref > end) ref = end;
  else if (ref < start) ref = start;
  return { label: first, year: parsed.year, month: parsed.month, ref };
}

/** The month groups of the visible accounts (`budget.MonthCatRow`), with an `ORDER BY`. */
const MONTH_CAT_SELECT = `SELECT c.currency, c.month, c.category, c.income, c.expense, c.n,
    c.flow_n AS flowN, c.uncategorized_n AS uncategorizedN,
    c.uncategorized_expense AS uncategorizedExpense
  FROM fold_month_cat c JOIN accounts a ON a.id = c.account_id WHERE ${VISIBLE}`;

interface MonthCatSql {
  readonly currency: string;
  readonly month: string;
  readonly category: string;
  readonly income: string;
  readonly expense: string;
  readonly n: number;
  readonly flowN: number;
  readonly uncategorizedN: number;
  readonly uncategorizedExpense: string;
}

const monthCatRow = (r: MonthCatSql): budget.MonthCatRow => ({
  currency: r.currency,
  month: r.month,
  category: r.category === "" ? null : r.category,
  income: D(r.income),
  expense: D(r.expense),
  n: r.n,
  flowN: r.flowN,
  uncategorizedN: r.uncategorizedN,
  uncategorizedExpense: D(r.uncategorizedExpense),
});

/** "YYYY-MM-DD" of a month group's day. */
const DAY_DATE = "d.month || '-' || substr('0' || d.day, -2)";

/**
 * The aggregates the month figures of `label` in `currency` read: the first bookings of the counted
 * accounts (`cashflowCoverageStart`), the norm months chosen in SQL exactly as `normMonths` chooses
 * them (whole, before the month, with income or spending: a sum is non-zero exactly when its text
 * has a digit 1-9), the month groups of those months in `currency` plus every currency's groups of
 * `label` (by account, then first outflow: `spendingByCategoryFromRows`' order), and the day groups of
 * the norm months.
 */
function monthAggregatesOf(
  read: Read,
  currency: string,
  label: string,
): budget.MonthAggregates & { readonly coverage: IsoDate | null } {
  const firsts = read<{ account: string; first: IsoDate | null }>(
    `SELECT a.gid AS account, (SELECT ${DAY_DATE} FROM fold_month_day d
       WHERE d.account_id = a.id AND d.currency = ? ORDER BY d.month, d.day LIMIT 1) AS first
     FROM accounts a WHERE ${VISIBLE} AND a.type != ?`,
    currency,
    budget.CASH_ACCOUNT_TYPE,
  ).flatMap((f) => (f.first === null ? [] : [{ account: f.account, currency, first: f.first }]));
  const coverage = budget.coverageStartFromRows(firsts, currency);
  const norm = read<{ month: string }>(
    `SELECT DISTINCT c.month FROM fold_month_cat c JOIN accounts a ON a.id = c.account_id
     WHERE ${VISIBLE} AND c.currency = ? AND c.month < ? AND c.month || '-01' >= ?
       AND (c.income GLOB '*[1-9]*' OR c.expense GLOB '*[1-9]*')
     ORDER BY c.month DESC LIMIT ?`,
    currency,
    label,
    coverage ?? "",
    budget.NORM_MONTHS,
  ).map((r) => r.month);
  const months = marks(norm.length);
  const cat = read<MonthCatSql>(
    `${MONTH_CAT_SELECT} AND (c.month = ? OR (c.currency = ? AND c.month IN (${months})))
     ORDER BY c.account_id, c.first_outflow`,
    label,
    currency,
    ...norm,
  ).map(monthCatRow);
  const day = read<{
    currency: string;
    month: string;
    day: number;
    n: number;
    income: string;
    expense: string;
    maxIncome: string | null;
  }>(
    `SELECT d.currency, d.month, d.day, d.n, d.income, d.expense, d.max_income AS maxIncome
     FROM fold_month_day d JOIN accounts a ON a.id = d.account_id
     WHERE ${VISIBLE} AND d.currency = ? AND d.month IN (${months})`,
    currency,
    ...norm,
  ).map((r) => ({
    currency: r.currency,
    month: r.month,
    day: r.day,
    n: r.n,
    income: D(r.income),
    expense: D(r.expense),
    maxIncome: r.maxIncome === null ? null : D(r.maxIncome),
  }));
  return { cat, day, firsts, coverage };
}

/**
 * The largest uncategorized flow outflow of the month (the rows `uncategorized.count` counts), in
 * book order on equal amounts: the uncategorized partial index and the transfer exclusions narrow the
 * rows in SQL, `budget.isFlow` (the predicate the month aggregates use) and the exact comparison
 * decide in JS.
 */
function largestUncategorized(
  read: Read,
  currency: string,
  label: string,
  own: ReadonlySet<string>,
): CompanionLargest | null {
  const start = `${label}-01`;
  let largest: CompanionLargest | null = null;
  for (const t of read<{
    gid: string;
    amount: string;
    date: IsoDate;
    name: string | null;
    reference: string | null;
    description: string | null;
    iban: string | null;
    category: string | null;
    internal: number;
    accountType: string;
  }>(
    `SELECT t.gid, t.amount, t.booking_date AS date, t.counterparty_name AS name, t.reference,
       t.description, t.counterparty_iban AS iban, t.category, t.is_internal_transfer AS internal,
       a.type AS accountType
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.category_source = 'default' AND t.booking_date >= ? AND t.booking_date <= ?
       AND t.currency = ? AND ${VISIBLE} AND t.amount LIKE '-%' AND t.is_internal_transfer = 0
       AND (t.category IS NULL OR t.category NOT IN ('transfer', 'cash_withdrawal'))
     ORDER BY a.id, t.id`,
    start,
    monthEnd(start),
    currency,
  )) {
    const amount = D(t.amount);
    const flow = budget.isFlow(
      { category: t.category, isInternalTransfer: t.internal === 1, counterpartyIban: t.iban },
      own,
    );
    if (!amount.lt(ZERO) || !flow) continue;
    if (largest === null || amount.lt(largest.amount)) {
      const cash = t.accountType === budget.CASH_ACCOUNT_TYPE;
      largest = {
        gid: t.gid,
        payee: payeeOf(t.name, t.reference, t.description, cash),
        date: t.date,
        amount,
      };
    }
  }
  return largest;
}

/**
 * The month's spending in the vault's other currencies (those with spending only), in
 * `budgetCurrencies` order: its counts over every visible row (the day groups).
 */
function otherCurrenciesOf(
  read: Read,
  cat: readonly budget.MonthCatRow[],
  currency: string,
  label: string,
  baseCurrency: string,
): { readonly currency: string; readonly spent: Decimal }[] {
  const spent = new Map<string, Decimal>();
  for (const r of cat) {
    if (r.month !== label || r.currency === currency) continue;
    spent.set(r.currency, (spent.get(r.currency) ?? D("0.00")).add(r.expense));
  }
  const others = [...spent].filter(([, s]) => !s.isZero()).map(([c]) => c);
  if (others.length === 0) return [];
  const counts = read<budget.CurrencyCountRow>(
    `SELECT d.currency, sum(d.n) AS transactions, min(${DAY_DATE}) AS first, max(${DAY_DATE}) AS last
     FROM fold_month_day d JOIN accounts a ON a.id = d.account_id
     WHERE ${VISIBLE} AND d.currency IN (${marks(others.length)}) GROUP BY d.currency`,
    ...others,
  );
  return budget
    .currenciesFromRows(counts, baseCurrency)
    .map((c) => ({ currency: c.currency, spent: spent.get(c.currency) as Decimal }));
}

/** The own IBAN keys of the vault: every account's, removed ones too (`bookOwnIbans`). */
function ownIbanKeys(read: Read): Set<string> {
  return core.ownIbans(read<{ iban: string | null }>("SELECT iban FROM accounts"));
}

/**
 * The month's figures in one currency: income and spending, the usual month (whole, complete months:
 * `normMonths`), the projection to its end (with `billsDue` as given, 0 by default), the uncategorized
 * rows and the categories. The phone reads it through the overview's `core.companionMonth`, which
 * supplies the bills still due; this plain function has no query of its own. Over the month
 * aggregates (`budget.months`): a few hundred group rows and the month's uncategorized rows, never the
 * vault's history; equal to the book-based figures (`budget.monthlyCashflow` and the rest).
 */
export function companionMonth(
  read: Read,
  args: CompanionMonthArgs,
  extra: { readonly billsDue?: Decimal } = {},
): CompanionMonth {
  const baseCurrency = budget.budgetBaseCurrency(profileOf(read)?.baseCurrency);
  const currency = args.currency || baseCurrency;
  const { label, year, month, ref } = companionMonthOf(args);
  const agg = monthAggregatesOf(read, currency, label);
  const rows = budget.monthlyCashflowFromRows(agg.cat, currency);
  const row = rows.find((r) => r.label === label);
  const income = row?.income ?? D("0.00");
  const spent = row?.expense ?? D("0.00");
  const norm = budget.closedMonthNorm(rows, ref, budget.NORM_MONTHS, agg.coverage);
  const normToDate = budget.usualToDateFromRows(agg, currency, ref);
  const usualPayDay = budget.usualPayDayFromRows(agg, currency, ref);
  const billsDue = extra.billsDue ?? D("0.00");
  const projection = budget.monthProjection({
    today: ref,
    currency,
    incomeSoFar: income,
    spentSoFar: spent,
    billsDue,
    norm,
    normToDate,
    usualPayDay,
  });
  const usual = budget.categoryNormFromRows(agg, currency, ref);
  const categories = budget
    .spendingByCategoryFromRows(agg.cat, currency, { year, month }, args.lang)
    .map((c) => ({
      category: c.category,
      label: c.label,
      amount: c.amount,
      usual: usual.get(c.category) ?? null,
      share: spent.isZero() ? 0 : c.amount.div(spent).toFloat(),
    }));
  let count = 0;
  let sum = D("0.00");
  for (const r of agg.cat) {
    if (r.month !== label || r.currency !== currency) continue;
    count += r.uncategorizedN;
    sum = sum.add(r.uncategorizedExpense);
  }
  const largest =
    count === 0 ? null : largestUncategorized(read, currency, label, ownIbanKeys(read));
  return {
    month: label,
    currency,
    complete: projection.monthEnd < args.today,
    monthEnd: projection.monthEnd,
    daysLeft: projection.daysLeft,
    income,
    spent,
    billsDue,
    norm,
    normToDate,
    usualPayDay,
    projection,
    uncategorized: { count, sum, largest },
    categories,
    otherCurrencies: otherCurrenciesOf(read, agg.cat, currency, label, baseCurrency),
  };
}

// --------------------------------------------------------------------------- transactions

export type CompanionCursor = { readonly date: IsoDate; readonly gid: string };

export type CompanionFilter = "all" | "uncategorized" | "income" | "cash" | "account";

export type CompanionTransactionsArgs = {
  readonly filter: CompanionFilter;
  readonly account?: string | null;
  readonly category?: string | null;
  readonly before?: CompanionCursor | null;
  /** Default 100, at most 300. */
  readonly limit?: number | null;
};

export interface CompanionTransactions {
  readonly rows: readonly CompanionTxnRow[];
  /** The cursor of the next page; null on the last one. */
  readonly next: CompanionCursor | null;
}

/** The SQL of a list filter (alias `t`, `a`); null when the filter can match nothing. */
function filterSql(args: CompanionTransactionsArgs): { sql: string; params: string[] } | null {
  switch (args.filter) {
    case "all":
      return { sql: "", params: [] };
    case "uncategorized":
      return { sql: `AND ${UNCATEGORIZED_SQL}`, params: [] };
    case "income":
      // Inflows that are income: no own transfer, no structural category (a cash leg, own moves).
      return {
        sql: `AND CAST(t.amount AS REAL) > 0 AND t.is_internal_transfer = 0
          AND (t.category IS NULL OR t.category NOT IN ('transfer', 'cash_withdrawal'))`,
        params: [],
      };
    case "cash":
      return { sql: "AND a.type = ?", params: [budget.CASH_ACCOUNT_TYPE] };
    case "account":
      return args.account ? { sql: "AND a.gid = ?", params: [args.account] } : null;
  }
}

export const budgetTransactions = defineQuery({
  id: "budget.companionTransactions",
  run(read, args: CompanionTransactionsArgs): CompanionTransactions {
    const filter = filterSql(args);
    if (filter === null) return { rows: [], next: null };
    const limit = clampLimit(args.limit, LIST_DEFAULT);
    const params: (string | number)[] = [...filter.params];
    let sql = filter.sql;
    if (args.category) {
      sql += ` AND t.category = ? AND NOT ${UNCATEGORIZED_SQL}`;
      params.push(args.category);
    }
    if (args.before) {
      sql += " AND (t.booking_date < ? OR (t.booking_date = ? AND t.gid < ?))";
      params.push(args.before.date, args.before.date, args.before.gid);
    }
    const found = read<SqlRow>(
      `${ROW_SELECT} WHERE ${VISIBLE} ${sql} ${NEWEST_FIRST} LIMIT ?`,
      ...params,
      limit + 1,
    );
    const rows = found.slice(0, limit).map(toRow);
    const last = rows.at(-1);
    return {
      rows,
      next: found.length > limit && last !== undefined ? { date: last.date, gid: last.gid } : null,
    };
  },
});

/**
 * How many uncategorized rows the vault has (visible accounts), optionally in one month and currency:
 * the Activity chip's count and the triage total. Its own query, so a list page never pays for it.
 */
export const budgetUncategorizedCount = defineQuery({
  id: "budget.companionUncategorizedCount",
  run: (read, args: CompanionUncategorizedScope): number => uncategorizedTotal(read, args),
});

// --------------------------------------------------------------------------- search

export type CompanionSearchArgs = {
  readonly q: string;
  readonly lang: core.UiLang;
  /** Default 200, at most 300. */
  readonly limit?: number | null;
};

export interface CompanionSearch {
  readonly rows: readonly CompanionTxnRow[];
  /** Hits before the limit. */
  readonly total: number;
  /** The payee's year-by-year summary when every hit shares one merchant key (and currency). */
  readonly summary: budget.PayeeSummary | null;
}

const NUMBER_TOKEN = /^\d+(?:[.,]\d+)?$/;
/** A token the index can match: it holds a letter or a digit (the tokenizer drops everything else). */
const INDEXABLE = /[\p{L}\p{N}]/u;

/** The category keys with a label word (Polish or English, normalized) that starts with the token. */
function categoryKeysMatching(token: string): string[] {
  const words = (label: string) => normalizeText(label).split(/[^\p{L}\p{N}]+/u);
  return budget.CATEGORIES.filter((c) =>
    [...words(c.label), ...words(c.labelEn)].some((w) => w.startsWith(token)),
  ).map((c) => c.key);
}

/** One search token: its FTS5 expression and the categories whose label it names. */
interface SearchToken {
  readonly match: string;
  readonly categories: readonly string[];
}

/**
 * One token (whitespace-separated, through `normalizeText`): a prefix match of the row's indexed text
 * (`budget.search`: statement texts and merchant key, case and diacritics folded both ways), for a
 * number also of the amount (`ftsAmountPrefix`), and the categories whose label word it starts.
 * Null for a token with no letter or digit (nothing to match).
 */
function searchToken(raw: string): SearchToken | null {
  const token = normalizeText(raw);
  if (!INDEXABLE.test(token)) return null;
  // A quoted phrase: FTS syntax characters are literal inside; `"` doubles.
  const text = `text : "${token.replaceAll('"', '""')}"*`;
  const match = NUMBER_TOKEN.test(token)
    ? `(${text} OR amount : "${ftsAmountPrefix(token)}"*)`
    : text;
  return { match, categories: categoryKeysMatching(token) };
}

/** A SQL condition with its parameters. */
interface Cond {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

/** The `transactions.id` of an index row (its rowid: booking day * 2^32 + id). */
const FTS_TXN = `(${SEARCH_FTS}.rowid & ${FTS_ID_MASK})`;

/** The index's hits (visible rows only) as `transactions t` rows, newest booking day first. */
const FTS_FROM = `FROM ${SEARCH_FTS} CROSS JOIN transactions t ON t.id = ${FTS_TXN}`;

/**
 * A row of a category the token names that is not uncategorized (a NULL source is not uncategorized,
 * as in `CompanionTxnRow.uncategorized`). An uncategorized row (an outflow with source `default`)
 * holds the engine's default category `other` (domain `categorize`, its last step), so the check
 * reads the row only for a token naming `other`. `plus` keeps the category index out of a
 * date-ordered walk.
 */
function categoryHit(t: SearchToken, plus = false): Cond {
  const unc = t.categories.includes("other") ? ` AND COALESCE(NOT ${UNCATEGORIZED_SQL}, 1)` : "";
  return {
    sql: `(${plus ? "+" : ""}t.category IN (${marks(t.categories.length)})${unc})`,
    params: t.categories,
  };
}

/** A row the token hits: its text (the index) or, for a token naming categories, its category. */
function tokenHit(t: SearchToken, plus = false): Cond {
  const text = `t.id IN (SELECT ${FTS_TXN} FROM ${SEARCH_FTS} WHERE ${SEARCH_FTS} MATCH ?)`;
  if (t.categories.length === 0) return { sql: text, params: [t.match] };
  const cat = categoryHit(t, plus);
  return { sql: `(${cat.sql} OR ${text})`, params: [...cat.params, t.match] };
}

const and = (conds: readonly Cond[]): Cond => ({
  sql: conds.map((c) => ` AND ${c.sql}`).join(""),
  params: conds.flatMap((c) => c.params),
});

/** A hit as the page reads it. */
interface HitKey {
  readonly id: number;
  readonly date: IsoDate;
  readonly gid: string;
  readonly mk: string | null;
}

const HIT_KEY = "t.id, t.booking_date AS date, t.gid, t.merchant_key AS mk";

/** `NEWEST_FIRST` in JS (booking date, then gid, both descending). */
const newestFirst = (a: HitKey, b: HitKey): number =>
  a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.gid < b.gid ? 1 : a.gid > b.gid ? -1 : 0;

/** The summary columns of a hit (one payee's rows, beyond the page). */
const SEARCH_HIT = `t.gid, t.booking_date AS date, t.amount, t.currency, t.counterparty_name AS name,
  t.reference, t.description, a.type AS accountType`;

/** The columns a payee summary reads of a search hit. */
type SearchHit = Pick<
  SqlRow,
  "gid" | "date" | "amount" | "currency" | "name" | "reference" | "description" | "accountType"
>;

/**
 * Where the hits come from: the page (newest first, `limit`), the total, whether some hit has another
 * merchant key than `mk` (`otherMerchant`), and every hit's summary columns.
 */
interface HitSource {
  page(limit: number): { rows: readonly HitKey[]; complete: boolean };
  count(): number;
  otherMerchant(mk: string): boolean;
  all(): readonly SearchHit[];
}

/**
 * Hits driven by the index: a match (`match`) filtered by `filter`. The index iterates newest booking
 * day first, so the page reads twice the limit with an early exit and cuts it exactly by gid inside
 * the last day; with no filter the total is the index's count of the match (it holds visible rows
 * only), never a read of every hit's row.
 */
function indexHits(read: Read, match: string, filter: Cond): HitSource {
  const where = `WHERE ${SEARCH_FTS} MATCH ?${filter.sql}`;
  const params = [match, ...filter.params];
  return {
    page(limit) {
      const fetch = 2 * limit;
      const got = read<HitKey>(
        `SELECT ${HIT_KEY} ${FTS_FROM} ${where} ORDER BY ${SEARCH_FTS}.rowid DESC LIMIT ?`,
        ...params,
        fetch,
      );
      if (got.length < fetch) return { rows: [...got].sort(newestFirst), complete: true };
      // Every hit of a later day is in `got`; the last day's hits too unless `got` ends inside it.
      const cut = (got[limit - 1] as HitKey).date;
      let rows: readonly HitKey[] = got;
      if ((got.at(-1) as HitKey).date === cut) {
        const day = bookingDay(cut);
        rows = [
          ...got.filter((r) => r.date > cut),
          ...read<HitKey>(
            `SELECT ${HIT_KEY} ${FTS_FROM} ${where}
               AND ${SEARCH_FTS}.rowid >= ${FTS_ROWID_SQL} AND ${SEARCH_FTS}.rowid < ${FTS_ROWID_SQL}`,
            ...params,
            day,
            0,
            day + 1,
            0,
          ),
        ];
      }
      return { rows: [...rows].sort(newestFirst), complete: false };
    },
    count: () =>
      read<{ n: number }>(
        filter.sql === ""
          ? `SELECT count(*) AS n FROM ${SEARCH_FTS} ${where}`
          : `SELECT count(*) AS n ${FTS_FROM} ${where}`,
        ...params,
      )[0]?.n ?? 0,
    otherMerchant: (mk) =>
      read(
        `SELECT 1 AS x ${FTS_FROM} ${where} AND COALESCE(t.merchant_key, '') <> ? LIMIT 1`,
        ...params,
        mk,
      ).length > 0,
    all: () =>
      read<SearchHit>(
        `SELECT ${SEARCH_HIT} ${FTS_FROM} JOIN accounts a ON a.id = t.account_id ${where}`,
        ...params,
      ),
  };
}

/** Hits at or above this many page by walking the booking-date index (measured at 60k rows). */
const WALK_MIN_HITS = 2000;

/**
 * The visible rows of the token's categories (`others`: the other tokens' filter). Without a filter
 * the count reads the category index alone (`categoryHit` reads a row only for `other`), less the rows
 * of accounts that are not visible (removed, or not arrived yet). The page walks the booking-date index
 * newest first with an early exit for a large category, else sorts the category's rows.
 */
function categoryRows(read: Read, t: SearchToken, others: Cond): HitSource {
  const cat = categoryHit(t);
  const from = `FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE ${VISIBLE} AND ${cat.sql}${others.sql}`;
  const params = [...cat.params, ...others.params];
  let total: number | undefined;
  const count = (): number => {
    if (total !== undefined) return total;
    if (others.sql !== "") {
      total = read<{ n: number }>(`SELECT count(*) AS n ${from}`, ...params)[0]?.n ?? 0;
      return total;
    }
    const all = read<{ n: number }>(
      `SELECT count(*) AS n FROM transactions t WHERE ${cat.sql}`,
      ...cat.params,
    )[0]?.n;
    const hidden = read<{ id: number }>(
      `SELECT account_id AS id FROM (SELECT DISTINCT account_id FROM transactions)
       WHERE account_id NOT IN (SELECT id FROM accounts WHERE removed_at IS NULL)`,
    ).map((r) => r.id);
    const off =
      hidden.length === 0
        ? 0
        : (read<{ n: number }>(
            `SELECT count(*) AS n FROM transactions t
             WHERE t.account_id IN (${marks(hidden.length)}) AND ${cat.sql}`,
            ...hidden,
            ...cat.params,
          )[0]?.n ?? 0);
    total = (all ?? 0) - off;
    return total;
  };
  return {
    page(limit) {
      const order = `${NEWEST_FIRST} LIMIT ?`;
      const rows =
        count() >= WALK_MIN_HITS
          ? read<HitKey>(
              `SELECT ${HIT_KEY} FROM transactions t JOIN accounts a ON a.id = t.account_id
               WHERE ${VISIBLE} AND ${categoryHit(t, true).sql}${others.sql} ${order}`,
              ...params,
              limit,
            )
          : read<HitKey>(`SELECT ${HIT_KEY} ${from} ${order}`, ...params, limit);
      return { rows, complete: rows.length < limit };
    },
    count,
    otherMerchant: (mk) =>
      read(`SELECT 1 AS x ${from} AND COALESCE(t.merchant_key, '') <> ? LIMIT 1`, ...params, mk)
        .length > 0,
    all: () => read<SearchHit>(`SELECT ${SEARCH_HIT} ${from}`, ...params),
  };
}

/**
 * Two disjoint hit sources as one: the page merges both pages (each the exact newest of its part,
 * so the newest of the union are among them), the total adds both counts.
 */
function unionHits(parts: readonly HitSource[]): HitSource {
  return {
    page(limit) {
      const pages = parts.map((p) => p.page(limit));
      return {
        rows: pages.flatMap((p) => p.rows).sort(newestFirst),
        complete: pages.every((p) => p.complete),
      };
    },
    count: () => parts.reduce((n, p) => n + p.count(), 0),
    otherMerchant: (mk) => parts.some((p) => p.otherMerchant(mk)),
    all: () => parts.flatMap((p) => p.all()),
  };
}

/**
 * Hits of category-naming tokens only: the first token's hits split into two disjoint parts, the
 * visible rows of its categories (the category index) and its index hits outside them, each filtered
 * by the other tokens. For a single token the second part counts as the index's count of the match
 * less its hits inside the categories (the index iterated against the category index), never a read
 * of every hit's row. A token in nearly every row's text that also starts a category label ("zakup":
 * "Zakupy") still pays that intersection over every hit: see `companion-queries.perf.test.ts`.
 */
function categoryHits(read: Read, named: readonly SearchToken[]): HitSource {
  const [first, ...rest] = named as [SearchToken, ...SearchToken[]];
  const others = and(rest.map((t) => tokenHit(t)));
  const cat = categoryHit(first);
  const outside = indexHits(read, first.match, {
    sql: ` AND NOT COALESCE(${cat.sql}, 0)${others.sql}`,
    params: [...cat.params, ...others.params],
  });
  const count = (sql: string, ...params: SqlValue[]) =>
    read<{ n: number }>(sql, ...params)[0]?.n ?? 0;
  return unionHits([
    categoryRows(read, first, others),
    rest.length > 0
      ? outside
      : {
          ...outside,
          count: () =>
            count(
              `SELECT count(*) AS n FROM ${SEARCH_FTS} WHERE ${SEARCH_FTS} MATCH ?`,
              first.match,
            ) -
            count(
              `SELECT count(*) AS n FROM ${SEARCH_FTS} WHERE ${SEARCH_FTS} MATCH ?
                 AND ${FTS_TXN} IN (SELECT t.id FROM transactions t WHERE ${cat.sql})`,
              first.match,
              ...cat.params,
            ),
        },
  ]);
}

/**
 * Search the visible rows, newest first. Prefix-token semantics over the `budget.search` index
 * (dev-feedback #22.9): every token must match; a token matches a word of the row's statement texts
 * or merchant key that starts with it, case and diacritics folded both ways ("orl" and "orlen" find
 * ORLEN, "zabka" finds ŻABKA, "Łódź" finds LODZ; "rlen" finds nothing), a number also an amount that
 * starts with it ("1284" finds 1284.00, "12,5" finds 12.50), a label word also its category's rows.
 *
 * Cost (performance.md, <= 8 ms at 60k rows): the text tokens drive the index in booking-date order,
 * so a word in every row ("zakup", "sk") reads the newest page with an early exit plus the index's
 * count, never every hit's row; a category label ("paliwo") reads its category's rows through the
 * category index for the count and walks the booking-date index for the page.
 */
export const budgetSearch = defineQuery({
  id: "budget.companionSearch",
  run(read, args: CompanionSearchArgs): CompanionSearch {
    const tokens = args.q
      .split(/\s+/)
      .map(searchToken)
      .filter((t) => t !== null);
    if (tokens.length === 0) return { rows: [], total: 0, summary: null };
    const limit = clampLimit(args.limit, SEARCH_DEFAULT);
    const plain = tokens.filter((t) => t.categories.length === 0);
    const named = tokens.filter((t) => t.categories.length > 0);
    const source =
      plain.length > 0
        ? indexHits(
            read,
            plain.map((t) => t.match).join(" AND "),
            and(named.map((t) => tokenHit(t))),
          )
        : categoryHits(read, named);
    const page = source.page(limit);
    const total = page.complete ? page.rows.length : source.count();
    const ids = page.rows.slice(0, limit).map((r) => r.id);
    // One merchant key across every hit (a key seen on the page, no other key among the rest).
    const keys = new Set(page.rows.map((r) => r.mk ?? ""));
    const [mk] = keys;
    const shared =
      total >= 2 &&
      keys.size === 1 &&
      mk !== undefined &&
      mk !== "" &&
      (page.complete || !source.otherMerchant(mk))
        ? mk
        : null;
    const found =
      ids.length === 0
        ? []
        : read<SqlRow>(
            `${ROW_SELECT} WHERE t.id IN (${marks(ids.length)}) ${NEWEST_FIRST}`,
            ...ids,
          );
    // One merchant: its year-by-year summary over every hit (beyond the page: one payee's rows, slim).
    const hits: readonly SearchHit[] =
      shared === null ? [] : total <= found.length ? found : source.all();
    const summary =
      shared === null || hits.length === 0
        ? null
        : budget.payeeSummary(
            hits.map((h) => ({
              key: h.gid,
              merchantKey: shared,
              payee: payeeOf(
                h.name,
                h.reference,
                h.description,
                h.accountType === budget.CASH_ACCOUNT_TYPE,
              ),
              date: h.date,
              amount: D(h.amount),
              currency: h.currency,
            })),
          );
    return { rows: found.map(toRow), total, summary };
  },
});

// --------------------------------------------------------------------------- detail

export type CompanionDetailArgs = { readonly txn: string; readonly lang: core.UiLang };

export interface CompanionTxnDetail {
  readonly row: CompanionTxnRow;
  /** The counterparty account number's last four characters. */
  readonly ibanTail: string | null;
  /** The other side of the same own transfer. */
  readonly transferCounterpart: {
    readonly account: { readonly gid: string; readonly name: string };
  } | null;
  /** The import batch that brought the row. */
  readonly batch: { readonly source: string; readonly finishedAt: string | null } | null;
  /** Older rows of the same merchant, newest first (at most 5). */
  readonly earlier: readonly CompanionTxnRow[];
  /** Every visible row of the merchant, this one included. */
  readonly sameMerchantCount: number;
  /** The merchant's category rule (an owner's pin is `locked`); null without a rule or merchant key. */
  readonly merchantRule: { readonly category: string; readonly locked: boolean } | null;
}

export const budgetTransactionDetail = defineQuery({
  id: "budget.companionTransaction",
  run(read, args: CompanionDetailArgs): CompanionTxnDetail | null {
    const found = read<
      SqlRow & { iban: string | null; transferGroup: string | null; batch: number | null }
    >(
      `SELECT ${ROW_COLUMNS}, t.counterparty_iban AS iban, t.transfer_group_id AS transferGroup,
         t.import_batch_id AS batch ${ROW_FROM} WHERE ${VISIBLE} AND t.gid = ?`,
      args.txn,
    )[0];
    if (found === undefined) return null;
    const row = toRow(found);
    // The other leg's account; a removed account is out of the budget, so it is never named.
    const counterpart =
      found.transferGroup === null
        ? undefined
        : read<{ gid: string; name: string }>(
            `SELECT a.gid, a.name FROM transactions t JOIN accounts a ON a.id = t.account_id
             WHERE t.transfer_group_id = ? AND t.gid != ? AND ${VISIBLE} ORDER BY t.id LIMIT 1`,
            found.transferGroup,
            found.gid,
          )[0];
    const batch =
      found.batch === null
        ? undefined
        : read<{ source: string; finishedAt: string | null }>(
            "SELECT source, finished_at AS finishedAt FROM import_batches WHERE id = ?",
            found.batch,
          )[0];
    const key = row.merchantKey;
    const sameMerchantCount =
      key === null
        ? 0
        : (read<{ n: number }>(`SELECT count(*) AS n FROM (${merchantRowsSql(1)})`, key)[0]?.n ??
          0);
    const earlier =
      key === null
        ? []
        : read<SqlRow>(
            `${ROW_SELECT} WHERE ${VISIBLE} AND t.gid IN (SELECT gid FROM (${merchantRowsSql(1)}))
               AND (t.booking_date < ? OR (t.booking_date = ? AND t.gid < ?))
             ${NEWEST_FIRST} LIMIT ?`,
            key,
            row.date,
            row.date,
            row.gid,
            EARLIER_MAX,
          ).map(toRow);
    const rule =
      key === null
        ? undefined
        : read<{ category: string; locked: number }>(
            "SELECT category, locked FROM category_rules WHERE merchant_key = ?",
            key,
          )[0];
    return {
      row,
      ibanTail: found.iban ? Array.from(found.iban).slice(-4).join("") : null,
      transferCounterpart: counterpart === undefined ? null : { account: counterpart },
      batch:
        batch === undefined
          ? null
          : { source: batch.source, finishedAt: eventTimestamp(batch.finishedAt) },
      earlier,
      sameMerchantCount,
      merchantRule:
        rule === undefined ? null : { category: rule.category, locked: rule.locked === 1 },
    };
  },
});

// --------------------------------------------------------------------------- uncategorized

export type CompanionUncategorizedArgs = CompanionUncategorizedScope & {
  /** Default 50, at most 300. */
  readonly limit?: number | null;
};

export interface CompanionUncategorizedRow extends CompanionTxnRow {
  /** The merchant's newest owner or LLM decision: its rule, else a decided row; null without one. */
  readonly suggestion: string | null;
}

export interface CompanionUncategorized {
  readonly rows: readonly CompanionUncategorizedRow[];
  /**
   * The uncategorized flow outflows in the scope (the month and currency when given), not only
   * `rows`: the month figures' count (`budget.isFlow`). `rows` lists by the plain flag (an outflow,
   * not an internal transfer, `category_source = 'default'`), so it may also hold a row with an
   * own-account counterparty or a structural category that `total` leaves out (the engine files such
   * rows as transfers, so through the engine the two agree).
   */
  readonly total: number;
}

/**
 * The per-row decisions a merchant's newest row can suggest. A row filed `llm` or `manual` took its
 * category from the merchant's rule (`categorize`, steps 2 and 4), which `suggestions` reads first, so
 * only the per-row sources are listed here.
 */
const DECIDED_SOURCES = ["manual_txn", "llm_full", "llm_fallback"] as const;

/** Per merchant key: its category rule, else the category of its newest decided row. */
function suggestions(read: Read, keys: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;
  for (const r of read<{ merchantKey: string; category: string }>(
    `SELECT merchant_key AS merchantKey, category FROM category_rules
     WHERE merchant_key IN (${marks(keys.length)}) AND source IN ('manual', 'llm')
     ORDER BY created_at, id`,
    ...keys,
  ))
    out.set(r.merchantKey, r.category);
  const open = keys.filter((k) => !out.has(k));
  if (open.length === 0) return out;
  // The newest decided row per merchant, one grouped read.
  for (const r of read<{ merchantKey: string; category: string }>(
    `SELECT merchantKey, category FROM (
       SELECT m.merchantKey, t.category, ROW_NUMBER() OVER (
         PARTITION BY m.merchantKey ORDER BY t.booking_date DESC, t.gid DESC) AS rn
       FROM (${merchantRowsSql(open.length)}) m JOIN transactions t ON t.gid = m.gid
       WHERE t.category IS NOT NULL
         AND t.category_source IN (${DECIDED_SOURCES.map((s) => `'${s}'`).join(", ")})
     ) WHERE rn = 1`,
    ...open,
  ))
    out.set(r.merchantKey, r.category);
  return out;
}

/**
 * The scope's uncategorized flow outflows, newest first, at most `limit`: exactly the rows the count
 * and the total count (`budget.isFlow`: also no structural category and no own-account counterparty,
 * the IBANs compared as keys in JS), read in keyset pages until `limit` rows pass.
 */
function uncategorizedFlowRows(
  read: Read,
  scope: CompanionUncategorizedScope,
  limit: number,
): CompanionTxnRow[] {
  const { sql, params } = scopeSql(scope);
  const own = ownIbanKeys(read);
  const out: CompanionTxnRow[] = [];
  let before: CompanionCursor | null = null;
  for (;;) {
    const cursor: (string | number)[] =
      before === null ? [] : [before.date, before.date, before.gid];
    const page: (SqlRow & { iban: string | null })[] = read(
      `SELECT ${ROW_COLUMNS}, t.counterparty_iban AS iban ${ROW_FROM}
       WHERE ${VISIBLE} AND ${UNCATEGORIZED_SQL}${sql}
         ${before === null ? "" : "AND (t.booking_date < ? OR (t.booking_date = ? AND t.gid < ?))"}
       ${NEWEST_FIRST} LIMIT ?`,
      ...params,
      ...cursor,
      limit,
    );
    for (const r of page) {
      const cp = r.iban ? ibanKey(r.iban) : "";
      if (cp !== "" && own.has(cp)) continue;
      if (r.category !== null && budget.NON_SPENDING_CATEGORIES.has(r.category)) continue;
      out.push(toRow(r));
      if (out.length === limit) return out;
    }
    const last: SqlRow | undefined = page.at(-1);
    if (last === undefined || page.length < limit) return out;
    before = { date: last.date, gid: last.gid };
  }
}

export const budgetUncategorizedRows = defineQuery({
  id: "budget.companionUncategorized",
  run(read, args: CompanionUncategorizedArgs): CompanionUncategorized {
    const limit = clampLimit(args.limit, UNCATEGORIZED_DEFAULT);
    const rows = uncategorizedFlowRows(read, args, limit);
    const keys = [...new Set(rows.flatMap((r) => (r.merchantKey === null ? [] : [r.merchantKey])))];
    const suggested = suggestions(read, keys);
    return {
      rows: rows.map((r) => ({
        ...r,
        suggestion: r.merchantKey === null ? null : (suggested.get(r.merchantKey) ?? null),
      })),
      total: uncategorizedTotal(read, args),
    };
  },
});

// --------------------------------------------------------------------------- category picker

export type CompanionCategoriesArgs = { readonly today: IsoDate; readonly lang: core.UiLang };

export interface CompanionCategoryOption {
  readonly key: string;
  readonly label: string;
  readonly kind: budget.CategoryKind;
  /** Rows filed under it in the last 12 months. */
  readonly uses: number;
  /** Its position in the list (expense keys first: the swatch colour index). */
  readonly rank: number;
}

export const budgetCategoryOptions = defineQuery({
  id: "budget.companionCategories",
  run(read, args: CompanionCategoriesArgs): CompanionCategoryOption[] {
    const uses = new Map(
      read<{ category: string; n: number }>(
        `SELECT t.category, count(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
         WHERE ${VISIBLE} AND t.category IS NOT NULL AND NOT ${UNCATEGORIZED_SQL}
           AND t.booking_date > ? AND t.booking_date <= ?
         GROUP BY t.category`,
        addMonths(args.today, -USES_MONTHS),
        args.today,
      ).map((r) => [r.category, r.n]),
    );
    const order = new Map(budget.CATEGORIES.map((c, i) => [c.key, i]));
    const expense = budget.CATEGORIES.filter((c) => c.kind === "expense").sort(
      (a, b) =>
        (uses.get(b.key) ?? 0) - (uses.get(a.key) ?? 0) ||
        (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0),
    );
    const rest = budget.CATEGORIES.filter(
      (c) => c.key === budget.CASH_WITHDRAWAL || c.kind === "income",
    ).sort(
      (a, b) =>
        Number(b.key === budget.CASH_WITHDRAWAL) - Number(a.key === budget.CASH_WITHDRAWAL) ||
        (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0),
    );
    return [...expense, ...rest].map((c, rank) => ({
      key: c.key,
      label: budget.categoryLabel(c.key, args.lang),
      kind: c.kind,
      uses: uses.get(c.key) ?? 0,
      rank,
    }));
  },
});

// --------------------------------------------------------------------------- overview inputs

/** The days before the vault's newest booking date a payee's last charge keeps it active. */
const ACTIVE_DAYS = 45;

interface RecurringSql {
  merchant_key: string;
  currency: string;
  typical_amount: string;
  occurrences: number;
  months_covered: number;
  median_gap_days: number;
  last_date: IsoDate;
  seq_account: number;
  seq_id: number;
  payee: string;
  account_id: number | null;
  charge_last: IsoDate | null;
  first_seen: IsoDate;
  charges: string;
}

const recordOf = (r: RecurringSql): RecurringRecord => ({
  merchantKey: r.merchant_key,
  currency: r.currency,
  typicalAmount: r.typical_amount,
  occurrences: r.occurrences,
  monthsCovered: r.months_covered,
  medianGapDays: r.median_gap_days,
  lastDate: r.last_date,
  seqAccount: r.seq_account,
  seqId: r.seq_id,
  payee: r.payee,
  accountId: r.account_id,
  chargeLast: r.charge_last,
  firstSeen: r.first_seen,
  charges: r.charges,
});

/**
 * The active recurring payments up to `today` (rows booked later are not charges yet), one per
 * recurring candidate with its own charges, in list order (`budget.recurringPayments` +
 * `activeRecurring` + `recurringSeries` over the book cut at `today`). Over the recurring deriver's
 * records (`fold_recurring`, every group over all its rows): active = last charge within 45 days of
 * the newest booking date up to `today`. A group with a charge after `today`, or with both active
 * and stale candidates (the series are formed over the active ones only), is recomputed from its
 * rows up to `today` (`fold_recurring_rows`, `recurring-groups.ts`).
 */
function recurringRecords(read: Read, today: IsoDate): RecurringRecord[] {
  // The recurring tables wake a live query with the rows, accounts and merchant rules (their
  // `wakesWith`); the modules' payment patterns are read by the overview.
  const ref =
    read<{ d: IsoDate }>(
      `SELECT t.booking_date AS d FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE ${VISIBLE} AND t.booking_date <= ? ORDER BY t.booking_date DESC LIMIT 1`,
      today,
    )[0]?.d ?? null;
  const cutoff = ref === null ? null : addDays(ref, -ACTIVE_DAYS);
  const isActive = (lastDate: IsoDate) => cutoff === null || lastDate >= cutoff;
  // Groups with a possible charge after today: their stored records count rows today does not. Only
  // a group that may recur over all its rows (`fold_recurring_groups`) may over those up to today.
  const later = new Set(
    read<{ mk: string; currency: string }>(
      `SELECT DISTINCT t.merchant_key AS mk, t.currency FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.booking_date > ? AND ${VISIBLE} AND t.is_internal_transfer = 0
         AND t.merchant_key <> '' AND t.amount LIKE '-%'
         AND EXISTS (SELECT 1 FROM fold_recurring_groups g
           WHERE g.merchant_key = t.merchant_key AND g.currency = t.currency)`,
      today,
    ).map((r) => JSON.stringify([r.mk, r.currency])),
  );
  const byGroup = new Map<string, RecurringRecord[]>();
  for (const r of read<RecurringSql>("SELECT * FROM fold_recurring")) {
    const g = JSON.stringify([r.merchant_key, r.currency]);
    const list = byGroup.get(g);
    if (list === undefined) byGroup.set(g, [recordOf(r)]);
    else list.push(recordOf(r));
  }
  const out: RecurringRecord[] = [];
  const recompute: string[] = [...later];
  for (const [g, records] of byGroup) {
    if (later.has(g)) continue;
    const active = records.filter((r) => isActive(r.lastDate));
    if (active.length === records.length) out.push(...records);
    else if (active.length > 0) recompute.push(g);
  }
  for (const g of recompute) {
    const [mk, currency] = JSON.parse(g) as [string, string];
    const rows = read<GroupEntryRow>(
      `${GROUP_ENTRIES_SQL} AND booking_date <= ? ${BOOK_ORDER}`,
      mk,
      currency,
      today,
    );
    out.push(...groupRecords(mk, currency, rows, (c) => isActive(c.lastDate)));
  }
  return out.filter((r) => isActive(r.lastDate)).sort(compareRecords);
}

/** The records as upcoming-charge inputs (the account of the series' newest charge, by id). */
function chargesOf(
  read: Read,
  records: readonly RecurringRecord[],
): { record: RecurringRecord; charge: budget.RecurringCharge }[] {
  const ids = [...new Set(records.flatMap((r) => (r.accountId === null ? [] : [r.accountId])))];
  const accounts = new Map(
    ids.length === 0
      ? []
      : read<{ id: number; gid: string; name: string }>(
          `SELECT id, gid, name FROM accounts WHERE id IN (${marks(ids.length)})`,
          ...ids,
        ).map((a) => [a.id, { id: a.gid, name: a.name }]),
  );
  return records.map((record) => {
    const typicalAmount = D(record.typicalAmount);
    return {
      record,
      charge: {
        key: `${record.merchantKey}:${record.currency}:${typicalAmount.toString()}`,
        payee: record.payee,
        typicalAmount,
        currency: record.currency,
        // A charge at a new price continues the series after the candidate's own last charge.
        lastDate:
          record.chargeLast !== null && record.chargeLast > record.lastDate
            ? record.chargeLast
            : record.lastDate,
        medianGapDays: record.medianGapDays,
        account: record.accountId === null ? null : (accounts.get(record.accountId) ?? null),
      },
    };
  });
}

/**
 * The active recurring payments as upcoming-charge inputs: `key` = the series key
 * (`<merchant key>:<currency>:<typical amount>`), the paying account = the account of the series'
 * newest charge.
 */
export function recurringCharges(read: Read, today: IsoDate): budget.RecurringCharge[] {
  return chargesOf(read, recurringRecords(read, today)).map((c) => c.charge);
}

/** The same series with their last 12 charges (newest first, positive) and their first charge. */
export function payeeChargeHistories(read: Read, today: IsoDate): budget.PayeeChargeHistory[] {
  return chargesOf(read, recurringRecords(read, today)).map(({ record, charge }) => ({
    ...charge,
    charges: (JSON.parse(record.charges) as [IsoDate, string][]).map(([date, amount]) => ({
      date,
      amount: D(amount),
    })),
    firstSeen: record.firstSeen,
  }));
}

const BALANCE_TYPES = ["checking", "savings", budget.CASH_ACCOUNT_TYPE] as const;

/**
 * The current balance of every visible checking, savings and cash account, valued as the overview
 * values them (`budgetNetWorth`): a bank account's newest balance snapshot (its `latest`: the
 * snapshots alone, the walk back over its rows only shapes the history), a cash pool's running sum up
 * to `today` (the month aggregates' signed sums: whole months before today's, then today's month's
 * days through today). Accounts without a known balance are left out.
 */
export function accountBalances(read: Read, today: IsoDate): budget.AccountBalance[] {
  const accounts = read<{ id: number; gid: string; name: string; type: string; currency: string }>(
    `SELECT id, gid, name, type, currency FROM accounts
     WHERE removed_at IS NULL AND type IN (${marks(BALANCE_TYPES.length)}) ORDER BY id`,
    ...BALANCE_TYPES,
  );
  const snapshots = new Map<number, core.BalanceSnapshot[]>();
  for (const b of read<{ account: number; date: IsoDate; amount: string; source: string }>(
    `SELECT b.account_id AS account, b.date, b.amount, b.source FROM balances b
     JOIN accounts a ON a.id = b.account_id
     WHERE a.removed_at IS NULL AND a.type IN ('checking', 'savings')
       AND b.date = (SELECT max(date) FROM balances WHERE account_id = b.account_id)
     ORDER BY b.id`,
  )) {
    const list = snapshots.get(b.account) ?? [];
    list.push({ date: b.date, amount: D(b.amount), source: b.source });
    snapshots.set(b.account, list);
  }
  const pools = accounts.filter((a) => a.type === budget.CASH_ACCOUNT_TYPE).map((a) => a.id);
  const running = new Map<number, Decimal>(pools.map((id) => [id, D("0.00")]));
  if (pools.length > 0) {
    const month = today.slice(0, 7);
    const add = (r: { account: number; net: string }) =>
      running.set(r.account, (running.get(r.account) as Decimal).add(D(r.net)));
    for (const r of read<{ account: number; net: string }>(
      `SELECT account_id AS account, net FROM fold_month_cat
       WHERE account_id IN (${marks(pools.length)}) AND month < ?`,
      ...pools,
      month,
    )) {
      add(r);
    }
    for (const r of read<{ account: number; net: string }>(
      `SELECT account_id AS account, net FROM fold_month_day
       WHERE account_id IN (${marks(pools.length)}) AND month = ? AND day <= ?`,
      ...pools,
      month,
      Number(today.slice(8, 10)),
    )) {
      add(r);
    }
  }
  return accounts.flatMap((a) => {
    if (a.type === budget.CASH_ACCOUNT_TYPE) {
      return [
        { id: a.gid, name: a.name, currency: a.currency, balance: running.get(a.id) as Decimal },
      ];
    }
    const rows = snapshots.get(a.id);
    const latest = rows === undefined ? null : new core.BalanceValuation(rows).latest(null, today);
    return latest == null
      ? []
      : [{ id: a.gid, name: a.name, currency: a.currency, balance: latest[1] }];
  });
}
