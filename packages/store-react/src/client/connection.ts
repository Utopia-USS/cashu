// The store client's connection to the process that runs the store engine, as the UI shows it. The
// in-process client (phone, tests) is always `online`. The desktop renderer's port client follows the
// relay's link (host-protocol/store relay.ts):
//   connecting   first connect, or reconnecting after the host went away
//   starting     the background service (local host) is being started
//   online       connected
//   recovered    connected again after a loss (shown briefly, then `online`)
//   unavailable  the background service could not be started; the app keeps retrying
// While not connected the snapshots stay as they were (stale): the UI keeps showing them and says so.
export type ConnectionStatus = "connecting" | "starting" | "online" | "recovered" | "unavailable";

/** What `useConnection` reads (useSyncExternalStore shape). */
export interface ConnectionSource {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => ConnectionStatus;
}

/** True while the shown snapshots may be out of date (no live connection to the store). */
export function isStale(status: ConnectionStatus): boolean {
  return status === "connecting" || status === "starting" || status === "unavailable";
}

/** The connection of a client whose store runs in this runtime: always online. */
export const ALWAYS_ONLINE: ConnectionSource = Object.freeze({
  subscribe: () => () => {},
  getSnapshot: () => "online" as const,
});

/** A settable connection status with listeners. */
export class ConnectionState implements ConnectionSource {
  #status: ConnectionStatus;
  readonly #listeners = new Set<() => void>();

  constructor(initial: ConnectionStatus) {
    this.#status = initial;
  }

  readonly subscribe = (onChange: () => void): (() => void) => {
    this.#listeners.add(onChange);
    return () => this.#listeners.delete(onChange);
  };

  readonly getSnapshot = (): ConnectionStatus => this.#status;

  set(status: ConnectionStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    for (const listener of [...this.#listeners]) listener();
  }
}
