// S55l live data, sync source: a second device's batch, folded into a host vault by a real sync
// engine pass, reaches an open `ui` subscription as a pushed value, with no read by the client. Two
// paths: a synthetic vault (the engine pass through the vault queue, the value pushed by the apply),
// and the production native vault (`host.syncVault`), whose store refuses reads while it syncs: the
// channel drops the re-runs of that window and re-subscribes once the sync settled. The desktop e2e
// (apps/desktop/e2e/desktop-specs/105-live-data.spec.ts) covers the other write sources on screen;
// synthetic e2e vaults have no sync engine, so this source is proven here at the host level. Runs in
// the default test tier (vitest.tiers.ts excludes only *.exhaustive.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { builtinModules, metaClockStore, mintUlid, Store, vaultSalt } from "@cashu/store";
import { createOwnLogCodec, createSyncEngine, crypto, type Transport } from "@cashu/sync";
import {
  insecureTestCodec,
  insecureTestGate,
  ManualClock,
  MemoryClockStore,
  MemorySink,
  MemoryTransport,
} from "@cashu/sync/testing";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalHost } from "./host.js";
import { memoryLog } from "./log.js";
import { storeFiles } from "./stores.js";
import { cleanup, storeClient, tempDir, testHostOptions } from "./testing/harness.js";
import { type NativeVaultFixture, nativeVaultFixture } from "./testing/nativeVaultFixture.js";

const fixtures: NativeVaultFixture[] = [];
afterEach(() => {
  cleanup();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

const HERE = "daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const THERE = "dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function engine(
  vault: string,
  device: string,
  remote: Transport,
  store: Store,
  clock: ManualClock,
) {
  return createSyncEngine({
    vault,
    device,
    local: new MemoryTransport(),
    remotes: [remote],
    codec: insecureTestCodec(),
    gate: insecureTestGate(),
    sink: store.sink(),
    clockStore: metaClockStore(store.driver, device),
    physicalClock: clock,
  });
}

/** The other device's own store of the same vault (its salt from the vault's salt file). */
function otherDevice(dataDir: string, vault: string): Store {
  const salt = readFileSync(join(storeFiles(dataDir).vaultDir, `${vault}.salt`), "utf8").trim();
  return Store.open({
    driver: openNodeSqlite(":memory:"),
    vault,
    salt: vaultSalt(Uint8Array.from(Buffer.from(salt, "hex"))),
    modules: builtinModules(),
  });
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("live data from sync", () => {
  it("pushes a remote device's folded batch to an open ui subscription", async () => {
    const dir = tempDir();
    const host = await startLocalHost(testHostOptions(dir));
    const client = await storeClient(dir);
    try {
      const vault = client.vaults[0];
      const opened = vault === undefined ? undefined : host.stores.vaults.get(vault);
      if (vault === undefined || opened === undefined) throw new Error("synthetic vault absent");
      const profile = await client.subscribe("core.profile", vault);
      const name = (value: unknown) => (value as { name?: unknown } | null)?.name;
      expect(name(profile.first)).toEqual(expect.any(String));
      expect(name(profile.first)).not.toBe("Renamed on another device");

      const remote = new MemoryTransport();
      const clock = new ManualClock(Date.now());
      const here = await engine(vault, HERE, remote, opened.store, clock);
      const other = otherDevice(dir, vault);
      const there = await engine(vault, THERE, remote, other, clock);
      await there.write([
        {
          t: "profile.renamed",
          v: 1,
          i: "01JZZZZZZZZZZZZZZZZZZZZZZ1",
          g: vault,
          a: new Date(clock.now()).toISOString(),
          d: { name: "Renamed on another device" },
        },
      ]);
      await there.sync();
      // The host's own pass, serialized with UI commands like the native session's sync.
      await opened.queue.run(() => here.sync());
      other.close();

      await until(() => profile.values.length > 1);
      expect(profile.values.map(name)).toEqual([name(profile.first), "Renamed on another device"]);
    } finally {
      client.close();
      await host.stop();
    }
  });

  it("drops re-runs while a native vault syncs and re-pushes once the sync settled", async () => {
    const fixture = await nativeVaultFixture({ modules: ["budget"], pairPeer: true });
    fixtures.push(fixture);
    const { provider } = fixture.vaultSource;
    const vault = fixture.vaultId;
    const peer = fixture.peerDevice;
    const peerIdentity = fixture.peerIdentity;
    if (peer === undefined || peerIdentity === undefined) throw new Error("synthetic peer absent");
    const ring = await crypto.loadKeyring(provider.keyStore, provider.sodium, vault);
    if (!ring) throw new Error("synthetic keyring absent");
    const remote = new MemoryTransport();
    const there = await createSyncEngine({
      vault,
      device: peer,
      local: new MemoryTransport(),
      remotes: [remote],
      codec: createOwnLogCodec({ sodium: provider.sodium, ring, signer: peerIdentity }),
      gate: insecureTestGate(),
      sink: new MemorySink(),
      clockStore: new MemoryClockStore(),
    });
    const log = memoryLog();
    const host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      log,
      vaultSource: {
        kind: "native",
        provider: { ...provider, remoteTransports: () => [remote] },
      },
    });
    const client = await storeClient(fixture.dataDir);
    try {
      const opened = host.stores.vaults.get(vault);
      if (opened?.native === undefined) throw new Error("native vault not open");
      const native = opened.native;
      const profile = await client.subscribe("core.profile", vault);
      const name = (value: unknown) =>
        value instanceof Error ? value : (value as { name?: unknown } | null)?.name;
      expect(name(profile.first)).toBe("Synthetic");

      await there.write([
        {
          t: "profile.renamed",
          v: 1,
          i: mintUlid(Date.now()),
          g: vault,
          a: new Date().toISOString(),
          d: { name: "Renamed on another device" },
        },
      ]);
      await there.sync();
      await there.close();
      ring.wipe();

      // Hold the host's pull, so the sync stays in flight while the test looks.
      const pull = remote.read.bind(remote);
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      remote.read = async (...args) => {
        await held;
        return pull(...args);
      };
      let atSettle: number | undefined;
      const stopWatching = native.onSyncSettled(() => {
        atSettle ??= profile.values.length;
      });
      const pending = host.syncVault(vault);
      await until(() => native.isSyncing());
      expect(() => opened.store.read("SELECT name FROM profiles")).toThrow(
        "native_session_unavailable",
      );
      release();
      const result = await pending;
      stopWatching();
      expect(result.rolledBack).toBe(false);
      expect(result.applied).toBeGreaterThan(0);
      expect(native.isSyncing()).toBe(false);
      // The fold re-ran the query inside the sync: nothing reached the client then (no value, no
      // error); the re-subscribe after the settle pushed the folded name once.
      expect(atSettle).toBe(1);
      await until(() => profile.values.length > 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(profile.values.map(name)).toEqual(["Synthetic", "Renamed on another device"]);
      expect(log.lines.filter((line) => line.includes("store.query.failed"))).toEqual([]);
    } finally {
      client.close();
      await host.stop();
    }
  });
});
