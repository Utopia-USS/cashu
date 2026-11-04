// Deriver budget.categories (S24 4.3, events.md 8.3 / 9, D-24.1): the effective `category` /
// `category_source` of every transaction row except the cash legs (the legs deriver writes theirs).
//
// The view is a full deterministic recompute over the current set (D-24.1: Python
// `categorize_all(use_llm=False)` after a fresh transfer match): the S09 precedence
// (`budget.createCategorizer().effective`) per row, with the subscription payees from the
// recurring grouping over the non-internal rows whose decided category is read from the claim
// registers, never from the derived column (so the result is a function of the facts, not of the
// previous run).
//
// Incremental unit = the recurring group (payee, currency, outflow amount; `recurringMember`): a
// payee is a subscription payee when one of its groups qualifies (`recurringDates`), and a row's
// group depends only on the row, its payee's merchant rule and the vault-wide inputs (own IBANs,
// cash accounts, payment patterns).
// - a dirty row re-derives itself and re-checks its old and new group;
// - a touched merchant rule re-groups and re-derives every row of its payee;
// - a payee whose subscription flag flips re-derives every row of it;
// - a change of the own-IBAN set or of the cash accounts (signature in `fold_category_env`), a
//   module contribution (payment patterns), a full re-fold, or a bulk dirty set (an eighth of the
//   rows, 256 at least) runs `deriveAll`.
// Internal state: `fold_category_members` (row key -> its group and date, for rows in a group: the
// old group of a re-folded row is only known here) and `fold_category_groups` (the qualifying
// groups and their payees). A payee's rows are found through the transactions materializer's
// `fold_txn_keys.merchant_key` (the same `merchantKey` of the same row content).
//
// `is_internal_transfer` is read from the view (the transfers deriver writes it, before this one);
// the bank rows whose flag it flipped in this apply (`takeTransferFlips`) are dirty rows here too.
// Every input of the transfers deriver is an input here, so this deriver runs whenever it did.
import { budget, core, D } from "@cashu/domain";
import { CONTRIBUTIONS, type DeriveContext, type Deriver } from "../../engine/types.js";
import type { Read } from "../../query.js";
import type { TableDef } from "../../sql/ddl.js";
import { budgetEngineContext } from "../read-models.js";
import { CASHEXP, CASHLEG, splitKey, TRANSACTIONS } from "../transactions.js";
import { selectIn } from "./keys.js";
import { takeTransferFlips } from "./transfers.js";

const membersTable: TableDef = {
  name: "fold_category_members",
  primaryKey: ["row"],
  internal: true,
  withoutRowid: true,
  columns: [
    { name: "row", type: "TEXT", notNull: true },
    /** JSON `[payee, currency, amountKey]`. */
    { name: "grp", type: "TEXT", notNull: true },
    { name: "booking_date", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["grp"] }],
};

/** The qualifying recurring groups (`recurringDates` not null) and their payees. */
const groupsTable: TableDef = {
  name: "fold_category_groups",
  primaryKey: ["grp"],
  internal: true,
  withoutRowid: true,
  columns: [
    { name: "grp", type: "TEXT", notNull: true },
    { name: "payee", type: "TEXT", notNull: true },
  ],
};

const envTable: TableDef = {
  name: "fold_category_env",
  primaryKey: ["k"],
  internal: true,
  withoutRowid: true,
  columns: [
    { name: "k", type: "TEXT", notNull: true },
    { name: "v", type: "TEXT", notNull: true },
  ],
};

/** Claim sources a bank row keeps (events.md 8.3); `""` is a cleared register. */
const CLAIM_SOURCES: ReadonlySet<string> = new Set(["manual_txn", "llm_full", "llm_fallback"]);
const REGISTRY = core.builtinRegistry();
/**
 * One full pass instead of per-group work when at least FULL_PASS_MIN rows are dirty and they are
 * more than an eighth of the rows (S24 4.1: a bulk import, a first sync). Measured (perf.test.ts,
 * file mode): a full pass costs ~8 us per row (it writes only what changed), the incremental path
 * ~70 us per dirty row.
 */
