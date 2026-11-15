// The native dev demo (devDemo.ts `native`): demo-anna provisioned through the native Create flow into
// a dir under the lab root only, its keys in the demo's own files, served on the native host where
// the sync relay switch works through the demo's own relay wiring (here over the in-memory Firebase fake,
// `demo-cashu`): the vault's recovery secret kept in the demo's key files, its hash at the relay.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createFakeFirebase } from "@cashu/sync/testing";
import { afterEach, expect, it } from "vitest";
import {
  demoRelayOptions,
  initNativeDevDemo,
  type ServedDevDemo,
  serveDevDemo,
} from "./devDemo.js";
import { demoRelayRecoverySecrets } from "./devDemoNative.js";
import { cleanup, tempDir } from "./harness.js";
import { ManualRelayTimers } from "./relayFixture.js";

let served: ServedDevDemo | undefined;
afterEach(async () => {
  await served?.stop();
  served = undefined;
  cleanup();
});

const pad = (n: number) => String(n).padStart(2, "0");
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

it("provisions demo-anna as a native vault under the lab root and serves it with the relay", async () => {
  const lab = tempDir("cashu-lab-");
  const home = tempDir("cashu-home-");
  const today = localToday();
  await expect(
    initNativeDevDemo(join(tempDir(), "demo"), { home, today, labRoot: lab }),
  ).rejects.toThrow("lab root");

  const dataDir = join(lab, "desktop-demo");
  await initNativeDevDemo(dataDir, { home, today, labRoot: lab });
  await expect(initNativeDevDemo(dataDir, { home, today, labRoot: lab })).rejects.toThrow(
    "new or empty",
  );
  expect(existsSync(join(dataDir, "native", "v1", "inventory.json"))).toBe(true);
  const keys = join(dataDir, "demo-keys");
  expect(statSync(keys).mode & 0o777).toBe(0o700);
  expect(readdirSync(keys).length).toBeGreaterThan(0);

  // The demo's own relay wiring (what `devDemo.ts serve` binds), served by the fake.
  const wiring = demoRelayOptions(dataDir, {
    CASHU_FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    CASHU_FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  });
  if (wiring.kind !== "ready") throw new Error("no demo relay");
  const fake = createFakeFirebase();
  const timers = new ManualRelayTimers();
  const relay = { ...wiring.relay, fetch: fake.fetch, retries: 0, timers, now: timers.now };
  served = await serveDevDemo(dataDir, { home, labRoot: lab, relay });
  const vaults = [...served.host.stores.vaults.values()];
  expect(vaults.map((vault) => vault.mode)).toEqual(["native"]);
  const anna = vaults[0];
  if (anna === undefined) throw new Error("no demo vault");
  const read = (sql: string) => anna.store.read<{ n: number }>(sql)[0]?.n ?? 0;
  expect(anna.store.read<{ slug: string }>("SELECT slug FROM profiles")).toEqual([
    { slug: "demo-anna" },
  ]);
  expect(read("SELECT COUNT(*) AS n FROM transactions")).toBeGreaterThan(100);
  expect(read("SELECT COUNT(*) AS n FROM loans")).toBe(1);

  // The relay switch works on the demo: the vault and this Mac's membership land at the relay.
  expect(await served.host.relay.enable(anna.id)).toEqual({
    result: { kind: "done" },
    reopen: true,
  });
  expect(fake.documents(`vaults/${anna.id}`).has(`vaults/${anna.id}`)).toBe(true);
  // The vault's recovery secret is in the demo's key files (0600) and its hash at the relay.
  const kept = await demoRelayRecoverySecrets(dataDir).get(anna.id);
  expect(kept?.current.length).toBe(32);
  expect(statSync(join(keys, `relay-recovery.${anna.id}`)).mode & 0o777).toBe(0o600);
  expect(fake.documents(`vaults/${anna.id}`).get(`vaults/${anna.id}`)?.fields.recoveryHash).toEqual(
    {
      bytesValue: createHash("sha256")
        .update(kept?.current as Uint8Array)
        .digest("base64"),
    },
  );

  await expect(serveDevDemo(dataDir, { home, labRoot: tempDir("cashu-lab-") })).rejects.toThrow(
    "lab root",
  );
});
