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
// Incremental unit = the payee (merchant key): a payee's subscription flag depends only on its own
// rows, its merchant rule and the vault-wide inputs (own IBANs, cash accounts, payment patterns).
// - a dirty row re-derives itself, and re-checks the flag of its old and new payee;
// - a touched merchant rule re-derives every row of its payee;
// - a payee whose flag flips re-derives every row of it;
// - a change of the own-IBAN set or of the cash accounts (signature in `fold_category_env`), a
//   module contribution (payment patterns), a full re-fold, or a bulk dirty set (a fifth of the rows,
//   256 at least) runs `deriveAll`.
// Internal state: `fold_category_payees` (row key -> its view row id and payee, as last derived; the
// old payee of a re-folded row is only known here) and `fold_category_subs` (the flagged payees).
//
// `is_internal_transfer` is read from the view (S24b's transfers deriver writes it, before this
// one); when it lands, its changed rows must reach this deriver as dirty rows.
import { budget, core, D } from "@cashu/domain";
import { CONTRIBUTIONS, type DeriveContext, type Deriver } from "../../engine/types.js";
import type { Read } from "../../query.js";
import type { TableDef } from "../../sql/ddl.js";
import { budgetEngineContext } from "../read-models.js";
import { CASHEXP, CASHLEG, splitKey, TRANSACTIONS } from "../transactions.js";
import { selectIn } from "./keys.js";

const payeesTable: TableDef = {
  name: "fold_category_payees",
  primaryKey: ["row"],
  internal: true,
  withoutRowid: true,
  columns: [
    { name: "row", type: "TEXT", notNull: true },
    { name: "txn", type: "INTEGER", notNull: true },
    { name: "payee", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["payee"] }],
};

