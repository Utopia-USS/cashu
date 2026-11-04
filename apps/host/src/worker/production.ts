/** Native-only production worker binding after authenticated host admission. */

import { join } from "node:path";
import { ensurePrivateDir } from "@cashu/node-host";
import { enabledModuleIds } from "@cashu/store/core";
import { type NotificationQueue, SqlPriceCache } from "@cashu/store/investments/local";
import { DailyPriceLock } from "@cashu/store/investments/services";
import type { StrategyDirectoryAuthority } from "../proposals/strategyFiles.js";
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
  /** Host-checked native-only admission now; T54 may replace it with verified migration. */
  assertAdmission(): void;
  /** Exact authenticated vault root and pinned private strategy directory, never a slug guess. */
  strategyDirectory(vault: OpenVault): StrategyDirectoryAuthority | null;
  /** Native session evaluates the authenticated devices lease with actual pull/publication evidence. */
  canFetchPublicMarket?(vault: OpenVault): boolean;
  /** Profile language comes from the admitted local setting/catalog authority. */
  language(vault: OpenVault): "pl" | "en";
  /** Host-owned queue and checked OS delivery, if the platform can actually submit. */
  readonly notifications?: NotificationQueue;
  readonly notifier?: WorkerNotifier;
  /** Bound host-only connector executor. Its final import command checks the D7 holder again. */
  readonly connectors?: ConnectorFetchPort;
  readonly budget?: BudgetSyncPort;
  /** Shared with checked proposal approval so daily evaluation and imports cannot overlap. */
  readonly dailyLock?: DailyPriceLock;
}

/**
 * One host instance owns the daily lock and the device-local cache. Bank jobs remain absent until
 * their own authenticated sessions, per-binding state and handover land.
 * Public market sources are absent too; a lease check alone is not a configured source.
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
    }
  >();
  const fileFor = (vault: OpenVault) => {
    if (vault.mode !== "native" || !host.isCurrent(vault)) return null;
    const present = files.get(vault.id);
    if (present !== undefined) return present.authority.isCurrent() ? present.port : null;
    try {
      const authority = input.strategyDirectory(vault);
      if (authority === null || authority.vault !== vault.id || !authority.isCurrent()) return null;
      const port = workerStrategyFiles(authority);
      files.set(vault.id, { authority, port });
      return port;
    } catch {
      return null;
    }
  };
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
  const prices = new SqlPriceCache(host.stores.device.driver);
  const dailyLock = input.dailyLock ?? new DailyPriceLock();
  // The switch is the last preparation step: an earlier file/cache/state failure leaves Python
  // eligible. A later ambiguous failure keeps the durable native owner and refuses a second run.
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
        ? { isHolder: () => host.isCurrent(vault) && input.canFetchPublicMarket?.(vault) === true }
        : null,
    // Public sources remain absent until the production cache/transport binding is admitted.
    offline: true,
    language: input.language,
    investments: {
      prices,
      dailyLock,
      files: fileFor,
      ...(input.notifications === undefined ? {} : { notifications: input.notifications }),
    },
    ...(input.connectors === undefined ? {} : { connectors: input.connectors }),
    ...(input.budget === undefined ? {} : { budget: input.budget }),
    ...(input.notifier === undefined ? {} : { notifier: input.notifier }),
    unavailable(vault, job) {
      if (vault.mode !== "native" || !host.isCurrent(vault)) return "native_admission_unavailable";
      const modules = enabledModuleIds(vault.store.read.bind(vault.store));
      if (job === "investments.daily") {
        if (!modules.has("investments")) return null;
        if (fileFor(vault) === null) return "file_authority_unavailable";
        return ownership.isExclusive(job, vault) ? null : "ownership_unavailable";
      }
      if (job === "connectors.fetch")
        return modules.has("investments") || modules.has("budget")
          ? input.connectors === undefined
            ? "connector_provider_unavailable"
            : input.canFetchPublicMarket?.(vault) !== true
              ? "fetch_authority_unavailable"
              : ownership.isExclusive(job, vault)
                ? null
                : "ownership_unavailable"
          : null;
      if (job === "budget.sync")
        return modules.has("budget")
          ? input.budget === undefined
            ? "bank_provider_unavailable"
            : input.canFetchPublicMarket?.(vault) !== true
              ? "fetch_authority_unavailable"
              : ownership.isExclusive(job, vault)
                ? null
                : "ownership_unavailable"
          : null;
      return modules.has("investments") &&
        (input.notifier === undefined || input.notifications === undefined)
        ? "notifier_unavailable"
        : null;
    },
  };
}
