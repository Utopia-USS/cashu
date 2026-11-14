// Deriver budget.months (M3 companion performance): the monthly aggregates the phone's month figures,
// the uncategorized count and the cash pool balances read instead of every row (`budgetBook`).
//
// Two internal tables, one row per (account, currency, month, category) and per (account, currency,
// month, day) of `transactions`: every row of every account (removed ones too: the queries keep only
// the visible accounts, so a removal needs no re-derive), the derived cash legs included, exactly the
// rows `budgetBook` reads before its removed-account filter. The flow sums follow `budget.isFlow`
// (not a matched internal transfer, the counterparty IBAN not one of the vault's own, the category
// not `transfer` / `cash_withdrawal`): `income` (amount >= 0) and `expense` (positive magnitude), the
// uncategorized flow outflows (`category_source = 'default'`); `net` sums every row signed (the cash
// pool's running balance). Sums are exact decimals added in JS from 0 and stored as their text (never
// SQLite SUM over REAL), so a sum of sums equals the sum of the rows, exponent included.
//
// Incremental unit = the group. `fold_month_rows` remembers each row's share of its groups as typed
// columns (by row key: the transactions partition, a cash leg under its source partition), so a row
// that vanished or moved is found and a group can be recomputed from its remembered rows alone. Per
// apply the candidate row keys are the dirty transaction partitions and the rows whose category or
// transfer flag changed (`takeCategoryChanges`; the categories deriver runs right before this one and
// has the same inputs), every cash leg after an account change (the legs deriver re-checks them all
// then). An unchanged row is skipped. A new row is added to its groups (adding never gives a sum
// another exponent than a recompute would). A changed row recomputes only the groups it left (its old
// month group when its month share changed, its old day group when its day share - currency, date,
// amount, flow - changed: a category move leaves the day groups alone) and is added to the groups it
// joined; a vanished row recomputes its old groups (a subtraction could leave a wider exponent than
// the remaining rows have). A recompute reads the group's remembered rows (`fold_month_rows` by
// account, month and category or day), never the month of `transactions`. A change of the own-IBAN
// set (signature in `fold_month_env`), a full pass of the categories deriver, a full re-fold or a bulk
// dirty set runs `deriveAll`: every row, read in id-order chunks.
import { budget, core, D, type Decimal, decimalKey, ZERO } from "@cashu/domain";
import type { DeriveContext, Deriver } from "../../engine/types.js";
import type { TableDef } from "../../sql/ddl.js";
import { CASHEXP, CASHLEG, splitKey, TRANSACTIONS } from "../transactions.js";
import { ALL_CHANGED, categoriesDeriver, takeCategoryChanges } from "./categories.js";
import { selectIn } from "./keys.js";

/** The aggregates change only with the rows (`transactions`) and the accounts (own IBANs, removal). */
const WAKES_WITH = [TRANSACTIONS, "accounts"] as const;

const catTable: TableDef = {
  name: "fold_month_cat",
  primaryKey: ["account_id", "currency", "month", "category"],
  internal: true,
  // a companion deriver's table: derived again on import (Deriver.companion)
  snapshot: false,
  withoutRowid: true,
  wakesWith: WAKES_WITH,
  columns: [
    { name: "account_id", type: "INTEGER", notNull: true },
    { name: "currency", type: "TEXT", notNull: true },
    /** "YYYY-MM". */
    { name: "month", type: "TEXT", notNull: true },
    /** The stored category; '' for none. */
    { name: "category", type: "TEXT", notNull: true },
    /** Flow inflows (amount >= 0), exact decimal text summed from 0. */
    { name: "income", type: "TEXT", notNull: true },
    /** Flow outflows, positive magnitude. */
    { name: "expense", type: "TEXT", notNull: true },
    /** Every row of the group. */
    { name: "n", type: "INTEGER", notNull: true },
    /** The flow rows. */
    { name: "flow_n", type: "INTEGER", notNull: true },
    /** Every row, signed. */
    { name: "net", type: "TEXT", notNull: true },
    { name: "uncategorized_n", type: "INTEGER", notNull: true },
    { name: "uncategorized_expense", type: "TEXT", notNull: true },
    /** The smallest `transactions.id` of its flow outflows (`spendingByCategory`'s first-seen order). */
    { name: "first_outflow", type: "INTEGER" },
  ],
};

