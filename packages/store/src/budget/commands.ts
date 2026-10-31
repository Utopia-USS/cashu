// Budget commands (S24 5): statement imports, cash pool deletes, the cushion settings. Python
// oracles: `budget/service.py` (ingest_transactions, import_statement, _end_of_day_balances),
// `budget/cash.py` (delete_cash_transaction), `budget/settings.py` (parse).
// The category commands (set a transaction's category, add a cash expense, merchant rules, LLM
// results) need the S09 taxonomy for validation and land with S24c.
import { Decimal, floatRepr } from "@cashu/domain";
import { type DatedAmount, planImport, type RawTransaction } from "@cashu/domain/budget";
import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../command.js";
import { emitBalance, ensureAccount } from "../core/commands.js";
import { accountByGid } from "../core/queries.js";
import { BALANCE_SOURCES } from "../events/v1/core.js";
import { blobRef, gid } from "../events/v1/primitives.js";
import { storedTxnsOfAccount, transactionByGid } from "./queries.js";
import { CASHEXP, CASHLEG } from "./transactions.js";

const ISO_CURRENCY = /^[A-Z]{3}$/;
const plain = (d: Decimal) => d.format("f");

// ------------------------------------------------------------------------------- import

const decimalValue = z.custom<Decimal>((v) => v instanceof Decimal, "expected a Decimal");
const rawTransaction = z.custom<RawTransaction>(
  (v) => typeof v === "object" && v !== null && (v as RawTransaction).amount instanceof Decimal,
  "expected a parsed transaction",
);
const datedAmount = z.object({ date: z.string(), amount: decimalValue });

/**
 * Python `_end_of_day_balances`: one figure per date from the running balances in file order (a
 * newest-first statement is reversed first, so the last row of a date is its end of day).
 */
function endOfDayBalances(
  transactions: readonly Pick<RawTransaction, "bookingDate">[],
  balances: readonly DatedAmount[],
): Map<string, Decimal> {
  const eod = new Map<string, Decimal>();
  if (balances.length === 0) return eod;
  const first = transactions[0]?.bookingDate;
  const last = transactions[transactions.length - 1]?.bookingDate;
  const descending =
    transactions.length >= 2 && first !== undefined && last !== undefined && first > last;
  for (const b of descending ? [...balances].reverse() : balances) eod.set(b.date, b.amount);
  return eod;
}

/**
 * Write a parsed statement (Python `import_statement` + `ingest_transactions`) as one batch: the
 * account (given, or found / opened from the statement's bank and number), `importBatch.recorded`,
 * one `txn.imported` per new row (S07 `planImport` over every stored row of the account), and the
 * end-of-day balances (explicit closing balances win). The newest-day rule depends on the view at
 * import time, so it runs on the fetch-lease holder only (events.md 8.3).
 */
export const importStatement = defineCommand({
  id: "budget.importStatement",
  input: z.object({
    account: gid.optional(),
    statement: z.object({
      bank: z.string().regex(/^[a-z0-9_-]+$/),
      accountNumber: z.string().nullable(),
      accountName: z.string().nullable(),
      currency: z.string(),
      transactions: z.array(rawTransaction),
      balances: z.array(datedAmount),
      closingBalances: z.array(datedAmount),
    }),
    accountType: z.string().default("checking"),
    accountName: z.string().nullable().optional(),
    externalId: z.string().min(1).nullable().optional(),
    source: z.enum(BALANCE_SOURCES).default("csv"),
    filename: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    newestDayRule: z.boolean().default(false),
    archive: blobRef.optional(),
  }),
  run(ctx, input) {
    if (input.newestDayRule && !ctx.lease.isHolder()) return refuse("not_leader");
    const stmt = input.statement;
    const rows = stmt.transactions;
    // PARITY(S07 Q7): Python stores any currency text; the event catalog takes ISO codes only.
    if (rows.some((r) => !ISO_CURRENCY.test(r.currency.toUpperCase()))) {
      return refuse("bad_currency");
    }
    let account: { gid: string; currency: string; bank: string; created: boolean };
    if (input.account !== undefined) {
      const a = accountByGid(ctx.read, input.account);
      if (a === undefined) return refuse("no_account");
      account = { gid: a.gid, currency: a.currency, bank: a.bank, created: false };
    } else {
      if (!ISO_CURRENCY.test(stmt.currency)) return refuse("bad_currency");
      const a = ensureAccount(ctx, {
        bank: stmt.bank,
        iban: stmt.accountNumber,
        name: input.accountName || stmt.accountName,
        externalId: input.externalId ?? null,
        type: input.accountType,
        currency: stmt.currency,
      });
      account = { gid: a.gid, currency: a.currency, bank: stmt.bank, created: a.created };
    }

    const stored = account.created ? [] : storedTxnsOfAccount(ctx.read, account.gid);
    const plan = planImport(stored, rows, { newestDayRule: input.newestDayRule });
    const batch = ctx.newGid();
    const at = ctx.now();
    ctx.emit("importBatch.recorded", batch, {
      source: input.source,
      bank: account.bank,
      account: account.gid,
      filename: input.filename ?? null,
      startedAt: at,
      finishedAt: at,
      numSeen: rows.length,
      numInserted: plan.toInsert.length,
      numDuplicates: plan.numDuplicates + plan.numOverlap,
      notes: input.notes || null,
      ...(input.archive === undefined ? {} : { archive: input.archive }),
    });
    for (const t of plan.toInsert) {
      ctx.emit(
        "txn.imported",
        ctx.det("transactions", [account.gid, t.dedupHash, String(t.occurrence)]),
        {
          account: account.gid,
          batch,
          bookingDate: t.bookingDate,
          valueDate: t.valueDate,
          amount: plain(t.amount),
          currency: t.currency,
          counterpartyName: t.counterpartyName,
          counterpartyIban: t.counterpartyIban,
          description: t.description,
          reference: t.reference,
          bankTransactionId: t.bankTransactionId,
          source: t.source,
          dedupHash: t.dedupHash,
          occurrence: t.occurrence,
          raw: t.raw,
        },
      );
    }
    const eod = endOfDayBalances(rows, stmt.balances);
    for (const c of stmt.closingBalances) eod.set(c.date, c.amount);
    for (const [date, amount] of eod) {
      emitBalance(ctx, account.gid, date, input.source, plain(amount), account.currency);
    }
    return ok({
      account: account.gid,
      batch,
      numSeen: rows.length,
      numInserted: plan.toInsert.length,
      numDuplicates: plan.numDuplicates + plan.numOverlap,
    });
  },
});

