import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHostLock, hostRunPaths } from "@cashu/node-host";
import { crypto } from "@cashu/sync";
import { afterEach, expect, it } from "vitest";
import { main } from "./main.js";
import { ProductionVaultSourceFactory } from "./productionVaultSource.js";

const VAULT = "a".repeat(32);
const DEVICE = "b".repeat(32);
const created: string[] = [];
afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function candidate() {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "cashu-t44-provider-")));
  created.push(dataDir);
  const inventoryDir = join(dataDir, "native", "v1");
  const vaultRoot = join(dataDir, "vaults", VAULT);
  mkdirSync(inventoryDir, { recursive: true, mode: 0o700 });
  mkdirSync(vaultRoot, { recursive: true, mode: 0o700 });
  const inventoryPath = join(inventoryDir, "inventory.json");
  writeFileSync(
    inventoryPath,
    JSON.stringify({
      format: 1,
      vaults: [{ vaultId: VAULT, deviceId: DEVICE, state: "ready", enrollment: "creator" }],
    }),
    { mode: 0o600 },
  );
  const cert = Buffer.alloc(crypto.CERT_BYTES);
  cert[0] = 1;
  writeFileSync(
    join(vaultRoot, "certificates.v1.json"),
    JSON.stringify({
      format: 1,
      vaultId: VAULT,
      deviceId: DEVICE,
      certificates: [cert.toString("base64url")],
    }),
    { mode: 0o600 },
  );
  const runDir = hostRunPaths(dataDir).runDir;
  mkdirSync(runDir, { mode: 0o700 });
  return { dataDir, inventoryPath, runDir };
}

it("preflights read-only and refuses a changed locator under the held lock", async () => {
  const f = candidate();
  const factory = new ProductionVaultSourceFactory(f.dataDir);
  factory.preflight();
  const lock = acquireHostLock(hostRunPaths(f.dataDir).lockPath);
  if (!lock) throw new Error("test lock unavailable");
  try {
    writeFileSync(
      f.inventoryPath,
      JSON.stringify({
        format: 1,
        vaults: [{ vaultId: VAULT, deviceId: DEVICE, state: "ready", enrollment: "pairing" }],
      }),
    );
    await expect(factory.open(lock)).rejects.toThrow("native_inventory_changed");
  } finally {
    lock.release();
  }
});

it("requires a preflight and a live exact host lock before any OS KeyStore is opened", async () => {
  const f = candidate();
  const factory = new ProductionVaultSourceFactory(f.dataDir);
  const lock = acquireHostLock(hostRunPaths(f.dataDir).lockPath);
  if (!lock) throw new Error("test lock unavailable");
  await expect(factory.open(lock)).rejects.toThrow("native_preflight_required");
  factory.preflight();
  lock.release();
  await expect(factory.open(lock)).rejects.toThrow("native_host_lock_required");
});

it("ordinary run reports setup required before host files, and validates a supplied bundle stamp", async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "cashu-t44-new-")));
  created.push(dataDir);
  const errors: string[] = [];
  const io = {
    env: {},
    stdout: () => undefined,
    stderr: (line: string) => errors.push(line),
    onSignal: () => undefined,
    build: "test",
  };
  expect(await main(["run", "--data-dir", dataDir], io)).toBe(70);
  expect(errors.at(-1)).toBe("cashu-host: native vault setup required");
  expect(existsSync(join(dataDir, "run"))).toBe(false);
  expect(await main(["run", "--data-dir", dataDir, "--bundle", join(dataDir, "absent")], io)).toBe(
    64,
  );
  expect(errors.at(-1)).toContain("--bundle must name an existing canonical regular file");
});
