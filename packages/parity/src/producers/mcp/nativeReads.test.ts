import { addDays, D, parseDateTime } from "@cashu/domain";
import { asProfileId, market, toCurrency } from "@cashu/domain/investments";
import {
  type InvestmentWriteServices,
  investmentWriteServices,
  loadAccountLabels,
  loadGuard,
  type NativeToolStore,
  type ToolContext,
  toolContext,
} from "@cashu/mcp";
import {
  betterSqlite3Driver,
  builtinModules,
  investmentsCommands as C,
  type Command,
  type CommandEnv,
  createProfile,
  HybridClock,
  runCommand,
  investmentsServices as S,
  Store,
  setModules,
  storeWriter,
  vaultSalt,
} from "@cashu/store";
import { mcpProfile } from "@cashu/store/core";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import type { CanonObject } from "../../json.ts";
import { dumps, PyFloat } from "../output.ts";
import { mergeMcpReads, nativeMcpReads } from "./nativeReads.ts";

function fixture() {
  const db = new Database(":memory:");
  const vault = "11111111111111111111111111111111";
  const device = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const store = Store.open({
    driver: betterSqlite3Driver(db),
    vault,
    salt: vaultSalt(new Uint8Array(32).fill(7)),
    modules: builtinModules(),
  });
  let nonce = 1;
  const clock = { now: () => Date.parse("2026-10-01T12:00:00Z") };
  const env: CommandEnv = {
    device,
    clock,
    hlc: new HybridClock(device, { physical: clock }),
    lease: { isHolder: () => true },
    random: (size) => new Uint8Array(size).fill(nonce++),
  };
  const run = <I, R>(command: Command<I, R>, input: unknown) => {
    const result = runCommand(store, storeWriter(store), command, input, env);
    if (!result.ok) throw new Error("synthetic command refused");
  };
  run(createProfile, { slug: "synthetic", name: "Test Household", modules: [] });
  return {
    run,
    store,
    vault,
    reads: (bind?: (context: ToolContext<NativeToolStore>) => InvestmentWriteServices) => {
      const read = store.read.bind(store);
      const profile = mcpProfile(read);
      if (profile === undefined) throw new Error("missing synthetic profile");
      let investmentWrites: InvestmentWriteServices | undefined;
      const native: NativeToolStore = {
        get investmentWrites() {
          return investmentWrites;
        },
        read,
        profile,
        prices: null,
        fxNewest: null,
        today: "2026-10-01",
        now: clock.now,
        toolInventory: [],
        run: () => {
          throw new Error("read attempted mutation");
        },
      };
      const context = toolContext({
        store: native,
        profileId: 1,
        privacy: "amounts",
        today: native.today,
        loadGuard: () => loadGuard(read, 1, new Uint8Array(32).fill(3)),
        loadAccountLabels: () => loadAccountLabels(read),
      });
      investmentWrites = bind?.(context);
      return nativeMcpReads(context, new Set(profile.modules), () => {
        throw new Error("empty fixture has no loan references");
      });
    },
    close: () => {
      store.detach();
      db.close();
    },
  };
}

it("native read answers follow the actual store and ignore changed raw oracle values/errors", async () => {
  const f = fixture();
  try {
    const disabled = await f.reads();
    expect(disabled["spending_breakdown()"]).toEqual({ error_kind: "module_disabled" });
    const calls: CanonObject = new Map(
      Object.keys(disabled).map((key) => [key, new Map([["error_kind", "oracle-placeholder"]])]),
    );
    const replay = vi.fn(() => ({ replayed: true }));
    expect(mergeMcpReads(calls, disabled, replay)).toEqual(disabled);
    expect(replay).not.toHaveBeenCalled();
    f.run(setModules, { moduleIds: ["budget"] });
    const enabled = await f.reads();
    expect(enabled["spending_breakdown()"]).not.toEqual(disabled["spending_breakdown()"]);
    expect(enabled["spending_breakdown()"]).toMatchObject({ currency: "PLN" });
    calls.set("spending_breakdown()", new Map([["forged", "not a native answer"]]));
    expect(dumps(mergeMcpReads(calls, enabled, replay))).toBe(dumps(enabled));
    expect(replay).not.toHaveBeenCalled();
    calls.set("unported()", new Map());
    expect(mergeMcpReads(calls, enabled, replay)["unported()"]).toEqual({ replayed: true });
    expect(replay).toHaveBeenCalledTimes(1);
  } finally {
    f.close();
  }
});

