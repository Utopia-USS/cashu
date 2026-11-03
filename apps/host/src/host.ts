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
import { homedir } from "node:os";
import { join } from "node:path";
import type { market } from "@cashu/domain/investments";
import { type AdminStatus, HOST_PROTOCOL } from "@cashu/host-protocol";
import {
  budgetTools,
  coreTools,
  type InvestmentHistoryReads,
  type InvestmentReads,
  investmentTools,
  loansTools,
  NativeMcpServer,
  type NativeToolStore,
  type ToolContext,
} from "@cashu/mcp";
import {
  type HostPathEnv,
  type HostSession,
  type RunningHost,
  refusePaths,
  startHost,
} from "@cashu/node-host";
import { mcpProfile } from "@cashu/store/core";
import { handleAdmin } from "./admin.js";
import { HANDOVER_EXIT, watchBundle } from "./bundle.js";
import type { CategorizeProvider, CloudCategorizeProvider } from "./cli/budget/categorizeOllama.js";
import { DELEGATED } from "./cli/delegated.js";
import { portedCommands } from "./cli/ported.js";
import { serveCliSession } from "./cli/runner.js";
import type { PortedCommand } from "./cli/tree.js";
import { recordStart, type StartRecord } from "./crashLoop.js";
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
import { SERVED_COMMANDS, servedQueries } from "./registry.js";
import {
  currentRuntime,
  type HostRuntime,
  type Program,
  pythonProgram,
  shimProgram,
} from "./runtime.js";
import { serveStoreChannel } from "./storeChannel.js";
import { type HostStores, openHostStores } from "./stores.js";
import { bridgeCommand } from "./sync/command.js";
import type { CrashPoint } from "./sync/loop.js";
import { SyncService } from "./sync/service.js";
import type { WorkerBindings, WorkerHostContext } from "./worker/contracts.js";
import { startWorker } from "./worker/service.js";

const DEFAULT_LINGER_MS = 10 * 60 * 1000;
const DEFAULT_BUNDLE_CHECK_MS = 60 * 1000;
const DEFAULT_SLICE_EVENTS = 1_000;
const CLEAN_EXIT = 0;

type ExitReason = "stop" | "idle" | "signal" | "handover";

export interface LocalHostOptions {
  /** Explicit per-vault capabilities only. Production authority/consent/credential binding is separate. */
  readonly budgetClassifiers?: {
    readonly local?: CategorizeProvider;
    readonly cloud?: CloudCategorizeProvider;
  };
  /** Injected only after genuine per-job ownership and per-vault authority are available. */
  readonly worker?: (context: WorkerHostContext) => WorkerBindings;
  /** Actual device cache and its committed changes. Without a cache, overview uses last trades.
   * Persistent production cache lifecycle remains TRANSITIONAL(S53b). */
  readonly overview?: Parameters<typeof servedQueries>[0];
  readonly dataDir: string;
  readonly build?: string;
  /** How long an idle host (no session, nothing queued) stays before it exits 0. */
  readonly lingerMs?: number;
  /** A file of the bundle this host runs from; its replacement triggers a handover (exit 75). */
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
}

