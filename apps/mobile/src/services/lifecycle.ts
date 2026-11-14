// The services' lifecycle (pure, tested in Node): closing every open database of one services
// instance once, and the root's epoch and phase: the epoch remounts the app's tree when the services are
// rebuilt (the phone wipe), so every query cache, subscription and screen state starts over on the new
// stores; the phase replaces the tree while the wipe runs, and for good when it failed.

interface Closable {
  close(): void;
}

export interface ServicesParts {
  /** The query client (its `dispose` releases every live query before the stores close). */
  readonly client: { dispose(): void };
  readonly vaults: Iterable<Closable>;
  readonly prices: Closable;
  readonly device: Closable;
}

/**
 * `close()` of one services instance: the client first, then every vault store, the price cache and the
 * device store. Idempotent (a second call does nothing). Every part is closed even when one throws;
 * the first failure is rethrown after the rest.
 */
export function servicesCloser(parts: ServicesParts): () => void {
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    const attempt = (close: () => void) => {
      try {
        close();
      } catch (error) {
        failures.push(error);
      }
    };
    attempt(() => parts.client.dispose());
    for (const vault of parts.vaults) attempt(() => vault.close());
    attempt(() => parts.prices.close());
    attempt(() => parts.device.close());
    if (failures.length > 0) throw failures[0];
  };
}

/**
 * What the root shows: the app (`ready`), nothing while the services open their paired vaults' keys
 * (`opening`, a fraction of a second at launch or after a pairing), the full-screen "Removing this
 * phone's copy" state while a wipe runs (`wiping`; the app's tree is unmounted, so nothing reads a store
 * being closed), or the fatal "close cashU and open it again" state when a wipe could not close, delete
 * or rebuild (`failed`).
 */
export type RootPhase = "ready" | "opening" | "wiping" | "failed";

let epoch = 0;
let phase: RootPhase = "ready";
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** `useSyncExternalStore` source of the root's remount key and phase. */
export function subscribeEpoch(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEpoch(): number {
  return epoch;
}

export function getRootPhase(): RootPhase {
  return phase;
}

/** The services are (re)opening: the root unmounts the app until `bumpEpoch`. */
export function showOpening(): void {
  phase = "opening";
  notify();
}

/** The wipe started: the root shows the "Removing" state instead of the app. */
export function showWiping(): void {
  phase = "wiping";
  notify();
}

/**
 * Remount the app's tree over the services `bootServices()` returns now (`ready`), or show the fatal
 * state (`failed`) when there are no usable services to mount.
 */
export function bumpEpoch(next: "ready" | "failed" = "ready"): void {
  epoch++;
  phase = next;
  notify();
}
