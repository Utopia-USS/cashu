// When the phone syncs (M4-D section 3; there is no push service and no "sync now"): after the first
// frame, on the return to the foreground (at most every 30 s per vault), every
// `FOREGROUND_PASS_EVERY_MS` while the app stays in the foreground (the runner owns that timer: a relay
// that went away shows as paused, a Mac's change arrives, without the owner leaving the app), a push-only pass on the
// arrival in the background when own writes wait, and inside the background task before the
// notification plan. One pass in flight per vault: a trigger while one runs joins it. Every pass goes
// through the vault's command queue (`VaultSession.pass`), so it never overlaps a command. A trigger
// that finds a vault still `opening` (the start right after a remount, a cold background launch) is
// remembered and decided once the open settled: one pass per vault however many triggers arrived
// meanwhile. The background task's whole sync step is bounded by `TASK_OPEN_WAIT_MS` from its start
// (opens and passes alike), so the notification plan after it always runs: the task is an iOS
// processing task, which may get minutes when the phone idles but can expire at any moment without the
// JS being told; a pass still running at the deadline goes on in the background. A vault whose open
// or pass failed with a code a new open can heal (`RETRYABLE_FAILURES`) is opened again on a return
// to the foreground (`retry`), backing off 1, 5, then 30 minutes between tries, then the foreground's
// pass once it opened; any other failure stays until the next launch. Pure: tested in Node with fake
// sessions and a fake clock.
import type { SyncResult } from "@cashu/sync/engine";
import type { VaultSyncStatus } from "../services/vaultEngine";

export type SyncTrigger = "start" | "foreground" | "background" | "task";

/** The part of a vault session the runner drives. */
export interface SyncTarget {
  readonly vault: string;
  status(): VaultSyncStatus;
  /** Resolves when the vault left `opening` (never rejects). */
  readonly opened: Promise<void>;
  /** Open a `failed` vault again (its status turns `opening`). */
  retry?(): void;
  pass(mode: "full" | "push"): Promise<SyncResult | undefined>;
}

export interface SyncRunner {
  /** Run the passes `trigger` asks for; resolves when every pass it started or joined settled. */
  request(trigger: SyncTrigger): Promise<void>;
  /**
   * The app is in the foreground (true) or left it (false): while in it, a `foreground` request every
   * `FOREGROUND_PASS_EVERY_MS`. Idempotent.
   */
  foreground(active: boolean): void;
}

/** The least time between two foreground passes of one vault. */
export const FOREGROUND_MIN_INTERVAL_MS = 30_000;

/** While the app stays in the foreground, a foreground pass at least this often (under 5 minutes). */
export const FOREGROUND_PASS_EVERY_MS = 4 * 60_000;

/** How long the background task's sync step may take before it plans with what synced. */
export const TASK_OPEN_WAIT_MS = 20_000;

/**
 * The failures a new open can heal: keys that were not readable (a Keychain that did not answer, a
 * keyring that came back), an open that threw something unexpected, a queue closed under it. Every
 * other code (an authority that does not check out, a rolled-back or mismatched log, `needs_repair`)
 * fails the same way on every open, and an open replays the whole log on the JS thread.
 */
const RETRYABLE_FAILURES: ReadonlySet<string> = new Set([
  "missing_authority",
  "keystore_unavailable",
  "vault_open_failed",
  "vault_queue_closed",
]);

/** The waits before the first, second and every later retry of one failed vault. */
const RETRY_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000];

/** A trigger asking for a full pass wins over the push-only one when several wait for one open. */
function stronger(a: SyncTrigger, b: SyncTrigger): SyncTrigger {
  return a === "background" ? b : a;
}

