/** Native-only production worker binding after authenticated host admission. */

import { join } from "node:path";
import { ensurePrivateDir } from "@cashu/node-host";
import { enabledModuleIds } from "@cashu/store/core";
import { type NotificationQueue, SqlPriceCache } from "@cashu/store/investments/local";
import {
  DailyPriceLock,
  type DailySources,
  type StrategyFileSyncPorts,
} from "@cashu/store/investments/services";
import {
  type StrategyDirectoryAuthority,
  strategyPublicationPorts,
} from "../proposals/strategyFiles.js";
import type { OpenVault } from "../stores.js";
import type {
  BudgetSyncPort,
  ConnectorFetchPort,
  WorkerBindings,
  WorkerHostContext,
  WorkerNotifier,
} from "./contracts.js";
import { admittedWorkerOwnership } from "./ownership.js";
import { privateWorkerState } from "./state.js";
import { workerStrategyFiles } from "./strategyFiles.js";

export interface ProductionWorkerInput {
  readonly dataDir: string;
  /** Host-checked native-only admission; legacy source directories use a separate import target. */
  assertAdmission(): void;
  /** Exact authenticated vault root and pinned private strategy directory, never a slug guess. */
  strategyDirectory(vault: OpenVault): StrategyDirectoryAuthority | null;
  /** Native session evaluates the authenticated devices lease with actual pull/publication evidence. */
  canFetchPublicMarket?(vault: OpenVault): boolean;
  /**
   * Obtains fresh pull evidence for a stale fetch leader before a network job (production:
   * `refreshFetchAuthority` in ../fetchAuthority.ts). Without it the job needs another sync source.
   */
  refreshFetchAuthority?(vault: OpenVault): Promise<boolean>;
  /**
   * Status only: why the vault may not fetch now, null when it may or would after that refresh
   * (production: `fetchAuthorityIssue` in ../fetchAuthority.ts).
   */
  fetchAuthorityIssue?(vault: OpenVault): string | null;
  /** Profile language comes from the admitted local setting/catalog authority. */
  language(vault: OpenVault): "pl" | "en";
  /** Host-owned queue and checked OS delivery, if the platform can actually submit. */
  readonly notifications?: NotificationQueue;
  readonly notifier?: WorkerNotifier;
  /** Bound host-only connector executor. Its final import command checks the D7 holder again. */
  readonly connectors?: ConnectorFetchPort;
  readonly budget?: BudgetSyncPort;
  /** One host-owned device cache and checked public sources shared with views and MCP. */
  readonly market?: {
    readonly prices: SqlPriceCache;
    sources(vaultIds: readonly string[]): DailySources;
    marketForVault(
      read: import("@cashu/store/query").Read,
      vault: string,
    ): import("@cashu/store/investments/screen-sources").MarketInput;
  };
  /** Shared with checked proposal approval so daily evaluation and imports cannot overlap. */
  readonly dailyLock?: DailyPriceLock;
}

/**
 * One host instance owns the daily lock and the device-local cache. Bank, connector and market
 * jobs require their checked providers and current native authority.
 */
