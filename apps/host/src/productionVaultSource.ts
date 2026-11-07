import { StartupFailureError } from "@cashu/host-protocol/startup-failure";
import { type HostLock, hostRunPaths } from "@cashu/node-host";
import { createProductionKeyStore } from "@cashu/node-host/keyring";
import { crypto } from "@cashu/sync";
import { readExistingNativeInventory } from "./nativeInventory.js";
import type { NativeVaultSource } from "./nativeVault.js";

/** Two checks around acquisition of the real host lock. Neither check creates enrollment. */
export class ProductionVaultSourceFactory {
  readonly #dataDir: string;
  readonly #createKeyStore: typeof createProductionKeyStore;
  #preflightFingerprint: string | undefined;

  constructor(
    dataDir: string,
    /** Test seam only. The ordinary host entry always uses the constrained OS factory. */
    createKeyStore: typeof createProductionKeyStore = createProductionKeyStore,
  ) {
    this.#dataDir = dataDir;
    this.#createKeyStore = createKeyStore;
  }

  /** The host's Create and opener must use the same constrained OS KeyStore provider. */
  creationKeyStoreFactory(): typeof createProductionKeyStore {
    return this.#createKeyStore;
  }

  preflight(): void {
    this.#preflightFingerprint = readExistingNativeInventory(this.#dataDir).fingerprint;
  }

  async open(lock: HostLock): Promise<NativeVaultSource> {
    if (!lock.held || lock.path !== hostRunPaths(this.#dataDir).lockPath)
      throw new StartupFailureError("unknown", "native_host_lock_required");
    if (this.#preflightFingerprint === undefined)
      throw new StartupFailureError("native_inventory_unavailable", "native_preflight_required");
    const found = readExistingNativeInventory(this.#dataDir);
    if (found.fingerprint !== this.#preflightFingerprint)
      throw new StartupFailureError("native_inventory_unavailable", "native_inventory_changed");
    const sodium = await crypto.loadNodeSodium();
    if (!lock.held) throw new StartupFailureError("unknown", "native_host_lock_required");
    const names = new Set<string>();
    for (const entry of found.entries) {
      names.add(crypto.keyringName(entry.vaultId));
      names.add(crypto.deviceIdentityName(entry.deviceId));
    }
    const keyStore = this.#createKeyStore({
      dataDir: this.#dataDir,
      purpose: "open",
      authorizedNames: names,
      sodium,
    });
    const byVault = found.certificates;
    const dataDir = this.#dataDir;
    return Object.freeze({
      inventory: found.entries,
      keyStore,
      sodium,
      async bootstrapCertificates(entry) {
        const exact = found.entries.find((candidate) => candidate.vaultId === entry.vaultId);
        if (
          !exact ||
          exact.deviceId !== entry.deviceId ||
          exact.vaultRoot !== entry.vaultRoot ||
          exact.enrollment !== entry.enrollment ||
          !lock.held
        )
          throw new StartupFailureError("native_inventory_unavailable", "native_inventory_changed");
        const current = readExistingNativeInventory(dataDir);
        if (current.fingerprint !== found.fingerprint)
          throw new StartupFailureError("native_inventory_unavailable", "native_inventory_changed");
        const certs = byVault.get(entry.vaultId);
        if (!certs)
          throw new StartupFailureError("native_inventory_unavailable", "native_inventory_invalid");
        return certs.map((certificate) => certificate.slice());
      },
    } satisfies NativeVaultSource);
  }
}
