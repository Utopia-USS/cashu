import { AsyncLocalStorage } from "node:async_hooks";
import type { HostLock } from "@cashu/node-host";
import {
  type BankingSecretAuthority,
  type BankingSecretStore,
  createProductionBankingSecrets,
} from "@cashu/node-host/banking-secrets";
import { refreshFetchAuthority } from "../fetchAuthority.js";
import type { HostStores, OpenVault } from "../stores.js";
import { createVaultBankingImportPort } from "./hostImport.js";
import { type BankingAuthority, EnableBankingService } from "./service.js";

export interface BankingRuntimeOptions {
  readonly dataDir: string;
  readonly lock: HostLock;
  readonly stores: HostStores;
  readonly isCurrentVault?: (vault: OpenVault) => boolean;
  readonly redirectUrl: string;
  readonly language: () => "pl" | "en";
  /** Authenticated owner UI action for the selected vault, checked after every await. */
  readonly isOwnerAction: (profileId: string) => boolean;
  /** Test seam only. Production uses the separate native banking OS Keyring service. */
  readonly makeSecrets?: (authority: BankingSecretAuthority) => BankingSecretStore;
}

/** One service per open profile keeps the pending consent and one-shot callback across requests. */
export class BankingRuntime {
  private readonly ownerScope = new AsyncLocalStorage<{
    profileId: string;
    current: () => boolean;
  }>();
  private readonly services = new Map<
    string,
    { vault: OpenVault; service: EnableBankingService }
  >();
  private readonly options: BankingRuntimeOptions;
  constructor(options: BankingRuntimeOptions) {
    this.options = options;
  }

  /** Owner authority follows one authenticated UI request across awaits; workers never inherit it. */
  withOwnerAction<T>(
    profileId: string,
    current: () => boolean,
    task: () => Promise<T>,
  ): Promise<T> {
    return this.ownerScope.run({ profileId, current }, task);
  }

  service(profileId: string): EnableBankingService | null {
    const vault = this.options.stores.vaults.get(profileId);
    if (vault?.mode !== "native" || !this.options.lock.held) return null;
    const existing = this.services.get(profileId);
    if (existing?.vault === vault) return existing.service;
    if (existing) void existing.service.close();
    const authority: BankingAuthority = {
      profileId,
      isCurrent: () =>
        this.options.lock.held &&
        this.options.stores.vaults.get(profileId) === vault &&
        vault.native.isCurrent() &&
        (this.options.isCurrentVault?.(vault) ?? true),
      isHolder: () => vault.native.canFetchPublicMarket(),
      refresh: () => refreshFetchAuthority(vault),
      isOwnerAction: () => {
        const scoped = this.ownerScope.getStore();
        return (
          this.options.isOwnerAction(profileId) ||
          (scoped?.profileId === profileId && scoped.current())
        );
      },
    };
    const secretAuthority: BankingSecretAuthority = {
      dataDir: this.options.dataDir,
      lock: this.options.lock,
      profileId,
      isCurrent: (candidate) => candidate === profileId && authority.isCurrent(),
      isOwnerAction: authority.isOwnerAction,
    };
    const secrets = (this.options.makeSecrets ?? createProductionBankingSecrets)(secretAuthority);
    const service = new EnableBankingService({
      authority,
      secrets,
      imports: createVaultBankingImportPort(vault, authority),
      redirectUrl: this.options.redirectUrl,
      language: this.options.language,
    });
    this.services.set(profileId, { vault, service });
    return service;
  }

  async close(): Promise<void> {
    const services = [...this.services.values()];
    this.services.clear();
    await Promise.all(services.map(({ service }) => service.close()));
  }
}