const FULL_PASS_SHARE = 8;
const FULL_PASS_MIN = 256;
const CHUNK = 256;
const PLACEHOLDERS = Array.from({ length: CHUNK }, () => "?").join(", ");

interface Loaded {
  id: number;
  row: string;
  booking_date: string;
  amount: string;
  currency: string;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  description: string | null;
  reference: string | null;
  is_internal_transfer: number;
  category: string | null;
  category_source: string | null;
  account_type: string | null;
  claim: string | null;
  claim_by: string | null;
}

interface Row {
  readonly id: number;
  readonly current: readonly [string | null, string | null];
  readonly input: budget.CategorizeRow;
}

interface Member {
  readonly grp: string;
  readonly date: string;
}

const COLUMNS = `t.id, t.booking_date, t.amount, t.currency, t.counterparty_name, t.counterparty_iban,
  t.description, t.reference, t.is_internal_transfer, t.category, t.category_source,
  a.type AS account_type, c.claim, c.claim_by`;

/** The row key of a view row (the transactions materializer's partition). */
const ROW_KEY = `CASE WHEN t.dedup_hash LIKE '${CASHEXP}%' THEN t.dedup_hash
  ELSE v.gid || '|' || t.dedup_hash || '|' || t.occurrence END`;

const SELECT_ROWS = `SELECT ${COLUMNS}, ${ROW_KEY} AS row FROM transactions t
  JOIN view_ids v ON v.id = t.account_id LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN fold_transaction_claims c ON c.partition = ${ROW_KEY}`;

function toRow(r: Loaded): Row {
  const onCash = r.account_type === budget.CASH_ACCOUNT_TYPE;
  const claim =
    r.claim !== null && r.claim_by !== null && CLAIM_SOURCES.has(r.claim_by)
      ? { category: r.claim, source: r.claim_by as budget.ClaimSource }
      : null;
  return {
    id: r.id,
    current: [r.category, r.category_source],
    input: {
      key: r.row,
      onCashAccount: onCash,
      bookingDate: r.booking_date,
      currency: r.currency,
      amount: D(r.amount),
      counterpartyName: r.counterparty_name,
      counterpartyIban: r.counterparty_iban,
      description: r.description,
      reference: r.reference,
      isInternalTransfer: r.is_internal_transfer === 1,
      claim,
    },
  };
}

/** `values` in chunks of CHUNK, each padded with NULL (one prepared statement shape). */
function* chunks(values: readonly string[]): Generator<(string | null)[]> {
  for (let i = 0; i < values.length; i += CHUNK) {
    const c: (string | null)[] = values.slice(i, i + CHUNK);
    while (c.length < CHUNK) c.push(null);
    yield c;
  }
}

/** Every non-leg row of the view (the full recompute's input). */
function allRows(ctx: DeriveContext): Row[] {
  return ctx.sql.all<Loaded>(`${SELECT_ROWS} WHERE t.dedup_hash NOT LIKE '${CASHLEG}%'`).map(toRow);
}

/** Predict the exact visible pair changes of one merchant rule before its event is appended. */
export function projectedMerchantRuleChanges(
  read: Read,
  rule: budget.MerchantRule,
  patterns: readonly core.PaymentPattern[],
): number {
  const rows = read<Loaded>(`${SELECT_ROWS} WHERE t.dedup_hash NOT LIKE '${CASHLEG}%'`).map(toRow);
  const registry = core.builtinRegistry();
  const previous = budgetEngineContext(read, patterns, registry);
  const rules = new Map(previous.rules);
  rules.set(rule.merchantKey, rule);
  const projected = budget.categorizeAll(
    rows.map((row) => row.input),
    { ...previous, rules },
    budget.subscriptionExclusions(registry),
  ).results;
  let changed = 0;
  for (const row of rows) {
    const after = projected.get(row.input.key);
    if (after && (row.current[0] !== after.category || row.current[1] !== after.source)) changed++;
    if (after === null && (row.current[0] !== null || row.current[1] !== null)) changed++;
  }
  return changed;
}

