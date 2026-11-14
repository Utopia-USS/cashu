/// <reference types="node" />
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import {
  builtinModules,
  createProfile,
  HybridClock,
  runCommand,
  Store,
  storeWriter,
  vaultSalt,
} from "@cashu/store";
import { profileIdentity } from "@cashu/store/overview";
import { runQuery } from "@cashu/store/query";
import { expect, it } from "vitest";
import { resolveProfileRoute } from "./profileRoute.js";
import { ProfileRouteSync } from "./profileRouteSync.js";

it("retains A while the earlier B selection is pending and corrects the observed B", async () => {
  const sync = new ProfileRouteSync();
  const writes: string[] = [];
  const completions: (() => void)[] = [];
  const write = (vault: string) => {
    writes.push(vault);
    return new Promise<void>((resolve) => completions.push(resolve));
  };
  sync.update("B", "A", write);
  sync.update("A", "A", write);
  expect(writes).toEqual(["B"]);
  sync.update("A", "B", write);
  completions.shift()?.();
  await Promise.resolve();
  expect(writes).toEqual(["B", "A"]);
  sync.update("A", "A", write);
  completions.shift()?.();
  await Promise.resolve();
  sync.update("A", "A", write);
  expect(writes).toEqual(["B", "A"]);
});

it("refuses duplicate real-store slugs and resolves only an explicit matching open vault", () => {
  const vaults = ["a".repeat(32), "b".repeat(32)];
  const held = new Set(vaults);
  const stores: Store[] = [];
  try {
    const profiles = vaults.map((vault, index) => {
      const store = Store.open({
        driver: openNodeSqlite(":memory:"),
        vault,
        salt: vaultSalt(new Uint8Array(32).fill(index + 1)),
        modules: builtinModules(),
      });
      stores.push(store);
      const clock = { now: () => Date.parse("2026-11-03T12:00:00Z") };
      const device = "c".repeat(32);
      const result = runCommand(
        store,
        storeWriter(store),
        createProfile,
        { slug: "same", name: `Synthetic ${index}` },
        {
          device,
          clock,
          hlc: new HybridClock(device, { physical: clock }),
          lease: { isHolder: () => held.has(vault) },
        },
      );
      expect(result.ok).toBe(true);
      const identity = runQuery(store, profileIdentity, undefined).value;
      if (identity === null) throw new Error("synthetic profile absent");
      return { ...identity, vault };
    });
    expect(resolveProfileRoute(profiles, "same")).toEqual({ kind: "ambiguous" });
    expect(resolveProfileRoute([...profiles].reverse(), "same")).toEqual({ kind: "ambiguous" });
    expect(resolveProfileRoute(profiles, "same", vaults[1])).toEqual({
      kind: "ready",
      profile: profiles[1],
    });
    expect(resolveProfileRoute(profiles, "missing", vaults[1])).toEqual({ kind: "unavailable" });
    expect(resolveProfileRoute(profiles, "same", "d".repeat(32))).toEqual({ kind: "unavailable" });
    expect(resolveProfileRoute(profiles.slice(0, 1), "same")).toEqual({
      kind: "ready",
      profile: profiles[0],
    });
  } finally {
    held.clear();
    for (const store of stores) store.close();
  }
});
