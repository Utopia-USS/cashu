/// <reference types="node" />
// The stores this device opens in the store process: the device store and the vaults.
//
// TRANSITIONAL(desktop-vaults): vaults come from a synthetic demo source behind the dev flag. The real
// source opens each vault the device holds with its gid salt from the keyring (KeyStore, S27) and its
// device identity from pairing (S29), and writes commands through the sync engine's local append
// (S28) instead of applying them straight to the view.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  builtinModules,
  createProfile,
  HybridClock,
  metaClockStore,
  runCommand,
  Store,
  vaultSalt,
} from "@cashu/store";
import { currentVault, DeviceStore, setCurrentVault } from "@cashu/store/device";
import { runQuery } from "@cashu/store/query";
import type { LocalStores, VaultHandle } from "@cashu/store-react/local";
import { openNodeSqlite } from "./nodeSqlite.js";

const HEX32 = /^[0-9a-f]{32}$/;

function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** A 32-hex secret-ish value kept in a file only the owner can read; created on first use. */
function hexFile(path: string, bytes: number): string {
  if (existsSync(path)) {
    const value = readFileSync(path, "utf8").trim();
    if (new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) return value;
    throw new Error(`unreadable value in ${path}`);
  }
  const value = randomBytes(bytes).toString("hex");
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return value;
}

function openVault(dir: string, vault: string, device: string): VaultHandle {
  const salt = Uint8Array.from(Buffer.from(hexFile(join(dir, `${vault}.salt`), 32), "hex"));
  const driver = openNodeSqlite(join(dir, `${vault}.db`));
  const store = Store.open({ driver, vault, salt: vaultSalt(salt), modules: builtinModules() });
  const clockStore = metaClockStore(driver, device);
  const restored = clockStore.load();
  const hlc = new HybridClock(device, restored === undefined ? {} : { restore: restored });
  return {
    store,
    writer: {
      append(envelopes) {
        clockStore.save(hlc.state);
        store.applyEnvelopes(envelopes);
      },
    },
    env: { device, clock: { now: () => Date.now() }, hlc, lease: { isHolder: () => true } },
  };
}

/** Open the device store and the demo vaults under `storeDir`; seeds one demo vault on first run. */
export function openDemoStores(storeDir: string): LocalStores & { close(): void } {
  privateDir(storeDir);
  const vaultDir = privateDir(join(storeDir, "vaults"));
  const device = hexFile(join(storeDir, "device-id"), 16);
  const deviceDriver = openNodeSqlite(join(storeDir, "device.db"));
  deviceDriver.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
  const deviceStore = DeviceStore.open(deviceDriver);

  const ids = readdirSync(vaultDir)
    .filter((f) => f.endsWith(".db"))
    .map((f) => f.slice(0, -3))
    .filter((id) => HEX32.test(id));
  const vaults = new Map<string, VaultHandle>();
  for (const id of ids) vaults.set(id, openVault(vaultDir, id, device));
  if (vaults.size === 0) {
    const id = randomBytes(16).toString("hex");
    const handle = openVault(vaultDir, id, device);
    const created = runCommand(
      handle.store,
      handle.writer,
      createProfile,
      { slug: "demo", name: "Demo" },
      handle.env,
    );
    if (!created.ok) throw new Error(`demo vault not seeded: ${created.reason}`);
    vaults.set(id, handle);
  }
  const current = runQuery(deviceStore, currentVault, undefined).value;
  const first = [...vaults.keys()].sort()[0];
  if ((current === null || !vaults.has(current)) && first !== undefined) {
    const switched = deviceStore.run(setCurrentVault, { vault: first });
    if (!switched.ok) throw new Error(`current vault not set: ${switched.reason}`);
  }
  return {
    device: deviceStore,
    vaults,
    close() {
      for (const v of vaults.values()) v.store.close();
      deviceStore.close();
    },
  };
}