const dayTable: TableDef = {
  name: "fold_month_day",
  primaryKey: ["account_id", "currency", "month", "day"],
  internal: true,
  // a companion deriver's table: derived again on import (Deriver.companion)
  snapshot: false,
  withoutRowid: true,
  wakesWith: WAKES_WITH,
  columns: [
    { name: "account_id", type: "INTEGER", notNull: true },
    { name: "currency", type: "TEXT", notNull: true },
    { name: "month", type: "TEXT", notNull: true },
    { name: "day", type: "INTEGER", notNull: true },
    { name: "n", type: "INTEGER", notNull: true },
    { name: "income", type: "TEXT", notNull: true },
    { name: "expense", type: "TEXT", notNull: true },
    /** The largest flow inflow above 0 as canonical text (`decimalKey`: only its value counts). */
    { name: "max_income", type: "TEXT" },
    { name: "net", type: "TEXT", notNull: true },
  ],
};

/**
 * Each row's share of its groups as last derived (`leg` 1: the cash leg of partition `row`): the
 * group keys and what the sums read. Indexed by (account, month, category) for a month group's
 * recompute; a day group's recompute reads the (account, month) prefix.
 */
const rowsTable: TableDef = {
  name: "fold_month_rows",
  primaryKey: ["leg", "row"],
  internal: true,
  // a companion deriver's table: derived again on import (Deriver.companion)
  snapshot: false,
  withoutRowid: true,
  columns: [
    { name: "leg", type: "INTEGER", notNull: true },
    { name: "row", type: "TEXT", notNull: true },
    { name: "account_id", type: "INTEGER", notNull: true },
    { name: "currency", type: "TEXT", notNull: true },
    { name: "month", type: "TEXT", notNull: true },
    { name: "day", type: "INTEGER", notNull: true },
    /** '' for none. */
    { name: "category", type: "TEXT", notNull: true },
    /** `transactions.id` (the month group's first outflow). */
    { name: "txn_id", type: "INTEGER", notNull: true },
    /** The amount as stored. */
    { name: "amount", type: "TEXT", notNull: true },
    /** 1: a flow row (`budget.isFlow`). */
    { name: "flow", type: "INTEGER", notNull: true },
    /** 1: an uncategorized flow outflow. */
    { name: "uncategorized", type: "INTEGER", notNull: true },
  ],
  indexes: [{ columns: ["account_id", "month", "category"] }],
};

const envTable: TableDef = {
  name: "fold_month_env",
  primaryKey: ["k"],
  internal: true,
  // a companion deriver's table: derived again on import (Deriver.companion)
  snapshot: false,
  withoutRowid: true,
  columns: [
    { name: "k", type: "TEXT", notNull: true },
    { name: "v", type: "TEXT", notNull: true },
  ],
};

/** Same bulk rule as the categories deriver: a full pass beats per-key work on big dirty sets. */
const FULL_PASS_SHARE = 8;
const FULL_PASS_MIN = 256;
/** Rows per read of the full pass. */
const CHUNK_ROWS = 4096;

interface Loaded {
  id: number;
  gid: string;
  account_id: number;
  booking_date: string;
  amount: string;
  currency: string;
  category: string | null;
  category_source: string | null;
  is_internal_transfer: number;
  counterparty_iban: string | null;
  dedup_hash: string;
  occurrence: number;
}

