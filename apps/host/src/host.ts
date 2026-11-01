// The local host's composition root: one per data dir, the only process that opens this device's
// stores. Started on demand by its first client (owner decision: no always-on service), it:
//   1. takes the machine lock and the socket (`startHost`, @cashu/node-host; a second host fails with
//      HostBusyError, exit 3),
//   2. records its start (crash-loop detection: after repeated crashes it runs in safe mode),
//   3. opens the stores under the writer lease (exclusive SQLite opens; damaged views recovered),
//   4. serves sessions by role: `ui` gets the store channel v2, `admin` gets status / stop / handover,
//      `cli` the hosted command tree (cli/runner.ts), `mcp` an MCP server for its profile (mcp/session.ts);
//      writes the stable launcher `<data dir>/bin/cashu` (launcher.ts),
//   5. lingers while idle (no session, no queued write) and then exits 0; exits 75 when its bundle
//      was replaced (handover); a signal or `admin.stop` exits 0.
// Everything is logged as codes and counts (log.ts). A clean exit clears the crash record.
import { homedir } from "node:os";
import { type AdminStatus, HOST_PROTOCOL } from "@cashu/host-protocol";
import {
  type HostPathEnv,
  type HostSession,
  type RunningHost,
  refusePaths,
  startHost,
} from "@cashu/node-host";
import { handleAdmin } from "./admin.js";
import { HANDOVER_EXIT, watchBundle } from "./bundle.js";
import { DELEGATED } from "./cli/delegated.js";
import { portedCommands } from "./cli/ported.js";
import { serveCliSession } from "./cli/runner.js";
import type { PortedCommand } from "./cli/tree.js";
import { recordStart, type StartRecord } from "./crashLoop.js";
import { writeLauncher } from "./launcher.js";
import { takeWriterLease, type WriterLease } from "./lease.js";
import { errorName, fileLog, type HostLog } from "./log.js";
import { startPythonMcp } from "./mcp/python.js";
import { type McpBackend, serveMcpSession } from "./mcp/session.js";
import { SERVED_COMMANDS, SERVED_QUERIES } from "./registry.js";
import {
  currentRuntime,
  type HostRuntime,
  type Program,
  pythonProgram,
  shimProgram,
} from "./runtime.js";
import { serveStoreChannel } from "./storeChannel.js";
import { type HostStores, openHostStores } from "./stores.js";

const DEFAULT_LINGER_MS = 10 * 60 * 1000;
const DEFAULT_BUNDLE_CHECK_MS = 60 * 1000;
const DEFAULT_SLICE_EVENTS = 1_000;
const CLEAN_EXIT = 0;

type ExitReason = "stop" | "idle" | "signal" | "handover";

export interface LocalHostOptions {
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
}

export interface LocalHost {
  readonly server: RunningHost;
  readonly lease: WriterLease;
  readonly stores: HostStores;
  readonly safeMode: boolean;
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
  const build = options.build ?? "dev";
  const lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
  let dispatch: (session: HostSession) => void = (session) => session.close();
  const server = await startHost({
    dataDir: options.dataDir,
    build,
    features: ["store.v2", "admin.handover", "cli.exec", "mcp.lines"],
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
  const ported = options.ported ?? portedCommands();
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
  let sessions = 0;

  const status = (): AdminStatus => ({
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
  });

  const stop = (reason: ExitReason = "stop"): Promise<number> => {
    stopping ??= (async () => {
      const code = reason === "handover" ? HANDOVER_EXIT : CLEAN_EXIT;
      log.info("host.stopping", { reason, pendingWrites: stores.pending() });
      server.beginStop();
      stopBundle();
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      await Promise.all([...mcpServers].map((b) => b.close()));
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
    if (sessions > 0 || stopping !== undefined) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (sessions > 0 || stopping !== undefined) return;
      if (stores.pending() > 0) {
        armIdle();
        return;
      }
      void stop("idle");
    }, lingerMs);
  };

  const stopBundle =
    options.bundlePath === undefined
      ? () => {}
      : watchBundle(options.bundlePath, options.bundleCheckMs ?? DEFAULT_BUNDLE_CHECK_MS, () => {
          log.info("host.bundle-replaced");
          void stop("handover");
        });

  const host: LocalHost = {
    server,
    lease,
    stores,
    safeMode,
    capabilities: { jobs: !safeMode, network: !safeMode },
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
          queries: SERVED_QUERIES,
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
          delegated: DELEGATED,
          python,
          log,
        });
        return;
      case "mcp":
        serveMcpSession(session, {
          log,
          start: (profile, open) =>
            python === undefined
              ? undefined
              : startPythonMcp({
                  program: python,
                  dataDir: server.paths.dataDir,
                  profile,
                  open,
                  env: runtime.env,
                }),
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