// ------------------------------------------------------------------------------- cash pool

/**
 * Delete a cash pool entry (Python `delete_cash_transaction`): a cash expense ends (`txn.deleted`);
 * a mirror leg is derived, so deleting it clears the claim on its source bank transaction
 * (`txn.categoryCleared`, events.md 8.3); anything else is refused.
 */
export const deleteCashTransaction = defineCommand({
  id: "budget.deleteCashTransaction",
  input: z.object({ txn: gid }),
  run(ctx, input) {
    const t = transactionByGid(ctx.read, input.txn);
    if (t === undefined || t.accountType !== "cash") return refuse("not_cash");
    if (t.dedupHash.startsWith(CASHEXP)) {
      ctx.emit("txn.deleted", t.gid, {});
      return ok<{ deleted: "expense" | "leg" }>({ deleted: "expense" });
    }
    const source = t.raw.cash_leg_of;
    if (t.dedupHash.startsWith(CASHLEG) && typeof source === "string") {
      ctx.emit("txn.categoryCleared", source, {});
      return ok<{ deleted: "expense" | "leg" }>({ deleted: "leg" });
    }
    return refuse("not_cash");
  },
});

// ------------------------------------------------------------------------------- cushion

/** `budget/settings.py` MAX_TARGET_MONTHS. */
const MAX_TARGET_MONTHS = 36;

const loose = z.union([z.string(), z.number(), z.boolean(), z.null()]).optional();

/** `_positive`: empty -> null; a positive finite number quantized to 0.01 (half even); else refused. */
function positive(value: z.infer<typeof loose>): Decimal | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return "invalid";
  let d: Decimal;
  try {
    d = Decimal.parse(typeof value === "number" ? floatRepr(value) : value);
  } catch {
    return "invalid";
  }
  if (d.isSigned() || d.isZero()) return "invalid"; // non-finite text already threw
  return d.quantize(-2);
}

/**
 * Save the cushion settings (Python `settings.parse` + `save`): currency stripped and upper-cased,
 * positive amounts quantized to 0.01, months 1..36, account gids of this vault (first occurrence
 * kept), an enabled cushion needs a target. One `budgetSettings.cushionSet` with every field.
 */
export const setCushion = defineCommand({
  id: "budget.setCushion",
  input: z.object({
    enabled: z.boolean().default(false),
    currency: z.string().nullable().optional(),
    targetAmount: loose,
    targetMonths: loose,
    accounts: z.array(z.string()).default([]),
    monthlyMax: loose,
  }),
  run(ctx: CommandContext, input) {
    let currency: string | null = null;
    if (input.currency !== undefined && input.currency !== null && input.currency !== "") {
      currency = input.currency.trim().toUpperCase();
      if (!ISO_CURRENCY.test(currency)) return refuse("invalid_currency");
    }
    const target = positive(input.targetAmount);
    if (target === "invalid") return refuse("invalid_target_amount");
    const monthlyMax = positive(input.monthlyMax);
    if (monthlyMax === "invalid") return refuse("invalid_monthly_max");
    const m = input.targetMonths;
    let months: number | null = null;
    if (m !== undefined && m !== null && m !== "") {
      if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > MAX_TARGET_MONTHS) {
        return refuse("invalid_target_months");
      }
      months = m;
    }
    const accounts = [...new Set(input.accounts)];
    if (accounts.some((a) => accountByGid(ctx.read, a) === undefined)) {
      return refuse("unknown_account");
    }
    if (input.enabled && target === null && months === null) return refuse("needs_target");
    ctx.emit("budgetSettings.cushionSet", ctx.det("budget_settings", ["cushion"]), {
      enabled: input.enabled,
      currency,
      targetAmount: target === null ? null : plain(target),
      targetMonths: months,
      accounts,
      monthlyMax: monthlyMax === null ? null : plain(monthlyMax),
    });
    return ok(null);
  },
});
