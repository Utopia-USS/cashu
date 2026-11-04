// The snapshot cache under `useQuery`: one entry per target + `queryKey(query, args)`, shared by every
// component that reads it. The first reader opens the live query; readers subscribe (ref-counted);
// when the last one leaves, the entry lingers briefly (a remount or a StrictMode double effect reuses
// it) and is then released, which stops the live query. Every pushed value is structurally shared with
// the previous one, and an unchanged value notifies nobody.
import { mintUlid } from "@cashu/store";
import { type Query, type QueryArgs, queryKey } from "@cashu/store/query";
import type { UiAction, UiActionResult } from "@cashu/store/ui-actions";
import { ALWAYS_ONLINE, type ConnectionSource } from "./connection.js";
import { replaceEqual } from "./structural.js";
import type {
  Adapter,
  AnyCommand,
  CommandAttempt,
  CommandOutcome,
  QueryEntry,
  SnapshotState,
  StoreClient,
  Target,
} from "./types.js";

export interface CacheOptions {
  /** True when first reads cross a process boundary (they may suspend). */
  readonly async: boolean;
  /** How long an entry nobody reads any more stays open (default 1 s). */
  readonly lingerMs?: number;
  /** How long an entry opened by a render that never subscribed stays open (default 10 s). */
  readonly idleMs?: number;
  /** The link to the store's process (default: always online, the in-process client). */
  readonly connection?: ConnectionSource;
  readonly mintKey?: () => string;
}

function targetKey(target: Target): string {
  return target.kind === "device" ? "device" : `vault:${target.vault}`;
}

/** A promise with the fields React's `use` reads to return a settled value without suspending. */
type Thenable = Promise<void> & {
  status?: "pending" | "fulfilled" | "rejected";
  value?: undefined;
  reason?: unknown;
};

function settledThenable(): Thenable {
  const thenable: Thenable = Promise.resolve();
  thenable.status = "fulfilled";
  thenable.value = undefined;
  return thenable;
}

class Entry<R> implements QueryEntry<R> {
  #state: SnapshotState<R> = { status: "pending" };
  #ready!: Thenable;
  #settle: { resolve(): void; reject(error: unknown): void } | null = null;
  #close: (() => void) | null = null;
  #refs = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #listeners = new Set<() => void>();

  private readonly cache: QueryCache;
  readonly key: string;
  private readonly target: Target;
  private readonly query: Query<QueryArgs, R>;
  private readonly args: QueryArgs;

  constructor(
    cache: QueryCache,
    key: string,
    target: Target,
    query: Query<QueryArgs, R>,
    args: QueryArgs,
  ) {
    this.cache = cache;
    this.key = key;
    this.target = target;
    this.query = query;
    this.args = args;
    this.#makePending();
  }

  #makePending(): void {
    let settle: { resolve(): void; reject(error: unknown): void } | null = null;
    const ready: Thenable = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    ready.status = "pending";
    // A rejection is read through the snapshot (thrown to the error boundary); never unhandled.
    ready.catch(() => {});
    this.#ready = ready;
    this.#settle = {
      resolve: () => {
        ready.status = "fulfilled";
        ready.value = undefined;
        settle?.resolve();
      },
      reject: (error) => {
        ready.status = "rejected";
        ready.reason = error;
        settle?.reject(error);
      },
    };
  }

  /** Discard a snapshot from the old UI policy before a new subscription can deliver. */
  reset(): void {
    this.#settle?.resolve();
    this.#state = { status: "pending" };
    this.#makePending();
  }

  notify(): void {
    this.#notify();
  }

  get ready(): PromiseLike<void> {
    return this.#ready;
  }

  get open(): boolean {
    return this.#close !== null;
  }

  start(): void {
    if (this.#close !== null) return;
    let closed = false;
    const close = this.cache.adapter.open(this.target, this.query, this.args, {
      value: (value) => {
        if (!closed) this.#push(value as R);
      },
      error: (error) => {
        if (!closed) this.#fail(error);
      },
    });
    this.#close = () => {
      closed = true;
      close();
    };
    if (this.#refs === 0) this.#schedule(this.cache.idleMs);
  }

  readonly subscribe = (onChange: () => void): (() => void) => {
    this.#refs += 1;
    this.#cancel();
    if (this.#close === null) this.cache.revive(this);
    this.#listeners.add(onChange);
    return () => {
      this.#listeners.delete(onChange);
      this.#refs -= 1;
      if (this.#refs === 0) this.#schedule(this.cache.lingerMs);
    };
  };

  readonly getSnapshot = (): SnapshotState<R> => this.#state;

  #push(incoming: R): void {
    const prev = this.#state;
    if (prev.status === "value") {
      const value = replaceEqual(prev.value, incoming);
      if (value === prev.value) return;
      this.#state = { status: "value", value };
    } else {
      this.#state = { status: "value", value: incoming };
      if (this.#settle !== null) {
        this.#settle.resolve();
        this.#settle = null;
      } else if (this.#ready.status === "rejected") {
        // The first read failed and a later run succeeded: readers mounting now get the value.
        this.#ready = settledThenable();
      }
    }
    this.#notify();
  }

  #fail(error: unknown): void {
    this.#state = { status: "error", error };
    this.#settle?.reject(error);
    this.#settle = null;
    this.#notify();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #schedule(ms: number): void {
    this.#cancel();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#refs === 0) this.release();
    }, ms);
  }

  #cancel(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  release(): void {
    this.#cancel();
    this.#close?.();
    this.#close = null;
    this.cache.forget(this);
  }
}

