// The local host's composition root: one per data dir, the only process that opens this device's
// stores. Started on demand by its first client (owner decision: no always-on service), it:
//   1. takes the machine lock and the socket (`startHost`, @cashu/node-host; a second host fails with
//      HostBusyError, exit 3),
//   2. records its start (crash-loop detection: after repeated crashes it runs in safe mode),
//   3. opens the stores under the writer lease (exclusive SQLite opens; damaged views recovered),
//   4. serves sessions by role: `ui` gets the store channel v2, `admin` gets status / stop / handover,
//      `cli` the hosted command tree (cli/runner.ts), `mcp` an MCP server for its profile (mcp/session.ts);
//      writes the stable launcher `<data dir>/bin/cashu` (launcher.ts),
//   4a. runs the sync service when the data dir configures one (sync/service.ts: the outbox bridge and
//      the carrier loop, TRANSITIONAL(S49)); it starts in the background, never in safe mode, and
//      stops before the stores close,
//   5. lingers while idle (no session, no queued write) and then exits 0; exits 75 when its bundle
//      was replaced (handover); a signal or `admin.stop` exits 0.
// Everything is logged as codes and counts (log.ts). A clean exit clears the crash record.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseDateTime } from "@cashu/domain";
import type { market } from "@cashu/domain/investments";
import {
  type AdminStatus,
  deviceListParamsSchema,
  deviceListResultSchema,
  HOST_PROTOCOL,
  NATIVE_CREATION_FEATURE,
  NATIVE_DEVICES_FEATURE,
  NOTIFICATION_INTENT_FEATURE,
  NOTIFICATION_INTENT_METHOD,
  nativeCreationCommitParamsSchema,
  nativeCreationCommitResultSchema,
  nativeCreationCurrentParamsSchema,
  nativeCreationCurrentResultSchema,
  nativeCreationInspectParamsSchema,
  nativeCreationInspectResultSchema,
  nativeCreationPrepareParamsSchema,
  nativeCreationPrepareResultSchema,
  notificationResolveParamsSchema,
  notificationResolveResultSchema,
  revokeCancelParamsSchema,
  revokeCancelResultSchema,
  revokeCommitParamsSchema,
  revokeCommitResultSchema,
  revokeInspectParamsSchema,
  revokeInspectResultSchema,
  revokePreviewParamsSchema,
  revokePreviewResultSchema,
  uiCreationAllowed,
  uiDevicesAllowed,
} from "@cashu/host-protocol";
import {
  budgetTools,
  coreTools,
  type InvestmentAsyncCapabilities,
  type InvestmentHistoryReads,
  type InvestmentReads,
  type InvestmentWriteServices,
  investmentImportAdapter,
  investmentSearchAdapter,
  investmentTools,
  investmentWatchAdapter,
  investmentWriteTools,
  loansTools,
  NativeMcpServer,
  type NativeToolStore,
  type ResearchServices,
  researchTools,
  type ToolContext,
} from "@cashu/mcp";
import {
  type HostPathEnv,
  type HostSession,
  type RunningHost,
  readUpdateAdmission,
  recordUpdateHandoverComplete,
  refusePaths,
  startHost,
} from "@cashu/node-host";
import { readBundleIdentity, watchBundleIdentity } from "@cashu/node-host/bundle-identity";
import { mcpProfile } from "@cashu/store/core";
import { NotificationQueue } from "@cashu/store/investments/local";
import { PerformanceService } from "@cashu/store/investments/performance";
import { strategyScreenArgsSchema } from "@cashu/store/investments/strategies-screen";
import type { SyncResult } from "@cashu/sync";
import { handleAdmin } from "./admin.js";
import { HANDOVER_EXIT } from "./bundle.js";
import type { CategorizeProvider, CloudCategorizeProvider } from "./cli/budget/categorizeOllama.js";
import { DELEGATED } from "./cli/delegated.js";
import { portedCommands } from "./cli/ported.js";
import { serveCliSession } from "./cli/runner.js";
import type { PortedCommand } from "./cli/tree.js";
import { recordStart, type StartRecord } from "./crashLoop.js";
import { createDeviceService } from "./devices/service.js";
import { currentStrategyImages } from "./investmentScreenSources.js";
import { type InvestmentImportCapability, investmentImportActions } from "./investmentsScreen.js";
import { writeLauncher } from "./launcher.js";
import { takeWriterLease, type WriterLease } from "./lease.js";
import { errorName, fileLog, type HostLog } from "./log.js";
import { compositeBackend } from "./mcp/composite.js";
import { budgetFileReader, investmentFileReader, investmentMappingReader } from "./mcp/files.js";
import { mcpFileHome, mcpNamedHome } from "./mcp/homes.js";
import { nativeRuntime } from "./mcp/native.js";
import { startPythonMcp } from "./mcp/python.js";
import { type McpBackend, serveMcpSession } from "./mcp/session.js";
import { TOOL_INVENTORY } from "./mcp/tools.js";
import { createNativeCreationService } from "./nativeCreation.js";
import { classifyNativeCreationStartup } from "./nativeCreationJournal.js";
import type { NativeVaultSource } from "./nativeVault.js";
import {
  type HostNotificationCapability,
  hostNotificationCapability,
} from "./notificationCapability.js";
import { privateNotificationIntents } from "./notifications/intentLedger.js";
import { type IntentVaultAuthority, resolveNotificationIntent } from "./notifications/resolve.js";
import type { ProductionVaultSourceFactory } from "./productionVaultSource.js";
import { type ProposalApprovalProvider, proposalScreen } from "./proposalsScreen.js";
import { servedCommands, servedQueries } from "./registry.js";
import {
  currentRuntime,
  type HostRuntime,
  type Program,
  pythonProgram,
  shimProgram,
} from "./runtime.js";
import { settingsInfoQuery } from "./settingsInfo.js";
import { settingsWorkspaceActions } from "./settingsScreen.js";
import {
  type SignalsScreenCapability,
  signalsScreenActions,
  signalsScreenClock,
} from "./signalsScreen.js";
import { serveStoreChannel } from "./storeChannel.js";
import {
  type HostStores,
  openHostStores,
  openNativeHostStores,
  openNativeSetupStores,
} from "./stores.js";
import { type StrategyScreenCapability, strategiesScreen } from "./strategiesScreen.js";
import { bridgeCommand } from "./sync/command.js";
import { validateNativeVaultInventorySet } from "./sync/keys/deviceAuthority.js";
import type { CrashPoint } from "./sync/loop.js";
import { SyncService } from "./sync/service.js";
import { type UpdateProvider, updateScreen } from "./updateScreen.js";
import type { WorkerBindings, WorkerHostContext } from "./worker/contracts.js";
import { startWorker } from "./worker/service.js";
import type { WorkspaceProvider } from "./workspace/index.js";