/**
 * The view rows the row keys name now, in a few batched reads: import rows per account root by
 * hash, cash expenses by gid. Keys naming no row are absent from the result.
 */
function rowsByKey(ctx: DeriveContext, keys: Iterable<string>): Map<string, Row> {
  const wanted = new Set(keys);
  const out = new Map<string, Row>();
  const hashesByRoot = new Map<string, Set<string>>();
  const expenses: string[] = [];
  for (const key of wanted) {
    if (key.startsWith(CASHEXP)) expenses.push(key.slice(CASHEXP.length));
    else if (!key.startsWith(CASHLEG)) {
      const [root, hash] = splitKey(key);
      const set = hashesByRoot.get(root) ?? new Set<string>();
      set.add(hash);
      hashesByRoot.set(root, set);
    }
  }
  const take = (rows: Loaded[]) => {
    for (const r of rows) if (wanted.has(r.row)) out.set(r.row, toRow(r));
  };
  for (const [root, hashes] of hashesByRoot) {
    for (const c of chunks([...hashes])) {
      take(
        ctx.sql.all<Loaded>(
          `${SELECT_ROWS} WHERE t.account_id = (SELECT id FROM view_ids WHERE gid = ?)
             AND t.dedup_hash IN (${PLACEHOLDERS})`,
          root,
          ...c,
        ),
      );
    }
  }
  for (const c of chunks(expenses)) {
    take(
      ctx.sql.all<Loaded>(
        `${SELECT_ROWS} WHERE t.gid IN (${PLACEHOLDERS}) AND t.dedup_hash LIKE '${CASHEXP}%'`,
        ...c,
      ),
    );
  }
  return out;
}

/** The row keys of a payee (the materializer's merchant key index). */
function keysOfPayee(ctx: DeriveContext, payee: string): string[] {
  return ctx.sql
    .all<{ row: string }>("SELECT row FROM fold_txn_keys WHERE merchant_key = ?", payee)
    .map((r) => r.row);
}

/** The stored group membership of these row keys. */
function membersOf(ctx: DeriveContext, keys: readonly string[]): Map<string, Member> {
  return new Map(
    selectIn<{ row: string; grp: string; booking_date: string }>(
      ctx.sql,
      "SELECT row, grp, booking_date FROM fold_category_members WHERE row IN (%IN%)",
      keys,
    ).map((m) => [m.row, { grp: m.grp, date: m.booking_date }]),
  );
}

/** The vault-wide inputs that are not dirty-tracked per row: own IBANs and cash accounts. */
function envSignature(ctx: DeriveContext): string {
  const accounts = ctx.sql.all<{ gid: string; iban: string | null; type: string }>(
    "SELECT gid, iban, type FROM accounts",
  );
  const own = [...core.ownIbans(accounts)].sort();
  const cash = accounts
    .filter((a) => a.type === budget.CASH_ACCOUNT_TYPE)
    .map((a) => a.gid)
    .sort();
  return JSON.stringify([own, cash]);
}

function storedSignature(ctx: DeriveContext): string | undefined {
  return ctx.sql.get<{ v: string }>("SELECT v FROM fold_category_env WHERE k = 'env'")?.v;
}

interface Engine {
  readonly categorizer: budget.Categorizer;
  readonly notSubscription: ReadonlySet<string>;
}

function engine(ctx: DeriveContext): Engine {
  const read: Read = (sql, ...params) => ctx.sql.all(sql, ...params);
  return {
    categorizer: budget.createCategorizer(
      budgetEngineContext(read, ctx.contributions.paymentPatterns(), REGISTRY),
    ),
    notSubscription: new Set([
      ...budget.NOT_SUBSCRIPTION_CATEGORIES,
      ...ctx.contributions.notSubscriptionCategories(),
    ]),
  };
}

/** The recurring group a row counts in, or null (internal transfers count in none). */
function memberOf(e: Engine, row: Row): Member | null {
  if (row.input.isInternalTransfer) return null;
  const m = e.categorizer.recurringMember(row.input, e.notSubscription);
  return m === null
    ? null
    : { grp: JSON.stringify([m.payee, m.currency, m.amountKey]), date: row.input.bookingDate };
}

