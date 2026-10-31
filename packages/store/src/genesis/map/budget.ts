// Genesis row mappers, budget (S26 spec 4.2, 4.3 cushion; events.md 8.2, 8.3; gid.md 4.4, 4.5, 7):
// merchant rules, import batches, bank transactions with their per-row category claims, cash
// expenses, the manual claims of derived cash legs, and the budget.json cushion.

import type { Cushion } from "../files.js";
import { budgetTxnKind } from "../hashes.js";
import type { CategoryRuleRow, ImportBatchRow, TransactionRow } from "../rows.js";
import {
  event,
  gidOf,
  type MapContext,
  type RowEvents,
  requiredGid,
  rowEvents,
  stampsOf,
} from "./context.js";

const RULE_SOURCES: readonly string[] = ["manual", "llm"];
/** Per-transaction category claims (D8); every other source is an engine / rule category (DERIVED). */
const CLAIM_SOURCES: readonly string[] = ["manual_txn", "llm_full", "llm_fallback"];

/** `categoryRule.set`; a source outside manual / llm is `bad_enum` (spec 4.2). */
export function mapCategoryRule(r: CategoryRuleRow, ctx: MapContext): RowEvents | undefined {
  const gid = gidOf(ctx, "category_rules", r.id);
  if (gid === undefined) return undefined;
  if (!RULE_SOURCES.includes(r.source)) {
    ctx.count("category_rules", "bad_enum");
    return undefined;
  }
  const data = {
    merchantKey: r.merchantKey,
    category: r.category,
    source: r.source,
    locked: r.locked,
  };
  return rowEvents("category_rules", r.id, [
    event("categoryRule.set", gid, data, stampsOf(r, ["createdAt"])),
  ]);
}

/** `importBatch.recorded` (budget batches keep no archive). */
export function mapImportBatch(r: ImportBatchRow, ctx: MapContext): RowEvents | undefined {
  const gid = gidOf(ctx, "import_batches", r.id);
  if (gid === undefined) return undefined;
  const data = {
    source: r.source,
    bank: r.bank,
    account: ctx.rw.ref("import_batches", "account_id", "accounts", r.accountId),
    filename: r.filename,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    numSeen: r.numSeen,
    numInserted: r.numInserted,
    numDuplicates: r.numDuplicates,
    notes: r.notes,
  };
  return rowEvents("import_batches", r.id, [
    event("importBatch.recorded", gid, data, stampsOf(r, ["startedAt", "finishedAt"])),
  ]);
}

/** A bank row: `txn.imported` (v2 hash and occurrence of phase 1) + its category claim. */
function mapBankTxn(r: TransactionRow, gid: string, ctx: MapContext): RowEvents | undefined {
  const hash = ctx.ids.budgetTxns.get(r.id);
  if (hash === undefined) return undefined;
  const stamps = stampsOf(r, ["createdAt"]);
  const raw = ctx.rw.json("transactions", "raw", r.raw);
  // The view keeps `{}` for a row without raw data (events.md 8.3 `raw` is an object).
  if (raw === null) ctx.count("transactions", "raw_null_as_object");
  const data = {
    account: requiredGid(ctx, "accounts", r.accountId),
    batch: ctx.rw.ref("transactions", "import_batch_id", "import_batches", r.importBatchId),
    bookingDate: r.bookingDate,
    valueDate: r.valueDate,
    amount: r.amount,
    currency: r.currency,
    counterpartyName: r.counterpartyName,
    counterpartyIban: r.counterpartyIban,
    description: r.description,
    reference: r.reference,
    bankTransactionId: r.bankTransactionId,
    source: r.source,
    dedupHash: hash.dedupHash,
    occurrence: hash.occurrence,
    raw: raw ?? {},
  };
  const events = [event("txn.imported", gid, data, stamps)];
  const source = r.categorySource;
  if (source !== null && CLAIM_SOURCES.includes(source) && r.category !== null) {
    events.push(event("txn.categorySet", gid, { category: r.category, source }, stamps));
  }
  return rowEvents("transactions", r.id, events);
}

/** A cash expense: `txn.cashExpenseAdded`; a non-negative amount or a blank title is refused (m10). */
function mapCashExpense(r: TransactionRow, gid: string, ctx: MapContext): RowEvents | undefined {
  const negative = r.amount.startsWith("-") && /[1-9]/.test(r.amount);
  if (!negative || r.description === null || r.description === "" || r.category === null) {
    ctx.count("transactions", "bad_cash_expense");
    return undefined;
  }
  const data = {
    account: requiredGid(ctx, "accounts", r.accountId),
    bookingDate: r.bookingDate,
    amount: r.amount,
    currency: r.currency,
    title: r.description,
    category: r.category,
  };
  return rowEvents("transactions", r.id, [
    event("txn.cashExpenseAdded", gid, data, stampsOf(r, ["createdAt"])),
  ]);
}

/** Bank rows and cash expenses, in id order (spec 5.1 group 9, before the leg claims). */
export function mapTransaction(r: TransactionRow, ctx: MapContext): RowEvents | undefined {
  const kind = budgetTxnKind(r);
  if (kind === "cashLeg") return undefined;
  const gid = gidOf(ctx, "transactions", r.id);
  if (gid === undefined) return undefined;
  return kind === "bank" ? mapBankTxn(r, gid, ctx) : mapCashExpense(r, gid, ctx);
}

/**
 * The owner's category of a derived cash leg: `txn.categorySet` on DET(transactions)["cashleg",
 * @source] (spec 4.2). The leg itself is DERIVED and has no `ids` entry.
 */
export function mapCashLegClaim(r: TransactionRow, ctx: MapContext): RowEvents | undefined {
  const gid = ctx.ids.cashLegClaims.get(r.id);
  if (gid === undefined || r.categorySource !== "manual_txn" || r.category === null) {
    return undefined;
  }
  const data = { category: r.category, source: "manual_txn" };
  return rowEvents("transactions", undefined, [
    event("txn.categorySet", gid, data, stampsOf(r, ["createdAt"])),
  ]);
}

/**
 * `budgetSettings.cushionSet` from a parsed budget.json; account ids outside the profile are dropped
 * and counted (`budget_settings`, `dangling_account_ids`).
 */
export function mapCushion(cushion: Cushion, ctx: MapContext): RowEvents {
  const data = {
    enabled: cushion.enabled,
    currency: cushion.currency,
    targetAmount: cushion.targetAmount,
    targetMonths: cushion.targetMonths,
    accounts: ctx.rw.refs("budget_settings", "account_ids", "accounts", cushion.accountIds),
    monthlyMax: cushion.monthlyMax,
  };
  const gid = ctx.ids.det("budget_settings", ["cushion"]);
  return rowEvents("budget_settings", undefined, [event("budgetSettings.cushionSet", gid, data)]);
}
