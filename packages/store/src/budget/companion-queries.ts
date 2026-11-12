// Budget reads of the phone companion (`@cashu/store/budget/companion`): the month figures, the
// transaction lists, search and detail, the uncategorized rows, the category picker and the plain
// budget inputs the overview composes (recurring charges, payee histories, account balances). Its own
// entry so the phone, whose bundler (Metro) does not tree-shake, reads it without the budget barrel.
// Budget only: it never reads loans, investments or assets (they meet in `overview/companion.ts`).
//
// Lists, search, detail and the uncategorized rows are direct SQL over `transactions` (newest first,
// keyset pages), never the whole `budgetBook`; month figures load the book once per run and use the
// domain analytics. Every money value stays a `Decimal` in its own currency; nothing is summed across
// currencies.
//
// Query budget (performance.md, lead decision 2026-11-12): the list reads (`budgetTransactions`, the
// uncategorized count) hold the 8 ms budget on the 60k workload and `companion-queries.perf.test.ts`
// asserts it; the month figures, attention and search are over it in M1 (the fixture is ~1.7k rows) and
// are logged there. M3 moves them to derived monthly tables and FTS5.
import {
  addMonths,
  budget,
  core,
  D,
  type Decimal,
  type IsoDate,
  monthEnd,
  normalizeText,
  ZERO,
} from "@cashu/domain";
import { defineQuery, type Read } from "../query.js";
import { eventTimestamp } from "../sql/values.js";
import { budgetBook, budgetEngineContext, budgetNetWorth } from "./read-models.js";

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
const HISTORY_CHARGES = 12;
const USES_MONTHS = 12;

/** The SQL form of `CompanionTxnRow.uncategorized` (table alias `t`). */
const UNCATEGORIZED_SQL = `(CAST(t.amount AS REAL) < 0 AND t.is_internal_transfer = 0
  AND t.category_source = 'default')`;

// --------------------------------------------------------------------------- merchant keys
//
// The one place the companion reads a row's merchant key. It lives in the fold-internal
// `fold_txn_keys` (written with the row by `transactions.ts`, so these live queries wake with the row);
// the reads below join it on its `row` key: `cashexp:<gid>` for a cash expense, else
// `<account gid>|<dedup hash>|<occurrence>`. Promoting `merchant_key` to a `transactions` column (a
// materializer version bump, events.md rule 15) and querying `t.merchant_key` directly is M3 work; until
// then the key format is spelled only here.

/** The `fold_txn_keys.row` of a transaction (aliases `t`, `a`). */
const FOLD_ROW_KEY = `CASE WHEN t.dedup_hash LIKE 'cashexp:%' THEN t.dedup_hash
    ELSE a.gid || '|' || t.dedup_hash || '|' || t.occurrence END`;

/** The join that gives a row (aliases `t`, `a`) its merchant key as `k.merchant_key`. */
const MERCHANT_KEY_JOIN = `LEFT JOIN fold_txn_keys k ON k.row = ${FOLD_ROW_KEY}`;

/**
 * A subquery of `(gid, merchantKey)` of the visible rows whose merchant key is one of `count` bound
 * keys (bind the keys twice), through the merchant key index: an import row's key splits into its
 * account, dedup hash and occurrence (the transactions' unique index), a cash expense's carries its gid
 * (cash legs have no merchant key).
 */
function merchantRowsSql(count: number): string {
  const list = marks(count);
  return `SELECT t.gid AS gid, x.mk AS merchantKey FROM (
       SELECT mk, root, substr(rest, 1, instr(rest, '|') - 1) AS hash,
         CAST(substr(rest, instr(rest, '|') + 1) AS INTEGER) AS occ
       FROM (SELECT merchant_key AS mk, substr(row, 1, instr(row, '|') - 1) AS root,
               substr(row, instr(row, '|') + 1) AS rest
             FROM fold_txn_keys WHERE merchant_key IN (${list}) AND row NOT LIKE 'cashexp:%')
     ) x JOIN accounts a ON a.gid = x.root
     JOIN transactions t ON t.account_id = a.id AND t.dedup_hash = x.hash AND t.occurrence = x.occ
     WHERE ${VISIBLE}
     UNION ALL
     SELECT t.gid, k.merchant_key FROM fold_txn_keys k JOIN transactions t ON t.gid = substr(k.row, 9)
     JOIN accounts a ON a.id = t.account_id
     WHERE k.merchant_key IN (${list}) AND k.row LIKE 'cashexp:%' AND ${VISIBLE}`;
}

// --------------------------------------------------------------------------- row SQL

