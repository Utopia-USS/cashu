// Planned deposits (Python `service/planned.py`, write side): create, cancel, and booking by a
// matching deposit (events.md 8.8). A plan counts against the strategy's contribution plan and is
// never cash, value or a performance flow; only a real deposit transaction is. A deposit books an
// open plan when it has the plan's currency, the plan's account (any brokerage account of the vault
// when the plan names none), a trade date from MATCH_BEFORE_DAYS before to MATCH_AFTER_DAYS after the
// planned date, an amount within AMOUNT_TOLERANCE of the planned one, and books no other plan; the
// closest date wins, then the closest amount, then the older transaction. Plans are matched oldest
// planned date first. Booked / cancelled are terminal FWW in the fold, and the fold re-checks that a
// transaction books one plan only (GUARD O10), so concurrent bookings converge.
import {
  addDays,
  D,
  type Decimal,
  DecimalError,
  daysBetween,
  floatRepr,
  pyLen,
  pyStrip,
  tryCurrency,
  ZERO,
} from "@cashu/domain";
import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../../command.js";
import { accountByMemberGid, profileOf } from "../../core/queries.js";
import { calendarDate, gid } from "../../events/v1/primitives.js";
import {
  type BrokerageDeposit,
  brokerageDeposits,
  openPlannedDeposits,
  plannedDeposit,
  plannedDeposits,
} from "../queries/planned.js";
import { brokerageAccount, brokerageAccounts } from "../queries/transactions.js";

const MATCH_BEFORE_DAYS = 7;
const MATCH_AFTER_DAYS = 31;
/** A deposit within 10 % of the planned amount books the plan. */
const AMOUNT_TOLERANCE: Decimal = D("0.10");
/** A plan may be dated up to a month back (a deposit already made is booked at once). */
const PAST_DAYS = 31;
const FUTURE_DAYS = 366;
const MAX_AMOUNT: Decimal = D("1000000000");
const MAX_NOTE = 500;

/** Refusals Python raises as `PlannedError` (the API answers 422 `planned_invalid`). */
export const PLANNED_INVALID_REASONS = [
  "amount_not_number",
  "amount_not_positive",
  "amount_too_large",
  "planned_date_too_old",
  "planned_date_too_far",
  "invalid_currency",
  "note_too_long",
] as const;

/** A deposit emitted earlier in the caller's batch (not in the view yet). */
export interface PendingDeposit {
  readonly gid: string;
  readonly account: string;
  readonly tradeDate: string;
  readonly cashAmount: string;
  readonly cashCurrency: string;
}

interface OpenPlan {
  readonly gid: string;
  readonly account: string | null;
  readonly amount: Decimal;
  readonly currency: string;
  readonly plannedDate: string;
}

