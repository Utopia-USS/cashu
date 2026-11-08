// What the UI role's screens read and do: proposal, settings, update, Signals, import and strategy
// actions; the investment screen sources (strategy images, market, clock); the served queries; and
// the store channel's query preparation and privacy policy. Built before the host starts serving;
// the stores are attached once open.
import { parseDateTime } from "@cashu/domain";
import type { market } from "@cashu/domain/investments";
import type { classifierSettingsQuery } from "@cashu/store/core/classifier-settings";
import type { deviceListQuery } from "@cashu/store/core/desktop-settings";
import type { NotificationQueue } from "@cashu/store/investments/local";
import { PerformanceService } from "@cashu/store/investments/performance";
import { strategyScreenArgsSchema } from "@cashu/store/investments/strategies-screen";
import type { Read } from "@cashu/store/query";
import { budgetStatementActions } from "../budgetScreen.js";
import type { connectorSettingsServed } from "../connectorSettings.js";
import { currentStrategyImages } from "../investmentScreenSources.js";
import type { investmentsRunningQuery } from "../investmentsRunning.js";
import { investmentImportActions } from "../investmentsScreen.js";
import type { ProductionMarket } from "../market/production.js";
import { nativeStrategyDocuments } from "../nativeStrategyDocuments.js";
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
function nativeStrategyBinder() {
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
        const cap = nativeStrategyDocuments(authority);
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
  const proposals = proposalScreen(options.proposals);
  const workspaceActions = settingsWorkspaceActions(options.workspace);
  const updates = updateScreen(options.updates);
  const clock = signalsScreenClock(now);
  const performance = new PerformanceService();
  const budgetStatements = budgetStatementActions({ now });
  const imports =
    options.investmentImports === undefined
      ? null
      : investmentImportActions({ ...options.investmentImports, now });
  const nativeStrategies =
    options.strategies === undefined && nativeMode ? nativeStrategyBinder() : undefined;
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
    ...(options.investmentImports === undefined
      ? {}
      : {
          importAvailable: (read: Read) => {
            const vault = vaultOf(read);
            const capability = vault === undefined ? null : options.investmentImports?.bind(vault);
            return capability != null && capability.vault === vault && capability.isCurrent();
          },
        }),
  });
  type InvestmentSources = ReturnType<typeof investmentSources>;

  /** Prepares the strategy documents image a non-private strategies screen read needs. */
  const prepareQuery: NonNullable<StoreChannelOptions["prepareQuery"]> = async (
    vault,
    query,
    args,
  ) => {
    if (query === STRATEGIES_SCREEN) {
      const parsed = strategyScreenArgsSchema.safeParse(args);
      if (!parsed.success) throw new Error("invalid_query_input");
      if (!parsed.data.privacy) await strategyManager?.prepare(vault, parsed.data.selection);
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
      const { stores, queue, prices } = local;
      const localSignals = new Map<
        string,
        {
          readonly opened: OpenVault;
          readonly ports: SignalsMarketPorts | null;
          readonly cap: SignalsScreenCapability;
        }
      >();
      let generations = 0;
      const bind = (vault: string): SignalsScreenCapability | null => {
        const opened = stores.vaults.get(vault);
        if (opened === undefined) return null;
        const offered = options.signals?.bind(vault) ?? null;
        const ports = offered?.isCurrent() ? offered : null;
        const cached = localSignals.get(vault);
        if (cached?.opened === opened && cached.ports === ports) return cached.cap;
        const cap: SignalsScreenCapability = {
          vault,
          generation: `local:${vault}:${++generations}`,
          isCurrent: () => stores.vaults.get(vault) === opened && (ports?.isCurrent() ?? true),
          notifications: queue,
          ...(prices ? { prices } : {}),
          ...(ports?.searchSources ? { searchSources: ports.searchSources } : {}),
          ...(ports?.watchMarket ? { watchMarket: ports.watchMarket } : {}),
        };
        localSignals.set(vault, { opened, ports, cap });
        return cap;
      };
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
            ...(imports?.actions ?? []),
            ...(strategyManager?.actions ?? []),
            ...budgetStatements.actions,
          ]
        : [
            proposals,
            updates.action,
            ...workspaceActions,
            ...(options.uiActions ?? []),
            ...signalActions,
            ...(imports?.actions ?? []),
            ...(strategyManager?.actions ?? []),
            ...budgetStatements.actions,
          ];
    },
    prepareQuery,
    privateQuery,
    close() {
      budgetStatements.close();
      imports?.close();
      strategyManager?.close();
      images.close();
    },
  };
}