const DEFAULT_LINGER_MS = 10 * 60 * 1000;
const DEFAULT_SLICE_EVENTS = 1_000;
const CLEAN_EXIT = 0;
const requireNative = createRequire(import.meta.url);
const NATIVE_MCP_STORE_TOOLS = new Set([
  "setup_status",
  "mark_review_done",
  "spending_breakdown",
  "cashflow_summary",
  "recurring_payments",
  "uncategorized_merchants",
  "loans_summary",
  "signals",
  "theses",
  "alerts",
  "add_alert",
  "mute_alert",
  "record_decision",
  "research_notes",
  "set_topic_market_view",
  "upsert_topic_thesis",
  "set_instrument_segment",
]);
const NATIVE_MCP_INVESTMENT_READS = new Set([
  "portfolio_overview",
  "positions",
  "review_context",
  "strategy_status",
]);
const NATIVE_MCP_RESEARCH = new Set([
  "research_context",
  "start_research_run",
  "add_research_note",
  "finish_research_run",
]);
const NATIVE_MCP_INVESTMENT_WRITES = new Set([
  "set_recommendation",
  "set_recommendations",
  "upsert_thesis",
  "watchlist",
  "remove_from_watchlist",
  "add_to_watchlist",
]);

type ExitReason = "stop" | "idle" | "signal" | "handover";

export interface LocalHostOptions {
  /** Explicit isolated test harness or an injected exact-vault native authority. */
  readonly vaultSource?:
    | { readonly kind: "synthetic-harness" }
    | { readonly kind: "native"; readonly provider: NativeVaultSource }
    | { readonly kind: "native-production"; readonly factory: ProductionVaultSourceFactory };
  /** Checked S60 preparation authority, bound to the exact open vault. Absent by default. */
  readonly proposals?: ProposalApprovalProvider;
  /** Exact-vault checked workspace provider. Unbound means unavailable, never absent. */
  readonly workspace?: WorkspaceProvider;
  /** Verified packaged updater, absent in unbound native builds. */
  readonly updates?: UpdateProvider;
  readonly strategies?: { bind(vault: string): StrategyScreenCapability | null };
  readonly strategyImages?: ReturnType<typeof currentStrategyImages>;
  readonly investments?: import("@cashu/store/investments/screen").InvestmentScreenSources;
  readonly investmentImports?: { bind(vault: string): InvestmentImportCapability | null };
  /** Optional public-market provider; local Signals actions need no remote provider. */
  readonly signals?: { bind(vault: string): SignalsScreenCapability | null };
  readonly research?: import("@cashu/store/investments/research-screen").ResearchScreenSources;
  readonly review?: import("@cashu/store/investments/review-screen").ReviewScreenSources;
  readonly mcpInvestmentAsync?: (vault: string) => InvestmentAsyncCapabilities | undefined;
  readonly uiActions?: import("./storeChannel.js").StoreChannelOptions["actions"];
  readonly prepareUiQuery?: import("./storeChannel.js").StoreChannelOptions["prepareQuery"];
  readonly privateUiQuery?: import("./storeChannel.js").StoreChannelOptions["privateQuery"];
  /** Explicit per-vault capabilities only. Production authority/consent/credential binding is separate. */
  readonly budgetClassifiers?: {
    readonly local?: CategorizeProvider;
    readonly cloud?: CloudCategorizeProvider;
  };
  /** Injected only after genuine per-job ownership and per-vault authority are available. */
  readonly worker?: (
    context: WorkerHostContext,
    notifications?: HostNotificationCapability,
  ) => WorkerBindings;
  /** Actual device cache and its committed changes. Without a cache, overview uses last trades.
   * Persistent production cache lifecycle remains TRANSITIONAL(S53b). */
  readonly overview?: Parameters<typeof servedQueries>[0];
  readonly dataDir: string;
  readonly build?: string;
  /** How long an idle host (no session, nothing queued) stays before it exits 0. */
  readonly lingerMs?: number;
  /** Verified .app bundle path; its replacement triggers a handover (exit 75). */
  readonly bundlePath?: string;
  readonly bundleCheckMs?: number;
  readonly pathEnv?: HostPathEnv;
  /** Defaults to `<data dir>/logs/host.log`. */
  readonly log?: HostLog;
  readonly now?: () => number;
  /** The home whose real cashU locations the synthetic store source refuses (tests: a temp dir). */
  readonly home?: string;
  readonly maxInFlight?: number;
  /** Fault tests only: runs after a command committed, before its reply. */
  readonly afterCommit?: () => void;
  /** Where this host runs from (default: this process); picks the shim and the Python CLI. */
  readonly runtime?: HostRuntime;
  /** TRANSITIONAL(S49): the Python CLI for delegated commands and MCP sessions (null: none). */
  readonly python?: Program | null;
  /** The commands run in the host (default: `portedCommands()`). */
  readonly ported?: readonly PortedCommand[];
  /** Write `<data dir>/bin/cashu` at start (default true). */
  readonly launcher?: boolean;
  /** Device cache dependency, also used by synthetic oracle fixtures. */
  readonly mcpPrices?: market.PriceCache;
  readonly mcpFxNewest?: () => string | null;
  /** Explicit coherent read authorities; native investment views are unavailable without them. */
  readonly mcpInvestmentReads?: (context: ToolContext<NativeToolStore>) => InvestmentReads;
  readonly mcpInvestmentHistory?: (context: ToolContext<NativeToolStore>) => InvestmentHistoryReads;
  /** Explicit vault-scoped strategy, portfolio and plan authority for native research tools. */
  readonly mcpResearch?: (context: ToolContext<NativeToolStore>) => ResearchServices;
  /** Explicit per-call vault/plan/file authority for optional investment write services. */
  readonly mcpInvestmentWrites?: (context: ToolContext<NativeToolStore>) => InvestmentWriteServices;
  /** Explicit legacy-file authority for packaged hosts or an external Python program. */
  readonly mcpLegacyDataDir?: string;
  /** Tests only: called at each crash point of the sync service's loop. */
  readonly syncAt?: (point: CrashPoint) => void;
}

