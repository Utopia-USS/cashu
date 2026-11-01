// Planned deposits (Python `service/planned.py`): create / cancel and booking by a matching deposit,
// with the store-level meaning of tests/investments/persistence/test_be_api.py (planned deposits
// lifecycle, a plan for a deposit already made). Imports are the lead's command: `importDeposit` below
// stands in for its commit step 7 (a deposit emitted in the batch, then `bookMatchingPlans` with it
// pending). Synthetic data only; the test clock is 2026-10-31.
import { market } from "@cashu/domain/investments";
import { loadStrategy } from "@cashu/domain/investments/strategy";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCommand, ok } from "../../command.js";
import { createProfile, openAccount } from "../../core/commands.js";
import { calendarDate, decimal, gid } from "../../events/v1/primitives.js";
import { parsePlannedStatuses, plannedDeposit, plannedDeposits } from "../queries/planned.js";
import { monthPlan, monthPlanRecord } from "../services/planned.js";
import { addManualTransaction } from "./manual.js";
import { bookMatchingPlans, cancelPlannedDeposit, createPlannedDeposit } from "./planned.js";
import { brokerage, otherVault, type Vault, vault } from "./testing/fixtures.js";

/** A deposit emitted in the batch, then booked against the plans (the import commit's steps 3 and 7). */
const importDeposit = defineCommand({
  id: "test.importDeposit",
  input: z.object({
    account: gid,
    tradeDate: calendarDate,
    cashAmount: decimal,
    cashCurrency: z.string().default("PLN"),
  }),
  run(ctx, input) {
    const txn = ctx.newGid();
    ctx.emit("invTxn.imported", txn, {
      account: input.account,
      batch: null,
      type: "deposit",
      tradeDate: input.tradeDate,
      settleDate: null,
      instrument: null,
      quantity: null,
      price: null,
      currency: input.cashCurrency,
      grossAmount: input.cashAmount,
      fee: "0",
      tax: "0",
      cashAmount: input.cashAmount,
      cashCurrency: input.cashCurrency,
      fxRate: null,
      splitRatio: null,
      note: null,
      source: "manual",
      externalRef: null,
      dedupHash: `manual:${txn}`,
      createdAt: ctx.now(),
    });
    const booked = bookMatchingPlans(ctx, [
      {
        gid: txn,
        account: input.account,
        tradeDate: input.tradeDate,
        cashAmount: input.cashAmount,
        cashCurrency: input.cashCurrency,
      },
    ]);
    return ok({ txn, booked });
  },
});

const PLAN_STRATEGY = `version: 1
base_currency: PLN
buckets:
  - id: stocks
    match: { asset_class: [equity, etf] }
  - id: cash
    match: { asset_class: cash }
allocation:
  targets: { stocks: 0.9, cash: 0.1 }
contributions:
  monthly_amount: 1500
  day_of_month: 10
`;

function strategy() {
  const config = loadStrategy(PLAN_STRATEGY).config;
  if (config === null) expect.fail("the test strategy must load");
  return config;
}

const plan = (v: Vault, input: Record<string, unknown>) => v.value(createPlannedDeposit, input);
const status = (v: Vault, g: string) => plannedDeposit(v.store.read.bind(v.store), g)?.status;
const month = (v: Vault, m = "2026-11") => {
  const out = monthPlan(v.store.read.bind(v.store), {
    month: m,
    today: "2026-10-31",
    strategy: strategy(),
    prices: new market.InMemoryPriceCache(),
  });
  if (!out.ok) expect.fail(out.reason);
  return monthPlanRecord(out.value);
};

