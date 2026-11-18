import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHostLock, hostRunPaths, resolveReal } from "@cashu/node-host";
import { removeTempDir } from "@cashu/node-host/testing/temp-dirs";
import { crypto } from "@cashu/sync";
import { afterEach, expect, it } from "vitest";
import { main } from "./main.js";
import { ProductionVaultSourceFactory } from "./productionVaultSource.js";

const VAULT = "a".repeat(32);
const DEVICE = "b".repeat(32);
const created: string[] = [];
afterEach(() => {
  for (const path of created.splice(0)) removeTempDir(path);
});

function candidate() {
  const dataDir = resolveReal(mkdtempSync(join(tmpdir(), "cashu-t44-provider-")));
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

/** Below vitest's 5 s test budget, so a host that never serves fails with its own stderr. */
const SERVING_WAIT_MS = 4_000;

/**
 * Waits for the "serving" line, but fails at once with the host's stderr when `main` returns or
 * throws first (a start refusal), and after a bounded wait when it does neither.
 */
async function servingOrFailure(
  serving: Promise<void>,
  running: Promise<number>,
  errors: readonly string[],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), SERVING_WAIT_MS);
  });
  try {
    const outcome = await Promise.race([serving.then(() => "serving" as const), running, timeout]);
    if (outcome === "serving") return;
    const reason = outcome === "timeout" ? "did not serve in time" : `exited with ${outcome}`;
    throw new Error(`host ${reason} before serving; stderr:\n${errors.join("\n")}`);
  } finally {
    clearTimeout(timer);
  }
}

it("ordinary run serves clean setup under a host lock and validates a supplied bundle stamp", async () => {
  const dataDir = resolveReal(mkdtempSync(join(tmpdir(), "cashu-t44-new-")));
  created.push(dataDir);
  const errors: string[] = [];
  let signal: (() => void) | undefined;
  let markServing: () => void = () => {};
  const serving = new Promise<void>((resolve) => {
    markServing = resolve;
  });
  const io = {
    env: {},
    stdout: (line: string) => {
      if (line.startsWith("cashu-host: serving")) markServing();
    },
    stderr: (line: string) => errors.push(line),
    onSignal: (handler: () => void) => {
      signal = handler;
    },
    build: "test",
  };
  const running = main(["run", "--data-dir", dataDir], io);
  await servingOrFailure(serving, running, errors);
  expect(errors).toEqual([]);
  expect(existsSync(join(dataDir, "run"))).toBe(true);
  expect(signal).toBeTypeOf("function");
  signal?.();
  expect(await running).toBe(0);
  expect(await main(["run", "--data-dir", dataDir, "--bundle", join(dataDir, "absent")], io)).toBe(
    64,
  );
  expect(errors.at(-1)).toContain("source host cannot claim a packaged bundle");
});