const COLUMNS = `t.id, t.gid, t.account_id, t.booking_date, t.amount, t.currency, t.category,
  t.category_source, t.is_internal_transfer, t.counterparty_iban, t.dedup_hash, t.occurrence`;

/** One row's share of its groups. */
interface Contribution {
  readonly account: number;
  readonly currency: string;
  readonly month: string;
  readonly day: number;
  /** '' for none. */
  readonly category: string;
  readonly amount: Decimal;
  /** The amount as stored. */
  readonly amountText: string;
  readonly flow: boolean;
  readonly uncategorized: boolean;
  readonly id: number;
}

/** The group keys of a contribution (account, currency, month, then category or day). */
const catKey = (c: Contribution): string =>
  `${c.account}\u0000${c.currency}\u0000${c.month}\u0000${c.category}`;
const dayKey = (c: Contribution): string =>
  `${c.account}\u0000${c.currency}\u0000${c.month}\u0000${c.day}`;

/** Equal: the row's share of its month group is the same (its day share aside). */
const sameCatShare = (a: Contribution, b: Contribution): boolean =>
  a.account === b.account &&
  a.currency === b.currency &&
  a.month === b.month &&
  a.category === b.category &&
  a.id === b.id &&
  a.amountText === b.amountText &&
  a.flow === b.flow &&
  a.uncategorized === b.uncategorized;

/** Equal: the row's share of its day group is the same (the day groups hold no category). */
const sameDayShare = (a: Contribution, b: Contribution): boolean =>
  a.account === b.account &&
  a.currency === b.currency &&
  a.month === b.month &&
  a.day === b.day &&
  a.amountText === b.amountText &&
  a.flow === b.flow;

function contributionOf(r: Loaded, own: ReadonlySet<string>): Contribution {
  const amount = D(r.amount);
  const flow = budget.isFlow(
    {
      category: r.category,
      isInternalTransfer: r.is_internal_transfer === 1,
      counterpartyIban: r.counterparty_iban,
    },
    own,
  );
  return {
    account: r.account_id,
    currency: r.currency,
    month: r.booking_date.slice(0, 7),
    day: Number(r.booking_date.slice(8, 10)),
    category: r.category ?? "",
    amount,
    amountText: r.amount,
    flow,
    uncategorized: flow && amount.lt(ZERO) && r.category_source === "default",
    id: r.id,
  };
}

/** A `fold_month_rows` row (its key aside). */
interface Remembered {
  account_id: number;
  currency: string;
  month: string;
  day: number;
  category: string;
  txn_id: number;
  amount: string;
  flow: number;
  uncategorized: number;
}

const MEMORY_COLUMNS =
  "account_id, currency, month, day, category, txn_id, amount, flow, uncategorized";

const remembered = (m: Remembered): Contribution => ({
  account: m.account_id,
  currency: m.currency,
  month: m.month,
  day: m.day,
  category: m.category,
  amount: D(m.amount),
  amountText: m.amount,
  flow: m.flow === 1,
  uncategorized: m.uncategorized === 1,
  id: m.txn_id,
});

function remember(ctx: DeriveContext, leg: number, row: string, c: Contribution): void {
  ctx.sql.insert(
    rowsTable.name,
    `INSERT OR REPLACE INTO fold_month_rows (leg, row, ${MEMORY_COLUMNS})`,
    "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    leg,
    row,
    c.account,
    c.currency,
    c.month,
    c.day,
    c.category,
    c.id,
    c.amountText,
    c.flow ? 1 : 0,
    c.uncategorized ? 1 : 0,
  );
}

interface CatAcc {
  readonly account: number;
  readonly currency: string;
  readonly month: string;
  readonly category: string;
  income: Decimal;
  expense: Decimal;
  n: number;
  flowN: number;
  net: Decimal;
  uncategorizedN: number;
  uncategorizedExpense: Decimal;
  firstOutflow: number | null;
}

