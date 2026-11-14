// Every client's way in: connect to the data dir's host, or start one and wait for it. A start is
// tried once per call; concurrent starters race harmlessly (the losers fail the lock DB and exit 3,
// HOST_BUSY_EXIT), so eight clients at once still end with one host. Retries back off from 20 ms,
// doubling to 250 ms, for up to 10 s. A host that answers `starting` (it holds the lock and is
// opening its stores, which takes a while for several vaults or after an upgrade's view rebuild) is
// waited for, not raced: no start, polls up to 1 s apart, and the bound grows to
// `startingDeadlineMs` (5 min) from the first such answer; `onStarting` reports the wait. A refusal
// (another major, another data dir, a bad role) is final. Nothing here is localized: the shim maps
// `HostStartError` (exit 69) to its catalog text.
import {
  type ConnectHostOptions,
  connectHost,
  HostConnectError,
  type HostConnection,
} from "./client.js";

/** Exit code (EX_UNAVAILABLE) of a client that could not reach or start the host. */
export const HOST_UNAVAILABLE_EXIT = 69;

export class HostStartError extends Error {
  readonly code = "host-unavailable";
  readonly exitCode = HOST_UNAVAILABLE_EXIT;
  readonly last: HostConnectError;

  constructor(last: HostConnectError) {
    super(
      last.kind === "starting"
        ? `the background host is still starting: ${last.message}`
        : `could not start or reach the background host: ${last.message}`,
    );
    this.name = "HostStartError";
    this.last = last;
  }

  /** A host was found but did not finish starting within the bound (it may still finish). */
  get starting(): boolean {
    return this.last.kind === "starting";
  }
}

export interface ConnectOrStartOptions extends ConnectHostOptions {
  /**
   * Starts a host (a detached spawn, or a service manager kick). Called at most once, never while a
   * host answers `starting`. Without it nothing is started: an absent host is thrown at once (the
   * retryable `HostConnectError`), and only a starting host is waited for.
   */
  readonly start?: () => void | Promise<void>;
  readonly deadlineMs?: number;
  /** The bound from the first `starting` answer (default 5 min). */
  readonly startingDeadlineMs?: number;
  /** Called before each wait for a starting host, with the time since its first `starting` answer. */
  readonly onStarting?: (elapsedMs: number) => void;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface ConnectOrStartResult {
  readonly connection: HostConnection;
  /** Whether this call started a host (it may have lost the race to another starter). */
  readonly started: boolean;
}

/** How often a starting host is asked again. */
const STARTING_POLL_MS = 1_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function connectOrStart(
  options: ConnectOrStartOptions,
): Promise<ConnectOrStartResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  let deadline = now() + (options.deadlineMs ?? 10_000);
  const maxBackoff = options.maxBackoffMs ?? 250;
  let wait = options.initialBackoffMs ?? 20;
  let started = false;
  let startingSince: number | undefined;
  for (;;) {
    try {
      return { connection: await connectHost(options), started };
    } catch (error) {
      if (!(error instanceof HostConnectError)) throw error;
      if (!error.retryable) throw error;
      if (error.kind === "starting") {
        if (startingSince === undefined) {
          startingSince = now();
          deadline = Math.max(deadline, startingSince + (options.startingDeadlineMs ?? 300_000));
        }
        if (now() >= deadline) throw new HostStartError(error);
        options.onStarting?.(now() - startingSince);
        await sleep(STARTING_POLL_MS);
        continue;
      }
      if (options.start === undefined) throw error;
      if (!started) {
        started = true;
        await options.start();
      }
      if (now() >= deadline) throw new HostStartError(error);
      await sleep(wait);
      wait = Math.min(wait * 2, maxBackoff);
    }
  }
}