/** Starts the data dir's host. Throws `HostBusyError` when another host holds the lock. */
export async function startLocalHost(options: LocalHostOptions): Promise<LocalHost> {
  // TRANSITIONAL(S53b): the synthetic store source must never write into the owner's real cashU
  // data dir; the real vault source (keyring salts, paired identity) lifts this.
  refusePaths(
    { dataDir: { label: "data dir", path: options.dataDir }, outputs: [] },
    options.home ?? homedir(),
  );
  const now = options.now ?? Date.now;
  const queries = servedQueries(options.overview);
  const build = options.build ?? "dev";
  const lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
  let dispatch: (session: HostSession) => void = (session) => session.close();
  const server = await startHost({
    dataDir: options.dataDir,
    build,
    features: [
      "store.v2",
      "admin.handover",
      "cli.exec",
      "mcp.lines",
      "sync.status",
      "worker.status",
    ],
    ...(options.pathEnv === undefined ? {} : { pathEnv: options.pathEnv }),
    onSession: (session) => dispatch(session),
  });
  const log = options.log ?? fileLog(server.paths.logPath);

  let record: StartRecord;
  let stores: HostStores;
  let lease: WriterLease;
  try {
    record = recordStart(server.paths.runDir, now());
    lease = takeWriterLease(server.lock);
    stores = openHostStores(server.paths.dataDir, lease, log, now);
  } catch (error) {
    log.error("host.start-failed", { error: errorName(error) });
    await server.close();
    throw error;
  }
  const safeMode = record.safeMode;
  const runtime = options.runtime ?? currentRuntime();
  const python =
    options.python === undefined ? pythonProgram(runtime) : (options.python ?? undefined);
  const capabilities = { jobs: !safeMode, network: !safeMode };
  let syncService: SyncService | undefined;
  const sync: Promise<SyncService | undefined> = SyncService.start({
    dataDir: server.paths.dataDir,
    home: options.home ?? homedir(),
    lease,
    log,
    capabilities,
    now,
    ...(options.syncAt === undefined ? {} : { at: options.syncAt }),
  }).then(
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
  const ported = [
    ...(options.ported ??
      portedCommands({
        runtime,
        now,
        ...(python === undefined
          ? {
              nativeStores: stores,
              classifier: options.budgetClassifiers?.local,
              cloudClassifier: options.budgetClassifiers?.cloud,
            }
          : {}),
      })),
    bridgeCommand(() => sync),
  ];
  const portedNames = new Set(ported.map((command) => command.name));
  const delegated = Object.fromEntries(
    Object.entries(DELEGATED).filter(([name]) => !portedNames.has(name)),
  );
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
  const workerContext: WorkerHostContext = {
    stores,
    now: () => now(),
    isCurrent: (vault) =>
      stopping === undefined && !bundleReplaced && stores.vaults.get(vault.id) === vault,
    jobsEnabled: () => capabilities.jobs && stopping === undefined && !bundleReplaced,
    networkEnabled: () => capabilities.network && stopping === undefined && !bundleReplaced,
    uiCount: () => server.sessionCounts().ui,
  };
  let workerBindings: WorkerBindings | undefined;
  try {
    workerBindings = options.worker?.(workerContext);
  } catch (error) {
    log.warn("worker.binding-failed", { error: errorName(error) });
  }
  const worker = startWorker(workerContext, workerBindings);

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
      server.beginStop();
      stopBundle();
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (reason === "handover")
        await Promise.all([...mcpServers].map((b) => b.prepareHandover?.()));
      await Promise.all([...mcpServers].map((b) => b.close()));
      // The sync service's current iteration finishes and its vaults close while the lock is held.
      await (await sync)?.stop();
      await worker.stop();
      await stores.drain();
      stores.close();
      // Before the lock goes: a successor host records its own start after taking the lock.
      record.clean();
      await server.close();
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
      if (stores.pending() > 0 || worker.pending > 0) {
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
      : watchBundle(options.bundlePath, options.bundleCheckMs ?? DEFAULT_BUNDLE_CHECK_MS, () => {
          log.info("host.bundle-replaced");
          bundleReplaced = true;
          void stop("handover");
        });

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
          stores,
          queries,
          commands: SERVED_COMMANDS,
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
            const vault = [...stores.vaults.values()].find(
              (v) => mcpProfile(v.store.read.bind(v.store))?.slug === profile,
            );
            const child =
              python === undefined
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
            const legacyDataDir =
              options.mcpLegacyDataDir ??
              (runtime.checkout !== undefined &&
              (python === undefined ||
                (python.command === join(runtime.checkout, ".venv", "bin", "cashu") &&
                  python.args.length === 0))
                ? join(runtime.checkout, "data")
                : undefined);
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
                readInvestmentImportFile: readInvestmentFile,
                readInvestmentMappingFile: readInvestmentMapping,
              }),
              tools,
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
