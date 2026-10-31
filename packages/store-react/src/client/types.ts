// The client side of the store bindings: what `useQuery` / `useCommand` talk to. One client serves the
// device store and every vault open on this device; a `Target` names which one. Two adapters fill it:
// in-process (the phone, tests: synchronous reads, never suspends) and a MessagePort to the desktop's
// store process (asynchronous first read, snapshots pushed afterwards).
import type { Command, CommandResult } from "@cashu/store";
import type { DeviceCommand } from "@cashu/store/device";
import type { Query, QueryArgs } from "@cashu/store/query";

/** The store a query or command runs against: the device store, or one vault's store. */
export type Target =
  | { readonly kind: "device" }
  | { readonly kind: "vault"; readonly vault: string };

export const DEVICE_TARGET: Target = Object.freeze({ kind: "device" });

/** A vault command or a device command (the command's own `scope` tells which store it writes). */
export type AnyCommand<I = unknown, R = unknown, In = unknown> =
  | Command<I, R, In>
  | DeviceCommand<I, R, In>;

/** Where a query run's result goes. */
export interface Sink {
  value(value: unknown): void;
  error(error: unknown): void;
}

/** What the snapshot cache needs from a transport. */
export interface Adapter {
  /** Vaults open on this device (the profiles a user can switch between). */
  readonly vaults: readonly string[];
  /** Start a live query; the sync adapter delivers its first value before returning. */
  open(target: Target, query: Query<QueryArgs, unknown>, args: QueryArgs, sink: Sink): () => void;
  /** Run a command; expected failures resolve as `{ ok: false }`, unexpected ones reject. */
  run(target: Target, command: AnyCommand, input: unknown): Promise<CommandResult<unknown>>;
}

/** The state of one snapshot, as `useSyncExternalStore` reads it (identity changes on every change). */
export type SnapshotState<R> =
  | { readonly status: "pending" }
  | { readonly status: "value"; readonly value: R }
  | { readonly status: "error"; readonly error: unknown };

/** One cached snapshot (one per target + query key), shared by every reader of that key. */
export interface QueryEntry<R> {
  /** Subscribe for changes (ref-counted; the last unsubscribe releases the live query). */
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => SnapshotState<R>;
  /**
   * Settles with the first value (or the first read's error). It carries React's thenable fields
   * (`status`, `value`), so `use(ready)` returns at once when it already settled: it suspends only
   * while a first read is in flight, which never happens with the sync adapter.
   */
  readonly ready: PromiseLike<void>;
}

export interface StoreClient {
  readonly vaults: readonly string[];
  /** Whether a first read waits for another process (the desktop renderer) and may suspend. */
  readonly async: boolean;
  entry<A extends QueryArgs, R>(target: Target, query: Query<A, R>, args: A): QueryEntry<R>;
  run<I, R, In>(
    target: Target,
    command: AnyCommand<I, R, In>,
    input: In,
  ): Promise<CommandResult<R>>;
}

/** A message channel (a DOM / Node MessagePort, Electron's MessagePortMain), adapted by the app. */
export interface Channel {
  post(message: unknown): void;
  listen(handler: (message: unknown) => void): () => void;
}
