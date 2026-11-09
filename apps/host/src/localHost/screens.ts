// What the UI role's screens read and do: proposal, settings, update, Signals, statement import and
// strategy actions; the investment screen sources (strategy images, market, clock); the served
// queries; and the store channel's query preparation and privacy policy. Built before the host
// starts serving; the stores are attached once open.
import { parseDateTime } from "@cashu/domain";
import type { market } from "@cashu/domain/investments";
import type { classifierSettingsQuery } from "@cashu/store/core/classifier-settings";
import type { deviceListQuery } from "@cashu/store/core/desktop-settings";
import type { NotificationQueue } from "@cashu/store/investments/local";
import { PerformanceService } from "@cashu/store/investments/performance";
import type { DailyPriceLock } from "@cashu/store/investments/services";
import { strategyScreenArgsSchema } from "@cashu/store/investments/strategies-screen";
import type { Read } from "@cashu/store/query";
import { budgetStatementActions } from "../budgetScreen.js";
import type { connectorSettingsServed } from "../connectorSettings.js";
import { refreshFetchAuthority } from "../fetchAuthority.js";
import { currentStrategyImages } from "../investmentScreenSources.js";
import type { investmentsRunningQuery } from "../investmentsRunning.js";
import type { ProductionMarket } from "../market/production.js";
import { nativeStrategyDocuments } from "../nativeStrategyDocuments.js";
import { followVaultStrategy } from "../proposals/strategyFollow.js";
import { proposalScreen } from "../proposalsScreen.js";
import { servedQueries } from "../registry.js";
import type { settingsInfoQuery } from "../settingsInfo.js";
import { settingsWorkspaceActions, type settingsWorkspaceStatus } from "../settingsScreen.js";
import {
  type SignalsMarketPorts,
  type SignalsScreenCapability,
  signalsScreenActions,
  signalsScreenClock,
} from "../signalsScreen.js";
import type { StoreChannelOptions } from "../storeChannel.js";
import type { HostStores, OpenVault } from "../stores.js";
import { type StrategyScreenCapability, strategiesScreen } from "../strategiesScreen.js";
import { updateScreen } from "../updateScreen.js";
import type { LocalHostOptions, VaultBinder } from "./options.js";

/** Queries whose document reads are private unless the client asked for privacy. */
const PRIVATE_UNLESS_PRIVACY = new Set([
  "core.desktopProposals.detail",
  "core.desktopProposals.list",
  "device.settings.hostInfo",
  "device.settings.mcpAudit",
  "device.settings.connectorActivity",
]);
const STRATEGIES_SCREEN = "investments.strategies.screen";

/** The strategy documents of each open native vault, bound once per vault and generation. */
function nativeStrategyBinder(lock: DailyPriceLock | undefined) {
  let stores: HostStores | null = null;
  const caps = new Map<string, { vault: OpenVault; cap: StrategyScreenCapability }>();
  return {
    attach(opened: HostStores) {
      stores = opened;
    },
    bind(id: string): StrategyScreenCapability | null {
      const vault = stores?.vaults.get(id);
      if (vault?.mode !== "native" || !vault.native.isCurrent()) return null;
      const previous = caps.get(id);
      if (previous?.vault === vault && previous.cap.isCurrent()) return previous.cap;
      const authority = vault.native.strategyDirectoryAuthority();
      if (!authority) return null;
      try {
        const documents = nativeStrategyDocuments(authority);
        const sync = documents.sync;
        const cap: StrategyScreenCapability =
          lock === undefined || sync === undefined
            ? documents
            : {
                ...documents,
                async follow() {
                  const release = lock.tryAcquire();
                  if (release === null) return "busy";
                  try {
                    return await followVaultStrategy(vault, sync, () => {
                      return stores?.vaults.get(id) === vault && documents.isCurrent();
                    });
                  } finally {
                    release();
                  }
                },
              };
        caps.set(id, { vault, cap });
        return cap;
      } catch {
        return null;
      }
    },
  };
}

/** The vault gid of the store `read` runs against. */
const vaultOf = (read: Read) => read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;