const payeeOfGroup = (grp: string): string => (JSON.parse(grp) as [string])[0];

function write(ctx: DeriveContext, row: Row, value: budget.Effective): void {
  const category = value?.category ?? null;
  const source = value?.source ?? null;
  if (row.current[0] === category && row.current[1] === source) return;
  ctx.sql.write(
    TRANSACTIONS,
    "UPDATE transactions SET category = ?, category_source = ? WHERE id = ?",
    category,
    source,
    row.id,
  );
}

/**
 * Set the stored membership of `key` (null: in no group), writing only a change; adds the groups it
 * left and joined to `groups`.
 */
function setMember(
  ctx: DeriveContext,
  key: string,
  old: Member | undefined,
  now: Member | null,
  groups: Set<string>,
): void {
  if (old !== undefined) groups.add(old.grp);
  if (now !== null) groups.add(now.grp);
  if (now === null) {
    if (old !== undefined) {
      ctx.sql.write(membersTable.name, "DELETE FROM fold_category_members WHERE row = ?", key);
    }
  } else if (old === undefined || old.grp !== now.grp || old.date !== now.date) {
    ctx.sql.insert(
      membersTable.name,
      "INSERT OR REPLACE INTO fold_category_members (row, grp, booking_date)",
      "(?, ?, ?)",
      key,
      now.grp,
      now.date,
    );
  }
}

/** The payees with a qualifying group. */
function subscriptionPayees(ctx: DeriveContext): Set<string> {
  return new Set(
    ctx.sql
      .all<{ payee: string }>("SELECT DISTINCT payee FROM fold_category_groups")
      .map((r) => r.payee),
  );
}

/** Re-check groups from their members' dates: a qualifying group is stored, any other is not. */
function recheckGroups(ctx: DeriveContext, groups: readonly string[]): void {
  const stored = new Set(
    selectIn<{ grp: string }>(
      ctx.sql,
      "SELECT grp FROM fold_category_groups WHERE grp IN (%IN%)",
      groups,
    ).map((g) => g.grp),
  );
  const dates = new Map<string, string[]>();
  for (const m of selectIn<{ grp: string; booking_date: string }>(
    ctx.sql,
    "SELECT grp, booking_date FROM fold_category_members WHERE grp IN (%IN%)",
    groups,
  )) {
    const list = dates.get(m.grp) ?? [];
    list.push(m.booking_date);
    dates.set(m.grp, list);
  }
  for (const grp of groups) {
    const qualifies = budget.recurringDates(dates.get(grp) ?? []) !== null;
    if (qualifies === stored.has(grp)) continue;
    if (qualifies) {
      ctx.sql.write(
        groupsTable.name,
        "INSERT INTO fold_category_groups (grp, payee) VALUES (?, ?)",
        grp,
        payeeOfGroup(grp),
      );
    } else {
      ctx.sql.write(groupsTable.name, "DELETE FROM fold_category_groups WHERE grp = ?", grp);
    }
  }
}