it("missing native coverage or a new native argument variant refuses replay", async () => {
  const f = fixture();
  try {
    const native = await f.reads();
    const calls: CanonObject = new Map(Object.keys(native).map((key) => [key, null]));
    const replay = vi.fn(() => null);
    calls.set("spending_breakdown(period=2026)", null);
    expect(() => mergeMcpReads(calls, native, replay)).toThrow("arguments are not covered");
    calls.delete("spending_breakdown(period=2026)");
    calls.delete("loans_summary()");
    expect(() => mergeMcpReads(calls, native, replay)).toThrow("coverage is incomplete");
    expect(replay).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it("actual native alert/watchlist reads ignore poisoned labelled oracle trees", async () => {
  const f = fixture();
  try {
    f.run(setModules, { moduleIds: ["investments"] });
    f.run(C.addToWatchlist, {
      target: {
        planned: {
          name: "Synthetic public listing",
          symbol: "SYNTH",
          currency: "PLN",
          assetClass: "equity",
          aliases: [{ namespace: "yahoo", value: "SYNTH.WA" }],
        },
      },
    });
    const instrument = f.store.read<{ gid: string }>(
      "SELECT gid FROM inv_instruments WHERE symbol = 'SYNTH'",
    )[0]?.gid;
    if (!instrument) throw new Error("missing synthetic native instrument");
    f.run(C.createAlert, {
      instrument,
      kind: "range_breakout",
      params: { window_days: 10, max_range_pct: 0.08, direction: "up" },
      title: "Synthetic condition",
      source: "agent",
      createdBy: "mcp",
    });
    const strategy = await S.loadStrategy(f.store, {
      read: async (name) => (name === "strategy.yaml" ? "version: 1\nbase_currency: PLN\n" : null),
      write: async () => {},
      exists: async () => true,
    });
    const prices = new market.InMemoryPriceCache();
    prices.upsertBars(
      market.marketSymbol("yahoo", "SYNTH.WA"),
      Array.from({ length: 11 }, (_, index) => ({
        date: addDays("2026-10-01", index - 10),
        close: D(index === 10 ? "105" : "100"),
        open: null,
        high: null,
        low: null,
        volume: null,
        currency: toCurrency("PLN"),
        fetchedAt: null,
      })),
      parseDateTime("2026-10-01T12:00:00Z"),
    );
    const native = await f.reads((ctx) =>
      investmentWriteServices(ctx, {
        portfolio: {
          vault: asProfileId(f.vault),
          asOf: ctx.today,
          clock: {
            today: ctx.today,
            now: parseDateTime(new Date(ctx.store.now()).toISOString()),
            timeZone: "UTC",
          },
          strategy,
          lang: "pl",
          forOwner: false,
          prices,
        },
        isHolder: () => false,
      }),
    );
    expect(native["alerts()"]).toMatchObject({
      alerts: [
        {
          title: "Synthetic condition",
          state: {
            range_low: new PyFloat(100),
            range_high: new PyFloat(100),
            range_pct: new PyFloat(0),
            window_days: 10n,
          },
        },
      ],
    });
    expect(native["watchlist()"]).toMatchObject({ items: [{ instrument: { symbol: "SYNTH" } }] });
    const calls: CanonObject = new Map(
      Object.keys(native).map((key) => [
        key,
        new Map([["error_kind", "poisoned-expected-result"]]),
      ]),
    );
    calls.set("alerts()", new Map([["redacted", new Map([["alerts", ["not native facts"]]])]]));
    calls.set("alerts(status=all)", new Map([["error_kind", "forged-oracle-error"]]));
    calls.set("watchlist()", new Map([["redacted", new Map([["items", []]])]]));
    const replay = vi.fn(() => ({ poisoned: true }));
    expect(dumps(mergeMcpReads(calls, native, replay))).toBe(dumps(native));
    expect(replay).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