describe("planned deposits (test_be_api)", () => {
  it("planned deposits lifecycle and month plan", () => {
    const v = vault();
    const account = brokerage(v, "DIF");
    const other = otherVault();
    brokerage(other, "DIF");
    for (const [bad, reason] of [
      [{ amount: 0, plannedDate: "2026-11-10" }, "amount_not_positive"],
      [{ amount: "x", plannedDate: "2026-11-10" }, "amount_not_number"],
      [{ amount: 10, plannedDate: "2025-01-10" }, "planned_date_too_old"], // more than a month back
      [{ amount: 10, plannedDate: "2026-11-10", currency: "zloty" }, "invalid_currency"],
      [
        { amount: 10, plannedDate: "2026-11-10", account: other.det("accounts", ["x"]) },
        "no_account",
      ],
    ] as const) {
      const out = v.run(createPlannedDeposit, bad);
      expect(out.ok ? "ok" : out.reason, JSON.stringify(bad)).toBe(reason);
    }

    const first = plan(v, { amount: 1000, plannedDate: "2026-11-05", account, note: "listopad" });
    expect(first.booked).toEqual([]);
    const read = v.store.read.bind(v.store);
    const row = plannedDeposit(read, first.plan);
    expect([row?.status, row?.amount.toString(), row?.currency, row?.note]).toEqual([
      "planned",
      "1000.0",
      "PLN",
      "listopad",
    ]);
    const later = plan(v, { amount: 300, plannedDate: "2026-11-25" });
    const laterRow = plannedDeposit(read, later.plan);
    expect([laterRow?.account, laterRow?.currency]).toEqual([null, "PLN"]); // base currency

    expect(plannedDeposits(read).map((p) => p.gid)).toEqual([later.plan, first.plan]);
    expect(month(v)).toEqual({
      month: "2026-11",
      currency: "PLN",
      monthly_amount: "1500.00",
      day_of_month: 10,
      deposited: "0.00",
      planned: "1300.00",
      remaining: "200.00",
      covered: false,
      planned_count: 2,
    });
    expect(plannedDeposits(other.store.read.bind(other.store))).toEqual([]);
    const foreign = other.run(cancelPlannedDeposit, { plan: first.plan });
    expect(foreign.ok ? "ok" : foreign.reason).toBe("no_plan");

    // an imported deposit within the window and 10 % of the amount books the plan
    const imported = v.value(importDeposit, {
      account,
      tradeDate: "2026-11-02",
      cashAmount: "980.00",
    });
    expect(imported.booked).toEqual([first.plan]);
    const booked = plannedDeposit(read, first.plan);
    expect([booked?.status, booked?.bookedTxn]).toEqual(["booked", imported.txn]);
    expect(status(v, later.plan)).toBe("planned"); // 300 does not match a 980 deposit
    const after = month(v);
    expect([after.deposited, after.planned, after.remaining]).toEqual([
      "980.00",
      "300.00",
      "220.00",
    ]);
    const refused = v.run(cancelPlannedDeposit, { plan: first.plan });
    expect(refused.ok ? "ok" : refused.reason).toBe("planned_booked");

    expect(v.value(cancelPlannedDeposit, { plan: later.plan })).toEqual({
      plan: later.plan,
      status: "cancelled",
    });
    expect(plannedDeposits(read).map((p) => p.gid)).not.toContain(later.plan);
    const all = parsePlannedStatuses("all");
    if (!all.ok) expect.fail("all is a valid filter");
    expect(new Set(plannedDeposits(read, all.statuses).map((p) => p.status))).toEqual(
      new Set(["booked", "cancelled"]),
    );
    expect(parsePlannedStatuses("nope")).toEqual({ ok: false, reason: "unknown_status" });
    const badMonth = monthPlan(read, {
      month: "2026-13",
      today: "2026-10-31",
      strategy: null,
      prices: new market.InMemoryPriceCache(),
    });
    expect(badMonth).toEqual({ ok: false, reason: "invalid_month" });
  });

  it("a plan for a deposit already made is booked at once and once only", () => {
    const v = vault();
    const account = brokerage(v, "DIF");
    const deposit = v.value(importDeposit, {
      account,
      tradeDate: "2026-10-28",
      cashAmount: "500.00",
    });
    const first = plan(v, { amount: 500, plannedDate: "2026-11-01" });
    expect(first.booked).toEqual([first.plan]);
    expect(status(v, first.plan)).toBe("booked");
    // the same deposit cannot book a second plan
    const second = plan(v, { amount: 500, plannedDate: "2026-11-01" });
    expect(second.booked).toEqual([]);
    expect(status(v, second.plan)).toBe("planned");
    // a manual deposit books it
    const manual = v.value(addManualTransaction, {
      account,
      type: "deposit",
      tradeDate: "2026-11-02",
      cashAmount: 510,
      currency: "PLN",
    });
    expect(manual.booked).toEqual([second.plan]);
    const read = v.store.read.bind(v.store);
    expect(plannedDeposit(read, second.plan)?.bookedTxn).toBe(manual.transaction);
    expect(plannedDeposit(read, first.plan)?.bookedTxn).toBe(deposit.txn);
  });
});