export function createSyncRunner(options: {
  readonly targets: () => readonly SyncTarget[];
  readonly now: () => number;
  /** Resolves after `ms` (a cleared `setTimeout` when omitted); the task's sync deadline. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Runs `tick` every `ms` until the returned stop is called (`setInterval` when omitted). */
  readonly every?: (ms: number, tick: () => void) => () => void;
}): SyncRunner {
  const inFlight = new Map<string, Promise<void>>();
  const startedAt = new Map<string, number>();
  /** Per vault still opening: the strongest trigger that arrived meanwhile and the run after the open. */
  const waiting = new Map<string, { trigger: SyncTrigger; run: Promise<void> }>();
  /** Per failed vault: retries so far and when the last try (or the failure's sighting) was. */
  const retries = new Map<string, { tries: number; at: number }>();

  /** A `failed` vault whose code can heal and whose back-off has passed is opened again. */
  const maybeRetry = (target: SyncTarget, trigger: SyncTrigger): void => {
    const status = target.status();
    if (status.phase !== "failed") {
      if (status.phase !== "opening") retries.delete(target.vault);
      return;
    }
    const now = options.now();
    const seen = retries.get(target.vault);
    if (seen === undefined) {
      // First sighting of this failure: the back-off counts from here.
      retries.set(target.vault, { tries: 0, at: now });
      return;
    }
    if (trigger !== "foreground" || target.retry === undefined) return;
    if (!RETRYABLE_FAILURES.has(status.failure ?? "")) return;
    const wait = RETRY_BACKOFF_MS[Math.min(seen.tries, RETRY_BACKOFF_MS.length - 1)] ?? 0;
    if (now - seen.at < wait) return;
    retries.set(target.vault, { tries: seen.tries + 1, at: now });
    target.retry();
  };

  const due = (target: SyncTarget, trigger: SyncTrigger): "full" | "push" | undefined => {
    const status = target.status();
    if (!status.remote) return undefined;
    if (status.phase !== "ready" && status.phase !== "receiving" && status.phase !== "waiting")
      return undefined;
    if (trigger === "background") return status.unpushed ? "push" : undefined;
    if (trigger === "foreground") {
      const last = Math.max(status.lastPullAt ?? 0, startedAt.get(target.vault) ?? 0);
      if (last > 0 && options.now() - last < FOREGROUND_MIN_INTERVAL_MS) return undefined;
    }
    return "full";
  };

  const start = (target: SyncTarget, trigger: SyncTrigger): Promise<void> => {
    const running = inFlight.get(target.vault);
    if (running !== undefined) return running;
    const mode = due(target, trigger);
    if (mode === undefined) return Promise.resolve();
    startedAt.set(target.vault, options.now());
    const pass = target
      .pass(mode)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => inFlight.delete(target.vault));
    inFlight.set(target.vault, pass);
    return pass;
  };

  /** Remember `trigger` for a vault still opening; decided (once) when the open settled. */
  const afterOpen = (target: SyncTarget, trigger: SyncTrigger): Promise<void> => {
    const pending = waiting.get(target.vault);
    if (pending !== undefined) {
      pending.trigger = stronger(pending.trigger, trigger);
      return pending.run;
    }
    const entry: { trigger: SyncTrigger; run: Promise<void> } = { trigger, run: Promise.resolve() };
    entry.run = target.opened
      .catch(() => undefined)
      .then(() => {
        waiting.delete(target.vault);
        // An open that healed the vault starts its back-off over.
        if (target.status().phase !== "failed") retries.delete(target.vault);
        return start(target, entry.trigger);
      });
    waiting.set(target.vault, entry);
    return entry.run;
  };

  const every =
    options.every ??
    ((ms: number, tick: () => void) => {
      const timer = setInterval(tick, ms);
      return () => clearInterval(timer);
    });
  let stopForeground: (() => void) | undefined;

  const runner: SyncRunner = {
    foreground(active) {
      if (!active) {
        stopForeground?.();
        stopForeground = undefined;
        return;
      }
      if (stopForeground !== undefined) return;
      stopForeground = every(FOREGROUND_PASS_EVERY_MS, () => void runner.request("foreground"));
    },
    request(trigger) {
      const passes = options.targets().map((target) => {
        maybeRetry(target, trigger);
        if (target.status().phase !== "opening") return start(target, trigger);
        return afterOpen(target, trigger);
      });
      const all = Promise.all(passes).then(() => undefined);
      if (trigger !== "task") return all;
      // The task may expire at any moment: plan with what synced in time (the passes still run).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline =
        options.sleep?.(TASK_OPEN_WAIT_MS) ??
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, TASK_OPEN_WAIT_MS);
        });
      return Promise.race([all, deadline]).finally(() => clearTimeout(timer));
    },
  };
  return runner;
}

/** Why a vault's data may be behind, for the stale banner; null when sync is not the reason. */
export type SyncCause = "receiving" | "removed" | "offline" | "quota" | "failed";

export function syncCause(status: VaultSyncStatus | undefined): SyncCause | null {
  if (status === undefined || !status.remote) return null;
  // Waiting for another device's key rotation reads like waiting for its data.
  if (status.phase === "receiving" || status.phase === "waiting") return "receiving";
  if (status.phase === "removed" || status.relay?.lastError === "forbidden") return "removed";
  if (status.phase === "failed") return "failed";
  if (status.relay?.lastError === "quota") return "quota";
  if (status.relay?.lastError !== undefined || status.failure === "relay_unreachable")
    return "offline";
  return null;
}