export function createProductionWorkerBindings(
  host: WorkerHostContext,
  input: ProductionWorkerInput,
): WorkerBindings {
  input.assertAdmission();
  if (!host.jobsEnabled() || host.stores.vaults.size === 0)
    throw new Error("worker_native_admission_unavailable");
  const vaults = [...host.stores.vaults.values()];
  if (vaults.some((vault) => vault.mode !== "native"))
    throw new Error("worker_native_admission_unavailable");
  const currentVaults = vaults.filter((vault) => host.isCurrent(vault));
  if (currentVaults.length === 0) throw new Error("worker_native_admission_unavailable");
  const files = new Map<
    string,
    {
      authority: StrategyDirectoryAuthority;
      port: ReturnType<typeof workerStrategyFiles>;
      sync: StrategyFileSyncPorts;
    }
  >();
  const portsFor = (vault: OpenVault) => {
    if (vault.mode !== "native" || !host.isCurrent(vault)) return null;
    const present = files.get(vault.id);
    if (present !== undefined) return present.authority.isCurrent() ? present : null;
    try {
      const authority = input.strategyDirectory(vault);
      if (authority === null || authority.vault !== vault.id || !authority.isCurrent()) return null;
      const port = workerStrategyFiles(authority);
      // The daily run brings the files to the recorded version (strategyFileSync.ts) through the
      // same pinned directory and private journal as approvals.
      const sync = strategyPublicationPorts(authority);
      const entry = { authority, port, sync };
      files.set(vault.id, entry);
      return entry;
    } catch {
      return null;
    }
  };
  const fileFor = (vault: OpenVault) => portsFor(vault)?.port ?? null;
  // Claim file-capable vaults and native connector vaults. A budget-only connector does not depend
  // on a strategy directory; an unbound worker still leaves missing file authority untouched.
  const eligible = currentVaults.filter(
    (vault) =>
      fileFor(vault) !== null || input.connectors !== undefined || input.budget !== undefined,
  );
  const workerDir = join(input.dataDir, "worker");
  ensurePrivateDir(workerDir);
  const state = privateWorkerState(workerDir, () => {
    try {
      input.assertAdmission();
      return host.jobsEnabled() && vaults.some((vault) => host.isCurrent(vault));
    } catch {
      return false;
    }
  });
  const prices = input.market?.prices ?? new SqlPriceCache(host.stores.device.driver);
  const dailyLock = input.dailyLock ?? new DailyPriceLock();
  // Publish durable native job ownership only after file, cache and state preparation succeeds.
  const ownership = admittedWorkerOwnership({
    dataDir: input.dataDir,
    vaults: eligible,
    assertAdmission: input.assertAdmission,
  });
  return {
    state,
    ownership,
    authority: (vault) =>
      vault.mode === "native"
        ? { isHolder: () => host.isCurrent(vault) && vault.native.canRunSideEffects() }
        : null,
    fetchAuthority: (vault, job) =>
      (job === "investments.daily" ||
        (job === "connectors.fetch" && input.connectors !== undefined) ||
        (job === "budget.sync" && input.budget !== undefined)) &&
      vault.mode === "native" &&
      input.canFetchPublicMarket !== undefined
        ? {
            isHolder: () => host.isCurrent(vault) && input.canFetchPublicMarket?.(vault) === true,
            // Not gated on `host.isCurrent`: that is false while a pass runs, and the session's
            // refresh waits for such a pass and checks its own currentness.
            refresh: async () => {
              if (host.stores.vaults.get(vault.id) === vault)
                await input.refreshFetchAuthority?.(vault);
            },
          }
        : null,
    offline: input.market === undefined,
    language: input.language,
    investments: {
      prices,
      macroBars: (series) => prices.macroBars(series),
      ...(input.market === undefined ? {} : { marketForVault: input.market.marketForVault }),
      ...(input.market === undefined
        ? {}
        : {
            macroStore: {
              apply: (
                report: Parameters<SqlPriceCache["applyMacroReport"]>[0],
                now: Parameters<SqlPriceCache["applyMacroReport"]>[1],
              ) => prices.applyMacroReport(report, now),
            },
          }),
      ...(input.market === undefined ? {} : { sources: input.market.sources }),
      dailyLock,
      files: fileFor,
      strategySync: (vault: OpenVault) => portsFor(vault)?.sync ?? null,
      ...(input.notifications === undefined ? {} : { notifications: input.notifications }),
    },
    ...(input.connectors === undefined ? {} : { connectors: input.connectors }),
    ...(input.budget === undefined ? {} : { budget: input.budget }),
    ...(input.notifier === undefined ? {} : { notifier: input.notifier }),
    unavailable(vault, job) {
      if (vault.mode !== "native" || !host.isCurrent(vault)) return "native_admission_unavailable";
      // The real reason a fetch job cannot run (a stale pull alone is none: the job refreshes it
      // before its authority check, unless a back-off after a failed pull holds).
      const fetchIssue = (): string | null =>
        input.canFetchPublicMarket?.(vault) === true
          ? null
          : (input.fetchAuthorityIssue?.(vault) ?? "fetch_authority_unavailable");
      const modules = enabledModuleIds(vault.store.read.bind(vault.store));
      if (job === "investments.daily") {
        if (!modules.has("investments")) return null;
        if (fileFor(vault) === null) return "file_authority_unavailable";
        if (!ownership.isExclusive(job, vault)) return "ownership_unavailable";
        return input.market !== undefined && input.canFetchPublicMarket !== undefined
          ? fetchIssue()
          : null;
      }
      if (job === "connectors.fetch")
        return modules.has("investments") || modules.has("budget")
          ? input.connectors === undefined
            ? "connector_provider_unavailable"
            : (fetchIssue() ?? (ownership.isExclusive(job, vault) ? null : "ownership_unavailable"))
          : null;
      if (job === "budget.sync")
        return modules.has("budget")
          ? input.budget === undefined
            ? "bank_provider_unavailable"
            : (fetchIssue() ?? (ownership.isExclusive(job, vault) ? null : "ownership_unavailable"))
          : null;
      return modules.has("investments") &&
        (input.notifier === undefined || input.notifications === undefined)
        ? "notifier_unavailable"
        : null;
    },
  };
}
