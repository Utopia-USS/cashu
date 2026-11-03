// The overview read models over a vault's view (S06b): every module's setup facts from commands and
// events, at the store level, test-for-test with the API halves of tests/test_first_steps_api.py
// (test_budget_steps, test_budget_transfers_step_counts_own_moves_without_an_iban_pair,
// test_loans_payment_step_needs_the_budget_module, test_payment_matching_by_phrase_and_iban (the state),
// test_assets_vehicle_step_is_optional, test_setup_response_carries_the_cli_prefix), tests/test_profiles.py
// (test_profiles_crud setup states, test_setup_endpoint_shape, test_setup_status_follows_the_data),
// tests/test_asset_remove.py (a removed position leaves the blank page, MB2); net worth, the summary,
// the series and the hero over a synthetic vault (the domain math is tested in @cashu/domain); the
// brokerage valuation with and without the device's price cache; live invalidation by read tables.
import { assets, core, D, type Decimal, loans } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import { market } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { addManualPosition, setDepreciation } from "../assets/commands.js";
import { importStatement } from "../budget/commands.js";
import { defineCommand, ok } from "../command.js";
import { createProfile, openAccount, recordBalance, removeAccount } from "../core/commands.js";
import { SqlPriceCache } from "../investments/local/priceCache.js";
import {
  account as brokerageOpened,
  Events,
  instrument,
  ulid,
} from "../investments/testing/kit.js";
import { addLoan, setPaymentMatching } from "../loans/commands.js";
import type { Store } from "../materialize.js";
import { runQuery, watchQuery } from "../query.js";
import { run, type TestEnv, testEnv } from "../testing/commands.js";
import { memoryDriver, openTestStore, TEST_VAULT } from "../testing/store.js";
import {
  heroView,
  legacyNavigation,
  moduleSetup,
  moduleStates,
  netWorthSeries,
  overviewQueries,
  shellSummary,
  vaultNetWorthBook,
} from "./index.js";

const PL: core.SetupContext = { cli: "cashu --profile jan", lang: "pl" };
const TODAY = "2026-10-01";
const s = (d: Decimal | null | undefined) => (d == null ? null : d.toString());

/** Test-only writers of events no store command covers yet (S24c: categories, S22b: strategy). */
const claimCategory = defineCommand({
  id: "test.claimCategory",
  input: z.object({ gid: z.string(), category: z.string() }),
  run(ctx, input) {
    ctx.emit("txn.categorySet", input.gid, { category: input.category, source: "manual_txn" });
    return ok(null);
  },
});
const manualRule = defineCommand({
  id: "test.manualRule",
  input: z.object({ merchantKey: z.string(), category: z.string() }),
  run(ctx, input) {
    ctx.emit("categoryRule.set", ctx.det("category_rules", [input.merchantKey]), {
      merchantKey: input.merchantKey,
      category: input.category,
      source: "manual",
      locked: true,
    });
    return ok(null);
  },
});

function vault(modules: string[], baseCurrency = "PLN"): { store: Store; env: TestEnv } {
  const store = openTestStore();
  const env = testEnv();
  run(store, env, createProfile, { slug: "jan", name: "Jan", baseCurrency, modules });
  return { store, env };
}

function raw(date: string, amount: string, ref: string, cp: string | null = null): RawTransaction {
  return {
    bookingDate: date,
    valueDate: null,
    amount: D(amount),
    currency: "pln",
    counterpartyName: cp,
    counterpartyIban: null,
    description: null,
    reference: ref,
    bankTransactionId: null,
    source: "csv",
    raw: { ref },
  };
}

function ingest(
  store: Store,
  env: TestEnv,
  bank: string,
  iban: string,
  rows: RawTransaction[],
  closing: { date: string; amount: string }[] = [],
): string {
  const out = run(store, env, importStatement, {
    statement: {
      bank,
      accountNumber: iban,
      accountName: `${bank} test`,
      currency: "PLN",
      transactions: rows,
      balances: [],
      closingBalances: closing.map((c) => ({ date: c.date, amount: D(c.amount) })),
    },
  });
  if (!out.ok) throw new Error(out.reason);
  return (out.value as { account: string }).account;
}

