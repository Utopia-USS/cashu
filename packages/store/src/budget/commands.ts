// Budget commands (S24 5): statement imports, categories, the cash pool, the cushion settings.
// Python oracles: `budget/service.py` (ingest_transactions, import_statement, _end_of_day_balances,
// set_transaction_category, recategorize_merchant, the LLM half of categorize_all), `budget/cash.py`
// (get_cash_account, add_cash_expense, delete_cash_transaction), `categorize/reclassify.py` (the
// answers it writes), `budget/settings.py` (parse), with the validation of `budget/api.py`.
// Categories are facts (claims, rules); the effective category of every row is derived
// (`derive/categories.ts`), so no command writes one.
import { Decimal, floatRepr } from "@cashu/domain";
import {
  acceptMerchantAnswer,
  budgetBaseCurrency,
  CASH_ACCOUNT_TYPE,
  CASH_WITHDRAWAL,
  cashExpenseAmount,
  cashPoolExternalId,
  cashPoolName,
  checkCushionAccounts,
  type DatedAmount,
  defaultBudgetSettings,
  isCategoryKey,
  planImport,
  type RawTransaction,
  ruleUpsert,
} from "@cashu/domain/budget";
import { pyStrip, pyUpper } from "@cashu/domain/text";
import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../command.js";
import { emitBalance, ensureAccount } from "../core/commands.js";
import { accountByGid, profileOf } from "../core/queries.js";
import { BALANCE_SOURCES } from "../events/v1/core.js";
import { blobRef, calendarDate, gid } from "../events/v1/primitives.js";
import { ruleByMerchant, storedTxnsOfAccount, transactionByGid } from "./queries.js";
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

// ------------------------------------------------------------------------------- categories

const categoryKey = z.string().refine(isCategoryKey, "unknown category");

/**
 * The cash pool account of `currency` (Python `get_cash_account(create=True)`): the vault's
 * `manual` / `cash:<CUR>` account, else `account.opened` with its DET gid, named "Gotówka" in the
 * base currency and "Gotówka (<CUR>)" otherwise (the name is matching data, decided once).
 */
function ensureCashPool(ctx: CommandContext, currency: string): { gid: string; currency: string } {
  const base = budgetBaseCurrency(profileOf(ctx.read)?.baseCurrency);
  const pool = ensureAccount(ctx, {
    bank: "manual",
    iban: null,
    name: cashPoolName(currency, base),
    externalId: cashPoolExternalId(currency),
    type: CASH_ACCOUNT_TYPE,
    currency,
  });
  return { gid: pool.gid, currency: pool.currency };
}

/**
 * Set one transaction's category by hand (Python `set_transaction_category` via
 * POST /transactions/{id}/category): a `manual_txn` claim on the row (a cash leg or a cash expense
 * included), which survives every recomputation. Marking a bank row `cash_withdrawal` derives its
 * mirror leg on the cash pool, so the pool is opened in the same batch when the view lacks it (m3).
 */
export const setTransactionCategory = defineCommand({
  id: "budget.setTransactionCategory",
  input: z.object({ txn: gid, category: categoryKey }),
  run(ctx, input) {
    const t = transactionByGid(ctx.read, input.txn);
    if (t === undefined) return refuse("no_transaction");
    if (input.category === CASH_WITHDRAWAL && t.accountType !== CASH_ACCOUNT_TYPE) {
      ensureCashPool(ctx, t.currency);
    }
    ctx.emit("txn.categorySet", t.gid, { category: input.category, source: "manual_txn" });
    return ok(null);
  },
});

/**
 * Pin a merchant to a category (Python `recategorize_merchant` via POST /merchant-category): a
 * manual, locked `categoryRule.set`; its rows follow by derivation (rows with their own decision,
 * structural transfers and cash legs keep theirs). Nothing is emitted when the rule already says so.
 */
export const setMerchantCategory = defineCommand({
  id: "budget.setMerchantCategory",
  input: z.object({ merchantKey: z.string().min(1), category: categoryKey }),
  run(ctx, input) {
    const prev = ruleByMerchant(ctx.read, input.merchantKey);
    if (prev?.locked && prev.source === "manual" && prev.category === input.category) {
      return ok({ changed: false });
    }
    ctx.emit("categoryRule.set", ctx.det("category_rules", [input.merchantKey]), {
      merchantKey: input.merchantKey,
      category: input.category,
      source: "manual",
      locked: true,
    });
    return ok({ changed: true });
  },
});

/**
 * Cache the merchant classifier's answers as `llm` rules (the LLM half of `categorize_all`): an
 * answer becomes a rule only when `acceptMerchantAnswer` takes it (FIX(Q9, D-09.5a): never `other`,
 * `transfer` or `cash_withdrawal`), never over a locked rule (`ruleUpsert`), and not when the rule
 * already says so. The answers come from the classifier port (S09b), whose cloud variant only ever
 * saw `classifierMerchants(read).cloud` (PRIVACY(D-09.5)); this command sends nothing anywhere.
 */
