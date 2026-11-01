// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// Bridges of the budget tables (S31a spec 4.4, 4.6; events.md 8.3): merchant rules, import batches,
// transactions, and the budget.json cushion (not a DB row: the daemon diffs the file, D7a, and maps a
// changed value with `cushionEvents`). Inserts are the genesis snapshot (`mapCategoryRule`,
// `mapImportBatch`, `mapTransaction`); updates take every payload field from the genesis snapshot of
// `post`:
// - category rules: category / source / locked -> `categoryRule.set`, the whole value; the merchant
//   key (the DET part) never changes; Python deletes no rule (no delete event in the catalog);
// - import batches: APPEND, created once (`INSERT OR IGNORE` in the view). Python inserts a batch and
//   fills its counts, `finished_at` and `notes` in ONE transaction, which the merge folds into the
//   insert; an update in a later transaction has no event and blocks;
// - transactions: the category claim (S30 `_txn_filter` keeps category / category_source only for
//   the claim sources manual_txn / llm_full / llm_fallback, or a change away from one) ->
//   `txn.categorySet`, or `txn.categoryCleared` when the row no longer holds a claim. Every other
//   column of a bank row or cash expense is import data with no update event (catalog 8.3): a change
//   blocks (`reprocess_open_banking_fields` rewriting display texts is such a change). A cash expense
//   delete -> `txn.deleted`; a cash-leg delete (explicit `leg_delete`) -> `txn.categoryCleared` on the
//   leg claim gid DET(transactions)["cashleg", @source], addressed the way genesis addresses a leg
//   claim (`ids.ts` budgetIds). Cash legs themselves are derived and never captured (S30).
import { RULE_SOURCES, TXN_CLAIM_SOURCES } from "../../events/v1/budget.js";
import type { Cushion } from "../../genesis/files.js";
import { budgetTxnKind } from "../../genesis/hashes.js";
import {
  mapCategoryRule,
  mapCushion,
  mapImportBatch,
  mapTransaction,
} from "../../genesis/map/budget.js";
import { type EventDraft, event, type MapContext } from "../../genesis/map/context.js";
import type { CategoryRuleRow, ImportBatchRow, TransactionRow } from "../../genesis/rows.js";
import { need, onRow, refuseChanged } from "./core.js";
import {
  anyChanged,
  BridgeBlock,
  carried,
  derived,
  eventsOf,
  pick,
  type RowChange,
  type TableBridge,
} from "./types.js";

// ----------------------------------------------------------------------------------------------- //
// Category rules

const RULE_COLUMNS = [
  "id",
  "profile_id",
  "merchant_key",
  "category",
  "source",
  "locked",
  "created_at",
];

function ruleSnapshot(row: CategoryRuleRow, ctx: MapContext): readonly EventDraft[] {
  // Genesis leaves a rule of another source out (counted `bad_enum`); here that blocks by name.
  if (!RULE_SOURCES.some((s) => s === row.source)) {
    throw new BridgeBlock("bad-enum:category_rules:source");
  }
  return eventsOf(
    "category_rules",
    ctx.attempt(() => mapCategoryRule(row, ctx)),
  );
}

const categoryRules: TableBridge<CategoryRuleRow> = {
  table: "category_rules",
  gid: "det",
  columns: { ...carried(["categoryRule.set"], ...RULE_COLUMNS) },
  insert: (c, ctx) => ruleSnapshot(need("category_rules", c.post), ctx),
  update: (c, ctx) => {
    refuseChanged(c, "category_rules", ["id", "profile_id", "merchant_key", "created_at"]);
    return onRow(c.gid, ruleSnapshot(need("category_rules", c.post), ctx));
  },
};

// ----------------------------------------------------------------------------------------------- //
// Import batches

const BATCH_COLUMNS = [
  "id",
  "profile_id",
  "source",
  "bank",
  "account_id",
  "filename",
  "started_at",
  "finished_at",
  "num_seen",
  "num_inserted",
  "num_duplicates",
  "notes",
];

const importBatches: TableBridge<ImportBatchRow> = {
  table: "import_batches",
  gid: "ulid",
  columns: { ...carried(["importBatch.recorded"], ...BATCH_COLUMNS) },
  insert: (c, ctx) =>
    eventsOf(
      "import_batches",
      ctx.attempt(() => mapImportBatch(need("import_batches", c.post), ctx)),
    ),
  // A batch is recorded once: a change after its insert transaction cannot be carried.
  update: (c) => {
    refuseChanged(c, "import_batches", BATCH_COLUMNS);
    return [];
  },
};

// ----------------------------------------------------------------------------------------------- //
// Transactions