const setupOf = (store: Store, module: string, ctx = PL) => {
  const r = moduleSetup(store.read.bind(store), module, ctx);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
};
const byId = (view: core.SetupView) => new Map(view.steps.map((st) => [st.id, st]));
const txnGid = (store: Store, amount: string) =>
  (
    store.read<{ gid: string }>("SELECT gid FROM transactions WHERE amount = ?", amount)[0] as {
      gid: string;
    }
  ).gid;

describe("module setup over the view", () => {
  it("test_budget_steps", () => {
    const { store, env } = vault(["budget"]);
    const body = setupOf(store, "budget");
    expect(body.steps.map((st) => [st.id, st.status])).toEqual([
      ["statement", "on"],
      ["categories", "todo"],
      ["transfers", "todo"],
    ]);
    ingest(store, env, "mbank", "99114000000000000000000101", [
      raw("2026-09-03", "-55.00", "SKLEP NIEZNANY TEST"),
    ]);
    const after = setupOf(store, "budget");
    expect(after.state).toBe("partial");
    const steps = byId(after);
    expect(steps.get("statement")?.status).toBe("done");
    expect(steps.get("categories")?.status).toBe("on");
    expect(steps.get("transfers")?.status).toBe("done"); // one bank account: nothing to pair
    expect(steps.get("transfers")?.description).toBe("Jedno konto bankowe: nic do dopasowania.");
    // a manual merchant rule is the owner's decision: the categories step is done
    run(store, env, manualRule, { merchantKey: "sklep nieznany test", category: "groceries" });
    expect(byId(setupOf(store, "budget")).get("categories")?.status).toBe("done");
  });

  it("test_budget_transfers_step_counts_own_moves_without_an_iban_pair", () => {
    const { store, env } = vault(["budget"]);
    ingest(store, env, "mbank", "99114000000000000000000101", [
      raw("2026-09-03", "-200.00", "TOP-UP DRUGIE KONTO TEST"),
    ]);
    ingest(store, env, "pekao", "99124000000000000000000202", [
      raw("2026-09-03", "-12.00", "KAWIARNIA TEST"),
    ]);
    expect(byId(setupOf(store, "budget")).get("transfers")?.status).not.toBe("done");
    run(store, env, claimCategory, { gid: txnGid(store, "-200.00"), category: "transfer" });
    expect(byId(setupOf(store, "budget")).get("transfers")?.status).toBe("done");
  });

  it("a row categorized by hand closes the categories step", () => {
    const { store, env } = vault(["budget"]);
    ingest(store, env, "mbank", "99114000000000000000000101", [
      raw("2026-09-03", "-55.00", "SKLEP NIEZNANY TEST"),
      raw("2026-09-04", "-20.00", "INNY SKLEP TEST"),
    ]);
    expect(byId(setupOf(store, "budget")).get("categories")?.status).toBe("on");
    run(store, env, claimCategory, { gid: txnGid(store, "-55.00"), category: "groceries" });
    expect(byId(setupOf(store, "budget")).get("categories")?.status).toBe("done");
  });

  it("test_loans_payment_step_needs_the_budget_module", () => {
    const LOAN = {
      name: "Hipoteka",
      type: "mortgage",
      principal: "400000",
      annualRate: "6.5",
      termMonths: 300,
      startDate: "2025-01-05",
    };
    const alone = vault(["loans"]);
    expect(setupOf(alone.store, "loans").steps.map((st) => st.id)).toEqual(["loan"]);
    const both = vault(["budget", "loans"]);
    expect(setupOf(both.store, "loans").steps.map((st) => [st.id, st.title])).toEqual([
      ["loan", "Kredyt"],
      ["payments", "Rozpoznawanie rat"],
    ]);
    run(alone.store, alone.env, addLoan, LOAN);
    expect(setupOf(alone.store, "loans").state).toBe("ready");
    const added = run(both.store, both.env, addLoan, LOAN);
    expect(setupOf(both.store, "loans").state).toBe("partial");
    // test_payment_matching_by_phrase_and_iban: a phrase makes the module ready
    const account = added.ok ? (added.value as { account: string }).account : "";
    run(both.store, both.env, setPaymentMatching, { account, text: "bank hipoteczny test" });
    expect(setupOf(both.store, "loans").state).toBe("ready");
  });

  it("installments the categorization already recognised close the payments step", () => {
    const { store, env } = vault(["budget", "loans"]);
    run(store, env, addLoan, {
      name: "Hipoteka",
      type: "mortgage",
      principal: "400000",
      annualRate: "6.5",
      termMonths: 300,
      startDate: "2025-01-05",
    });
    ingest(store, env, "mbank", "99114000000000000000000101", [
      raw("2026-09-05", "-2700.90", "RATA KREDYTU HIPOTECZNEGO"),
    ]);
    // The loans text rule ("RATA KREDYTU") categorizes the installment as `loans` in the view.
    expect(setupOf(store, "loans").steps.map((st) => st.status)).toEqual(["done", "done"]);
    run(store, env, claimCategory, { gid: txnGid(store, "-2700.90"), category: "loans" });
    expect(setupOf(store, "loans").steps.map((st) => st.status)).toEqual(["done", "done"]);
  });

  it("test_assets_vehicle_step_is_optional; a removed position does not count (MB2)", () => {
    const { store, env } = vault(["assets"]);
    expect(setupOf(store, "assets").steps.map((st) => [st.id, st.optional, st.status])).toEqual([
      ["position", false, "on"],
      ["vehicle", true, "todo"],
    ]);
    const house = run(store, env, addManualPosition, { name: "Dom", type: "property", value: "5" });
    expect(setupOf(store, "assets").state).toBe("ready");
    expect(setupOf(store, "assets").steps.map((st) => st.status)).toEqual(["done", "todo"]);
    const car = run(store, env, addManualPosition, { name: "Auto", type: "vehicle", value: "1" });
    expect(setupOf(store, "assets").steps.map((st) => st.status)).toEqual(["done", "todo"]);
    const carGid = car.ok ? (car.value as { account: string }).account : "";
    run(store, env, setDepreciation, {
      account: carGid,
      purchasePrice: "80000",
      purchaseDate: "2025-05-01",
      annualRate: "15",
    });
    expect(setupOf(store, "assets").steps.map((st) => st.status)).toEqual(["done", "done"]);
    run(store, env, removeAccount, { account: carGid });
    run(store, env, removeAccount, {
      account: house.ok ? (house.value as { account: string }).account : "",
    });
    expect(setupOf(store, "assets").state).toBe("empty");
  });

  it("investments: account, strategy, transaction and a finished run", () => {
    const { store } = vault(["investments"]);
    expect(setupOf(store, "investments").state).toBe("empty");
    const ev = new Events();
    const acc = ulid(1);
    const inst = instrument(ev, ["xtb", "TST.PL"]);
    store.applyEnvelopes([brokerageOpened(ev, acc), ...inst.events]);
    expect(setupOf(store, "investments").steps.map((st) => st.status)).toEqual([
      "done",
      "on",
      "todo",
      "todo",
    ]);
    store.applyEnvelopes([
      ev.make("strategy.versionSaved", ulid(2), { sha256: "a".repeat(64) }),
      ev.make("invTxn.imported", ulid(3), {
        account: acc,
        instrument: inst.gid,
        source: "manual",
        dedupHash: `manual:${ulid(3)}`,
      }),
    ]);
    expect(setupOf(store, "investments").state).toBe("partial");
    store.applyEnvelopes([ev.make("ruleRun.finished", ulid(4), { status: "failed" })]);
    expect(setupOf(store, "investments").steps.at(-1)?.status).toBe("on");
    store.applyEnvelopes([ev.make("ruleRun.finished", ulid(5), { status: "partial" })]);
    expect(setupOf(store, "investments").state).toBe("ready");
  });

  it("test_setup_endpoint_shape / test_setup_response_carries_the_cli_prefix", () => {
    const { store } = vault(["budget"]);
    const body = setupOf(store, "budget");
    expect(body.cliPrefix).toBe("cashu --profile jan");
    expect(body.skill).toBe("/budget-setup");
    for (const st of body.steps) {
      for (const a of st.actions) {
        if (a.kind === "cli") expect(a.target.startsWith("cashu --profile jan ")).toBe(true);
      }
    }
    expect(moduleSetup(store.read.bind(store), "nope", PL)).toEqual({
      ok: false,
      reason: "unknown_module",
    });
  });

  it("test_profiles_crud / test_setup_status_follows_the_data: every module with its state", () => {
    const { store, env } = vault(["budget", "loans"]);
    const read = store.read.bind(store);
    expect(moduleStates(read)).toEqual([
      { id: "budget", enabled: true, setupState: "empty" },
      { id: "assets", enabled: false, setupState: "empty" },
      { id: "loans", enabled: true, setupState: "empty" },
      { id: "investments", enabled: false, setupState: "empty" },
    ]);
    run(store, env, addManualPosition, { name: "Dom", type: "property", value: "5" });
    expect(moduleStates(read).find((m) => m.id === "assets")?.setupState).toBe("ready");
  });
});

