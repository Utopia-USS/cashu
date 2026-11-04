// The command tree the `cli` role runs in the host. A native host serves the native product
// commands (no genesis, no skills) with its strategy files, worker, workspace and the owner-action
// ports for connectors and banking; a synthetic harness may inject its own isolated commands.
import type { RunningHost } from "@cashu/node-host";
import { mcpProfile } from "@cashu/store/core";
import type { PerformanceService } from "@cashu/store/investments/performance";
import type { InvestmentScreenSources } from "@cashu/store/investments/screen";
import { runBankingOwnerAction } from "../banking/ownerAction.js";
import type { BankingRuntime } from "../banking/runtime.js";
import type { BankingCliDeps } from "../cli/banking.js";
import type { ConnectorCliDeps } from "../cli/connectors/index.js";
import { portedCommands } from "../cli/ported.js";
import type { PortedCommand } from "../cli/tree.js";
import type { ConnectorCatalog } from "../connectors/catalog.js";
import type { createNativeCreationService } from "../nativeCreation.js";
import { readExistingNativeInventory } from "../nativeInventory.js";
import { nativeStrategyCliFiles } from "../nativeStrategyDocuments.js";
import { type HostRuntime, shippedConnectorsSource } from "../runtime.js";
import type { HostStores } from "../stores.js";
import type { StrategyScreenCapability } from "../strategiesScreen.js";
import type { HostWorker } from "../worker/service.js";
import type { MarketAuthorities } from "./market.js";
import type { LocalHostOptions, VaultBinder } from "./options.js";

/** Native product commands only: the lab genesis import and the skills copy stay out of the host. */
const isNativeProductCommand = (command: PortedCommand) =>
  command.name !== "genesis" && command.name !== "skills";

export function hostedCommands(input: {
  readonly options: LocalHostOptions;
  readonly nativeMode: boolean;
  readonly runtime: HostRuntime;
  readonly now: () => number;
  readonly server: RunningHost;
  readonly stores: HostStores;
  readonly creation: ReturnType<typeof createNativeCreationService> | undefined;
  readonly market: MarketAuthorities;
  readonly investmentSources: InvestmentScreenSources;
  readonly performance: PerformanceService;
  readonly strategies: VaultBinder<StrategyScreenCapability> | undefined;
  readonly worker: HostWorker;
  readonly bundleReplaced: () => boolean;
  /** Restarts the host after a profile was created (its vaults open on the next start). */
  readonly onCreationReady: () => void;
}): readonly PortedCommand[] {
  const { options, runtime, now, stores, market } = input;
  const common = {
    runtime,
    now,
    nativeStores: stores,
    prices: market.prices,
    marketData: market.marketData,
    creation: input.creation,
    onCreationReady: input.onCreationReady,
    investmentSources: input.investmentSources,
    performance: input.performance,
  };
  // Production exposes native product commands; synthetic harnesses may inject isolated test commands.
  if (!input.nativeMode)
    return (
      options.ported ??
      portedCommands({
        ...common,
        classifier: options.budgetClassifiers?.local,
        cloudClassifier: options.budgetClassifiers?.cloud,
      })
    );
  const catalog = options.connectorCatalog?.();
  return portedCommands({
    ...common,
    investmentSearch: (vault) => market.investmentAsync?.(vault.id)?.search,
    strategyFiles: (vault, slug) => {
      const capability = input.strategies?.bind(vault.id);
      if (
        vault.mode !== "native" ||
        !vault.native.isCurrent() ||
        mcpProfile(vault.store.read.bind(vault.store))?.slug !== slug
      )
        return null;
      if (capability?.vault === vault.id && capability.isCurrent()) return capability.files;
      const authority = vault.native.strategyDirectoryAuthority();
      return authority === null ? null : nativeStrategyCliFiles(authority);
    },
    classifier: options.budgetClassifiers?.local,
    cloudClassifier: options.budgetClassifiers?.cloud,
    workspace: options.workspace,
    worker: () => input.worker,
    ...(catalog === undefined
      ? {}
      : { connectors: connectorOwnerPort({ ...input, catalog, runtime }) }),
    ...(options.banking === undefined
      ? {}
      : { banking: bankingOwnerPort({ ...input, banking: options.banking }) }),
  }).filter(isNativeProductCommand);
}