describe("createPlannedDeposit", () => {
  it("validates in Python's order and normalizes amount, currency and note", () => {
    const v = vault();
    const account = brokerage(v);
    const cases: [Record<string, unknown>, string][] = [
      [{ amount: "-5", plannedDate: "2026-11-01" }, "amount_not_positive"],
      [{ amount: "1000000001", plannedDate: "2026-11-01" }, "amount_too_large"],
      [{ amount: "abc", plannedDate: "1999-01-01" }, "amount_not_number"], // amount first
      [{ amount: 5, plannedDate: "2027-11-02" }, "planned_date_too_far"],
      [
        { amount: 5, plannedDate: "2026-11-01", account: "01JG0000000000000000000099" },
        "no_account",
      ],
      [{ amount: 5, plannedDate: "2026-11-01", note: "x".repeat(501) }, "note_too_long"],
      [
        { amount: 5, plannedDate: "2026-11-01", currency: "EURO", note: "x".repeat(501) },
        "invalid_currency",
      ],
    ];
    for (const [input, reason] of cases) {
      const out = v.run(createPlannedDeposit, input);
      expect(out.ok ? "ok" : out.reason, JSON.stringify(input).slice(0, 60)).toBe(reason);
    }
    const read = v.store.read.bind(v.store);
    const edge = plan(v, {
      amount: " 12,50 ",
      plannedDate: "2026-09-30",
      currency: " eur ",
      note: "  ",
    });
    const row = plannedDeposit(read, edge.plan);
    expect([row?.amount.toString(), row?.currency, row?.note]).toEqual(["12.50", "EUR", null]);
    const far = plan(v, { amount: "1", plannedDate: "2027-11-01", account });
    expect(plannedDeposit(read, far.plan)?.account).toBe(account);
  });

  it("defaults the currency to the account's, else the profile's base currency", () => {
    const v = vault();
    v.value(createProfile, { slug: "anna", name: "Anna", baseCurrency: "EUR" });
    const usd = v.value(openAccount, {
      bank: "xtb",
      name: "USD",
      type: "brokerage",
      currency: "USD",
      externalId: "brokerage:usd",
    }).account;
    const read = v.store.read.bind(v.store);
    const onAccount = plan(v, { amount: 5, plannedDate: "2026-11-01", account: usd });
    const anywhere = plan(v, { amount: 5, plannedDate: "2026-11-01" });
    expect(plannedDeposit(read, onAccount.plan)?.currency).toBe("USD");
    expect(plannedDeposit(read, anywhere.plan)?.currency).toBe("EUR");
  });
});

