// The desktop dev demo (devDemo.ts): `init` writes two synthetic native vaults and the price cache;
// `serve` hosts them so the shell sees both profiles, anna's budget, asset, loan and valued positions.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { decodeValue, type JsonValue } from "@cashu/host-protocol/store";
import { afterEach, expect, it } from "vitest";
import { initDevDemo, type ServedDevDemo, serveDevDemo } from "./devDemo.js";
import { cleanup, type StoreClient, storeClient, tempDir } from "./harness.js";

let served: ServedDevDemo | undefined;
let client: StoreClient | undefined;
afterEach(async () => {
  client?.close();
  await served?.stop();
  client = undefined;
  served = undefined;
  cleanup();
});

const pad = (n: number) => String(n).padStart(2, "0");
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

it("creates and serves the two synthetic demo profiles", async () => {
  const dataDir = join(tempDir(), "demo");
  const home = tempDir("cashu-home-");
  const today = localToday();
  await initDevDemo(dataDir, { home, today });
  await expect(initDevDemo(dataDir, { home, today })).rejects.toThrow("new or empty");

  served = await serveDevDemo(dataDir, { home });
  client = await storeClient(dataDir);
  expect(client.vaults).toHaveLength(2);
  const slugs = new Map<string, string>();
  for (const vault of client.vaults) {
    const profile = decodeValue(
      (await client.subscribe("core.profileIdentity", vault)).first as JsonValue,
    );
    slugs.set((profile as { slug: string }).slug, vault);
  }
  expect([...slugs.keys()].sort()).toEqual(["demo-anna", "demo-piotr"]);
  const anna = slugs.get("demo-anna") as string;
  const piotr = slugs.get("demo-piotr") as string;
  const current = await client.subscribe("device.currentVault", "device");
  expect(current.first).toBe(anna);

  const read = (vault: string, sql: string) =>
    served?.host.stores.vaults.get(vault)?.store.read<{ n: number }>(sql)[0]?.n ?? 0;
  const modules = (vault: string) =>
    served?.host.stores.vaults
      .get(vault)
      ?.store.read<{ module_id: string }>(
        "SELECT module_id FROM profile_modules WHERE enabled = 1 ORDER BY module_id",
      )
      .map((row) => row.module_id);
  expect(modules(anna)).toEqual(["assets", "budget", "investments", "loans"]);
  expect(modules(piotr)).toEqual(["budget"]);
  for (const vault of [anna, piotr]) {
    expect(read(vault, "SELECT COUNT(*) AS n FROM transactions")).toBeGreaterThan(100);
    // Both legs of every checking -> savings transfer are matched as internal.
    const legs = read(
      vault,
      "SELECT COUNT(*) AS n FROM transactions WHERE reference = 'PRZELEW NA OSZCZEDNOSCI'",
    );
    expect(legs).toBeGreaterThanOrEqual(12);
    expect(
      read(vault, "SELECT COUNT(*) AS n FROM transactions WHERE is_internal_transfer = 1"),
    ).toBe(legs);
  }
  expect(read(anna, "SELECT COUNT(*) AS n FROM accounts WHERE type = 'property'")).toBe(1);
  expect(read(anna, "SELECT COUNT(*) AS n FROM loans")).toBe(1);
  expect(read(piotr, "SELECT COUNT(*) AS n FROM loans")).toBe(0);

  const portfolio = decodeValue(
    (
      await client.subscribe("investments.desktop.portfolio", anna, {
        today,
        now: new Date().toISOString(),
        timeZone: "Europe/Warsaw",
        lang: "en",
      })
    ).first as JsonValue,
  ) as {
    status: string;
    positions?: {
      positions: { value: unknown; is_stale: boolean; missing_fx_currency: string | null }[];
    };
  };
  expect(portfolio.status).toBe("ready");
  const positions = portfolio.positions?.positions ?? [];
  expect(positions).toHaveLength(3);
  for (const position of positions) {
    expect(position.value).not.toBeNull();
    expect(position.is_stale).toBe(false);
    expect(position.missing_fx_currency).toBeNull();
  }
  expect(readdirSync(dataDir)).toContain("dev-demo-market.db");
});

it("refuses to serve a dir it did not create", async () => {
  const dataDir = tempDir();
  await expect(serveDevDemo(dataDir, { home: tempDir("cashu-home-") })).rejects.toThrow(
    "not a dev demo data dir",
  );
});
