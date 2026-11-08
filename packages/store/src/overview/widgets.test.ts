import { D, parseDateTime } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { addManualPosition } from "../assets/commands.js";
import { setVehicle } from "../assets/vehicle.js";
import { addCashExpense, deleteCashTransaction } from "../budget/commands.js";
import { createProfile, openAccount, recordBalance } from "../core/commands.js";
import { createPlannedDeposit } from "../investments/commands/planned.js";
import { HOUSEHOLD_NOW, household } from "../investments/testing/household.js";
import { runQuery } from "../query.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { overviewQueries } from "./index.js";
import { cashWallet, overviewCashWallet } from "./widgets.js";

const TODAY = "2026-10-31";

describe("native Overview accounts and cash wallet", () => {
  it("values the visible accounts per currency and follows native cash add/delete with opaque rows", () => {
    const store = openTestStore();
    const env = testEnv();
    expect(
      run(store, env, createProfile, {
        slug: "synthetic",
        name: "Synthetic",
        baseCurrency: "PLN",
        modules: ["budget"],
      }).ok,
    ).toBe(true);
    const eur = run(store, env, openAccount, {
      bank: "mbank",
      name: "Synthetic EUR",
      type: "checking",
      currency: "EUR",
    });
    if (!eur.ok) throw new Error("synthetic account refused");
    expect(
      run(store, env, recordBalance, {
        account: eur.value.account,
        date: "2026-10-30",
        amount: "123.45",
        source: "csv",
      }).ok,
    ).toBe(true);
    const first = run(store, env, addCashExpense, {
      amount: "5.25",
      title: "Synthetic first",
      category: "groceries",
      onDate: TODAY,
    });
    const second = run(store, env, addCashExpense, {
      amount: "3.50",
      title: "Synthetic second",
      category: "groceries",
      onDate: TODAY,
    });
    if (!first.ok || !second.ok) throw new Error("synthetic cash refused");

    const query = overviewQueries({ prices: null }).accounts;
    const rows = runQuery(store, query, { today: TODAY }).value;
    expect(rows.find((row) => row.gid === eur.value.account)).toMatchObject({
      currency: "EUR",
      amount: D("123.45"),
    });
    expect(rows.find((row) => row.type === "cash")).toMatchObject({
      currency: "PLN",
      amount: D("-8.75"),
    });
    const wallet = runQuery(store, overviewCashWallet, {}).value;
    expect(wallet.balance).toEqual(D("-8.75"));
    expect(wallet.withdrawals).toEqual(D("0"));
    expect(wallet.expenses).toEqual(D("8.75"));
    expect(wallet.transactions.map((row) => row.gid)).toEqual([second.value.txn, first.value.txn]);
    expect(run(store, env, deleteCashTransaction, { txn: second.value.txn }).ok).toBe(true);
    expect(cashWallet(store.read.bind(store)).balance).toEqual(D("-5.25"));
    expect(cashWallet(store.read.bind(store)).transactions.map((row) => row.gid)).toEqual([
      first.value.txn,
    ]);
    const budget = runQuery(store, overviewQueries({ prices: null }).budgetWidgets, {
      today: "2026-11-01",
    }).value;
    expect(budget.month).toMatchObject({
      label: "2026-10",
      complete: true,
      currency: "PLN",
      spending: D("5.25"),
      surplus: D("-5.25"),
    });
    expect(budget.strategyUnavailable).toBe(false);
  });

  it("never reads another vault's separate view", () => {
    const empty = openTestStore();
    expect(
      runQuery(empty, overviewQueries({ prices: null }).accounts, { today: TODAY }).value,
    ).toEqual([]);
    expect(runQuery(empty, overviewCashWallet, {}).value.exists).toBe(false);
    expect(
      runQuery(empty, overviewQueries({ prices: null }).budgetWidgets, { today: TODAY }).value
        .month,
    ).toBeNull();
  });

  it("shows manual assets with the same valued rows as the hero and only this vault's notes", () => {
    const store = openTestStore();
    const env = testEnv();
    expect(
      run(store, env, createProfile, {
        slug: "asset-demo",
        name: "Synthetic",
        baseCurrency: "PLN",
        modules: ["assets"],
      }).ok,
    ).toBe(true);
    const property = run(store, env, addManualPosition, {
      name: "Synthetic property",
      type: "property",
      value: "350000.00",
      currency: "PLN",
      onDate: "2026-10-30",
      note: "Synthetic note",
    });
    const vehicle = run(store, env, setVehicle, {
      name: "Synthetic vehicle",
      purchasePrice: "20000.00",
      purchaseDate: "2026-01-01",
      annualRate: "15",
      floor: "3000",
      currency: "EUR",
      asOf: TODAY,
    });
    if (!property.ok || !vehicle.ok) throw new Error("synthetic asset refused");
    const rows = runQuery(store, overviewQueries({ prices: null }).assets, { today: TODAY }).value;
    expect(rows.find((row) => row.gid === property.value.account)).toMatchObject({
      type: "property",
      amount: D("350000.00"),
      note: "Synthetic note",
    });
    expect(rows.find((row) => row.gid === vehicle.value.account)).toMatchObject({
      kind: "vehicle",
      type: "vehicle",
      amount: D(vehicle.value.value),
      depreciation: { purchasePrice: D("20000.00"), annualRate: D("15") },
    });
    expect(rows.every((row) => row.bank === "manual")).toBe(true);
    const legacyManual = run(store, env, addManualPosition, {
      name: "Synthetic legacy vehicle type",
      type: "vehicle",
      value: "42",
      onDate: TODAY,
    });
    if (!legacyManual.ok) throw new Error("synthetic manual asset refused");
    const legacy = runQuery(store, overviewQueries({ prices: null }).assets, {
      today: TODAY,
    }).value.find((row) => row.gid === legacyManual.value.account);
    expect(legacy).toMatchObject({ kind: "manual", type: "vehicle", amount: D("42") });
    const ordered = runQuery(store, overviewQueries({ prices: null }).assets, {
      today: TODAY,
    }).value;
    expect(ordered.map((row) => row.gid)).toEqual([
      property.value.account,
      vehicle.value.account,
      legacyManual.value.account,
    ]);
  });

  it("computes investment widgets from an explicitly bound real strategy and market cache", () => {
    const fixture = household();
    const store = openTestStore();
    store.applyEnvelopes(fixture.events);
    const sources = {
      investmentRequest: () => ({
        vault: fixture.vault,
        asOf: TODAY,
        prices: fixture.prices,
        strategy: fixture.strategy,
        lang: "en" as const,
        forOwner: true,
        clock: { now: parseDateTime(HOUSEHOLD_NOW), today: TODAY, timeZone: "Europe/Warsaw" },
        newestRateDate: null,
      }),
    };
    const query = overviewQueries({ prices: fixture.prices }, sources).investments;
    const result = runQuery(store, query, { today: TODAY, lang: "en" }).value;
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("synthetic investment context refused");
    expect(result.currency).toBe("PLN");
    expect(result.value.gt(D("0"))).toBe(true);
    expect(result.yearPoints.length).toBeGreaterThan(0);
    const guarded = overviewQueries(
      { prices: fixture.prices },
      {
        investmentRequest: () => ({
          ...sources.investmentRequest(),
          vault: "foreign" as typeof fixture.vault,
        }),
      },
    );
    expect(runQuery(store, guarded.investments, { today: TODAY, lang: "en" }).value).toEqual({
      status: "unavailable",
    });
  });

  it("lists the open and the booked planned deposits, as Python GET /planned-deposits", () => {
    // Oracle (the retired Python app on its demo copy, planned.create + planned_deposits default statuses): a plan next
    // month stays `planned`; a plan made after its deposit (amount within 10 %) is booked at once and
    // carries booked_at. A cancelled plan is not listed.
    const fixture = household();
    const store = openTestStore();
    store.applyEnvelopes(fixture.events);
    const env = testEnv();
    const plan = (amount: string, plannedDate: string) => {
      const out = run(store, env, createPlannedDeposit, { amount, plannedDate });
      if (!out.ok) throw new Error(`synthetic plan refused: ${out.reason}`);
    };
    plan("2500", "2026-11-10");
    plan("105", "2026-09-30");
    const sources = {
      investmentRequest: () => ({
        vault: fixture.vault,
        asOf: TODAY,
        prices: fixture.prices,
        strategy: fixture.strategy,
        lang: "en" as const,
        forOwner: true,
        clock: { now: parseDateTime(HOUSEHOLD_NOW), today: TODAY, timeZone: "Europe/Warsaw" },
        newestRateDate: null,
      }),
    };
    const result = runQuery(
      store,
      overviewQueries({ prices: fixture.prices }, sources).investments,
      {
        today: TODAY,
        lang: "en",
      },
    ).value;
    if (result.status !== "available") throw new Error("synthetic investment context refused");
    expect(
      result.plans.map((p) => ({
        amount: p.amount.toString(),
        plannedDate: p.plannedDate,
        status: p.status,
        booked: p.bookedAt !== null,
      })),
    ).toEqual([
      { amount: "2500", plannedDate: "2026-11-10", status: "planned", booked: false },
      { amount: "105", plannedDate: "2026-09-30", status: "booked", booked: true },
    ]);
  });
});