/** Import data of a bank row or a cash expense: no update event exists for any of them. */
const TXN_IMPORT_COLUMNS = [
  "id",
  "account_id",
  "booking_date",
  "value_date",
  "amount",
  "currency",
  "counterparty_name",
  "counterparty_iban",
  "description",
  "reference",
  "bank_transaction_id",
  "source",
  "dedup_hash",
  "occurrence",
  "raw",
  "import_batch_id",
  "created_at",
];
const CLAIM_COLUMNS = ["category", "category_source"];
const CASH_EXPENSE_PREFIX = "cashexp:";

function txnSnapshot(row: TransactionRow, ctx: MapContext): readonly EventDraft[] {
  return eventsOf(
    "transactions",
    ctx.attempt(() => mapTransaction(row, ctx)),
  );
}

const isClaim = (row: TransactionRow): boolean =>
  row.category !== null &&
  row.categorySource !== null &&
  TXN_CLAIM_SOURCES.some((s) => s === row.categorySource);

function txnUpdate(c: RowChange<TransactionRow>, ctx: MapContext): readonly EventDraft[] {
  refuseChanged(c, "transactions", TXN_IMPORT_COLUMNS);
  if (!anyChanged(c, ...CLAIM_COLUMNS)) return [];
  const post = need("transactions", c.post);
  const snap = txnSnapshot(post, ctx);
  const head = snap[0];
  if (head === undefined) throw new BridgeBlock("unresolved:transactions");
  if (!isClaim(post)) return onRow(c.gid, [derived(head, "txn.categoryCleared", {})]);
  if (budgetTxnKind(post) === "bank")
    return onRow(c.gid, [pick("transactions", snap, "txn.categorySet")]);
  // A cash expense's snapshot carries its category inside `txn.cashExpenseAdded`; a recategorized
  // expense is a claim on it, with that category and the row's claim source.
  const added = pick("transactions", snap, "txn.cashExpenseAdded");
  const claim = { category: added.data.category, source: post.categorySource };
  return onRow(c.gid, [derived(added, "txn.categorySet", claim)]);
}

/** A delete: only a cash expense has a tombstone (events.md 8.3); bank rows are never deleted. */
function txnDelete(c: RowChange<TransactionRow>): readonly EventDraft[] {
  const hash = c.row.fields.dedup_hash;
  if (typeof hash !== "string" || !hash.startsWith(CASH_EXPENSE_PREFIX)) {
    throw new BridgeBlock("no-delete-event:transactions");
  }
  return [event("txn.deleted", c.gid, {})];
}

/** `leg_delete`: the owner deleted a cash mirror leg; its claim is cleared on the leg claim gid. */
function legDelete(c: RowChange<TransactionRow>, ctx: MapContext): readonly EventDraft[] {
  const source = c.row.fields.cash_leg_of;
  if (typeof source !== "number" && typeof source !== "string") {
    throw new BridgeBlock("unresolved:transactions");
  }
  const anchor = ctx.ids.resolver.gid("transactions", String(source));
  if (anchor === undefined) throw new BridgeBlock("unresolved:transactions");
  return [event("txn.categoryCleared", ctx.ids.det("transactions", ["cashleg", anchor]), {})];
}

const transactions: TableBridge<TransactionRow> = {
  table: "transactions",
  gid: "shipper",
  columns: {
    ...carried(["txn.imported", "txn.cashExpenseAdded"], ...TXN_IMPORT_COLUMNS),
    ...carried(
      ["txn.cashExpenseAdded", "txn.categorySet", "txn.categoryCleared"],
      ...CLAIM_COLUMNS,
    ),
  },
  insert: (c, ctx) => txnSnapshot(need("transactions", c.post), ctx),
  update: txnUpdate,
  delete: txnDelete,
  explicit: { leg_delete: legDelete },
  explicitEvents: { leg_delete: ["txn.categoryCleared"] },
};

// ----------------------------------------------------------------------------------------------- //
// Cushion (budget.json, D7a)

/**
 * The `budgetSettings.cushionSet` event of a cushion value (parsed by the genesis `files.ts` reader),
 * built by the genesis `mapCushion` with the vault's map context. The daemon calls it when the file's
 * value differs from the last shipped one (S31a spec 4.6).
 */
export function cushionEvents(cushion: Cushion, ctx: MapContext): readonly EventDraft[] {
  return eventsOf(
    "budget_settings",
    ctx.attempt(() => mapCushion(cushion, ctx)),
  );
}

export const budgetBridges: readonly TableBridge[] = [categoryRules, importBatches, transactions];