// --------------------------------------------------------------------------- net worth

interface Household {
  store: Store;
  env: TestEnv;
  checking: string;
  car: string;
  mortgage: string;
}

/** A small PLN household: salary, purchases and a monthly Netflix, a flat, a mortgage, a car, EUR. */
function household(): Household {
  const { store, env } = vault(["budget", "assets", "loans"]);
  const rows: RawTransaction[] = [];
  for (const m of ["06", "07", "08", "09"]) {
    rows.push(raw(`2026-${m}-07`, "-43.00", "NETFLIX.COM"));
    rows.push(raw(`2026-${m}-10`, "9000.00", `WYNAGRODZENIE ${m}`, "PRACODAWCA TEST"));
    rows.push(raw(`2026-${m}-12`, "-1000.00", `SKLEP MEBLOWY ${m} TEST`)); // one-off purchases
  }
  const checking = ingest(store, env, "mbank", "99114000000000000000000001", rows, [
    { date: "2026-09-30", amount: "5000.00" },
  ]);
  run(store, env, addManualPosition, {
    name: "Mieszkanie",
    type: "property",
    value: "600000",
    onDate: "2026-06-01",
  });
  const loan = run(store, env, addLoan, {
    name: "Hipoteka",
    type: "mortgage",
    principal: "400000",
    annualRate: "6.0",
    termMonths: 300,
    startDate: "2025-01-05",
    originationDate: "2024-12-10",
  });
  const car = run(store, env, addManualPosition, { name: "Auto", type: "vehicle", value: "1" });
  const carGid = car.ok ? (car.value as { account: string }).account : "";
  run(store, env, setDepreciation, {
    account: carGid,
    purchasePrice: "80000",
    purchaseDate: "2025-05-01",
    annualRate: "15",
    floor: "10000",
  });
  const eur = run(store, env, openAccount, {
    bank: "mbank",
    name: "EUR",
    type: "checking",
    currency: "EUR",
  });
  run(store, env, recordBalance, {
    account: eur.ok ? (eur.value as { account: string }).account : "",
    date: "2026-09-30",
    amount: "460.04",
    source: "csv",
  });
  return {
    store,
    env,
    checking,
    car: carGid,
    mortgage: loan.ok ? (loan.value as { account: string }).account : "",
  };
}