export const cacheLlmRules = defineCommand({
  id: "budget.cacheLlmRules",
  input: z.object({
    items: z.array(z.object({ merchantKey: z.string().min(1), category: z.string() })),
  }),
  run(ctx, input) {
    const answers = new Map<string, string>();
    for (const it of input.items) {
      const category = acceptMerchantAnswer(it.category);
      if (category !== null) answers.set(it.merchantKey, category);
    }
    let cached = 0;
    for (const [merchantKey, category] of answers) {
      const prev = ruleByMerchant(ctx.read, merchantKey);
      const next = ruleUpsert(prev, merchantKey, { category, source: "llm", locked: false });
      if (next === "keep") continue;
      if (prev?.source === "llm" && !prev.locked && prev.category === category) continue;
      ctx.emit("categoryRule.set", ctx.det("category_rules", [merchantKey]), {
        merchantKey,
        category: next.category,
        source: next.source,
        locked: next.locked,
      });
      cached += 1;
    }
    return ok({ cached });
  },
});

/**
 * Store the transaction classifier's answers (`reclassify_all` after `applyReclassify`): an
 * `llm_full` claim per row, except rows holding a manual claim (the claim GUARD, checked here too so
 * nothing redundant is emitted) and rows on a cash account (structural, never reclassified).
 * Unknown rows are skipped; the result counts the claims written.
 */
export const setLlmCategories = defineCommand({
  id: "budget.setLlmCategories",
  input: z.object({ items: z.array(z.object({ txn: gid, category: categoryKey })) }),
  run(ctx, input) {
    let set = 0;
    for (const it of input.items) {
      const t = transactionByGid(ctx.read, it.txn);
      if (t === undefined || t.accountType === CASH_ACCOUNT_TYPE) continue;
      if (t.categorySource === "manual_txn") continue;
      ctx.emit("txn.categorySet", t.gid, { category: it.category, source: "llm_full" });
      set += 1;
    }
    return ok({ set });
  },
});

// ------------------------------------------------------------------------------- cash pool

/**
 * Log a manual cash expense (Python `add_cash_expense` via POST /cash/expense): it draws the cash
 * pool of `currency` (default: the base currency) down by `-abs(amount)`, opened in the same batch
 * when missing. Refusals: `unknown_category`, `empty_title` (the title is stripped, as the API does),
 * `invalid_amount` (not a finite number: FIX(Q14), Python would store NaN), `zero_amount`,
 * `bad_currency`. The day defaults to today (the injected clock).
 */
export const addCashExpense = defineCommand({
  id: "budget.addCashExpense",
  input: z.object({
    amount: z.union([z.string(), z.number()]),
    title: z.string(),
    category: z.string(),
    currency: z.string().nullable().optional(),
    onDate: calendarDate.nullable().optional(),
  }),
  run(ctx, input) {
    if (!isCategoryKey(input.category)) return refuse("unknown_category");
    const title = pyStrip(input.title);
    if (!title) return refuse("empty_title");
    let parsed: Decimal;
    try {
      parsed = Decimal.parse(
        typeof input.amount === "number" ? floatRepr(input.amount) : pyStrip(input.amount),
      );
    } catch {
      return refuse("invalid_amount");
    }
    const amount = cashExpenseAmount(parsed);
    if (!amount.ok) return refuse(amount.reason);
    const currency = input.currency
      ? pyUpper(pyStrip(input.currency))
      : budgetBaseCurrency(profileOf(ctx.read)?.baseCurrency);
    if (!ISO_CURRENCY.test(currency)) return refuse("bad_currency");
    const pool = ensureCashPool(ctx, currency);
    const txn = ctx.newGid();
    ctx.emit("txn.cashExpenseAdded", txn, {
      account: pool.gid,
      bookingDate: input.onDate ?? ctx.today(),
      amount: plain(amount.amount),
      currency: pool.currency,
      title,
      category: input.category,
    });
    return ok({ txn });
  },
});

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
 * kept), an enabled cushion needs a target, then (PUT /budget/settings) every account is the
 * vault's and in the cushion currency (else the base currency). Refusals are value-free codes
 * (`cushion_currency_mismatch`, `unknown_account`, ...). One `budgetSettings.cushionSet` with every
 * field.
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
      currency = pyUpper(pyStrip(input.currency));
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
    if (input.enabled && target === null && months === null) return refuse("needs_target");
    // Python PUT /budget/settings, after the parse: every account is the profile's (unknown ids
    // first), and in the cushion currency (else the profile's base currency, "PLN" before a profile).
    const refs = accounts.flatMap((g) => {
      const a = accountByGid(ctx.read, g);
      return a === undefined ? [] : [{ id: a.gid, name: a.name, currency: a.currency }];
    });
    const problem = checkCushionAccounts(
      { ...defaultBudgetSettings().cushion, currency, accountIds: accounts },
      refs,
      profileOf(ctx.read)?.baseCurrency || "PLN",
    );
    if (problem !== null) {
      return refuse(
        problem.kind === "unknown_account" ? "unknown_account" : "cushion_currency_mismatch",
      );
    }
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