interface DayAcc {
  readonly account: number;
  readonly currency: string;
  readonly month: string;
  readonly day: number;
  n: number;
  income: Decimal;
  expense: Decimal;
  maxIncome: Decimal | null;
  net: Decimal;
}

/** Which of a contribution's groups `Groups.add` adds it to (default both). */
interface Share {
  readonly cat?: boolean;
  readonly day?: boolean;
}

/** Group sums of a set of contributions, keyed like the tables. */
class Groups {
  readonly cat = new Map<string, CatAcc>();
  readonly day = new Map<string, DayAcc>();

  /** Add `c` to its month group and its day group (each unless `share` leaves it out). */
  add(c: Contribution, share: Share = {}): void {
    if (share.cat !== false) this.addCat(c);
    if (share.day !== false) this.addDay(c);
  }

  private addCat(c: Contribution): void {
    const ck = catKey(c);
    let g = this.cat.get(ck);
    if (g === undefined) {
      g = {
        account: c.account,
        currency: c.currency,
        month: c.month,
        category: c.category,
        income: ZERO,
        expense: ZERO,
        n: 0,
        flowN: 0,
        net: ZERO,
        uncategorizedN: 0,
        uncategorizedExpense: ZERO,
        firstOutflow: null,
      };
      this.cat.set(ck, g);
    }
    g.n++;
    g.net = g.net.add(c.amount);
    if (!c.flow) return;
    g.flowN++;
    if (c.amount.gte(ZERO)) {
      g.income = g.income.add(c.amount);
      return;
    }
    const magnitude = c.amount.neg();
    g.expense = g.expense.add(magnitude);
    if (g.firstOutflow === null || c.id < g.firstOutflow) g.firstOutflow = c.id;
    if (c.uncategorized) {
      g.uncategorizedN++;
      g.uncategorizedExpense = g.uncategorizedExpense.add(magnitude);
    }
  }

  private addDay(c: Contribution): void {
    const dk = dayKey(c);
    let d = this.day.get(dk);
    if (d === undefined) {
      d = {
        account: c.account,
        currency: c.currency,
        month: c.month,
        day: c.day,
        n: 0,
        income: ZERO,
        expense: ZERO,
        maxIncome: null,
        net: ZERO,
      };
      this.day.set(dk, d);
    }
    d.n++;
    d.net = d.net.add(c.amount);
    if (!c.flow) return;
    if (c.amount.gte(ZERO)) {
      d.income = d.income.add(c.amount);
      if (c.amount.gt(ZERO) && (d.maxIncome === null || c.amount.gt(d.maxIncome))) {
        d.maxIncome = c.amount;
      }
      return;
    }
    d.expense = d.expense.add(c.amount.neg());
  }
}

interface StoredCat {
  income: string;
  expense: string;
  n: number;
  flow_n: number;
  net: string;
  uncategorized_n: number;
  uncategorized_expense: string;
  first_outflow: number | null;
}

interface StoredDay {
  n: number;
  income: string;
  expense: string;
  max_income: string | null;
  net: string;
}

const INSERT_CAT = `INSERT OR REPLACE INTO fold_month_cat (account_id, currency, month, category, income,
  expense, n, flow_n, net, uncategorized_n, uncategorized_expense, first_outflow)`;
const INSERT_DAY = `INSERT OR REPLACE INTO fold_month_day (account_id, currency, month, day, n, income,
  expense, max_income, net)`;

function writeCat(ctx: DeriveContext, g: CatAcc): void {
  ctx.sql.insert(
    catTable.name,
    INSERT_CAT,
    "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    g.account,
    g.currency,
    g.month,
    g.category,
    g.income.toString(),
    g.expense.toString(),
    g.n,
    g.flowN,
    g.net.toString(),
    g.uncategorizedN,
    g.uncategorizedExpense.toString(),
    g.firstOutflow,
  );
}