const subsTable: TableDef = {
  name: "fold_category_subs",
  primaryKey: ["payee"],
  internal: true,
  withoutRowid: true,
  columns: [{ name: "payee", type: "TEXT", notNull: true }],
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
 * One full pass instead of per-payee work when at least FULL_PASS_MIN rows are dirty and they are
 * more than a fifth of the rows (S24 4.1: a bulk import, a first sync).
 */
const FULL_PASS_SHARE = 5;
const FULL_PASS_MIN = 256;

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

const COLUMNS = `t.id, t.booking_date, t.amount, t.currency, t.counterparty_name, t.counterparty_iban,
  t.description, t.reference, t.is_internal_transfer, t.category, t.category_source,
  a.type AS account_type, c.claim, c.claim_by`;

/** The row key of a view row (the transactions materializer's partition). */
const ROW_KEY = `CASE WHEN t.dedup_hash LIKE '${CASHEXP}%' THEN t.dedup_hash
  ELSE v.gid || '|' || t.dedup_hash || '|' || t.occurrence END`;

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

/** Every non-leg row of the view (the full recompute's input). */
function allRows(ctx: DeriveContext): Row[] {
  return ctx.sql
    .all<Loaded>(
      `SELECT ${COLUMNS}, ${ROW_KEY} AS row FROM transactions t
       JOIN view_ids v ON v.id = t.account_id LEFT JOIN accounts a ON a.id = t.account_id
       LEFT JOIN fold_transaction_claims c ON c.partition = ${ROW_KEY}
       WHERE t.dedup_hash NOT LIKE '${CASHLEG}%'`,
    )
    .map(toRow);
}

/** Rows through the payee index (current after `trackRows`). */
const BY_PAYEE = `SELECT ${COLUMNS}, p.row AS row FROM fold_category_payees p
  JOIN transactions t ON t.id = p.txn LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN fold_transaction_claims c ON c.partition = p.row`;

function rowsOfPayee(ctx: DeriveContext, payee: string): Row[] {
  return ctx.sql.all<Loaded>(`${BY_PAYEE} WHERE p.payee = ?`, payee).map(toRow);
}

function rowsByKey(ctx: DeriveContext, keys: readonly string[]): Row[] {
  return selectIn<Loaded>(ctx.sql, `${BY_PAYEE} WHERE p.row IN (%IN%)`, keys).map(toRow);
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

function saveSignature(ctx: DeriveContext, sig: string): void {
  ctx.sql.write(
    envTable.name,
    "INSERT OR REPLACE INTO fold_category_env (k, v) VALUES ('env', ?)",
    sig,
  );
}

function engine(ctx: DeriveContext): {
  categorizer: budget.Categorizer;
  notSubscription: ReadonlySet<string>;
} {
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

/** Whether the recurring grouping flags `payee` (its non-internal rows only, payee-wide). */
function flagged(e: ReturnType<typeof engine>, rows: readonly Row[], payee: string): boolean {
  if (!payee) return false;
  const input = rows.filter((r) => !r.input.isInternalTransfer).map((r) => r.input);
  return e.categorizer.detectRecurring(input, e.notSubscription).length > 0;
}

/** The view row (id and merchant key) a row key names now, if any. */
function findRow(ctx: DeriveContext, key: string): { id: number; payee: string } | undefined {
  type Found = {
    id: number;
    counterparty_name: string | null;
    reference: string | null;
    description: string | null;
  };
  const cols = "t.id, t.counterparty_name, t.reference, t.description";
  let r: Found | undefined;
  if (key.startsWith(CASHEXP)) {
    r = ctx.sql.get<Found>(
      `SELECT ${cols} FROM transactions t WHERE t.gid = ? AND t.dedup_hash = ?`,
      key.slice(CASHEXP.length),
      key,
    );
  } else {
    const [root, hash, occurrence] = splitKey(key);
    r = ctx.sql.get<Found>(
      `SELECT ${cols} FROM transactions t
       WHERE t.account_id = (SELECT id FROM view_ids WHERE gid = ?) AND t.dedup_hash = ?
         AND t.occurrence = ?`,
      root,
      hash,
      occurrence,
    );
  }
  if (r === undefined) return undefined;
  return {
    id: r.id,
    payee: budget.merchantKey(r.counterparty_name, r.reference, r.description),
  };
}

/**
 * Bring `fold_category_payees` up to date for the dirty row keys; returns the payees whose rows
 * changed (old and new) and the keys that still name a row.
 */
function trackRows(
  ctx: DeriveContext,
  keys: readonly string[],
): { payees: Set<string>; live: string[] } {
  const payees = new Set<string>();
  for (const r of selectIn<{ payee: string }>(
    ctx.sql,
    "SELECT payee FROM fold_category_payees WHERE row IN (%IN%)",
    keys,
  )) {
    payees.add(r.payee);
  }
  const live: string[] = [];
  for (const key of keys) {
    const found = key.startsWith(CASHLEG) ? undefined : findRow(ctx, key);
    if (found === undefined) {
      ctx.sql.write(payeesTable.name, "DELETE FROM fold_category_payees WHERE row = ?", key);
      continue;
    }
    ctx.sql.write(
      payeesTable.name,
      "INSERT OR REPLACE INTO fold_category_payees (row, txn, payee) VALUES (?, ?, ?)",
      key,
      found.id,
      found.payee,
    );
    payees.add(found.payee);
    live.push(key);
  }
  return { payees, live };
}

function deriveAll(ctx: DeriveContext): void {
  const e = engine(ctx);
  const rows = allRows(ctx);
  const subs = budget.subscriptionPayees(
    e.categorizer.detectRecurring(
      rows.filter((r) => !r.input.isInternalTransfer).map((r) => r.input),
      e.notSubscription,
    ),
  );
  for (const r of rows) write(ctx, r, e.categorizer.effective(r.input, subs));
  ctx.sql.write(payeesTable.name, "DELETE FROM fold_category_payees");
  for (const r of rows) {
    ctx.sql.insert(
      payeesTable.name,
      "INSERT INTO fold_category_payees (row, txn, payee)",
      "(?, ?, ?)",
      r.input.key,
      r.id,
      budget.txnMerchantKey(r.input),
    );
  }
  ctx.sql.write(subsTable.name, "DELETE FROM fold_category_subs");
  for (const p of subs) {
    ctx.sql.insert(subsTable.name, "INSERT INTO fold_category_subs (payee)", "(?)", p);
  }
  saveSignature(ctx, envSignature(ctx));
}

export const categoriesDeriver: Deriver = {
  id: "budget.categories",
  version: 2,
  tables: [payeesTable, subsTable, envTable],
  writes: [{ table: TRANSACTIONS, columns: ["category", "category_source"] }],
  inputs: ["budget.transactions", "budget.category_rules", "core.accounts", CONTRIBUTIONS],
  derive(dirty, ctx) {
    if (dirty.has("core.accounts")) {
      const sig = envSignature(ctx);
      if (sig !== storedSignature(ctx)) {
        deriveAll(ctx);
        return;
      }
    }
    const txns = dirty.get("budget.transactions");
    const rules = dirty.get("budget.category_rules");
    if (txns === "all" || rules === "all") {
      deriveAll(ctx);
      return;
    }
    const keys = txns === undefined ? [] : [...txns];
    if (keys.length >= FULL_PASS_MIN) {
      const total =
        ctx.sql.get<{ n: number }>("SELECT count(*) AS n FROM fold_category_payees")?.n ?? 0;
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
    const { payees, live } = trackRows(ctx, keys);
    for (const p of rulePayees) payees.add(p);
    const subs = new Set(
      ctx.sql.all<{ payee: string }>("SELECT payee FROM fold_category_subs").map((r) => r.payee),
    );
    const todo = new Map<string, Row>();
    for (const p of payees) {
      const rows = rowsOfPayee(ctx, p);
      const now = flagged(e, rows, p);
      const flipped = now !== subs.has(p);
      if (flipped) {
        if (now) {
          subs.add(p);
          ctx.sql.write(subsTable.name, "INSERT INTO fold_category_subs (payee) VALUES (?)", p);
        } else {
          subs.delete(p);
          ctx.sql.write(subsTable.name, "DELETE FROM fold_category_subs WHERE payee = ?", p);
        }
      }
      if (flipped || rulePayees.has(p)) for (const r of rows) todo.set(r.input.key, r);
    }
    for (const r of rowsByKey(ctx, live)) todo.set(r.input.key, r);
    for (const r of todo.values()) write(ctx, r, e.categorizer.effective(r.input, subs));
  },
  deriveAll,
};