function todayValues(today: string): { mortgage: Decimal; car: Decimal } {
  const loan = loans.summarize(D("400000"), D("6.0"), 300, "2025-01-05", today, "2024-12-10");
  const car = assets.curveValue(
    {
      accountId: "car",
      purchasePrice: D("80000"),
      purchaseDate: "2025-05-01",
      annualRate: D("15"),
      floor: D("10000"),
    },
    today,
  );
  return { mortgage: loan.outstanding, car };
}

describe("net worth over the view", () => {
  it("the book holds every account, its balances and each module's contributor", () => {
    const h = household();
    const book = vaultNetWorthBook(h.store.read.bind(h.store), { today: TODAY, prices: null });
    expect(book.accounts.map((a) => a.type)).toEqual([
      "checking",
      "property",
      "mortgage",
      "vehicle",
      "checking",
    ]);
    expect(book.contributors).toHaveLength(4); // budget, assets, loans, investments
    const latest = core.latestBalancePerAccount(book);
    const { mortgage, car } = todayValues(TODAY);
    expect(s(latest.get(h.mortgage)?.[1])).toBe(s(mortgage)); // by the schedule
    expect(latest.get(h.car)?.[1].eq(car)).toBe(true); // by the curve, not the placeholder 1
    expect(s(latest.get(h.checking)?.[1])).toBe("5000.00");
  });

  it("test_summary (over the view)", () => {
    const h = household();
    const body = shellSummary(h.store.read.bind(h.store), { today: TODAY, prices: null });
    const { mortgage, car } = todayValues(TODAY);
    expect(Object.keys(body.networth)).toEqual(["EUR", "PLN"]);
    expect(s(body.networth.EUR)).toBe("460.04");
    const pln = D("5000.00").add(D("600000")).add(car).sub(mortgage);
    expect(body.networth.PLN?.eq(pln)).toBe(true);
    expect(body.breakdown.currency).toBe("PLN");
    expect(body.breakdown.homeEquity.eq(D("600000").sub(mortgage))).toBe(true);
    const m = body.month;
    expect(m && [m.label, s(m.income), s(m.expense), s(m.net)]).toEqual([
      "2026-09",
      "9000.00",
      "1043.00",
      "7957.00",
    ]);
    expect(body.subscriptions.count).toBe(1); // Netflix
    expect(s(body.subscriptions.monthlyTotal)).toBe("43.00");
  });

  it("the series view and the hero", () => {
    const h = household();
    const read = h.store.read.bind(h.store);
    const monthly = netWorthSeries(
      read,
      { today: TODAY, lang: "en", granularity: "monthly" },
      { prices: null },
    );
    expect(monthly.currency).toBe("PLN");
    expect(monthly.points.map((p) => p.date)).toEqual(["2026-06-01", "2026-09-30"]);
    expect(monthly.components.map((c) => [c.key, c.label, c.liability])).toEqual([
      ["money", "Money", false],
      ["property", "Property", false],
      ["vehicle", "Car", false],
      ["mortgage", "Mortgage", true],
    ]);
    const liquid = netWorthSeries(
      read,
      { today: TODAY, lang: "pl", scope: "liquid", currency: "EUR" },
      { prices: null },
    );
    expect(liquid.points.map((p) => [p.date, s(p.value)])).toEqual([["2026-09-30", "460.04"]]);

    const hero = heroView(read, { today: TODAY, prices: null });
    expect(s(hero.facts.liquid)).toBe("5000.00");
    expect(hero.facts.liabilityTypes).toEqual(["mortgage"]);
    expect(hero.norm && [hero.norm.months, s(hero.norm.expense)]).toEqual([4, "1043.00"]);
    expect(hero.monthsOfSpending?.quantize(D("0.1")).toString()).toBe("4.8");
    expect(hero.change?.since).toBe("2026-06-01");
    const last = monthly.points.at(-1)?.value ?? D("0");
    const prev = monthly.points.at(-2)?.value ?? D("0");
    expect(hero.change?.change.eq(last.sub(prev))).toBe(true);
  });

  it("brokerage accounts are valued from the device's price cache, else the last trade", () => {
    const { store } = vault(["investments"]);
    const ev = new Events();
    const acc = ulid(1);
    const inst = instrument(ev, ["yahoo", "TST.WA"], { symbol: "TST" });
    store.applyEnvelopes([
      brokerageOpened(ev, acc),
      ...inst.events,
      ev.make("invTxn.imported", ulid(3), {
        account: acc,
        instrument: inst.gid,
        source: "manual",
        dedupHash: `manual:${ulid(3)}`,
        tradeDate: "2026-09-01",
        quantity: "10",
        price: "12.5",
        grossAmount: "125",
        fee: "0",
        cashAmount: "-125",
      }),
    ]);
    const read = store.read.bind(store);
    const value = (prices: market.PriceCache | null) =>
      core.latestBalancePerAccount(vaultNetWorthBook(read, { today: TODAY, prices })).get(acc)?.[1];
    const driver = memoryDriver();
    const cache = new SqlPriceCache(driver);
    const query = overviewQueries({ prices: cache, changes: cache }).hero;
    const observed: string[] = [];
    const stop = watchQuery(
      store,
      query,
      { today: TODAY },
      {
        onValue: (view) => observed.push(view.facts.net.toString()),
        onError: (error) => {
          throw error;
        },
      },
    );
    const now = {
      date: "2026-09-30",
      hour: 18,
      minute: 0,
      second: 0,
      microsecond: 0,
      offsetSeconds: 0,
    };
    cache.upsertBars(
      market.marketSymbol("yahoo", "TST.WA"),
      [
        {
          date: "2026-09-30",
          open: null,
          high: null,
          low: null,
          close: D("20"),
          volume: null,
          currency: null,
          fetchedAt: null,
        },
      ],
      now,
    );
    expect(s(value(null))).not.toBe(s(value(cache)));
    expect(value(cache)?.gt(value(null) ?? D("0"))).toBe(true);
    expect(observed).toHaveLength(2);
    expect(observed[0]).not.toBe(observed[1]);
    const beforeRollback = [...observed];
    expect(() =>
      cache.batch(() => {
        cache.deleteBars(market.marketSymbol("yahoo", "TST.WA"), "2026-09-30", "2026-09-30");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(observed).toEqual(beforeRollback);
    stop();
    cache.deleteBars(market.marketSymbol("yahoo", "TST.WA"), "2026-09-30", "2026-09-30");
    expect(observed).toEqual(beforeRollback);
    driver.close();
  });
});

describe("queries", () => {
  it("requires explicit matching vault and slug provenance for a legacy identity", () => {
    const h = vault(["budget"]);
    expect(runQuery(h.store, legacyNavigation(), undefined).value).toBe(false);
    const observed: [string, string][] = [];
    const provided = legacyNavigation((vault, slug) => {
      observed.push([vault, slug]);
      return vault === TEST_VAULT && slug === "jan";
    });
    expect(runQuery(h.store, provided, undefined).value).toBe(true);
    expect(observed).toEqual([[TEST_VAULT, "jan"]]);
    expect(
      runQuery(
        h.store,
        legacyNavigation((_vault, slug) => slug === "another"),
        undefined,
      ).value,
    ).toBe(false);
    h.store.close();
  });
  it("the series reads the net-worth tables and re-runs when a balance is recorded", () => {
    const h = household();
    const q = overviewQueries({ prices: null });
    const args = { today: TODAY, lang: "pl" as const, granularity: "daily" };
    const { tables } = runQuery(h.store, q.netWorthSeries, args);
    for (const t of ["accounts", "balances", "loans", "depreciations", "transactions"]) {
      expect(tables.has(t)).toBe(true);
    }
    const values: number[] = [];
    const stop = watchQuery(h.store, q.netWorthSeries, args, {
      onValue: (v) => values.push(v.points.length),
      onError: (e) => {
        throw e;
      },
    });
    run(h.store, h.env, recordBalance, {
      account: h.checking,
      date: "2026-09-20",
      amount: "4000.00",
      source: "csv",
    });
    stop();
    expect(values.length).toBe(2);
    expect(values[1]).toBe((values[0] ?? 0) + 1); // a new point on 2026-09-20
  });

  it("stable ids", () => {
    const q = overviewQueries({ prices: null });
    expect(Object.values(q).map((x) => x.id)).toEqual([
      "core.netWorthSeries",
      "core.summary",
      "core.hero",
      "core.moduleSetup",
      "core.moduleStates",
    ]);
  });
});