function writeDay(ctx: DeriveContext, d: DayAcc): void {
  ctx.sql.insert(
    dayTable.name,
    INSERT_DAY,
    "(?, ?, ?, ?, ?, ?, ?, ?, ?)",
    d.account,
    d.currency,
    d.month,
    d.day,
    d.n,
    d.income.toString(),
    d.expense.toString(),
    d.maxIncome === null ? null : decimalKey(d.maxIncome),
    d.net.toString(),
  );
}

/** The (account, currency, month) of a group: one primary key range of either month table. */
const rangeKey = (g: { account: number; currency: string; month: string }): string =>
  `${g.account}\u0000${g.currency}\u0000${g.month}`;

/**
 * The stored groups of the ranges of `groups`, one read per range (`at` = the category or the day
 * column), all read before any write (the inserts are queued, a read flushes them).
 */
function storedOf<S>(
  ctx: DeriveContext,
  table: string,
  at: "category" | "day",
  columns: string,
  groups: Iterable<{ account: number; currency: string; month: string }>,
): Map<string, Map<string | number, S>> {
  const out = new Map<string, Map<string | number, S>>();
  for (const g of groups) {
    const k = rangeKey(g);
    if (out.has(k)) continue;
    out.set(
      k,
      new Map(
        ctx.sql
          .all<S & { k: string | number }>(
            `SELECT ${at} AS k, ${columns} FROM ${table}
             WHERE account_id = ? AND currency = ? AND month = ?`,
            g.account,
            g.currency,
            g.month,
          )
          .map((s) => [s.k, s]),
      ),
    );
  }
  return out;
}

/** Add `groups` to the stored groups (new shares only: a sum of sums is the sum of the rows). */
function addGroups(ctx: DeriveContext, groups: Groups): void {
  const cats = storedOf<StoredCat>(
    ctx,
    catTable.name,
    "category",
    "income, expense, n, flow_n, net, uncategorized_n, uncategorized_expense, first_outflow",
    groups.cat.values(),
  );
  const days = storedOf<StoredDay>(
    ctx,
    dayTable.name,
    "day",
    "n, income, expense, max_income, net",
    groups.day.values(),
  );
  for (const g of groups.cat.values()) {
    const s = cats.get(rangeKey(g))?.get(g.category);
    if (s !== undefined) {
      g.income = D(s.income).add(g.income);
      g.expense = D(s.expense).add(g.expense);
      g.n += s.n;
      g.flowN += s.flow_n;
      g.net = D(s.net).add(g.net);
      g.uncategorizedN += s.uncategorized_n;
      g.uncategorizedExpense = D(s.uncategorized_expense).add(g.uncategorizedExpense);
      if (
        s.first_outflow !== null &&
        (g.firstOutflow === null || s.first_outflow < g.firstOutflow)
      ) {
        g.firstOutflow = s.first_outflow;
      }
    }
    writeCat(ctx, g);
  }
  for (const d of groups.day.values()) {
    const s = days.get(rangeKey(d))?.get(d.day);
    if (s !== undefined) {
      d.n += s.n;
      d.income = D(s.income).add(d.income);
      d.expense = D(s.expense).add(d.expense);
      d.net = D(s.net).add(d.net);
      if (s.max_income !== null) {
        const stored = D(s.max_income);
        if (d.maxIncome === null || stored.gt(d.maxIncome)) d.maxIncome = stored;
      }
    }
    writeDay(ctx, d);
  }
}

/** The own IBAN keys of every account, removed ones too (`bookOwnIbans`). */
function ownIbans(ctx: DeriveContext): Set<string> {
  return core.ownIbans(ctx.sql.all<{ iban: string | null }>("SELECT iban FROM accounts"));
}

const signatureOf = (own: ReadonlySet<string>): string => JSON.stringify([...own].sort());

function storedSignature(ctx: DeriveContext): string | undefined {
  return ctx.sql.get<{ v: string }>("SELECT v FROM fold_month_env WHERE k = 'own'")?.v;
}