describe("bookMatchingPlans", () => {
  function setup() {
    const v = vault();
    return { v, a: brokerage(v, "A"), b: brokerage(v, "B"), read: v.store.read.bind(v.store) };
  }

  it("matches currency, account, the date window and the 10 % tolerance", () => {
    const { v, a, b, read } = setup();
    const onA = plan(v, { amount: 1000, plannedDate: "2026-11-10", account: a }).plan;
    for (const miss of [
      { account: b, tradeDate: "2026-11-10", cashAmount: "1000" }, // another account
      { account: a, tradeDate: "2026-11-10", cashAmount: "1000", cashCurrency: "EUR" },
      { account: a, tradeDate: "2026-11-02", cashAmount: "1000" }, // 8 days before
      { account: a, tradeDate: "2026-12-12", cashAmount: "1000" }, // 32 days after
      { account: a, tradeDate: "2026-11-10", cashAmount: "1100.01" }, // over 10 %
    ]) {
      expect(v.value(importDeposit, miss).booked, JSON.stringify(miss)).toEqual([]);
    }
    expect(status(v, onA)).toBe("planned");
    const edge = v.value(importDeposit, { account: a, tradeDate: "2026-12-11", cashAmount: "900" });
    expect(edge.booked).toEqual([onA]);
    expect(plannedDeposit(read, onA)?.bookedTxn).toBe(edge.txn);
  });

  it("takes the closest date, then the closest amount, then the older transaction", () => {
    const { v, a } = setup();
    const deposits = (rows: { tradeDate: string; cashAmount: string }[]) =>
      rows.map((r) => v.value(importDeposit, { account: a, ...r }).txn);
    // stored first (nothing to book yet), then the plan books the best one at create
    const [, nearDate] = deposits([
      { tradeDate: "2026-11-01", cashAmount: "1000" },
      { tradeDate: "2026-11-09", cashAmount: "950" },
    ]);
    const p1 = plan(v, { amount: 1000, plannedDate: "2026-11-10" }).plan;
    expect(plannedDeposit(v.store.read.bind(v.store), p1)?.bookedTxn).toBe(nearDate);
    const [, nearAmount] = deposits([
      { tradeDate: "2026-11-20", cashAmount: "1090" },
      { tradeDate: "2026-11-20", cashAmount: "1010" },
    ]);
    const p2 = plan(v, { amount: 1000, plannedDate: "2026-11-20" }).plan;
    expect(plannedDeposit(v.store.read.bind(v.store), p2)?.bookedTxn).toBe(nearAmount);
    const [older] = deposits([
      { tradeDate: "2026-11-28", cashAmount: "1000" },
      { tradeDate: "2026-11-28", cashAmount: "1000" },
    ]);
    const p3 = plan(v, { amount: 1000, plannedDate: "2026-11-28" }).plan;
    expect(plannedDeposit(v.store.read.bind(v.store), p3)?.bookedTxn).toBe(older);
  });

  it("books older plans first and one deposit books one plan (stored before pending)", () => {
    const { v, a, read } = setup();
    const late = plan(v, { amount: 500, plannedDate: "2026-11-12" }).plan;
    const early = plan(v, { amount: 500, plannedDate: "2026-11-11" }).plan;
    const one = v.value(importDeposit, { account: a, tradeDate: "2026-11-12", cashAmount: "500" });
    expect(one.booked).toEqual([early]); // the older planned date wins the deposit
    expect(status(v, late)).toBe("planned");
    const two = v.value(importDeposit, { account: a, tradeDate: "2026-11-12", cashAmount: "500" });
    expect(two.booked).toEqual([late]);
    expect(plannedDeposit(read, early)?.bookedTxn).toBe(one.txn);
    expect(plannedDeposit(read, late)?.bookedTxn).toBe(two.txn);
  });

  it("does nothing without open plans or brokerage accounts", () => {
    const v = vault();
    const p = plan(v, { amount: 500, plannedDate: "2026-11-11" }).plan;
    expect(status(v, p)).toBe("planned");
    const a = brokerage(v);
    const out = v.value(importDeposit, { account: a, tradeDate: "2026-11-11", cashAmount: "1" });
    expect(out.booked).toEqual([]);
  });
});

describe("cancelPlannedDeposit", () => {
  it("cancels once; a second cancel emits nothing; an unknown plan is refused", () => {
    const v = vault();
    const p = plan(v, { amount: 5, plannedDate: "2026-11-01" }).plan;
    const first = v.run(cancelPlannedDeposit, { plan: p });
    expect(first.ok && first.events.map((e) => e.type)).toEqual(["plannedDeposit.cancelled"]);
    const again = v.run(cancelPlannedDeposit, { plan: p });
    expect(again.ok && again.events).toEqual([]);
    expect(status(v, p)).toBe("cancelled");
    const none = v.run(cancelPlannedDeposit, { plan: "01JG0000000000000000000099" });
    expect(none.ok ? "ok" : none.reason).toBe("no_plan");
  });
});
