// Test kit: real in-memory stores (better-sqlite3), never a mocked store. Synthetic data only.
import {
  betterSqlite3Driver,
  builtinModules,
  createProfile,
  HybridClock,
  runCommand,
  Store,
  storeWriter,
  vaultSalt,
} from "@cashu/store";
import { DeviceStore } from "@cashu/store/device";
import Database from "better-sqlite3";
import type { LocalStores, VaultHandle } from "../local/stores.js";

export const VAULT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
export const VAULT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
const DEVICE = "cccccccccccccccccccccccccccccccc";
const BASE_WALL = 1_793_448_000_000; // 2026-10-31T12:00:00.000Z

function openVault(vault: string, profileName: string): VaultHandle {
  const store = Store.open({
    driver: betterSqlite3Driver(new Database(":memory:")),
    vault,
    salt: vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => i + vault.charCodeAt(0))),
    modules: builtinModules(),
  });
  let now = BASE_WALL;
  const clock = { now: () => (now += 1) };
  let seed = 7;
  const handle: VaultHandle = {
    store,
    writer: storeWriter(store),
    env: {
      device: DEVICE,
      clock,
      hlc: new HybridClock(DEVICE, { physical: clock }),
      lease: { isHolder: () => true },
      random: (n) =>
        Uint8Array.from({ length: n }, () => {
          seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
          return seed % 256;
        }),
    },
  };
  const created = runCommand(
    store,
    handle.writer,
    createProfile,
    { slug: "p", name: profileName },
    handle.env,
  );
  if (!created.ok) throw new Error(`test profile not created: ${created.reason}`);
  return handle;
}

/** A device store and two vaults (profiles "Ala" and "Ola"), the first one current. */
export function memoryStores(options: { current?: string | null } = {}): LocalStores & {
  close(): void;
} {
  const device = DeviceStore.open(betterSqlite3Driver(new Database(":memory:")));
  const vaults = new Map([
    [VAULT_A, openVault(VAULT_A, "Ala")],
    [VAULT_B, openVault(VAULT_B, "Ola")],
  ]);
  const current = options.current === undefined ? VAULT_A : options.current;
  if (current !== null) {
    device.driver
      .prepare("INSERT INTO device_settings (key, value) VALUES ('currentVault', ?)")
      .run(current);
  }
  return {
    device,
    vaults,
    close() {
      device.close();
      for (const v of vaults.values()) v.store.close();
    },
  };
}