const ROW_COLUMNS = `t.gid, t.booking_date AS date, t.amount, t.currency,
    t.counterparty_name AS name, t.description, t.reference, t.category,
    t.category_source AS source, t.is_internal_transfer AS internal,
    a.gid AS accountGid, a.name AS accountName, a.type AS accountType, k.merchant_key AS merchantKey`;
const ROW_FROM = `FROM transactions t JOIN accounts a ON a.id = t.account_id ${MERCHANT_KEY_JOIN}`;

/** The row columns over `transactions t JOIN accounts a`, with the row's merchant key (`k`). */
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
 * The uncategorized rows of the vault in the scope (visible accounts), through the partial index on
 * `transactions(category_source, booking_date) WHERE category_source = 'default'`.
 */
function uncategorizedTotal(read: Read, scope: CompanionUncategorizedScope = {}): number {
  const { sql, params } = scopeSql(scope);
  return (
    read<{ n: number }>(
      `SELECT count(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE ${VISIBLE} AND ${UNCATEGORIZED_SQL}${sql}`,
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

/**
 * The month's figures in one currency: income and spending, the usual month (whole, complete months:
 * `normMonths`), the projection to its end (with `billsDue` as given, 0 by default), the uncategorized
 * rows and the categories. The phone reads it through the overview's `core.companionMonth`, which
 * supplies the bills still due; this plain function has no query of its own.
 */
export function companionMonth(
  read: Read,
  args: CompanionMonthArgs,
  extra: { readonly book?: budget.BudgetBook; readonly billsDue?: Decimal } = {},
): CompanionMonth {
  const book = extra.book ?? budgetBook(read);
  const currency = args.currency || book.baseCurrency;
  const { label, year, month, ref } = companionMonthOf(args);
  const rows = budget.monthlyCashflow(book, currency);
  const row = rows.find((r) => r.label === label);
  const income = row?.income ?? D("0.00");
  const spent = row?.expense ?? D("0.00");
  const norm = budget.closedMonthNorm(
    rows,
    ref,
    budget.NORM_MONTHS,
    budget.cashflowCoverageStart(book, currency),
  );
  const normToDate = budget.usualToDate(book, currency, ref);
  const usualPayDay = budget.usualPayDay(book, currency, ref);
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
  const usual = budget.categoryNorm(book, currency, ref);
  const categories = budget
    .spendingByCategory(book, currency, { year, month }, args.lang)
    .map((c) => ({
      category: c.category,
      label: c.label,
      amount: c.amount,
      usual: usual.get(c.category) ?? null,
      share: spent.isZero() ? 0 : c.amount.div(spent).toFloat(),
    }));
  const cashAccounts = new Set(
    book.accounts.filter((a) => a.type === budget.CASH_ACCOUNT_TYPE).map((a) => a.id),
  );
  const own = budget.bookOwnIbans(book);
  let count = 0;
  let sum = D("0.00");
  let largest: CompanionLargest | null = null;
  // One pass over the month's flow outflows (`isFlow`: the rows `spent` counts): this currency's
  // uncategorized ones, and every other currency's spending.
  const otherSpent = new Map<string, Decimal>();
  for (const t of book.transactions) {
    if (t.bookingDate.slice(0, 7) !== label || !t.amount.lt(ZERO) || !budget.isFlow(t, own))
      continue;
    if (t.currency !== currency) {
      otherSpent.set(t.currency, (otherSpent.get(t.currency) ?? D("0.00")).add(t.amount.neg()));
      continue;
    }
    if (t.categorySource !== "default") continue;
    count += 1;
    sum = sum.add(t.amount.neg());
    if (largest === null || t.amount.lt(largest.amount)) {
      const cash = cashAccounts.has(t.account);
      largest = {
        gid: t.key,
        payee: payeeOf(t.counterpartyName, t.reference, t.description, cash),
        date: t.bookingDate,
        amount: t.amount,
      };
    }
  }
  const otherCurrencies = budget.budgetCurrencies(book).flatMap((c) => {
    const other = otherSpent.get(c.currency);
    return other === undefined || other.isZero() ? [] : [{ currency: c.currency, spent: other }];
  });
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
    otherCurrencies,
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
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The category keys whose label (Polish or English) contains the normalized token. */
function categoryKeysMatching(token: string): string[] {
  return budget.CATEGORIES.filter(
    (c) => normalizeText(c.label).includes(token) || normalizeText(c.labelEn).includes(token),
  ).map((c) => c.key);
}

/**
 * One token's condition: the statement texts (lower case, as typed), the merchant key (normalized,
 * so Polish diacritics match), a category label, and for a number the amount.
 */
function tokenSql(raw: string): { sql: string; params: string[] } | null {
  const token = normalizeText(raw);
  if (!token) return null;
  const text = `%${likeEscape(raw.toLowerCase())}%`;
  const key = `%${likeEscape(token)}%`;
  const parts = [
    "LOWER(t.counterparty_name) LIKE ? ESCAPE '\\'",
    "LOWER(t.description) LIKE ? ESCAPE '\\'",
    "LOWER(t.reference) LIKE ? ESCAPE '\\'",
    "k.merchant_key LIKE ? ESCAPE '\\'",
  ];
  const params = [text, text, text, key];
  const categories = categoryKeysMatching(token);
  if (categories.length > 0) {
    parts.push(`(t.category IN (${marks(categories.length)}) AND NOT ${UNCATEGORIZED_SQL})`);
    params.push(...categories);
  }
  if (NUMBER_TOKEN.test(token)) {
    const number = token.replace(",", ".");
    parts.push("ABS(CAST(t.amount AS REAL)) = CAST(? AS REAL)");
    parts.push("ltrim(t.amount, '-') LIKE ? ESCAPE '\\'");
    params.push(number, `${likeEscape(number)}%`);
  }
  return { sql: `(${parts.join(" OR ")})`, params };
}

/** The columns a payee summary reads of a search hit. */
type SearchHit = Pick<
  SqlRow,
  "gid" | "date" | "amount" | "currency" | "name" | "reference" | "description" | "accountType"
>;

export const budgetSearch = defineQuery({
  id: "budget.companionSearch",
  run(read, args: CompanionSearchArgs): CompanionSearch {
    const conditions = args.q
      .split(/\s+/)
      .map(tokenSql)
      .filter((c) => c !== null);
    if (conditions.length === 0) return { rows: [], total: 0, summary: null };
    const limit = clampLimit(args.limit, SEARCH_DEFAULT);
    const where = `WHERE ${VISIBLE} AND ${conditions.map((c) => c.sql).join(" AND ")}`;
    const params = conditions.flatMap((c) => c.params);
    // `limit + 1` rows: when they are every hit, the total and the shared merchant come from them (one
    // scan); otherwise from one aggregate over the same condition, never by reading every hit.
    const found = read<SqlRow>(
      `${ROW_SELECT} ${where} ${NEWEST_FIRST} LIMIT ?`,
      ...params,
      limit + 1,
    );
    const complete = found.length <= limit;
    let total = found.length;
    let shared: string | null = null;
    if (complete) {
      const first = found[0]?.merchantKey;
      shared = first && found.every((h) => h.merchantKey === first) ? first : null;
    } else {
      const stats = read<{ n: number; keys: number; key: string | null }>(
        `SELECT count(*) AS n, count(DISTINCT COALESCE(k.merchant_key, '')) AS keys,
           min(k.merchant_key) AS key ${ROW_FROM} ${where}`,
        ...params,
      )[0];
      total = stats?.n ?? 0;
      shared = stats !== undefined && stats.keys === 1 && stats.key ? stats.key : null;
    }
    // One merchant: its year-by-year summary over every hit (beyond the page: one payee's rows, slim).
    const hits: readonly SearchHit[] =
      shared === null || total < 2
        ? []
        : complete
          ? found
          : read<SearchHit>(
              `SELECT t.gid, t.booking_date AS date, t.amount, t.currency,
                 t.counterparty_name AS name, t.reference, t.description,
                 a.type AS accountType ${ROW_FROM} ${where}`,
              ...params,
            );
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
    const rows = found.slice(0, limit).map(toRow);
    return { rows, total, summary };
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
        : (read<{ n: number }>(`SELECT count(*) AS n FROM (${merchantRowsSql(1)})`, key, key)[0]
            ?.n ?? 0);
    const earlier =
      key === null
        ? []
        : read<SqlRow>(
            `${ROW_SELECT} WHERE ${VISIBLE} AND t.gid IN (SELECT gid FROM (${merchantRowsSql(1)}))
               AND (t.booking_date < ? OR (t.booking_date = ? AND t.gid < ?))
             ${NEWEST_FIRST} LIMIT ?`,
            key,
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
  /** Every uncategorized row in the scope (the month and currency when given), not only `rows`. */
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
    ...open,
  ))
    out.set(r.merchantKey, r.category);
  return out;
}

export const budgetUncategorizedRows = defineQuery({
  id: "budget.companionUncategorized",
  run(read, args: CompanionUncategorizedArgs): CompanionUncategorized {
    const limit = clampLimit(args.limit, UNCATEGORIZED_DEFAULT);
    const scope = scopeSql(args);
    const rows = read<SqlRow>(
      `${ROW_SELECT} WHERE ${VISIBLE} AND ${UNCATEGORIZED_SQL}${scope.sql} ${NEWEST_FIRST} LIMIT ?`,
      ...scope.params,
      limit,
    ).map(toRow);
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

/** What the overview supplies to the recurring detection (defaults: the built-in registry). */
export interface CompanionRecurringContext {
  readonly book?: budget.BudgetBook;
  readonly patterns?: readonly core.PaymentPattern[];
  readonly registry?: core.CoreRegistry;
}

/**
 * The active recurring payments of the book up to `today` (rows booked later are not charges yet),
 * one per recurring candidate, each with its own charges (`budget.recurringSeries`: a one-off purchase
 * at the same merchant is not one of them).
 */
function recurringOf(
  read: Read,
  today: IsoDate,
  ctx: CompanionRecurringContext,
): { series: budget.RecurringSeries; book: budget.BudgetBook }[] {
  const full = ctx.book ?? budgetBook(read);
  const book = { ...full, transactions: full.transactions.filter((t) => t.bookingDate <= today) };
  const registry = ctx.registry ?? core.builtinRegistry();
  const candidates = budget.activeRecurring(
    budget.recurringPayments(
      book,
      budgetEngineContext(read, ctx.patterns ?? [], registry),
      budget.subscriptionExclusions(registry),
    ),
    book,
  );
  return budget.recurringSeries(candidates, book).map((series) => ({ series, book }));
}

function chargeOf(series: budget.RecurringSeries, book: budget.BudgetBook): budget.RecurringCharge {
  const { candidate, rows } = series;
  const newest = rows.at(-1);
  const account =
    newest === undefined ? undefined : book.accounts.find((a) => a.id === newest.account);
  const cash = account?.type === budget.CASH_ACCOUNT_TYPE;
  return {
    key: series.key,
    payee:
      newest === undefined
        ? candidate.counterparty
        : payeeOf(newest.counterpartyName, newest.reference, newest.description, cash) ||
          candidate.counterparty,
    typicalAmount: candidate.typicalAmount,
    currency: candidate.currency,
    // A charge at a new price continues the series after the candidate's own last charge.
    lastDate:
      newest !== undefined && newest.bookingDate > candidate.lastDate
        ? newest.bookingDate
        : candidate.lastDate,
    medianGapDays: candidate.medianGapDays,
    account: account === undefined ? null : { id: account.id, name: account.name },
  };
}

/**
 * The active recurring payments as upcoming-charge inputs: `key` = the series key
 * (`<merchant key>:<currency>:<typical amount>`), the paying account = the account of the series'
 * newest charge.
 */
export function recurringCharges(
  read: Read,
  today: IsoDate,
  ctx: CompanionRecurringContext = {},
): budget.RecurringCharge[] {
  return recurringOf(read, today, ctx).map((r) => chargeOf(r.series, r.book));
}

/** The same series with their last 12 charges (newest first, positive) and their first charge. */
export function payeeChargeHistories(
  read: Read,
  today: IsoDate,
  ctx: CompanionRecurringContext = {},
): budget.PayeeChargeHistory[] {
  return recurringOf(read, today, ctx).map(({ series, book }) => ({
    ...chargeOf(series, book),
    charges: series.rows
      .slice(-HISTORY_CHARGES)
      .reverse()
      .map((t) => ({ date: t.bookingDate, amount: t.amount.copyAbs() })),
    firstSeen: series.rows[0]?.bookingDate ?? series.candidate.lastDate,
  }));
}

const BALANCE_TYPES = ["checking", "savings", budget.CASH_ACCOUNT_TYPE] as const;

/**
 * The current balance of every visible checking, savings and cash account, valued as the overview
 * values them (`budgetNetWorth`): a bank account's newest balance snapshot, a cash pool's running sum
 * up to `today`. Accounts without a known balance are left out.
 */
export function accountBalances(read: Read, today: IsoDate): budget.AccountBalance[] {
  const accounts = read<{
    gid: string;
    name: string;
    type: string;
    currency: string;
    active: number;
  }>(
    `SELECT gid, name, type, currency, active FROM accounts
     WHERE removed_at IS NULL AND type IN (${marks(BALANCE_TYPES.length)}) ORDER BY id`,
    ...BALANCE_TYPES,
  );
  const valuations = budgetNetWorth(read, { today, prices: null }).valuations(
    new Map(
      accounts.map((a) => [
        a.gid,
        { id: a.gid, type: a.type, currency: a.currency, active: a.active === 1, removedAt: null },
      ]),
    ),
  );
  return accounts.flatMap((a) => {
    const latest = valuations.get(a.gid)?.latest(null, today);
    return latest == null
      ? []
      : [{ id: a.gid, name: a.name, currency: a.currency, balance: latest[1] }];
  });
}