/** The import row key of a loaded row whose account's gid is `root`. */
const importKey = (root: string, r: Loaded): string => `${root}|${r.dedup_hash}|${r.occurrence}`;

/** Memory key: `<leg>\u0000<row>`. */
const memKey = (leg: number, row: string): string => `${leg}\u0000${row}`;

function deriveAll(ctx: DeriveContext): void {
  takeCategoryChanges(ctx); // every row is derived below
  const own = ownIbans(ctx);
  for (const t of [catTable, dayTable, rowsTable]) ctx.sql.write(t.name, `DELETE FROM ${t.name}`);
  const legOf = new Map(
    ctx.sql
      .all<{ partition: string; leg_gid: string }>("SELECT partition, leg_gid FROM fold_txn_legs")
      .map((l) => [l.leg_gid, l.partition]),
  );
  const roots = new Map(
    ctx.sql
      .all<{ id: number; gid: string }>(
        "SELECT id, gid FROM view_ids WHERE id IN (SELECT DISTINCT account_id FROM transactions)",
      )
      .map((v) => [v.id, v.gid]),
  );
  // In row order, a chunk at a time (never the whole history in memory at once).
  const groups = new Groups();
  let after = 0;
  for (;;) {
    const rows = ctx.sql.all<Loaded>(
      `SELECT ${COLUMNS} FROM transactions t WHERE t.id > ? ORDER BY t.id LIMIT ${CHUNK_ROWS}`,
      after,
    );
    for (const r of rows) {
      const c = contributionOf(r, own);
      groups.add(c);
      const key = rowKeyOf(r, roots.get(r.account_id) ?? "", legOf);
      remember(ctx, key.leg, key.row, c);
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < CHUNK_ROWS) break;
    after = last.id;
  }
  for (const g of groups.cat.values()) writeCat(ctx, g);
  for (const d of groups.day.values()) writeDay(ctx, d);
  ctx.sql.write(
    envTable.name,
    "INSERT OR REPLACE INTO fold_month_env (k, v) VALUES ('own', ?)",
    signatureOf(own),
  );
}

/** The memory key of a loaded row on the account whose gid is `root`. */
function rowKeyOf(
  r: Loaded,
  root: string,
  legOf: ReadonlyMap<string, string>,
): { leg: number; row: string } {
  if (r.dedup_hash.startsWith(CASHLEG)) return { leg: 1, row: legOf.get(r.gid) ?? r.dedup_hash };
  if (r.dedup_hash.startsWith(CASHEXP)) return { leg: 0, row: r.dedup_hash };
  return { leg: 0, row: importKey(root, r) };
}

/** The current rows (and cash legs) of these partitions, by memory key. */
function currentRows(ctx: DeriveContext, keys: readonly string[]): Map<string, Loaded> {
  const out = new Map<string, Loaded>();
  const wanted = new Set(keys);
  const hashesByRoot = new Map<string, Set<string>>();
  const expenses: string[] = [];
  for (const key of keys) {
    if (key.startsWith(CASHEXP)) expenses.push(key.slice(CASHEXP.length));
    else if (key.includes("|")) {
      const [root, hash] = splitKey(key);
      const set = hashesByRoot.get(root) ?? new Set<string>();
      set.add(hash);
      hashesByRoot.set(root, set);
    }
  }
  for (const [root, hashes] of hashesByRoot) {
    for (const r of selectIn<Loaded>(
      ctx.sql,
      `SELECT ${COLUMNS} FROM transactions t
       WHERE t.account_id = (SELECT id FROM view_ids WHERE gid = ?) AND t.dedup_hash IN (%IN%)`,
      [...hashes],
      [root],
    )) {
      const key = importKey(root, r);
      if (wanted.has(key)) out.set(memKey(0, key), r);
    }
  }
  for (const r of selectIn<Loaded>(
    ctx.sql,
    `SELECT ${COLUMNS} FROM transactions t WHERE t.gid IN (%IN%) AND t.dedup_hash LIKE '${CASHEXP}%'`,
    expenses,
  )) {
    out.set(memKey(0, r.dedup_hash), r);
  }
  const legs = selectIn<{ partition: string; leg_gid: string }>(
    ctx.sql,
    "SELECT partition, leg_gid FROM fold_txn_legs WHERE partition IN (%IN%)",
    keys,
  );
  const partOf = new Map(legs.map((l) => [l.leg_gid, l.partition]));
  for (const r of selectIn<Loaded>(
    ctx.sql,
    `SELECT ${COLUMNS} FROM transactions t WHERE t.gid IN (%IN%) AND t.dedup_hash LIKE '${CASHLEG}%'`,
    [...partOf.keys()],
  )) {
    const part = partOf.get(r.gid);
    if (part !== undefined) out.set(memKey(1, part), r);
  }
  return out;
}

