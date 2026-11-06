// S55l live data, sync source: a second device's batch, folded into a host vault by a real sync
// engine pass (through the vault queue, as the native session does), reaches an open `ui`
// subscription as a pushed value, with no re-subscribe and no read by the client. The desktop e2e
// (apps/desktop/e2e/desktop-specs/105-live-data.spec.ts) covers the other write sources on screen;
// synthetic e2e vaults have no sync engine, so this source is proven here at the host level.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { builtinModules, metaClockStore, Store, vaultSalt } from "@cashu/store";
import { createSyncEngine, MemoryTransport, type Transport } from "@cashu/sync";
import { insecureTestCodec, insecureTestGate, ManualClock } from "@cashu/sync/testing";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalHost } from "./host.js";
import { storeFiles } from "./stores.js";
import { cleanup, storeClient, tempDir, testHostOptions } from "./testing/harness.js";

afterEach(cleanup);

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
});