const compareDates = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Book every open plan (the view's, then `extra` plans of this batch) that a stored or pending
 * deposit matches; emits `plannedDeposit.booked` for each. Returns the booked plan gids.
 */
function bookPlans(
  ctx: CommandContext,
  extra: readonly OpenPlan[],
  pending: readonly PendingDeposit[],
): string[] {
  // a stable sort keeps the view's fold order on equal dates and puts this batch's plans last
  const plans: OpenPlan[] = [...openPlannedDeposits(ctx.read), ...extra].sort((a, b) =>
    compareDates(a.plannedDate, b.plannedDate),
  );
  const first = plans[0];
  if (first === undefined) return [];
  const accounts = new Set(brokerageAccounts(ctx.read).map((a) => a.gid));
  if (accounts.size === 0) return [];
  const earliest = addDays(first.plannedDate, -MATCH_BEFORE_DAYS);
  const deposits: BrokerageDeposit[] = [...brokerageDeposits(ctx.read, earliest)];
  for (const p of pending) {
    const account = accountByMemberGid(ctx.read, p.account)?.gid ?? p.account;
    if (!accounts.has(account) || p.tradeDate < earliest) continue;
    deposits.push({
      gid: p.gid,
      account,
      tradeDate: p.tradeDate,
      cashAmount: D(p.cashAmount),
      cashCurrency: p.cashCurrency,
    });
  }
  const used = new Set<string>();
  for (const p of plannedDeposits(ctx.read, ["booked"])) {
    if (p.bookedTxn !== null) used.add(p.bookedTxn);
  }
  const booked: string[] = [];
  for (const plan of plans) {
    const low = addDays(plan.plannedDate, -MATCH_BEFORE_DAYS);
    const high = addDays(plan.plannedDate, MATCH_AFTER_DAYS);
    const tolerance = plan.amount.mul(AMOUNT_TOLERANCE);
    let best: { deposit: BrokerageDeposit; days: number; diff: Decimal } | undefined;
    for (const t of deposits) {
      if (used.has(t.gid)) continue;
      if (plan.account !== null && t.account !== plan.account) continue;
      if (t.cashCurrency !== plan.currency) continue;
      if (t.tradeDate < low || t.tradeDate > high || !t.cashAmount.gt(ZERO)) continue;
      const diff = t.cashAmount.sub(plan.amount).abs();
      if (diff.gt(tolerance)) continue;
      const days = Math.abs(daysBetween(plan.plannedDate, t.tradeDate));
      // strictly better only: on a full tie the earlier deposit (older transaction) stays
      if (best === undefined || days < best.days || (days === best.days && diff.lt(best.diff))) {
        best = { deposit: t, days, diff };
      }
    }
    if (best === undefined) continue;
    used.add(best.deposit.gid);
    ctx.emit("plannedDeposit.booked", plan.gid, { txn: best.deposit.gid });
    booked.push(plan.gid);
  }
  return booked;
}

/**
 * Python `book_matching`: book every open plan a stored or pending deposit matches; returns the
 * booked plan gids. Pending deposits count after the stored ones (the older transactions) and only
 * when their account is one of the view's brokerage accounts. A building block for commands that
 * emit deposits in their own batch (an import commit, a manual deposit).
 */
export function bookMatchingPlans(
  ctx: CommandContext,
  pending: readonly PendingDeposit[] = [],
): string[] {
  return bookPlans(ctx, [], pending);
}

/** Python `_amount`: a positive decimal; a comma is a decimal separator. */
function parseAmount(
  value: string | number,
): { ok: true; amount: Decimal } | { ok: false; reason: string } {
  const text = typeof value === "number" ? floatRepr(value) : value;
  let amount: Decimal;
  try {
    amount = D(pyStrip(text).replaceAll(",", "."));
  } catch (e) {
    if (e instanceof DecimalError && e.signal === "NonFinite") {
      return { ok: false, reason: "amount_not_positive" }; // Python: not finite -> "greater than 0"
    }
    return { ok: false, reason: "amount_not_number" };
  }
  if (!amount.gt(ZERO)) return { ok: false, reason: "amount_not_positive" };
  if (amount.gt(MAX_AMOUNT)) return { ok: false, reason: "amount_too_large" };
  return { ok: true, amount };
}

export const createPlannedDeposit = defineCommand({
  id: "investments.createPlannedDeposit",
  input: z.object({
    amount: z.union([z.string(), z.number()]),
    plannedDate: calendarDate,
    currency: z.string().nullable().default(null),
    account: gid.nullable().default(null),
    note: z.string().nullable().default(null),
  }),
  /**
   * Python `create`: store a plan (status `planned`), then book it at once when a matching deposit
   * already exists (a plan made after its deposit). Currency defaults to the account's, else the
   * profile's base currency.
   */
  run(ctx, input) {
    const parsed = parseAmount(input.amount);
    if (!parsed.ok) return refuse(parsed.reason);
    const today = ctx.today();
    if (input.plannedDate < addDays(today, -PAST_DAYS)) return refuse("planned_date_too_old");
    if (input.plannedDate > addDays(today, FUTURE_DAYS)) return refuse("planned_date_too_far");
    let account: { gid: string; currency: string } | undefined;
    if (input.account !== null) {
      const root = accountByMemberGid(ctx.read, input.account)?.gid ?? input.account;
      account = brokerageAccount(ctx.read, root);
      if (account === undefined) return refuse("no_account");
    }
    const raw = input.currency || account?.currency;
    let currency: string;
    if (raw) {
      const code = tryCurrency(raw);
      if (code === null) return refuse("invalid_currency");
      currency = code;
    } else {
      currency = profileOf(ctx.read)?.baseCurrency ?? "PLN";
    }
    const note = input.note === null ? null : pyStrip(input.note) || null;
    if (note !== null && pyLen(note) > MAX_NOTE) return refuse("note_too_long");
    const plan: OpenPlan = {
      gid: ctx.newGid(),
      account: account?.gid ?? null,
      amount: parsed.amount,
      currency,
      plannedDate: input.plannedDate,
    };
    ctx.emit("plannedDeposit.created", plan.gid, {
      account: plan.account,
      amount: plan.amount.format("f"),
      currency,
      plannedDate: plan.plannedDate,
      note,
    });
    const booked = bookPlans(ctx, [plan], []);
    return ok({ plan: plan.gid, booked });
  },
});

export const cancelPlannedDeposit = defineCommand({
  id: "investments.cancelPlannedDeposit",
  input: z.object({ plan: gid }),
  /**
   * Python `cancel`: the plan stays as history with status `cancelled`; cancelling a cancelled plan
   * emits nothing. A booked plan is refused (its deposit is real).
   */
  run(ctx, input) {
    const row = plannedDeposit(ctx.read, input.plan);
    if (row === undefined) return refuse("no_plan");
    if (row.status === "booked") return refuse("planned_booked");
    if (row.status !== "cancelled") ctx.emit("plannedDeposit.cancelled", row.gid, {});
    return ok({ plan: row.gid, status: "cancelled" as const });
  },
});