export interface LocalHost {
  readonly server: RunningHost;
  readonly lease: WriterLease;
  readonly stores: HostStores;
  readonly safeMode: boolean;
  /** The sync service, once started (state `off` when the data dir configures none). */
  readonly sync: Promise<SyncService | undefined>;
  /** What may run besides serving sessions: nothing in safe mode (rule 6 under crash loops). */
  readonly capabilities: { readonly jobs: boolean; readonly network: boolean };
  /** Resolves with the exit code once the host stopped (0 clean, 75 handover). */
  readonly exit: Promise<number>;
  status(): AdminStatus;
  /** Stops: refuses new sessions, drains the write queues, closes stores, releases the lock. */
  stop(reason?: ExitReason): Promise<number>;
  /**
   * Applies `envelopes` to a vault in slices (one transaction each) through its write queue, so
   * commands of other sessions run between slices. Resolves with the applied count.
   */
  applySliced(vault: string, envelopes: readonly unknown[], sliceEvents?: number): Promise<number>;
  /** Native-only authenticated inbound fold/push through the shared vault queue. */
  syncVault(vault: string): Promise<SyncResult>;
}

/** Starts the data dir's host. Throws `HostBusyError` when another host holds the lock. */
export async function startLocalHost(options: LocalHostOptions): Promise<LocalHost> {
  if (options.vaultSource === undefined) throw new Error("native_vault_provider_unavailable");
  if (
    options.vaultSource.kind === "native-production" &&
    existsSync(join(options.dataDir, "cashu.db"))
  )
    throw new Error("legacy_python_db_awaits_s62");
  if (options.bundlePath !== undefined) {
    const identity = readBundleIdentity(options.bundlePath);
    if (
      identity.kind !== "present" ||
      options.vaultSource.kind === "synthetic-harness" ||
      process.env.ELECTRON_RUN_AS_NODE !== "1" ||
      resolve(process.execPath) !== join(identity.canonicalPath, "Contents", "MacOS", "cashU") ||
      resolve(currentRuntime().dir) !== join(identity.canonicalPath, "Contents", "Resources")
    )
      throw new Error("bundle_identity_unavailable");
    const notification = requireNative(
      join(identity.canonicalPath, "Contents", "Resources", "native", "CashUNotifications.node"),
    ) as { identity(): { verified: boolean } };
    if (notification.identity().verified !== true) throw new Error("bundle_identity_unavailable");
  } else {
    refusePaths(
      { dataDir: { label: "data dir", path: options.dataDir }, outputs: [] },
      options.home ?? homedir(),
    );
  }
  if (options.vaultSource.kind === "native") {
    if (options.vaultSource.provider.inventory.length === 0)
      throw new Error("native_inventory_unavailable");
    validateNativeVaultInventorySet(
      options.vaultSource.provider.inventory,
      resolve(options.dataDir),
    );
  }
  const startup =
    options.vaultSource.kind === "native-production"
      ? classifyNativeCreationStartup(resolve(options.dataDir))
      : null;
  if (startup === "ready" && options.vaultSource.kind === "native-production")
    options.vaultSource.factory.preflight();
  const now = options.now ?? Date.now;
  const nativeMode = options.vaultSource.kind !== "synthetic-harness";
  const proposalManager = proposalScreen(options.proposals);
  const workspaceActions = settingsWorkspaceActions(options.workspace);
  const updates = updateScreen(options.updates);
  const investmentClock = signalsScreenClock(now);
  const investmentPerformance = new PerformanceService();
  const importManager =
    options.investmentImports === undefined
      ? null
      : investmentImportActions({ ...options.investmentImports, now });
  const images =
    options.strategyImages ??
    currentStrategyImages((vault, generation) => {
      const capability = options.strategies?.bind(vault);
      return capability?.generation === generation && capability.isCurrent();
    });
  const strategyManager =
    options.strategies === undefined
      ? null
      : strategiesScreen({ ...options.strategies, publish: images.publish, revoke: images.revoke });
  const investmentSources = {
    ...options.investments,
    clock: {
      current: () => ({
        now: parseDateTime(new Date(now()).toISOString()),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    },
    ...(options.investments?.strategy === undefined &&
    (options.strategies !== undefined || options.strategyImages !== undefined)
      ? { strategy: images.source }
      : {}),
    ...(options.investmentImports === undefined
      ? {}
      : {
          importAvailable: (read: import("@cashu/store/query").Read) => {
            const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
            const capability = vault === undefined ? null : options.investmentImports?.bind(vault);
            return capability != null && capability.vault === vault && capability.isCurrent();
          },
        }),
  };
  const build = options.build ?? "dev";
  let dataDirPath: string | null = null;
  let settingsStores: HostStores | null = null;
  let currentWorkerStatus: (() => import("./worker/contracts.js").WorkerStatus) | null = null;
  const queries = servedQueries({
    ...options.overview,
    prices: options.overview?.prices ?? null,
    investments: investmentSources,
    proposalImages: { changes: images.source.changes, image: images.image },
    updateQuery: updates.query,
    settingsInfoQuery: settingsInfoQuery({
      version: build,
      dataDir: () => dataDirPath,
      worker: () => currentWorkerStatus?.() ?? null,
      stores: () => settingsStores,
    }),
    signals: {
      strategy: investmentSources.strategy,
      market: investmentSources.market,
      clock: investmentClock,
    },
    research: {
      ...options.research,
      strategy: investmentSources.strategy,
      market: investmentSources.market,
      clock: investmentClock,
    },
    review: {
      ...options.review,
      strategy: investmentSources.strategy,
      market: investmentSources.market,
      clock: investmentClock,
    },
    strategies: {
      strategy: images.source,
      ...(strategyManager === null ? {} : { documents: strategyManager.source }),
    },
  });
  const lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
  let dispatch: (session: HostSession) => void = (session) => session.close();
  const server = await startHost({
    dataDir: options.dataDir,
    build,
    features: [
      "store.v2",
      ...(options.vaultSource.kind === "native-production" ? [NATIVE_CREATION_FEATURE] : []),
      ...(nativeMode ? [NATIVE_DEVICES_FEATURE] : []),
      ...(nativeMode ? [NOTIFICATION_INTENT_FEATURE] : []),
      "admin.handover",
      "cli.exec",
      "mcp.lines",
      "sync.status",
      "worker.status",
    ],
    ...(options.pathEnv === undefined ? {} : { pathEnv: options.pathEnv }),
    onSession: (session) => dispatch(session),
  });
  dataDirPath = server.paths.dataDir;
  const log = options.log ?? fileLog(server.paths.logPath);

  let record: StartRecord;
  let stores: HostStores;
  let lease: WriterLease;
  let creation: ReturnType<typeof createNativeCreationService> | undefined;
  let notificationIntents: ReturnType<typeof privateNotificationIntents> | undefined;
  try {
    record = recordStart(server.paths.runDir, now());
    lease = takeWriterLease(server.lock);
    if (options.vaultSource.kind === "native-production") {
      const checked = classifyNativeCreationStartup(server.paths.dataDir);
      if (checked !== startup) throw new Error("native_inventory_changed");
      creation = createNativeCreationService({
        dataDir: server.paths.dataDir,
        lock: server.lock,
        now,
        createKeyStore: options.vaultSource.factory.creationKeyStoreFactory(),
      });
      // Authenticate completed anchors before native sessions take exclusive SQLite opens.
      await creation.primeVerifiedCompleted();
    }
    const source =
      options.vaultSource.kind === "native-production" && startup === "ready"
        ? { kind: "native" as const, provider: await options.vaultSource.factory.open(server.lock) }
        : options.vaultSource;
    if (source.kind === "native") {
      if (source.provider.inventory.length === 0) throw new Error("native_inventory_unavailable");
      validateNativeVaultInventorySet(source.provider.inventory, server.paths.dataDir);
    }
    stores =
      source.kind === "native"
        ? await openNativeHostStores(server.paths.dataDir, source.provider, lease, log, now)
        : source.kind === "native-production"
          ? openNativeSetupStores(server.paths.dataDir, lease, log, now)
          : openHostStores(server.paths.dataDir, lease, log, now);
    // Construction checks the private directory while the host lock is held. A bad ledger
    // prevents a native host from advertising click resolution.
    if (nativeMode)
      notificationIntents = privateNotificationIntents(
        server.paths.dataDir,
        () => server.lock.held && !server.stopping,
        now,
      );
  } catch (error) {
    log.error("host.start-failed", { error: errorName(error) });
    await server.close();
    throw error;
  }
  const signalQueue = new NotificationQueue(stores.device.driver);
  const localSignals = new Map<string, SignalsScreenCapability>();
  const bindSignals = (vault: string): SignalsScreenCapability | null => {
    if (options.signals !== undefined) return options.signals.bind(vault);
    const opened = stores.vaults.get(vault);
    if (opened === undefined) return null;
    let cap = localSignals.get(vault);
    if (cap === undefined) {
      cap = {
        vault,
        generation: `local:${vault}`,
        isCurrent: () => stores.vaults.get(vault) === opened,
        notifications: signalQueue,
        ...((options.mcpPrices ?? options.overview?.prices)
          ? { prices: options.mcpPrices ?? options.overview?.prices ?? undefined }
          : {}),
      };
      localSignals.set(vault, cap);
    }
    return cap;
  };
  const signalActions = signalsScreenActions({
    bind: bindSignals,
    now,
    timeZone: () => investmentClock.current().timeZone,
  });
  const uiCommands = servedCommands({ strategy: investmentSources.strategy });
  const safeMode = record.safeMode;
  const runtime = options.runtime ?? currentRuntime();
  const python = nativeMode
    ? undefined
    : options.python === undefined
      ? pythonProgram(runtime)
      : (options.python ?? undefined);
  const workerBound = !nativeMode || options.worker !== undefined;
  const capabilities = { jobs: !safeMode && workerBound, network: !safeMode && workerBound };
  let syncService: SyncService | undefined;
  const sync: Promise<SyncService | undefined> = (
    nativeMode
      ? Promise.resolve(undefined)
      : SyncService.start({
          dataDir: server.paths.dataDir,
          home: options.home ?? homedir(),
          lease,
          log,
          capabilities,
          now,
          ...(options.syncAt === undefined ? {} : { at: options.syncAt }),
        })
  ).then(
    (service) => {
      syncService = service;
      return service;
    },
    (error: unknown) => {
      log.error("sync.start-failed", { error: errorName(error) });
      return undefined;
    },
  );
  // TRANSITIONAL(S39c): Python owns financial mutations in mixed sessions. Native-only builds
  // bind the explicit profile to a loaded vault until the shared authority/catalog is available.
  const ported = nativeMode
    ? portedCommands({
        runtime,
        now,
        nativeStores: stores,
        investmentSources,
        performance: investmentPerformance,
        classifier: options.budgetClassifiers?.local,
        cloudClassifier: options.budgetClassifiers?.cloud,
      }).filter((command) => command.name !== "genesis" && command.name !== "skills")
    : [
        ...(options.ported ??
          portedCommands({
            runtime,
            now,
            ...(python === undefined
              ? {
                  nativeStores: stores,
                  investmentSources,
                  performance: investmentPerformance,
                  classifier: options.budgetClassifiers?.local,
                  cloudClassifier: options.budgetClassifiers?.cloud,
                }
              : {}),
          })),
        bridgeCommand(() => sync),
      ];
  const portedNames = new Set(ported.map((command) => command.name));
  const delegated = nativeMode
    ? {}
    : Object.fromEntries(Object.entries(DELEGATED).filter(([name]) => !portedNames.has(name)));
  if (options.launcher ?? true) {
    try {
      if (writeLauncher(server.paths.dataDir, shimProgram(runtime)))
        log.info("host.launcher-written");
    } catch (error) {
      log.warn("host.launcher-failed", { error: errorName(error) });
    }
  }
  const mcpServers = new Set<McpBackend>();
  log.info("host.started", {
    pid: process.pid,
    build,
    vaults: stores.vaults.size,
    recovered: stores.recovered,
    safeMode,
    recentCrashes: record.recentCrashes,
  });
  if (safeMode) log.warn("host.safe-mode", { recentCrashes: record.recentCrashes });

  let resolveExit: (code: number) => void = () => {};
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  let stopping: Promise<number> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let idleDeadline: number | undefined;
  let sessions = 0;
  let bundleReplaced = false;
  const creationRequests = new Set<Promise<void>>();
  const devices = createDeviceService(stores, now);
  // This ledger is pinned under the real host lock and survives host restart. It is also passed
  // to the eventual S40 notifier binding, so submit and click resolution use the same authority.
  const notificationAuthority: IntentVaultAuthority = {
    isAdmittedAndUnlocked: (vault) =>
      stores.vaults.get(vault.id) === vault &&
      vault.mode === "native" &&
      vault.native.isCurrent() &&
      stopping === undefined &&
      !bundleReplaced &&
      !server.stopping &&
      server.lock.held,
  };
  const workerContext: WorkerHostContext = {
    stores,
    now: () => now(),
    isCurrent: (vault) =>
      stopping === undefined &&
      !bundleReplaced &&
      stores.vaults.get(vault.id) === vault &&
      (vault.native === undefined || vault.native.canRunSideEffects()),
    jobsEnabled: () => capabilities.jobs && stopping === undefined && !bundleReplaced,
    networkEnabled: () => capabilities.network && stopping === undefined && !bundleReplaced,
    uiCount: () => server.sessionCounts().ui,
  };
  let workerBindings: WorkerBindings | undefined;
  const notifications =
    notificationIntents === undefined
      ? undefined
      : hostNotificationCapability(
          notificationIntents,
          () => stopping === undefined && !bundleReplaced && !server.stopping && server.lock.held,
        );
  try {
    workerBindings = options.worker?.(workerContext, notifications);
  } catch (error) {
    log.warn("worker.binding-failed", { error: errorName(error) });
  }
  const worker = startWorker(workerContext, workerBindings);
  settingsStores = stores;
  currentWorkerStatus = () => worker.status();

  const status = (): AdminStatus => {
    const currentWorker = worker.status();
    return {
      pid: process.pid,
      build,
      protocol: HOST_PROTOCOL,
      startedAt: server.startedAt.toISOString(),
      dataDir: server.paths.dataDirId,
      sessions: server.sessionCounts(),
      stopping: server.stopping,
      safeMode,
      vaults: stores.vaults.size,
      pendingWrites: stores.pending(),
      ...(syncService === undefined ? {} : { sync: syncService.status() }),
      worker: { ...currentWorker, jobs: [...currentWorker.jobs] },
    };
  };

  const stop = (reason: ExitReason = "stop"): Promise<number> => {
    stopping ??= (async () => {
      const code = reason === "handover" ? HANDOVER_EXIT : CLEAN_EXIT;
      log.info("host.stopping", { reason, pendingWrites: stores.pending() });
      stores.invalidate();
      server.beginStop();
      stopBundle();
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (reason === "handover")
        await Promise.all([...mcpServers].map((b) => b.prepareHandover?.()));
      await Promise.all([...mcpServers].map((b) => b.close()));
      // The sync service's current iteration finishes and its vaults close while the lock is held.
      await (await sync)?.stop();
      await worker.stop();
      notifications?.dispose();
      devices.close();
      await Promise.allSettled([...creationRequests]);
      await creation?.drain();
      importManager?.close();
      strategyManager?.close();
      images.close();
      await stores.drain();
      await stores.close();
      // Before the lock goes: a successor host records its own start after taking the lock.
      record.clean();
      try {
        if (reason === "handover" && readUpdateAdmission(options.dataDir, options.pathEnv)) {
          recordUpdateHandoverComplete(
            server.lock,
            options.dataDir,
            {
              pid: process.pid,
              startedAt: server.startedAt.toISOString(),
              build,
              dataDirId: server.paths.dataDirId,
            },
            options.pathEnv,
          );
        }
      } finally {
        await server.close();
      }
      log.info("host.stopped", { reason, code });
      resolveExit(code);
      return code;
    })();
    return stopping;
  };

  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (sessions > 0 || stopping !== undefined) {
      idleDeadline = undefined;
      return;
    }
    idleDeadline ??= Date.now() + lingerMs;
    const check = () => {
      idleTimer = undefined;
      if (sessions > 0 || stopping !== undefined) return;
      if (
        stores.pending() > 0 ||
        worker.pending > 0 ||
        creation?.pending() ||
        devices.pending() > 0 ||
        creationRequests.size > 0
      ) {
        idleTimer = setTimeout(check, 1000);
        return;
      }
      void stop("idle");
    };
    idleTimer = setTimeout(check, Math.max(0, idleDeadline - Date.now()));
  };

  const stopBundle =
    options.bundlePath === undefined
      ? () => {}
      : watchBundleIdentity(options.bundlePath, options.bundleCheckMs ?? 15_000, () => {
          log.info("host.bundle-replaced");
          bundleReplaced = true;
          void stop("handover");
        });

  const serveCreationRequest = (
    session: HostSession,
    frame: Extract<import("@cashu/host-protocol").ClientFrame, { t: "req" }>,
  ) => {
    // Existing UI sessions survive beginStop until drain completes. Close the admission gate before
    // the drain snapshot, so no new Create work can run after shutdown releases HostLock.
    if (server.stopping || stopping !== undefined || bundleReplaced) {
      session.send({
        t: "res",
        id: frame.id,
        outcome: { ok: false, error: { code: "stopping", message: "host is stopping" } },
      });
      return;
    }
    if (
      creation === undefined ||
      !uiCreationAllowed(frame.method, session.protocol.minor, [NATIVE_CREATION_FEATURE])
    ) {
      session.send({
        t: "res",
        id: frame.id,
        outcome: { ok: false, error: { code: "unknown-method", message: "method unavailable" } },
      });
      return;
    }
    let verifiedReady = false;
    const request = Promise.resolve()
      .then(async () => {
        let result: unknown;
        switch (frame.method) {
          case "native.creation.prepare": {
            const parsed = nativeCreationPrepareParamsSchema.safeParse(frame.params);
            result = parsed.success
              ? nativeCreationPrepareResultSchema.parse(await creation.prepare(parsed.data))
              : { kind: "refused", code: "invalid_input" };
            break;
          }
          case "native.creation.commit": {
            const parsed = nativeCreationCommitParamsSchema.safeParse(frame.params);
            result = parsed.success
              ? nativeCreationCommitResultSchema.parse(await creation.commit(parsed.data))
              : { kind: "refused", code: "invalid_input" };
            verifiedReady = (result as { kind: string }).kind === "ready";
            break;
          }
          case "native.creation.inspect":
            result = nativeCreationInspectResultSchema.parse(
              await creation.inspect(nativeCreationInspectParamsSchema.parse(frame.params)),
            );
            break;
          case "native.creation.current":
            result = nativeCreationCurrentResultSchema.parse(
              await creation.current(nativeCreationCurrentParamsSchema.parse(frame.params)),
            );
            break;
          default:
            throw new Error("unknown_method");
        }
        try {
          session.send({
            t: "res",
            id: frame.id,
            outcome: { ok: true, result: result as import("@cashu/host-protocol/store").JsonValue },
          });
        } catch {
          // A disconnected caller reconciles with read-only inspect/current.
        }
        if (verifiedReady) setTimeout(() => void stop("handover"), 0);
      })
      .catch(() => {
        try {
          session.send({
            t: "res",
            id: frame.id,
            outcome: { ok: false, error: { code: "failed", message: "creation request failed" } },
          });
        } catch {
          // The client may already be gone.
        }
      })
      .finally(() => {
        creationRequests.delete(request);
        armIdle();
      });
    creationRequests.add(request);
  };

  const serveDevicesRequest = (
    session: HostSession,
    frame: Extract<import("@cashu/host-protocol").ClientFrame, { t: "req" }>,
  ) => {
    if (
      !nativeMode ||
      server.stopping ||
      stopping !== undefined ||
      bundleReplaced ||
      !uiDevicesAllowed(frame.method, session.protocol.minor, [NATIVE_DEVICES_FEATURE])
    ) {
      session.send({
        t: "res",
        id: frame.id,
        outcome: { ok: false, error: { code: "unknown-method", message: "method unavailable" } },
      });
      return;
    }
    const request = Promise.resolve()
      .then(async () => {
        let result: unknown;
        let requiresReopen = false;
        switch (frame.method) {
          case "native.devices.list": {
            const input = deviceListParamsSchema.safeParse(frame.params);
            result = input.success
              ? deviceListResultSchema.parse(await devices.list(input.data))
              : { kind: "refused", code: "invalid_input" };
            break;
          }
          case "native.devices.revokePreview": {
            const input = revokePreviewParamsSchema.safeParse(frame.params);
            result = input.success
              ? revokePreviewResultSchema.parse(await devices.preview(input.data))
              : { kind: "refused", code: "invalid_input" };
            break;
          }
          case "native.devices.revokeCommit": {
            const input = revokeCommitParamsSchema.safeParse(frame.params);
            result = input.success
              ? revokeCommitResultSchema.parse(await devices.commit(input.data))
              : { kind: "refused", code: "invalid_input" };
            requiresReopen = (result as { kind: string }).kind === "outcome_unknown";
            break;
          }
          case "native.devices.revokeInspect": {
            const input = revokeInspectParamsSchema.safeParse(frame.params);
            result = input.success
              ? revokeInspectResultSchema.parse(await devices.inspect(input.data))
              : { kind: "refused", code: "invalid_input" };
            break;
          }
          case "native.devices.revokeCancel": {
            const input = revokeCancelParamsSchema.safeParse(frame.params);
            result = input.success
              ? revokeCancelResultSchema.parse(await devices.cancel(input.data))
              : { kind: "refused", code: "invalid_input" };
            break;
          }
          default:
            result = { kind: "refused", code: "invalid_input" };
        }
        try {
          session.send({
            t: "res",
            id: frame.id,
            outcome: { ok: true, result: result as import("@cashu/host-protocol/store").JsonValue },
          });
        } finally {
          if (requiresReopen) setTimeout(() => void stop("handover"), 0);
        }
      })
      .catch(() => {
        try {
          session.send({
            t: "res",
            id: frame.id,
            outcome: { ok: true, result: { kind: "refused", code: "unavailable" } },
          });
        } catch {
          /* caller disconnected */
        }
      })
      .finally(() => {
        creationRequests.delete(request);
        armIdle();
      });
    creationRequests.add(request);
  };

  const serveNotificationRequest = (
    session: HostSession,
    frame: Extract<import("@cashu/host-protocol").ClientFrame, { t: "req" }>,
  ) => {
    const parsed = notificationResolveParamsSchema.safeParse(frame.params);
    const bound = notificationIntents;
    const request = Promise.resolve()
      .then(async () => {
        const target =
          session.protocol.minor >= 4 &&
          !server.stopping &&
          stopping === undefined &&
          !bundleReplaced &&
          parsed.success &&
          bound !== undefined
            ? await resolveNotificationIntent(
                bound,
                stores,
                notificationAuthority,
                parsed.data.requestId,
                parsed.data.intentToken,
                now,
              )
            : null;
        const result = notificationResolveResultSchema.parse(
          target === null
            ? { kind: "unavailable" }
            : {
                kind: "target",
                vaultId: target.vaultId,
                target: target.kind,
                ...(target.kind === "signal" ? { signalId: target.signalId } : {}),
              },
        );
        session.send({ t: "res", id: frame.id, outcome: { ok: true, result } });
      })
      .catch(() => {
        try {
          session.send({
            t: "res",
            id: frame.id,
            outcome: { ok: true, result: { kind: "unavailable" } },
          });
        } catch {
          /* Disconnected callers never receive a token-bearing error. */
        }
      })
      .finally(() => {
        creationRequests.delete(request);
        armIdle();
      });
    creationRequests.add(request);
  };

  const host: LocalHost = {
    server,
    lease,
    stores,
    safeMode,
    sync,
    capabilities,
    exit,
    status,
    stop,
    applySliced(vaultId, envelopes, sliceEvents = DEFAULT_SLICE_EVENTS) {
      const vault = stores.vaults.get(vaultId);
      if (vault === undefined)
        return Promise.reject(new Error("this vault is not open on this host"));
      if (vault.mode === "native")
        return Promise.reject(new Error("durable_apply_authority_unavailable"));
      const size = Math.max(1, Math.floor(sliceEvents));
      function* slices(): Generator<void, number> {
        let applied = 0;
        for (let i = 0; i < envelopes.length; i += size) {
          applied += vault?.store.applyEnvelopes(envelopes.slice(i, i + size)).applied ?? 0;
          if (i + size < envelopes.length) yield;
        }
        return applied;
      }
      return vault.queue.runSliced(slices());
    },
    syncVault(vaultId) {
      const session = stores.vaults.get(vaultId)?.native;
      if (session === undefined) return Promise.reject(new Error("native_sync_unavailable"));
      return session.sync();
    },
  };

  dispatch = (session) => {
    sessions += 1;
    armIdle();
    session.onClose(() => {
      sessions -= 1;
      armIdle();
    });
    switch (session.role) {
      case "ui":
        serveStoreChannel(session, {
          ...(creation === undefined && notificationIntents === undefined && !nativeMode
            ? {}
            : {
                onRequest: (frame) =>
                  frame.method === NOTIFICATION_INTENT_METHOD
                    ? serveNotificationRequest(session, frame)
                    : frame.method.startsWith("native.devices.")
                      ? serveDevicesRequest(session, frame)
                      : serveCreationRequest(session, frame),
              }),
          stores,
          queries,
          commands: uiCommands,
          actions: nativeMode
            ? [
                proposalManager,
                ...(options.updates === undefined ? [] : [updates.action]),
                ...(options.workspace === undefined ? [] : workspaceActions),
                ...(options.uiActions ?? []),
                ...(options.signals === undefined ? [] : signalActions),
                ...(importManager?.actions ?? []),
                ...(strategyManager?.actions ?? []),
              ]
            : [
                proposalManager,
                updates.action,
                ...workspaceActions,
                ...(options.uiActions ?? []),
                ...signalActions,
                ...(importManager?.actions ?? []),
                ...(strategyManager?.actions ?? []),
              ],
          prepareQuery: async (vault, query, args) => {
            if (query === "investments.strategies.screen") {
              const parsed = strategyScreenArgsSchema.safeParse(args);
              if (!parsed.success) throw new Error("invalid_query_input");
              if (!parsed.data.privacy)
                await strategyManager?.prepare(vault, parsed.data.selection);
            }
            await options.prepareUiQuery?.(vault, query, args);
          },
          privateQuery: (query, args) => {
            if (query === "core.desktopProposals.detail" || query === "core.desktopProposals.list")
              return (args as { privacy?: unknown } | undefined)?.privacy !== true;
            if (query === "device.settings.hostInfo")
              return (args as { privacy?: unknown } | undefined)?.privacy !== true;
            if (query === "device.settings.mcpAudit")
              return (args as { privacy?: unknown } | undefined)?.privacy !== true;
            const parsed =
              query === "investments.strategies.screen"
                ? strategyScreenArgsSchema.safeParse(args)
                : null;
            return (
              (parsed !== null && (!parsed.success || !parsed.data.privacy)) ||
              options.privateUiQuery?.(query, args) === true
            );
          },
          log,
          ...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight }),
          ...(options.afterCommit === undefined ? {} : { afterCommit: options.afterCommit }),
        });
        return;
      case "admin":
        handleAdmin(session, { status, stop, log });
        return;
      case "cli":
        serveCliSession(session, {
          dataDir: server.paths.dataDir,
          ported,
          delegated,
          python,
          log,
        });
        return;
      case "mcp":
        serveMcpSession(session, {
          log,
          start: (profile, open) => {
            const matchingVaults = [...stores.vaults.values()].filter(
              (v) => mcpProfile(v.store.read.bind(v.store))?.slug === profile,
            );
            if (matchingVaults.length > 1) {
              log.warn("mcp.profile.ambiguous");
              return undefined;
            }
            const vault = matchingVaults[0];
            if (nativeMode && (vault?.native === undefined || !vault.native.isCurrent()))
              return undefined;
            const child =
              python === undefined || (nativeMode && !vault?.native?.canRunSideEffects())
                ? undefined
                : startPythonMcp({
                    program: python,
                    dataDir: server.paths.dataDir,
                    profile,
                    open,
                    env: runtime.env,
                  });
            // TRANSITIONAL(S53b): a profile with no native vault is still owned wholly by Python.
            // Never take this path for a native profile after a policy or bridge failure.
            if (vault === undefined) return child;
            const legacyDataDir = nativeMode
              ? undefined
              : (options.mcpLegacyDataDir ??
                (runtime.checkout !== undefined &&
                (python === undefined ||
                  (python.command === join(runtime.checkout, ".venv", "bin", "cashu") &&
                    python.args.length === 0))
                  ? join(runtime.checkout, "data")
                  : undefined));
            const fileReader =
              legacyDataDir === undefined
                ? undefined
                : budgetFileReader({
                    cwd: existsSync(open.cwd) ? open.cwd : server.paths.dataDir,
                    home: mcpFileHome(runtime.env),
                    namedHome: (name) => mcpNamedHome(name, runtime.env),
                    dataDir: server.paths.dataDir,
                    legacyDataDir,
                  });
            const investmentScope =
              legacyDataDir === undefined
                ? undefined
                : {
                    cwd: existsSync(open.cwd) ? open.cwd : server.paths.dataDir,
                    home: mcpFileHome(runtime.env),
                    namedHome: (name: string) => mcpNamedHome(name, runtime.env),
                    dataDir: server.paths.dataDir,
                    legacyDataDir,
                  };
            const readInvestmentFile =
              investmentScope === undefined ? undefined : investmentFileReader(investmentScope);
            const readInvestmentMapping =
              investmentScope === undefined ? undefined : investmentMappingReader(investmentScope);
            // TRANSITIONAL(S22c): cached-market reads remain on the legacy source until a real
            // device cache is supplied. The restrictive bridge still enforces this vault's policy.
            const tools = coreTools().filter((tool) =>
              tool.name === "profile_overview"
                ? options.mcpPrices !== undefined && options.mcpFxNewest !== undefined
                : tool.name !== "networth_breakdown" || options.mcpPrices !== undefined,
            );
            // TRANSITIONAL(S38b): mixed sessions keep financial reads beside the Python writer.
            // Native payee identities and unsynchronized native category views cannot form a
            // consistent categorization workflow with the delegated setter. Loans also use cashflow.
            // S56c ingestion alone does not settle the blocked native classification write contract.
            tools.push(
              ...budgetTools().filter((tool) =>
                tool.name === "validate_budget_import"
                  ? fileReader !== undefined
                  : child === undefined,
              ),
            );
            if (child === undefined) tools.push(...loansTools());
            // TRANSITIONAL(S38c): delegated writers and native investment reads do not yet share
            // coherent authority. File-only tools are independent of the financial write model.
            tools.push(
              ...investmentTools().filter((tool) =>
                tool.name === "inspect_export" || tool.name === "validate_import"
                  ? readInvestmentFile !== undefined
                  : child === undefined &&
                    (tool.name === "signals" ||
                      tool.name === "theses" ||
                      (tool.name === "history_metrics"
                        ? options.mcpInvestmentHistory !== undefined
                        : options.mcpInvestmentReads !== undefined)),
              ),
            );
            if (child === undefined)
              tools.push(
                ...researchTools().filter((tool) =>
                  tool.name === "research_context" ? options.mcpResearch !== undefined : true,
                ),
              );
            if (child === undefined)
              tools.push(
                ...investmentWriteTools().filter(
                  (tool) => tool.name !== "watchlist" || options.mcpInvestmentWrites !== undefined,
                ),
              );
            const investmentAsync = options.mcpInvestmentAsync?.(vault.id);
            if (nativeMode) {
              const enabled = (name: string): boolean => {
                if (NATIVE_MCP_STORE_TOOLS.has(name)) return true;
                if (name === "profile_overview")
                  return options.mcpPrices !== undefined && options.mcpFxNewest !== undefined;
                if (name === "networth_breakdown") return options.mcpPrices !== undefined;
                if (NATIVE_MCP_INVESTMENT_READS.has(name))
                  return options.mcpInvestmentReads !== undefined;
                if (name === "history_metrics") return options.mcpInvestmentHistory !== undefined;
                if (NATIVE_MCP_RESEARCH.has(name)) return options.mcpResearch !== undefined;
                if (NATIVE_MCP_INVESTMENT_WRITES.has(name)) {
                  if (options.mcpInvestmentWrites === undefined) return false;
                  if (name === "add_to_watchlist")
                    return (
                      investmentAsync?.vault === vault.id &&
                      investmentAsync.watch?.vault === vault.id &&
                      investmentAsync.watch.isCurrent()
                    );
                  return true;
                }
                if (name === "search_instruments")
                  return (
                    investmentAsync?.vault === vault.id &&
                    investmentAsync.search?.vault === vault.id &&
                    investmentAsync.search.isCurrent()
                  );
                return false;
              };
              tools.splice(0, tools.length, ...tools.filter((tool) => enabled(tool.name)));
            }
            const inventory =
              child === undefined
                ? TOOL_INVENTORY.filter((entry) => tools.some((tool) => tool.name === entry.name))
                : TOOL_INVENTORY;
            const native = new NativeMcpServer(
              nativeRuntime({
                stores,
                vault,
                dataDir: server.paths.dataDir,
                now,
                replaced: () => bundleReplaced,
                log,
                inventory,
                prices: options.mcpPrices ?? null,
                fxNewest: options.mcpFxNewest,
                readBudgetImportFile: fileReader,
                investmentReads: options.mcpInvestmentReads,
                investmentHistory: options.mcpInvestmentHistory,
                research: options.mcpResearch,
                investmentWrites: options.mcpInvestmentWrites,
                investmentAsync,
                readInvestmentImportFile: readInvestmentFile,
                readInvestmentMappingFile: readInvestmentMapping,
              }),
              tools,
              [
                ...(tools.some((tool) => tool.name === "search_instruments")
                  ? [investmentSearchAdapter]
                  : []),
                ...(tools.some((tool) => tool.name === "add_to_watchlist")
                  ? [investmentWatchAdapter]
                  : []),
                ...(tools.some((tool) => tool.name === "propose_import")
                  ? [investmentImportAdapter]
                  : []),
              ],
            );
            return compositeBackend({ native, python: child, inventory, profile });
          },
          track: (backend) => {
            mcpServers.add(backend);
            return () => mcpServers.delete(backend);
          },
        });
        return;
    }
  };
  armIdle();
  return host;
}