export function createScreenSurfaces(input: {
  readonly options: LocalHostOptions;
  readonly nativeMode: boolean;
  readonly now: () => number;
}) {
  const { options, nativeMode, now } = input;
  const proposals = proposalScreen(
    options.proposals,
    options.strategyProposals,
    options.accountProposals,
  );
  const workspaceActions = settingsWorkspaceActions(options.workspace);
  const updates = updateScreen(options.updates);
  const clock = signalsScreenClock(now);
  const performance = new PerformanceService();
  const budgetStatements = budgetStatementActions({ now });
  const nativeStrategies =
    options.strategies === undefined && nativeMode
      ? nativeStrategyBinder(options.strategyLock)
      : undefined;
  const strategies: VaultBinder<StrategyScreenCapability> | undefined =
    options.strategies ?? nativeStrategies;
  const images =
    options.strategyImages ??
    currentStrategyImages((vault, generation) => {
      const capability = strategies?.bind(vault);
      return capability?.generation === generation && capability.isCurrent();
    });
  const strategyManager =
    strategies === undefined
      ? null
      : strategiesScreen({ ...strategies, publish: images.publish, revoke: images.revoke });

  const investmentSources = (marketSource?: ProductionMarket["market"]) => ({
    ...options.investments,
    ...(marketSource === undefined ? {} : { market: marketSource }),
    clock: {
      current: () => ({
        now: parseDateTime(new Date(now()).toISOString()),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    },
    ...(options.investments?.strategy === undefined &&
    (strategies !== undefined || options.strategyImages !== undefined)
      ? { strategy: images.source }
      : {}),
  });
  type InvestmentSources = ReturnType<typeof investmentSources>;

  /**
   * Prepares the strategy documents image a strategies screen read needs, in incognito too: the image
   * stays in the host (the screen itself answers `unavailable: privacy`), and the portfolio, signals and
   * review read their strategy from it. Skipping it left a host started in incognito without strategy
   * files (`current_files_unavailable` on Investments) until incognito was turned off.
   */
  const prepareQuery: NonNullable<StoreChannelOptions["prepareQuery"]> = async (
    vault,
    query,
    args,
  ) => {
    if (query === STRATEGIES_SCREEN) {
      const parsed = strategyScreenArgsSchema.safeParse(args);
      if (!parsed.success) throw new Error("invalid_query_input");
      await strategyManager?.prepare(vault, parsed.data.privacy ? null : parsed.data.selection);
    }
    await options.prepareUiQuery?.(vault, query, args);
  };
  /** Classifies prose-bearing document reads as private. */
  const privateQuery: NonNullable<StoreChannelOptions["privateQuery"]> = (query, args) => {
    if (PRIVATE_UNLESS_PRIVACY.has(query))
      return (args as { privacy?: unknown } | undefined)?.privacy !== true;
    const parsed = query === STRATEGIES_SCREEN ? strategyScreenArgsSchema.safeParse(args) : null;
    return (
      (parsed !== null && (!parsed.success || !parsed.data.privacy)) ||
      options.privateUiQuery?.(query, args) === true
    );
  };

  return {
    performance,
    strategies,
    /** The opened stores the native strategy binder reads. */
    attach(stores: HostStores) {
      nativeStrategies?.attach(stores);
    },
    investmentSources,
    queries(served: {
      readonly market: ProductionMarket | undefined;
      readonly prices: market.PriceCache | null;
      readonly sources: InvestmentSources;
      readonly settingsInfo: ReturnType<typeof settingsInfoQuery>;
      readonly running?: ReturnType<typeof investmentsRunningQuery>;
      readonly connectorSettings?: ReturnType<typeof connectorSettingsServed>;
      readonly classifierSettings?: ReturnType<typeof classifierSettingsQuery>;
      readonly deviceList?: ReturnType<typeof deviceListQuery>;
      readonly workspaceStatus?: ReturnType<typeof settingsWorkspaceStatus>;
    }) {
      const { market: marketRuntime, sources } = served;
      return servedQueries({
        ...options.overview,
        sources: {
          ...options.overview?.sources,
          ...(marketRuntime === undefined
            ? {}
            : {
                marketData: (read: Read) => {
                  const vault = vaultOf(read);
                  return vault === undefined ? null : marketRuntime.marketData(read, vault);
                },
              }),
        },
        prices: served.prices,
        investments: sources,
        proposalImages: { changes: images.source.changes, image: images.image },
        updateQuery: updates.query,
        settingsInfoQuery: served.settingsInfo,
        ...(served.running === undefined ? {} : { runningQuery: served.running }),
        ...(served.connectorSettings === undefined
          ? {}
          : { connectorSettingsQuery: served.connectorSettings }),
        ...(served.classifierSettings === undefined
          ? {}
          : { classifierSettingsQuery: served.classifierSettings }),
        ...(served.deviceList === undefined ? {} : { deviceListQuery: served.deviceList }),
        ...(served.workspaceStatus === undefined
          ? {}
          : { workspaceStatusQuery: served.workspaceStatus }),
        signals: { strategy: sources.strategy, market: sources.market, clock },
        research: {
          ...options.research,
          ...marketRuntime?.research,
          strategy: sources.strategy,
          market: sources.market,
          clock,
        },
        review: {
          ...options.review,
          ...marketRuntime?.research,
          strategy: sources.strategy,
          market: sources.market,
          clock,
        },
        strategies: {
          strategy: images.source,
          ...(strategyManager === null ? {} : { documents: strategyManager.source }),
        },
      });
    },
    /** Signals actions: each open vault gets a local capability (watchlist, snooze, offline add),
     * plus the injected public-market ports (online search) while that vault has them. */
    signalActions(local: {
      readonly stores: HostStores;
      readonly queue: NotificationQueue;
      readonly prices: market.PriceCache | null;
    }) {
      const bind = localSignalsBinder({ ...local, signals: options.signals });
      return signalsScreenActions({ bind, now, timeZone: () => clock.current().timeZone });
    },
    /** The UI actions: a native host offers only the bound ones, a harness all of them. */
    uiActions(
      signalActions: ReturnType<typeof signalsScreenActions>,
    ): NonNullable<StoreChannelOptions["actions"]> {
      return nativeMode
        ? [
            proposals,
            ...(options.updates === undefined ? [] : [updates.action]),
            ...(options.workspace === undefined ? [] : workspaceActions),
            ...(options.uiActions ?? []),
            ...signalActions,
            ...(strategyManager?.actions ?? []),
            ...budgetStatements.actions,
          ]
        : [
            proposals,
            updates.action,
            ...workspaceActions,
            ...(options.uiActions ?? []),
            ...signalActions,
            ...(strategyManager?.actions ?? []),
            ...budgetStatements.actions,
          ];
    },
    prepareQuery,
    privateQuery,
    close() {
      budgetStatements.close();
      strategyManager?.close();
      images.close();
    },
  };
}

/**
 * The Signals capability of each open vault. Its local actions (watchlist, snooze, offline add)
 * depend only on the open vault, so `isCurrent` is the vault's identity and the capability stays the
 * same object while that vault is open. The public-market ports (online search, pick verification)
 * follow the market lease: read on each use, absent while the vault has none, and they check their
 * own authority on every request. Capabilities are keyed by the opened vault, so a closed or
 * reopened vault's capability is dropped with it.
 */
export function localSignalsBinder(input: {
  readonly stores: HostStores;
  readonly queue: NotificationQueue;
  readonly prices: market.PriceCache | null;
  readonly signals: VaultBinder<SignalsMarketPorts> | undefined;
}): (vault: string) => SignalsScreenCapability | null {
  const { stores, queue, prices } = input;
  const caps = new WeakMap<OpenVault, SignalsScreenCapability>();
  let generations = 0;
  return (vault) => {
    const opened = stores.vaults.get(vault);
    if (opened === undefined) return null;
    const cached = caps.get(opened);
    if (cached !== undefined) return cached;
    const ports = (): SignalsMarketPorts | null => {
      const offered = input.signals?.bind(vault) ?? null;
      return offered?.isCurrent() ? offered : null;
    };
    const cap: SignalsScreenCapability = {
      vault,
      generation: `local:${vault}:${++generations}`,
      isCurrent: () => stores.vaults.get(vault) === opened,
      refreshFetch: () => refreshFetchAuthority(opened),
      notifications: queue,
      ...(prices ? { prices } : {}),
      get searchSources() {
        return ports()?.searchSources;
      },
      get watchMarket() {
        return ports()?.watchMarket;
      },
    };
    caps.set(opened, cap);
    return cap;
  };
}