function deriveAll(ctx: DeriveContext): void {
  takeTransferFlips(ctx); // every row is re-derived below
  const e = engine(ctx);
  const rows = allRows(ctx);
  const members = new Map<string, Member | null>();
  const dates = new Map<string, string[]>();
  for (const r of rows) {
    const m = memberOf(e, r);
    members.set(r.input.key, m);
    if (m === null) continue;
    const list = dates.get(m.grp) ?? [];
    list.push(m.date);
    dates.set(m.grp, list);
  }
  const qualifying = [...dates].filter(([, d]) => budget.recurringDates(d) !== null);
  const subs = new Set(qualifying.map(([grp]) => payeeOfGroup(grp)));
  for (const r of rows) write(ctx, r, e.categorizer.effective(r.input, subs));
  // The internal tables: write only what differs from the last derivation (a bulk apply re-derives
  // a mostly unchanged set; a rebuild starts empty).
  const stored = new Map(
    ctx.sql
      .all<{ row: string; grp: string; booking_date: string }>(
        "SELECT row, grp, booking_date FROM fold_category_members",
      )
      .map((m) => [m.row, { grp: m.grp, date: m.booking_date }]),
  );
  const unused = new Set<string>();
  for (const [key, m] of members) {
    setMember(ctx, key, stored.get(key), m, unused);
    stored.delete(key);
  }
  for (const gone of stored.keys()) {
    ctx.sql.write(membersTable.name, "DELETE FROM fold_category_members WHERE row = ?", gone);
  }
  const storedGroups = new Set(
    ctx.sql.all<{ grp: string }>("SELECT grp FROM fold_category_groups").map((g) => g.grp),
  );
  for (const [grp] of qualifying) {
    if (storedGroups.delete(grp)) continue;
    ctx.sql.insert(
      groupsTable.name,
      "INSERT INTO fold_category_groups (grp, payee)",
      "(?, ?)",
      grp,
      payeeOfGroup(grp),
    );
  }
  for (const gone of storedGroups) {
    ctx.sql.write(groupsTable.name, "DELETE FROM fold_category_groups WHERE grp = ?", gone);
  }
  ctx.sql.write(
    envTable.name,
    "INSERT OR REPLACE INTO fold_category_env (k, v) VALUES ('env', ?)",
    envSignature(ctx),
  );
}

export const categoriesDeriver: Deriver = {
  id: "budget.categories",
  version: 2,
  tables: [membersTable, groupsTable, envTable],
  writes: [{ table: TRANSACTIONS, columns: ["category", "category_source"] }],
  inputs: [
    "budget.transactions",
    "budget.transfer_runs",
    "budget.category_rules",
    "core.accounts",
    CONTRIBUTIONS,
  ],
  derive(dirty, ctx) {
    if (dirty.has("core.accounts") && envSignature(ctx) !== storedSignature(ctx)) {
      deriveAll(ctx);
      return;
    }
    const txns = dirty.get("budget.transactions");
    const rules = dirty.get("budget.category_rules");
    if (txns === "all" || rules === "all") {
      deriveAll(ctx);
      return;
    }
    const keys = [...new Set([...(txns ?? []), ...takeTransferFlips(ctx)])];
    if (keys.length >= FULL_PASS_MIN) {
      const total = ctx.sql.get<{ n: number }>("SELECT count(*) AS n FROM fold_txn_keys")?.n ?? 0;
      if (keys.length * FULL_PASS_SHARE > total) {
        deriveAll(ctx);
        return;
      }
    }
    const rulePayees = new Set<string>();
    for (const g of rules ?? []) {
      const r = ctx.sql.get<{ merchant_key: string }>(
        "SELECT merchant_key FROM category_rules WHERE gid = ?",
        g,
      );
      if (r === undefined) {
        deriveAll(ctx); // a rule row without events: cannot name its payee
        return;
      }
      rulePayees.add(r.merchant_key);
    }
    if (keys.length === 0 && rulePayees.size === 0) return;

    const e = engine(ctx);
    const before = subscriptionPayees(ctx);
    // Rows whose group may have changed: the dirty ones and every row of a re-ruled payee (the rule
    // decides their category).
    const regroup = new Set(keys);
    for (const p of rulePayees) for (const k of keysOfPayee(ctx, p)) regroup.add(k);
    const keyList = [...regroup];
    const old = membersOf(ctx, keyList);
    const rows = rowsByKey(ctx, keyList);
    const groups = new Set<string>();
    for (const key of keyList) {
      const row = rows.get(key);
      setMember(ctx, key, old.get(key), row === undefined ? null : memberOf(e, row), groups);
    }
    recheckGroups(ctx, [...groups]);
    const subs = subscriptionPayees(ctx);
    const flipped = [...new Set([...before, ...subs])].filter((p) => before.has(p) !== subs.has(p));
    const more = flipped.flatMap((p) => keysOfPayee(ctx, p)).filter((k) => !rows.has(k));
    for (const [k, r] of rowsByKey(ctx, more)) rows.set(k, r);
    for (const r of rows.values()) write(ctx, r, e.categorizer.effective(r.input, subs));
  },
  deriveAll,
};