/** The groups of one (account, month) to recompute, by group key. */
interface Unit {
  readonly account: number;
  readonly month: string;
  readonly cat: Map<string, { readonly currency: string; readonly category: string }>;
  readonly day: Map<string, { readonly currency: string; readonly day: number }>;
}

const marks = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/**
 * Recompute these groups from their remembered rows (each from all of its rows: an exact fresh sum).
 * `fold_month_rows` already holds this apply's shares: the month groups read their categories
 * through the (account, month, category) index, the day groups the (account, month) prefix.
 */
function recompute(ctx: DeriveContext, units: Iterable<Unit>): void {
  for (const u of units) {
    const groups = new Groups();
    if (u.cat.size > 0) {
      const categories = new Set<string>();
      for (const g of u.cat.values()) {
        categories.add(g.category);
        ctx.sql.write(
          catTable.name,
          "DELETE FROM fold_month_cat WHERE account_id = ? AND currency = ? AND month = ? AND category = ?",
          u.account,
          g.currency,
          u.month,
          g.category,
        );
      }
      for (const m of ctx.sql.all<Remembered>(
        `SELECT ${MEMORY_COLUMNS} FROM fold_month_rows
         WHERE account_id = ? AND month = ? AND category IN (${marks(categories.size)})`,
        u.account,
        u.month,
        ...categories,
      )) {
        const c = remembered(m);
        if (u.cat.has(catKey(c))) groups.add(c, { day: false });
      }
    }
    if (u.day.size > 0) {
      const days = new Set<number>();
      for (const g of u.day.values()) {
        days.add(g.day);
        ctx.sql.write(
          dayTable.name,
          "DELETE FROM fold_month_day WHERE account_id = ? AND currency = ? AND month = ? AND day = ?",
          u.account,
          g.currency,
          u.month,
          g.day,
        );
      }
      for (const m of ctx.sql.all<Remembered>(
        `SELECT ${MEMORY_COLUMNS} FROM fold_month_rows
         WHERE account_id = ? AND month = ? AND day IN (${marks(days.size)})`,
        u.account,
        u.month,
        ...days,
      )) {
        const c = remembered(m);
        if (u.day.has(dayKey(c))) groups.add(c, { cat: false });
      }
    }
    for (const g of groups.cat.values()) writeCat(ctx, g);
    for (const d of groups.day.values()) writeDay(ctx, d);
  }
}

