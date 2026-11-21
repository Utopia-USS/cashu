import { parseDateTime } from "@cashu/domain";
import * as inv from "@cashu/domain/investments";
import { investmentsCommands as C, type Command, investmentsServices } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import type { LabelledTree } from "../privacy/labels.js";
import { pyDumps } from "../privacy/pyJson.js";
import { leakCheck, Redactor } from "../privacy/redactor.js";
import { investmentReads } from "../providers/investmentReads.js";
import { type ToolContext, validateArguments } from "../registry.js";
import { encodeEntityRef } from "../runtime/refs.js";
import type { NativeToolStore } from "../runtime/types.js";
import { nativeFixture } from "../testing/native.js";
import { investmentTools } from "./investments.js";
import { profileInstrument } from "./investmentsJournal.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
const fixture = () => {
  const f = nativeFixture();
  fixtures.push(f);
  return f;
};
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
async function context(
  f: ReturnType<typeof fixture>,
  privacy = "strict",
): Promise<ToolContext<NativeToolStore>> {
  const ctx = f.context(privacy);
  const strategy = await investmentsServices.loadStrategy(f.store, {
    read: async () => null,
    write: async () => {},
    exists: async () => false,
  });
  const clock = {
    today: ctx.today,
    now: parseDateTime(new Date(ctx.store.now()).toISOString()),
    timeZone: "UTC",
  };
  const reviewClock = {
    ...clock,
    localDate: (at: unknown) => String(at).slice(0, 10),
    midnight: (day: string) => parseDateTime(`${day}T00:00:00Z`),
  };
  const requests = {
    portfolio: {
      vault: inv.asProfileId(f.vault),
      asOf: ctx.today,
      clock,
      strategy,
      lang: "en" as const,
      forOwner: false,
      prices: f.prices,
      newestRateDate: null,
    },
    review: { clock: reviewClock, lang: "en" as const, config: strategy.config, calendar: null },
    strategy: {
      state: strategy,
      files: { yaml: "synthetic.yaml", md: "synthetic.md", yamlExists: false, mdExists: false },
      profileBase: inv.toCurrency("PLN"),
      lang: "en" as const,
    },
  };
  return { ...ctx, store: { ...ctx.store, investments: investmentReads(ctx, requests) } };
}
function spec(name: string) {
  const found = investmentTools().find((t) => t.name === name);
  if (found === undefined) throw new Error("missing tool");
  return found;
}
function redact(ctx: ToolContext<NativeToolStore>, tree: LabelledTree) {
  const redactor = new Redactor({ privacy: ctx.privacy, guard: ctx.guard }),
    data = redactor.apply(tree);
  leakCheck(data, { strict: ctx.strict, isins: redactor.isins, nonMoney: redactor.nonMoney });
  return JSON.parse(pyDumps(data));
}
/** For the synchronous read handlers; an async handler must go through `callAsync`. */
function call(ctx: ToolContext<NativeToolStore>, name: string, args: Record<string, unknown> = {}) {
  const tool = spec(name),
    tree = tool.handler(ctx, validateArguments(tool, args));
  if (tree instanceof Promise) throw new Error(`${name} is async: use callAsync`);
  return redact(ctx, tree);
}
async function callAsync(
  ctx: ToolContext<NativeToolStore>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const tool = spec(name);
  return redact(ctx, await tool.handler(ctx, validateArguments(tool, args)));
}
it("offers exactly the implemented read bodies with original descriptors and refusals", () => {
  expect(investmentTools().map((t) => t.name)).toEqual([
    "portfolio_overview",
    "positions",
    "signals",
    "review_context",
    "strategy_status",
    "history_metrics",
    "theses",
    "inspect_export",
    "validate_import",
  ]);
  expect(investmentTools().every((t) => !t.write)).toBe(true);
  const spec = investmentTools().find((t) => t.name === "validate_import");
  if (spec === undefined) throw new Error("missing validator");
  expect(() => validateArguments(spec, { path: "file.csv", converter: "script.py" })).toThrow(
    "MCP calls never make the app run code",
  );
});
it.each(["strict", "amounts"])(
  "uses genuine native T21 services and full privacy for empty vault in %s",
  async (privacy) => {
    const f = fixture(),
      ctx = await context(f, privacy);
    expect(call(ctx, "positions")).toMatchObject({ positions: [], cash: [], base_currency: "PLN" });
    expect(call(ctx, "portfolio_overview")).toMatchObject({
      accounts: [],
      signals: { action: 0, info: 0, new: 0 },
    });
    expect(call(ctx, "review_context")).toMatchObject({
      calendar: { stale: true, events: [] },
      review: { due: true },
    });
    expect(call(ctx, "strategy_status")).toMatchObject({ state: "missing", facts: null });
    expect(call(ctx, "signals")).toEqual({ status: "open", signals: [] });
    expect(call(ctx, "theses")).toEqual({ theses: [] });
    expect(f.committed()).toBe(0);
  },
);
it.each(["strict", "amounts"])(
  "exposes an opaque brokerage account reference in %s",
  async (privacy) => {
    const f = fixture();
    const account = f.run(C.addBrokerageAccount, { name: "Synthetic broker", broker: "dif" });
    if (!account.ok) throw new Error(account.reason);
    const ctx = await context(f, privacy);
    expect(call(ctx, "portfolio_overview").accounts).toMatchObject([
      { account_id: encodeEntityRef("account", account.value.account), broker: "dif" },
    ]);
  },
);
it("refuses unowned opaque instrument references, wrong kinds, numeric source ids and unavailable view authority", () => {
  const f = fixture(),
    ctx = f.context();
  expect(() =>
    profileInstrument(ctx, encodeEntityRef("instrument", "01ARZ3NDEKTSV4RRFFQ69G5FAV")),
  ).toThrow("no such instrument");
  expect(() =>
    profileInstrument(ctx, encodeEntityRef("signal", "01ARZ3NDEKTSV4RRFFQ69G5FAV")),
  ).toThrow("no such instrument");
  expect(() => profileInstrument(ctx, "1")).toThrow("no such instrument");
  expect(() => call(ctx, "positions")).toThrow("native investment reads are unavailable");
});
it("refuses script paths before reading and does not borrow general file authority for profile-only mapping", async () => {
  const f = fixture(),
    ctx = f.context();
  let calls = 0;
  const store = {
    ...ctx.store,
    readInvestmentImportFile: () => {
      calls++;
      return { name: "invalid.csv", bytes: new TextEncoder().encode("bad") };
    },
  };
  await expect(callAsync({ ...ctx, store }, "validate_import", { path: "x.py" })).rejects.toThrow(
    "path is a script",
  );
  expect(calls).toBe(0);
  await expect(
    callAsync({ ...ctx, store }, "validate_import", { path: "x.csv", mapping: "x.yaml" }),
  ).rejects.toThrow("local mapping files are unavailable");
  expect(await callAsync({ ...ctx, store }, "validate_import", { path: "x.csv" })).toMatchObject({
    ok: false,
    errors: 1,
    transactions: 0,
  });
});
function run<I, V>(f: ReturnType<typeof fixture>, command: Command<I, V>, input: unknown): V {
  const result = f.run(command, input);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
it("lists theses of the current portfolio and marks a closed position's thesis", async () => {
  const f = fixture(),
    account = run(f, C.addBrokerageAccount, { name: "Synthetic broker", broker: "dif" }).account;
  run(f, C.addManualTransaction, {
    account,
    type: "deposit",
    tradeDate: "2026-01-01",
    cashAmount: "3000",
    currency: "PLN",
  });
  const add = (symbol: string, isin: string, o: { sold?: boolean; watched?: boolean } = {}) => {
    const added = run(f, C.addToWatchlist, {
      target: {
        planned: {
          symbol,
          isin,
          name: `Synthetic ${symbol}`,
          currency: "PLN",
          assetClass: "equity",
          mic: "XWAR",
        },
      },
    });
    run(f, C.addManualTransaction, {
      account,
      instrument: added.instrument,
      type: "buy",
      tradeDate: "2026-01-02",
      quantity: "5",
      price: "100",
      cashAmount: "-500",
      currency: "PLN",
    });
    if (o.sold)
      run(f, C.addManualTransaction, {
        account,
        instrument: added.instrument,
        type: "sell",
        tradeDate: "2026-01-05",
        quantity: "5",
        price: "100",
        cashAmount: "500",
        currency: "PLN",
      });
    if (!o.watched) run(f, C.removeFromWatchlist, { item: added.item });
    run(f, C.createThesis, {
      instrument: added.instrument,
      entryType: "trend",
      thesis: `Teza testowa ${symbol}.`,
    });
  };
  add("HLD", "PLHLD0000014");
  add("WCH", "PLWCH0000013", { sold: true, watched: true });
  add("CLS", "PLCLS0000017", { sold: true });
  const ctx = await context(f),
    current = call(ctx, "theses").theses as Record<string, unknown>[];
  expect(current.map((row) => [row.symbol, row.position]).sort()).toEqual([
    ["HLD", "held"],
    ["WCH", "watched"],
  ]);
  const all = call(ctx, "theses", { include_closed: true }).theses as Record<string, unknown>[];
  expect(all.find((row) => row.symbol === "CLS")).toMatchObject({ position: "closed" });
  expect(call(ctx, "theses", { instrument: "CLS" }).theses).toMatchObject([
    { symbol: "CLS", position: "closed" },
  ]);
});