/** Owner-authenticated connector controls: valid while this host and the same catalog are current. */
function connectorOwnerPort(input: {
  readonly options: LocalHostOptions;
  readonly catalog: ConnectorCatalog;
  readonly runtime: HostRuntime;
  readonly server: RunningHost;
  readonly stores: HostStores;
  readonly bundleReplaced: () => boolean;
}): ConnectorCliDeps {
  const { options, catalog, server, stores, bundleReplaced } = input;
  const authorityCurrent = (signal: AbortSignal) => () =>
    !signal.aborted &&
    !bundleReplaced() &&
    server.lock.held &&
    options.connectorCatalog?.() === catalog;
  return {
    catalog,
    shippedCatalog: shippedConnectorsSource(input.runtime),
    isCurrent: () =>
      !bundleReplaced() && server.lock.held && options.connectorCatalog?.() === catalog,
    async disable(id, signal) {
      const current = authorityCurrent(signal);
      if (!current()) throw new Error("connector_authority_lost");
      catalog.disable(id, { ownerAction: true, isCurrent: current });
    },
    async remove(id, signal) {
      const current = authorityCurrent(signal);
      if (!current()) throw new Error("connector_authority_lost");
      const vaults = [...stores.vaults.values()].sort((a, b) => a.id.localeCompare(b.id));
      // Native startup opens the entire verified inventory as one set. Refuse any incomplete authority.
      if (
        vaults.length === 0 ||
        vaults.some((vault) => vault.mode !== "native" || !vault.native.isCurrent())
      )
        throw new Error("connector_inventory_unavailable");
      const inventory = readExistingNativeInventory(server.paths.dataDir);
      if (
        inventory.entries.length !== vaults.length ||
        inventory.entries.some(
          (entry) => entry.state !== "ready" || !vaults.some((vault) => vault.id === entry.vaultId),
        )
      )
        throw new Error("connector_inventory_unavailable");
      // Every vault queue, then the device queue: nothing binds the connector while it goes.
      const withVaults = async <T>(index: number, task: () => Promise<T>): Promise<T> => {
        const selected = vaults[index];
        return selected === undefined
          ? task()
          : selected.queue.run(() => withVaults(index + 1, task));
      };
      return withVaults(0, () =>
        stores.device.queue.run(() => {
          const noReferences = () =>
            current() &&
            readExistingNativeInventory(server.paths.dataDir).fingerprint ===
              inventory.fingerprint &&
            vaults.every(
              (vault) =>
                stores.vaults.get(vault.id) === vault &&
                vault.mode === "native" &&
                vault.native.isCurrent() &&
                vault.store.read<{ n: number }>(
                  "SELECT COUNT(*) AS n FROM connector_bindings WHERE connector_id = ?",
                  id,
                )[0]?.n === 0,
            ) &&
            stores.device.store.read<{ n: number }>(
              "SELECT COUNT(*) AS n FROM connector_runs WHERE connector_id = ?",
              id,
            )[0]?.n === 0;
          catalog.removeUnbound(id, { ownerAction: true, isCurrent: current }, noReferences);
          return { bindings: 0 };
        }),
      );
    },
  };
}

/** Banking owner actions from the CLI: valid while the vault and this host stay current. */
function bankingOwnerPort(input: {
  readonly banking: () => BankingRuntime | undefined;
  readonly server: RunningHost;
  readonly stores: HostStores;
  readonly bundleReplaced: () => boolean;
}): BankingCliDeps {
  const { server, stores, bundleReplaced } = input;
  return {
    vaults: stores.vaults,
    async perform(vault, action, signal) {
      const active = input.banking();
      const current = () =>
        !signal.aborted &&
        !bundleReplaced() &&
        !server.stopping &&
        server.lock.held &&
        stores.vaults.get(vault.id) === vault &&
        vault.mode === "native" &&
        vault.native.isCurrent();
      if (!active || !current()) return { ok: false as const, error: "authorization" };
      const result = await active.withOwnerAction(vault.id, current, () =>
        runBankingOwnerAction({
          runtime: active,
          profileId: vault.id,
          isOwnerAction: current,
          action,
        }),
      );
      return current() ? result : { ok: false as const, error: "outcome_unknown" };
    },
  };
}
