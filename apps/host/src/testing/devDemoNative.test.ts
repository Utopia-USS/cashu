// The native dev demo (devDemo.ts `native`): demo-anna provisioned through the native Create flow into
// a dir under the lab root only, its keys in the demo's own files, served on the native host where
// the sync relay switch works (here over the in-memory Firebase fake, `demo-cashu`).
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createFakeFirebase } from "@cashu/sync/testing";
import { afterEach, expect, it } from "vitest";
import { initNativeDevDemo, type ServedDevDemo, serveDevDemo } from "./devDemo.js";
import { cleanup, tempDir } from "./harness.js";
import { fakeRelayOptions, ManualRelayTimers } from "./relayFixture.js";

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

  const fake = createFakeFirebase();
  const relay = fakeRelayOptions(fake, new ManualRelayTimers());
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

  await expect(serveDevDemo(dataDir, { home, labRoot: tempDir("cashu-lab-") })).rejects.toThrow(
    "lab root",
  );
});