function derive(keys: readonly string[], ctx: DeriveContext, own: ReadonlySet<string>): void {
  const old = new Map(
    selectIn<Remembered & { leg: number; row: string }>(
      ctx.sql,
      `SELECT leg, row, ${MEMORY_COLUMNS} FROM fold_month_rows WHERE leg IN (0, 1) AND row IN (%IN%)`,
      keys,
    ).map((m) => [memKey(m.leg, m.row), remembered(m)]),
  );
  const now = currentRows(ctx, keys);
  const units = new Map<string, Unit>();
  const unitOf = (c: Contribution): Unit => {
    const k = `${c.account}\u0000${c.month}`;
    let u = units.get(k);
    if (u === undefined) {
      u = { account: c.account, month: c.month, cat: new Map(), day: new Map() };
      units.set(k, u);
    }
    return u;
  };
  /** The groups a row left: recomputed from their remaining rows. */
  const leftCat = (c: Contribution) =>
    unitOf(c).cat.set(catKey(c), { currency: c.currency, category: c.category });
  const leftDay = (c: Contribution) =>
    unitOf(c).day.set(dayKey(c), { currency: c.currency, day: c.day });
  /** The groups a row joined: added to, unless recomputed (the recompute counts it). */
  const joined: { readonly c: Contribution; readonly share: Required<Share> }[] = [];
  for (const key of new Set([...old.keys(), ...now.keys()])) {
    const before = old.get(key);
    const loaded = now.get(key);
    const after = loaded === undefined ? undefined : contributionOf(loaded, own);
    const [legText, row] = key.split("\u0000") as [string, string];
    const leg = Number(legText);
    if (after === undefined) {
      if (before !== undefined) {
        leftCat(before);
        leftDay(before);
      }
      ctx.sql.write(
        rowsTable.name,
        "DELETE FROM fold_month_rows WHERE leg = ? AND row = ?",
        leg,
        row,
      );
      continue;
    }
    const cat = before === undefined || !sameCatShare(before, after);
    const day = before === undefined || !sameDayShare(before, after);
    if (!cat && !day) continue;
    if (before !== undefined) {
      if (cat) leftCat(before);
      if (day) leftDay(before);
    }
    joined.push({ c: after, share: { cat, day } });
    remember(ctx, leg, row, after);
  }
  recompute(ctx, units.values());
  const groups = new Groups();
  for (const { c, share } of joined) {
    const u = units.get(`${c.account}\u0000${c.month}`);
    groups.add(c, {
      cat: share.cat && !u?.cat.has(catKey(c)),
      day: share.day && !u?.day.has(dayKey(c)),
    });
  }
  addGroups(ctx, groups);
}

export const monthsDeriver: Deriver = {
  id: "budget.months",
  // Only the phone reads it (companion queries): registered with `StoreOptions.companionReads`.
  companion: true,
  version: 1,
  tables: [catTable, dayTable, rowsTable, envTable],
  writes: [],
  // The categories deriver's inputs, by reference: it runs whenever that one did and takes its
  // changes in the same apply (handover.test.ts checks every such pair).
  inputs: categoriesDeriver.inputs,
  derive(dirty, ctx) {
    const changes = takeCategoryChanges(ctx);
    const txns = dirty.get("budget.transactions");
    if (txns === "all" || changes.includes(ALL_CHANGED)) {
      deriveAll(ctx);
      return;
    }
    const own = ownIbans(ctx);
    const keys = new Set([...(txns ?? []), ...changes]);
    if (dirty.has("core.accounts")) {
      if (signatureOf(own) !== storedSignature(ctx)) {
        deriveAll(ctx);
        return;
      }
      // the legs deriver re-checked every leg: so does this one
      for (const r of ctx.sql.all<{ row: string }>(
        `SELECT row FROM fold_month_rows WHERE leg = 1
         UNION SELECT partition FROM fold_txn_legs`,
      )) {
        keys.add(r.row);
      }
    }
    if (keys.size === 0) return;
    if (keys.size >= FULL_PASS_MIN) {
      const total = ctx.sql.get<{ n: number }>("SELECT count(*) AS n FROM fold_month_rows")?.n ?? 0;
      if (keys.size * FULL_PASS_SHARE > total) {
        deriveAll(ctx);
        return;
      }
    }
    derive([...keys], ctx, own);
  },
  deriveAll,
};
