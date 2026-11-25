// The host's life after start: sessions keep it alive, an idle host lingers and exits 0, a replaced
// bundle hands over (exit 75), `stop` closes admission, releases every service in the order the
// composition root gives, drains and closes the stores, clears the crash record and only then lets
// the lock go.
import {
  type HostPathEnv,
  type HostSession,
  type RunningHost,
  readUpdateAdmission,
  recordUpdateHandoverComplete,
} from "@cashu/node-host";
import { watchBundleIdentity } from "@cashu/node-host/bundle-identity";
import { HANDOVER_EXIT } from "../bundle.js";
import type { StartRecord } from "../crashLoop.js";
import { errorName, type HostLog } from "../log.js";
import type { HostStores } from "../stores.js";

const CLEAN_EXIT = 0;
/** The internal stop result of an aborted start; no caller holds that host, so nothing reads it. */
const START_FAILED_EXIT = 1;
const IDLE_RECHECK_MS = 1000;
const DEFAULT_BUNDLE_CHECK_MS = 15_000;

export type ExitReason = "stop" | "idle" | "signal" | "handover";

interface HostLifecycle {
  /** Resolves with the exit code once the host stopped (0 clean, 75 handover). */
  readonly exit: Promise<number>;
  /**
   * Host RPCs the host answers itself (creation, devices, pairing, notification, banking) that are
   * still running: an idle host waits for them and `stop` settles them before closing the stores.
   */
  readonly inFlightRequests: Set<Promise<void>>;
  /** True once `stop` began. */
  stopRequested(): boolean;
  /** True once the verified bundle was replaced on disk. */
  bundleReplaced(): boolean;
  /** No new host work: the server is stopping, a stop began or the bundle was replaced. */
  closing(): boolean;
  stop(reason?: ExitReason): Promise<number>;
  /**
   * Undoes a start that failed after this lifecycle existed: no idle stop can fire afterwards, the
   * services started so far are released, the stores drain and close and the server closes (lock
   * and socket). The crash record stays: a failed start is not a clean exit. `exit` never resolves.
   */
  abortStart(): Promise<void>;
  /** Schedules the next stop on handover from a later task (never inside the caller's reply). */
  handoverSoon(): void;
  /** (Re)arms the idle timer: with no session and nothing pending the host stops after the linger. */
  armIdle(): void;
  /** Counts `session` until it closes. */
  admit(session: HostSession): void;
  /** Starts watching the verified bundle; its replacement stops the host with a handover. */
  watchBundle(): void;
}

export function createHostLifecycle(input: {
  readonly server: RunningHost;
  readonly stores: HostStores;
  readonly record: StartRecord;
  readonly log: HostLog;
  readonly build: string;
  readonly dataDir: string;
  readonly pathEnv: HostPathEnv | undefined;
  readonly lingerMs: number;
  readonly bundlePath: string | undefined;
  readonly bundleCheckMs: number | undefined;
  /** Work besides store writes and host RPCs that keeps an idle host alive. */
  busy(): boolean;
  /** Releases the services between closing admission and draining the stores, in order. */
  release(reason: ExitReason): Promise<void>;
  /**
   * Before an idle exit, with admission closed and the stores still current: last work that needs
   * the vaults (the relay's final push), bounded by the caller. `signal` aborts when a stronger stop
   * (signal, handover, admin stop) arrives meanwhile: the work must then resolve at once. Its failure
   * never stops the exit.
   */
  beforeIdleExit?(signal: AbortSignal): Promise<void>;
}): HostLifecycle {
  const { server, stores, record, log, build } = input;
  let resolveExit: (code: number) => void = () => {};
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  let stopping: Promise<number> | undefined;
  // While the idle exit runs its last work: a stronger stop aborts it and its reason wins.
  let idleWork: AbortController | undefined;
  let strongerReason: ExitReason | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let idleDeadline: number | undefined;
  let sessions = 0;
  let replaced = false;
  let stopBundle: () => void = () => {};
  const inFlightRequests = new Set<Promise<void>>();

  const stop = (requested: ExitReason = "stop"): Promise<number> => {
    if (stopping !== undefined && requested !== "idle" && idleWork !== undefined) {
      strongerReason ??= requested;
      log.info("host.stop-escalated", { reason: requested });
      idleWork.abort();
    }
    stopping ??= (async () => {
      log.info("host.stopping", { reason: requested, pendingWrites: stores.pending() });
      if (requested === "idle" && input.beforeIdleExit !== undefined) {
        server.beginStop();
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleWork = new AbortController();
        await input.beforeIdleExit(idleWork.signal).catch((error: unknown) => {
          log.warn("host.before-exit-failed", { error: errorName(error) });
        });
        idleWork = undefined;
      }
      const reason = strongerReason ?? requested;
      const code = reason === "handover" ? HANDOVER_EXIT : CLEAN_EXIT;
      stores.invalidate();
      server.beginStop();
      stopBundle();
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      await input.release(reason);
      await stores.drain();
      await stores.close();
      // Before the lock goes: a successor host records its own start after taking the lock.
      record.clean();
      try {
        if (reason === "handover" && readUpdateAdmission(input.dataDir, input.pathEnv)) {
          recordUpdateHandoverComplete(
            server.lock,
            input.dataDir,
            {
              pid: process.pid,
              startedAt: server.startedAt.toISOString(),
              build,
              dataDirId: server.paths.dataDirId,
            },
            input.pathEnv,
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

  const abortStart = async (): Promise<void> => {
    // A stop already in flight closes everything itself.
    if (stopping !== undefined) {
      await stopping;
      return;
    }
    const aborting = (async () => {
      stores.invalidate();
      server.beginStop();
      stopBundle();
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = undefined;
      try {
        await input.release("stop");
      } finally {
        try {
          await stores.drain();
          await stores.close();
        } finally {
          await server.close();
        }
      }
      log.info("host.start-aborted");
      return START_FAILED_EXIT;
    })();
    stopping = aborting;
    await aborting;
  };

  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (sessions > 0 || stopping !== undefined) {
      idleDeadline = undefined;
      return;
    }
    idleDeadline ??= Date.now() + input.lingerMs;
    const check = () => {
      idleTimer = undefined;
      if (sessions > 0 || stopping !== undefined) return;
      if (stores.pending() > 0 || input.busy() || inFlightRequests.size > 0) {
        idleTimer = setTimeout(check, IDLE_RECHECK_MS);
        return;
      }
      void stop("idle");
    };
    idleTimer = setTimeout(check, Math.max(0, idleDeadline - Date.now()));
  };

  return {
    exit,
    inFlightRequests,
    stopRequested: () => stopping !== undefined,
    bundleReplaced: () => replaced,
    closing: () => server.stopping || stopping !== undefined || replaced,
    stop,
    abortStart,
    handoverSoon: () => {
      setTimeout(() => void stop("handover"), 0);
    },
    armIdle,
    admit(session) {
      sessions += 1;
      armIdle();
      session.onClose(() => {
        sessions -= 1;
        armIdle();
      });
    },
    watchBundle() {
      if (input.bundlePath === undefined) return;
      stopBundle = watchBundleIdentity(
        input.bundlePath,
        input.bundleCheckMs ?? DEFAULT_BUNDLE_CHECK_MS,
        () => {
          log.info("host.bundle-replaced");
          replaced = true;
          void stop("handover");
        },
      );
    },
  };
}
