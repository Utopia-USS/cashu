import { loadAccountLabels, loadGuard, type NativeToolStore, toolContext } from "@cashu/mcp";
import {
  betterSqlite3Driver,
  builtinModules,
  type Command,
  type CommandEnv,
  createProfile,
  HybridClock,
  runCommand,
  Store,
  setModules,
  storeWriter,
  vaultSalt,
} from "@cashu/store";
import { mcpProfile } from "@cashu/store/core";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import type { CanonObject } from "../../json.ts";
import { dumps } from "../output.ts";
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
    reads: () => {
      const read = store.read.bind(store);
      const profile = mcpProfile(read);
      if (profile === undefined) throw new Error("missing synthetic profile");
      const native: NativeToolStore = {
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

it("native read answers follow the actual store and ignore changed raw oracle values/errors", () => {
  const f = fixture();
  try {
    const disabled = f.reads();
    expect(disabled["spending_breakdown()"]).toEqual({ error_kind: "module_disabled" });
    const calls: CanonObject = new Map(
      Object.keys(disabled).map((key) => [key, new Map([["error_kind", "oracle-placeholder"]])]),
    );
    const replay = vi.fn(() => ({ replayed: true }));
    expect(mergeMcpReads(calls, disabled, replay)).toEqual(disabled);
    expect(replay).not.toHaveBeenCalled();
    f.run(setModules, { moduleIds: ["budget"] });
    const enabled = f.reads();
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

it("missing native coverage or a new native argument variant refuses replay", () => {
  const f = fixture();
  try {
    const native = f.reads();
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
