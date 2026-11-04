import { D, parseDateTime, toCurrency } from "@cashu/domain";
import { asInstrumentId, type market, priceBar } from "@cashu/domain/investments";
import { investmentsCommands, openAccount, recordBalance, setModules } from "@cashu/store";
import { lastReview } from "@cashu/store/investments/queries";
import { afterEach, expect, it } from "vitest";
import { pyDumps } from "../privacy/pyJson.js";
import { leakCheck, Redactor } from "../privacy/redactor.js";
import type { ToolContext } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";
import { nativeFixture } from "../testing/native.js";
import { coreTools } from "./core.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
const fixture = () => {
  const f = nativeFixture();
  fixtures.push(f);
  return f;
};
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function call(ctx: ToolContext<NativeToolStore>, name: string, args: Record<string, unknown> = {}) {
  const spec = coreTools().find((t) => t.name === name);
  if (!spec) throw new Error("missing synthetic tool");
  const redactor = new Redactor({ privacy: ctx.privacy, guard: ctx.guard });
  const output = redactor.apply(
    spec.handler(ctx, args) as import("../privacy/labels.js").LabelledTree,
  );
  leakCheck(output, { strict: ctx.strict, isins: redactor.isins, nonMoney: redactor.nonMoney });
  return JSON.parse(pyDumps(output));
}
async function callAsync(
  ctx: ToolContext<NativeToolStore>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const spec = coreTools().find((t) => t.name === name);
  if (!spec) throw new Error("missing synthetic tool");
  const redactor = new Redactor({ privacy: ctx.privacy, guard: ctx.guard });
  const output = redactor.apply(await spec.handler(ctx, args));
  leakCheck(output, { strict: ctx.strict, isins: redactor.isins, nonMoney: redactor.nonMoney });
  return JSON.parse(pyDumps(output));
}
function account(
  f: ReturnType<typeof nativeFixture>,
  currency = "PLN",
  type = "checking",
  name = "Private account",
) {
  const result = f.run(openAccount, {
    bank: type === "brokerage" ? "xtb" : "mbank",
    name,
    type,
    currency,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value.account;
}
it("returns registry-ordered Polish setup and the complete injected inventory, updating module state", () => {
  const f = fixture();
  const ctx = f.context("strict");
  const store = {
    ...ctx.store,
    toolInventory: [
      ...ctx.store.toolInventory,
      { name: "shared_tool", module: "loans", also: ["investments"] },
    ],
  };
  const result = call({ ...ctx, store }, "profile_overview");
  expect(result.modules.map((m: { id: string }) => m.id)).toEqual([
    "budget",
    "assets",
    "loans",
    "investments",
  ]);
  expect(result.modules[0]).toMatchObject({ name: "Budżet domowy", enabled: true });
  expect(result.modules[3].tools).toContain("shared_tool");
  expect(result.core_tools).toEqual([
    "mark_review_done",
    "networth_breakdown",
    "profile_overview",
    "setup_status",
  ]);
  expect(result.freshness.budget).toEqual({ transactions_newest: null, transactions: 0 });
  expect(f.run(setModules, { moduleIds: ["budget"] }).ok).toBe(true);
  const changed = call(f.context(), "profile_overview");
  expect(changed.modules[3]).toMatchObject({ enabled: false, setup_state: null, tools: [] });
  expect(changed.freshness).not.toHaveProperty("investments");
});
it("returns neutral copyable commands and the first pending setup step even for a disabled module", () => {
  const f = fixture();
  const result = call(f.context(), "setup_status", { module: "loans" });
  expect(result.enabled).toBe(false);
  expect(result.next_action.step).toBe(
    result.steps.find((s: { status: string }) => s.status === "on").id,
  );
  expect(JSON.stringify(result)).not.toContain("synthetic");
  expect(JSON.stringify(result)).toContain("--profile <profile>");
  expect(() => call(f.context(), "setup_status", { module: "unknown" })).toThrow(
    "unknown module; known: budget, assets, loans, investments",
  );
});
it("computes per-currency signed buckets, 365-day change and private account presentation", () => {
  const f = fixture();
  const cash = account(f);
  const credit = account(f, "PLN", "credit", "Private credit");
  const usd = account(f, "USD");
  for (const [a, date, amount] of [
    [cash, "2025-09-30", "100"],
    [cash, "2026-10-31", "200"],
    [credit, "2026-10-31", "-50"],
    [usd, "2026-10-31", "7"],
  ])
    expect(f.run(recordBalance, { account: a, date, amount }).ok).toBe(true);
  const amounts = call(f.context(), "networth_breakdown");
  expect(amounts.currencies.map((c: { currency: string }) => c.currency)).toEqual(["PLN", "USD"]);
  expect(amounts.currencies[0]).toMatchObject({
    assets: 200,
    liabilities: 50,
    net: 150,
    change_12m_pct: 0.5,
  });
  expect(amounts.currencies[0].accounts[0].account).toBe("mBank checking 1");
  expect(JSON.stringify(amounts)).not.toContain("Private");
  const strict = call(f.context("strict"), "networth_breakdown");
  expect(strict.currencies[0]).not.toHaveProperty("assets");
  expect(strict.currencies[0].accounts[0]).not.toHaveProperty("balance");
  expect(strict.currencies[0].accounts[0].share_of_assets).toBe(1);
});
it("handles an account with no balance and zero-asset shares", () => {
  const f = fixture();
  account(f);
  const result = call(f.context(), "networth_breakdown").currencies[0];
  expect(result).toMatchObject({
    assets: 0,
    liabilities: 0,
    net: 0,
    asset_liability_ratio: null,
    change_12m_pct: null,
  });
  expect(result.accounts[0]).toMatchObject({ balance: null, as_of: null, share_of_assets: null });
});
it("values brokerage history using actual cached prices and reports cache freshness", () => {
  const f = fixture();
  const brokerage = account(f, "PLN", "brokerage");
  const made = f.run(investmentsCommands.createInstrument, {
    name: "Public fund",
    currency: "PLN",
    assetClass: "equity",
    symbol: "SYNTH",
    aliases: [{ namespace: "yahoo", value: "SYNTH" }],
  });
  if (!made.ok) throw new Error(made.reason);
  expect(f.run(investmentsCommands.classifyInstrument, { instrument: made.value.gid }).ok).toBe(
    true,
  );
  const bought = f.run(investmentsCommands.addManualTransaction, {
    account: brokerage,
    type: "buy",
    tradeDate: "2026-10-01",
    instrument: made.value.gid,
    quantity: "2",
    price: "10",
  });
  if (!bought.ok) throw new Error(bought.reason);
  expect(call(f.context(), "networth_breakdown").currencies[0].net).toBe(20);
  f.prices.upsertBars(
    { provider: "yahoo", symbol: "SYNTH" },
    [
      {
        date: "2026-10-31",
        close: D("30"),
        open: null,
        high: null,
        low: null,
        volume: null,
        currency: toCurrency("PLN"),
        fetchedAt: null,
      },
    ],
    parseDateTime("2026-11-01T10:00:00Z"),
  );
  const ctx = f.context();
  const store = { ...ctx.store, fxNewest: "2026-10-30" };
  const result = call({ ...ctx, store }, "networth_breakdown");
  expect(result.currencies[0].net).toBe(60);
  expect(call({ ...ctx, store }, "profile_overview").freshness.investments).toMatchObject({
    transactions: 1,
    prices_newest: "2026-10-31",
    fx_newest: "2026-10-30",
    strategy: "missing",
    last_run: null,
  });
});
it("reports an alias-less imported price only for the current vault", () => {
  const f = fixture();
  const made = f.run(investmentsCommands.createInstrument, {
    name: "Synthetic unquoted",
    currency: "PLN",
    assetClass: "equity",
  });
  if (!made.ok) throw new Error(made.reason);
  expect(f.run(investmentsCommands.classifyInstrument, { instrument: made.value.gid }).ok).toBe(
    true,
  );
  const brokerage = account(f, "PLN", "brokerage");
  const bought = f.run(investmentsCommands.addManualTransaction, {
    account: brokerage,
    type: "buy",
    tradeDate: "2026-10-01",
    instrument: made.value.gid,
    quantity: "1",
    price: "5",
  });
  if (!bought.ok) throw new Error(bought.reason);
  const row = priceBar({
    instrumentId: asInstrumentId(made.value.gid),
    date: "2026-10-31",
    close: D("10"),
    source: "broker",
    currency: toCurrency("PLN"),
  });
  const marketData: market.CachedMarketData = {
    series: (id) => (id === made.value.gid ? [row] : []),
    fxRates: () => [],
    lastBarDate: (id) => (id === made.value.gid ? row.date : null),
    firstBarDate: (id) => (id === made.value.gid ? row.date : null),
    hasBarsFetchedBefore: () => false,
    lastRateDate: () => null,
    firstRateDate: () => null,
    hasRateOnOrBefore: () => false,
  };
  const ctx = f.context();
  const store = { ...ctx.store, marketData };
  expect(call({ ...ctx, store }, "profile_overview").freshness.investments.prices_newest).toBe(
    "2026-10-31",
  );
  expect(call({ ...ctx, store }, "networth_breakdown").currencies[0].net).toBe(10);
});
it("records a review with typed global reference, real counts and the owner agenda", async () => {
  const f = fixture();
  const opened = f.run(investmentsCommands.applySignalActions, {
    run: null,
    actions: [
      {
        type: "create",
        createdAt: "2026-10-31T10:00:00Z",
        candidate: {
          ruleId: "synthetic",
          kind: "test",
          dedupKey: "synthetic",
          severity: "action",
          message: "synthetic signal",
        },
      },
    ],
  });
  if (!opened.ok) throw new Error(opened.reason);
  expect(
    f.run(investmentsCommands.decideSignal, {
      signal: opened.value.created[0],
      action: "held",
      reason: "synthetic",
    }).ok,
  ).toBe(true);
  const result = await callAsync(f.context("strict"), "mark_review_done", {
    notes: "Owner note",
    agenda: [{ card: "world", note: "  Follow up  " }],
  });
  expect(result.review_id).toMatch(/^review:u[a-p]{52}$/);
  expect(result.done_at).toBe("2026-11-01T12:00:00.123000+00:00");
  expect(result.stats).toEqual({
    open_signals: 1,
    action_signals: 1,
    decisions_since_last_review: 1,
  });
  const stored = lastReview(f.store.read.bind(f.store), "investments");
  expect(stored?.stats).toMatchObject({
    source: "mcp",
    deck: { agenda: [{ card: "world", title: null, note: "Follow up" }] },
  });
  expect(stored?.notes).toBe("Owner note");
  expect(f.committed()).toBe(1);
  f.advance(1);
  expect((await callAsync(f.context(), "mark_review_done")).stats.decisions_since_last_review).toBe(
    0,
  );
});
it("refuses a review of a disabled module before running a command", async () => {
  const f = fixture();
  await expect(callAsync(f.context(), "mark_review_done", { module: "assets" })).rejects.toThrow(
    "module assets is not enabled",
  );
  expect(f.committed()).toBe(0);
});

it("reports actual newest balance, strategy version and rule-run counts", () => {
  const f = fixture();
  const a = account(f);
  expect(f.run(recordBalance, { account: a, date: "2026-10-30", amount: "5" }).ok).toBe(true);
  const strategy = f.seed("strategy.versionSaved", {
    yamlText: "cele: []",
    mdText: null,
    sha256: "a".repeat(64),
    state: "partial",
    issues: [],
  });
  f.seed("ruleRun.finished", {
    trigger: "worker",
    asOf: "2026-10-31",
    status: "partial",
    strategyVersion: strategy,
    stats: {},
    errors: ["synthetic error"],
    report: { new: [strategy], escalated: [strategy, strategy] },
    startedAt: "2026-10-31T10:00:00Z",
    finishedAt: "2026-10-31T10:01:00Z",
  });
  expect(call(f.context(), "profile_overview").freshness).toMatchObject({
    balances_newest: "2026-10-30",
    investments: {
      strategy: "partial",
      last_run: {
        status: "partial",
        trigger: "worker",
        as_of: "2026-10-31",
        finished_at: "2026-10-31T10:01:00+00:00",
        new_signals: 1,
        escalated_signals: 2,
        errors: 1,
      },
    },
  });
});