export class QueryCache implements StoreClient {
  invoke<I, R>(target: Target, action: UiAction<I, R>, input: I): Promise<UiActionResult<R>> {
    if (this.adapter.invoke === undefined)
      return Promise.resolve({ status: "not_started", reason: "capability_unavailable" });
    return this.adapter.invoke(target, action, input) as Promise<UiActionResult<R>>;
  }
  readonly adapter: Adapter;
  readonly async: boolean;
  readonly lingerMs: number;
  readonly idleMs: number;
  readonly connection: ConnectionSource;
  readonly mintKey: () => string;
  readonly #entries = new Map<string, Entry<unknown>>();

  constructor(adapter: Adapter, options: CacheOptions) {
    this.adapter = adapter;
    this.async = options.async;
    this.lingerMs = options.lingerMs ?? 1_000;
    this.idleMs = options.idleMs ?? 10_000;
    this.connection = options.connection ?? ALWAYS_ONLINE;
    this.mintKey = options.mintKey ?? (() => mintUlid(Date.now()));
  }

  get vaults(): readonly string[] {
    return this.adapter.vaults;
  }

  /** Live queries currently open (for tests and diagnostics). */
  get size(): number {
    return this.#entries.size;
  }

  entry<A extends QueryArgs, R>(target: Target, query: Query<A, R>, args: A): QueryEntry<R> {
    const key = `${targetKey(target)}|${queryKey(query, args)}`;
    let entry = this.#entries.get(key) as Entry<R> | undefined;
    if (entry === undefined) {
      entry = new Entry(this, key, target, query as Query<QueryArgs, R>, args);
      this.#entries.set(key, entry as Entry<unknown>);
      entry.start();
    }
    return entry;
  }

  async run<I, R, In>(
    target: Target,
    command: AnyCommand<I, R, In>,
    input: In,
    suppliedAttempt?: CommandAttempt,
  ): Promise<CommandOutcome<R>> {
    let attempt: CommandAttempt;
    try {
      attempt =
        suppliedAttempt ??
        Object.freeze({
          key: this.mintKey(),
          target: Object.freeze({ ...target }),
          command: command.id,
        });
    } catch {
      return { kind: "not_started", reason: "key_unavailable" };
    }
    if (
      attempt.command !== command.id ||
      attempt.target.kind !== target.kind ||
      (attempt.target.kind === "vault" &&
        target.kind === "vault" &&
        attempt.target.vault !== target.vault)
    )
      return { kind: "refused", reason: "attempt_scope_mismatch" };
    try {
      return (await this.adapter.run(target, command, input, attempt)) as CommandOutcome<R>;
    } catch {
      return { kind: "outcome_unknown", key: attempt.key, attempt };
    }
  }

  async reconcile<R>(attempt: CommandAttempt): Promise<CommandOutcome<R>> {
    if (this.adapter.reconcile === undefined)
      return { kind: "outcome_unknown", key: attempt.key, attempt };
    try {
      return (await this.adapter.reconcile(attempt)) as CommandOutcome<R>;
    } catch {
      return { kind: "outcome_unknown", key: attempt.key, attempt };
    }
  }

  /** A released entry subscribed again (a component kept it across the release): reopen it. */
  revive(entry: Entry<unknown>): void {
    if (!this.#entries.has(entry.key)) this.#entries.set(entry.key, entry);
    entry.start();
  }

  forget(entry: Entry<unknown>): void {
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
  }

  /** A privacy policy change invalidates every snapshot, including errors and private values. */
  resetSnapshots(): void {
    const entries = [...this.#entries.values()];
    for (const entry of entries) entry.reset();
    for (const entry of entries) entry.notify();
  }

  /** Release every live query (the app or test is shutting down). */
  dispose(): void {
    this.adapter.dispose?.();
    for (const entry of [...this.#entries.values()]) entry.release();
  }
}
