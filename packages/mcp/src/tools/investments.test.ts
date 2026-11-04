import { investments as inv, parseDateTime } from "@cashu/domain";
import { investmentsServices } from "@cashu/store";
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
