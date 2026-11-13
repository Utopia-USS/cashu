// The book-based recurring charges the phone read before the recurring deriver (M3): detection over
// the whole `budgetBook` up to `today` (`recurringPayments`, `activeRecurring`, `recurringSeries`),
// kept verbatim as the oracle `recurringCharges` / `payeeChargeHistories` over `fold_recurring` must
// equal (property and fixture tests), and the recurring property over random budget scripts. The
// detection and the series are the frozen pre-refactor copies (`recurring-frozen.ts`), not the
// domain's per-group functions the deriver runs. Tests only. Synthetic data only.
import { budget, core, type IsoDate } from "@cashu/domain";
import fc from "fast-check";
import { expect } from "vitest";
import { payeeChargeHistories, recurringCharges } from "../budget/companion-queries.js";
import { budgetBook, budgetEngineContext } from "../budget/read-models.js";
import type { Store } from "../materialize.js";
import { vaultPaymentPatterns } from "../overview/networth.js";
import type { Read } from "../query.js";
import { type categoryScript, deliver } from "./category-script.js";
import { recurringPaymentsFrozen, recurringSeriesFrozen } from "./recurring-frozen.js";

/** What the overview supplied to the book-based detection (defaults: the built-in registry). */
export interface CompanionRecurringContext {
  readonly patterns?: readonly core.PaymentPattern[];
  readonly registry?: core.CoreRegistry;
}

const HISTORY_CHARGES = 12;
const PAYEE_DESCRIPTION_CHARS = 40;

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

function recurringOf(
  read: Read,
  today: IsoDate,
  ctx: CompanionRecurringContext,
): { series: budget.RecurringSeries; book: budget.BudgetBook }[] {
  const full = budgetBook(read);
  const book = { ...full, transactions: full.transactions.filter((t) => t.bookingDate <= today) };
  const registry = ctx.registry ?? core.builtinRegistry();
  const candidates = budget.activeRecurring(
    recurringPaymentsFrozen(
      book,
      budgetEngineContext(read, ctx.patterns ?? [], registry),
      budget.subscriptionExclusions(registry),
    ),
    book,
  );
  return recurringSeriesFrozen(candidates, book).map((series) => ({ series, book }));
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
    lastDate:
      newest !== undefined && newest.bookingDate > candidate.lastDate
        ? newest.bookingDate
        : candidate.lastDate,
    medianGapDays: candidate.medianGapDays,
    account: account === undefined ? null : { id: account.id, name: account.name },
  };
}

/** The pre-M3 `recurringCharges` (detection over the whole book). */
export function recurringChargesFromBook(
  read: Read,
  today: IsoDate,
  ctx: CompanionRecurringContext = {},
): budget.RecurringCharge[] {
  return recurringOf(read, today, ctx).map((r) => chargeOf(r.series, r.book));
}

/** The pre-M3 `payeeChargeHistories`. */
export function payeeChargeHistoriesFromBook(
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

/** `fold_recurring` as stored (the list-order columns left out), in key order. */
function recurringTable(store: Store): unknown[] {
  return store.read(
    `SELECT merchant_key, currency, typical_amount, occurrences, months_covered, median_gap_days,
       last_date, payee, account_id, charge_last, first_seen, charges
     FROM fold_recurring ORDER BY merchant_key, currency, typical_amount`,
  );
}

/**
 * The recurring deriver's records, row groups and per-group counts as stored (rederive and rebuild
 * compare them; its account signature `fold_recurring_env` is a cache a full pass writes even when no
 * input changed).
 */
export function recurringState(store: Store): unknown[] {
  return [
    store.read("SELECT * FROM fold_recurring ORDER BY merchant_key, currency, typical_amount"),
    store.read("SELECT * FROM fold_recurring_rows ORDER BY row"),
    store.read("SELECT * FROM fold_recurring_keys ORDER BY merchant_key, currency, amount_key"),
    store.read("SELECT * FROM fold_recurring_groups ORDER BY merchant_key, currency"),
  ];
}

/** The overview's recurring context with the vault's own payment patterns (production defaults). */
export const overviewContext = (read: Read): CompanionRecurringContext => ({
  patterns: vaultPaymentPatterns(read),
  registry: core.builtinRegistry(),
});

/**
 * `fold_recurring` as the book gives it: every group over all its rows, every candidate active
 * (the frozen `recurringPayments` + `recurringSeries` over the whole book), independent of the deriver.
 */
function expectedTable(store: Store): unknown[] {
  const read = store.read.bind(store);
  const ctx = overviewContext(read);
  const registry = ctx.registry ?? core.builtinRegistry();
  const book = budgetBook(read);
  const ids = new Map(
    read<{ id: number; gid: string }>("SELECT id, gid FROM accounts").map((a) => [a.gid, a.id]),
  );
  const candidates = recurringPaymentsFrozen(
    book,
    budgetEngineContext(read, ctx.patterns ?? [], registry),
    budget.subscriptionExclusions(registry),
  );
  const rows = recurringSeriesFrozen(candidates, book).map((series) => {
    const c = series.candidate;
    const charge = chargeOf(series, book);
    const newest = series.rows.at(-1);
    return {
      merchant_key: c.counterparty,
      currency: c.currency,
      typical_amount: c.typicalAmount.toString(),
      occurrences: c.occurrences,
      months_covered: c.monthsCovered,
      median_gap_days: c.medianGapDays,
      last_date: c.lastDate,
      payee: charge.payee,
      account_id: newest === undefined ? null : (ids.get(newest.account) ?? null),
      charge_last: newest?.bookingDate ?? null,
      first_seen: series.rows[0]?.bookingDate ?? c.lastDate,
      charges: JSON.stringify(
        series.rows
          .slice(-HISTORY_CHARGES)
          .reverse()
          .map((t) => [t.bookingDate, t.amount.copyAbs().toString()]),
      ),
    };
  });
  const key = (r: (typeof rows)[number]) => [r.merchant_key, r.currency, r.typical_amount] as const;
  return rows.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < 3; i++)
      if (x[i] !== y[i]) return (x[i] as string) < (y[i] as string) ? -1 : 1;
    return 0;
  });
}

/**
 * The per-group counts equal a recount of the rows table (plain SQL, apart from the deriver's deltas):
 * members per amount key and those filed `subscriptions` / `other`; the groups that may recur are those
 * with an amount seen `RECURRING_MIN_OCCURRENCES` times or a filed member.
 */
function expectRecurringCounts(store: Store): void {
  const filed = budget.RECURRING_FILED_CATEGORIES.map((c) => `'${c}'`).join(", ");
  expect(
    store.read("SELECT * FROM fold_recurring_keys ORDER BY merchant_key, currency, amount_key"),
  ).toEqual(
    store.read(
      `SELECT merchant_key, currency, amount_key, count(*) AS n,
         sum(category IN (${filed})) AS filed
       FROM fold_recurring_rows WHERE amount_key IS NOT NULL
       GROUP BY merchant_key, currency, amount_key ORDER BY merchant_key, currency, amount_key`,
    ),
  );
  expect(store.read("SELECT * FROM fold_recurring_groups ORDER BY merchant_key, currency")).toEqual(
    store.read(
      `SELECT DISTINCT merchant_key, currency FROM (
         SELECT merchant_key, currency FROM fold_recurring_rows WHERE amount_key IS NOT NULL
         GROUP BY merchant_key, currency, amount_key
         HAVING count(*) >= ${budget.RECURRING_MIN_OCCURRENCES} OR sum(category IN (${filed})) > 0)
       ORDER BY merchant_key, currency`,
    ),
  );
}

/** `fold_recurring` equals the recompute from the book; the per-group counts equal a recount. */
export function expectRecurringRecomputed(store: Store): void {
  expect(recurringTable(store)).toEqual(expectedTable(store));
  expectRecurringCounts(store);
}

/**
 * Days the recurring reads are asked at: before some rows (a group with charges after `today` is
 * recomputed), at the end of the scripts' data (stale and active candidates in one group), after it.
 */
const TODAYS = ["2026-03-20", "2026-07-20", "2026-09-10", "2026-10-31", "2027-02-01"];

/** The record-based recurring reads equal the book-based ones on every day of `todays`. */
export function expectRecurringQueriesEqual(
  store: Store,
  todays: readonly string[] = TODAYS,
): void {
  const read = store.read.bind(store);
  const ctx = overviewContext(read);
  for (const today of todays) {
    expect(recurringCharges(read, today)).toEqual(recurringChargesFromBook(read, today, ctx));
    expect(payeeChargeHistories(read, today)).toEqual(
      payeeChargeHistoriesFromBook(read, today, ctx),
    );
  }
}

/**
 * The recurring property over a random budget script: after every batch `fold_recurring` equals the
 * recompute from the book, the incremental derivation equals `deriveAll` (`rederive`) and the
 * record-based reads equal the book-based ones; a rebuild keeps the tables. Used by
 * `budget/derive/recurring.property.test.ts` and its exhaustive twin.
 */
export const recurringProperty = (script: typeof categoryScript) =>
  fc.property(script, fc.integer({ min: 1, max: 1_000_000 }), (events, seed) => {
    const a = deliver(events, seed, (s) => {
      expectRecurringRecomputed(s);
      const incremental = recurringState(s);
      expect(s.rederive().touchedTables).toEqual(new Set());
      expect(recurringState(s)).toEqual(incremental);
      expectRecurringQueriesEqual(s);
    });
    const state = recurringState(a);
    a.rebuild();
    expect(recurringState(a)).toEqual(state);
    expectRecurringQueriesEqual(a);
  });
