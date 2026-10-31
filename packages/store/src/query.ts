// Read queries as typed objects (data-flow.md "Reading"): an id, the store it reads (a vault's store or
// the device store), and a function of the read handle and JSON arguments. `watchQuery` is the live
// half of `useQuery`: it records the tables each run read (`tablesRead` of every SQL it executed),
// listens to exactly those, and re-runs after an apply touched one of them. Nobody lists tables or
// event types by hand. Platform and React free: the phone runs it in-process, the desktop in the store
// process behind a MessagePort (@cashu/store-react).
import { canonicalJson } from "./canonical.js";
import type { SqlValue } from "./sql/driver.js";
import type { TablesListener } from "./subscribe.js";

/** Read-only SQL on one store (a query never sees another vault). */
export type Read = <R>(sql: string, ...params: SqlValue[]) => R[];

/** What a query runs against: a vault's `Store` or the `DeviceStore`. */
export interface QuerySource {
  read<R>(sql: string, ...params: SqlValue[]): R[];
  /** The tables `sql` reads (a closed set of table names, so exact for every query of the view). */
  tablesRead(sql: string): ReadonlySet<string>;
  /** Listen for applies that touched any of `tables`; returns the unsubscribe function. */
  subscribe(tables: Iterable<string>, listener: TablesListener): () => void;
}

/**
 * Which store a query reads: `vault` = the current profile's store (the profile is the store, never a
 * filter); `device` = the device-local store (current profile, device settings), which never syncs.
 */
export type QueryScope = "vault" | "device";

/**
 * Arguments cross the desktop's MessagePort and key the snapshot cache, so they are JSON values.
 * `undefined` for a query without arguments.
 */
export type QueryArgs =
  | undefined
  | null
  | string
  | number
  | boolean
  | readonly QueryArgs[]
  | { readonly [key: string]: QueryArgs | undefined };

export interface Query<A extends QueryArgs, R> {
  /** Stable, unique id (`<module>.<name>`): what the desktop renderer sends to the store process. */
  readonly id: string;
  readonly scope: QueryScope;
  /** Read rows and decode them into domain values. Deterministic in (view, args). */
  run(read: Read, args: A): R;
}

/** Declare a query (default scope: the current vault). */
export function defineQuery<A extends QueryArgs, R>(query: {
  readonly id: string;
  readonly scope?: QueryScope;
  run(read: Read, args: A): R;
}): Query<A, R> {
  return { id: query.id, scope: query.scope ?? "vault", run: query.run };
}

/** The snapshot cache key of `query` with `args` (canonical JSON: key order never splits a key). */
export function queryKey<A extends QueryArgs>(query: Query<A, unknown>, args: A): string {
  return `${query.id}:${canonicalJson(args ?? null)}`;
}

/** Run `query` once and report the tables it read. */
export function runQuery<A extends QueryArgs, R>(
  source: QuerySource,
  query: Query<A, R>,
  args: A,
): { readonly value: R; readonly tables: ReadonlySet<string> } {
  const tables = new Set<string>();
  const read: Read = (sql, ...params) => {
    for (const t of source.tablesRead(sql)) tables.add(t);
    return source.read(sql, ...params);
  };
  return { value: query.run(read, args), tables };
}

export interface QueryWatcher<R> {
  /** Every run's value (the first one synchronously, before `watchQuery` returns). */
  onValue(value: R): void;
  /** A run threw: the error goes to the reader, never into the apply that triggered the run. */
  onError(error: unknown): void;
}

/**
 * Run `query` now and again after every apply that touched a table it read; stops when the returned
 * function is called. The read set is taken from each run, so a query whose SQL depends on its data
 * follows the tables it actually reads.
 */
export function watchQuery<A extends QueryArgs, R>(
  source: QuerySource,
  query: Query<A, R>,
  args: A,
  watcher: QueryWatcher<R>,
): () => void {
  let stopped = false;
  let tablesKey = "";
  let unsubscribe = (): void => {};

  const listen = (tables: ReadonlySet<string>): void => {
    const key = [...tables].sort().join(",");
    if (key === tablesKey) return;
    unsubscribe();
    tablesKey = key;
    unsubscribe = tables.size === 0 ? () => {} : source.subscribe(tables, rerun);
  };

  function rerun(): void {
    if (stopped) return;
    let result: { readonly value: R; readonly tables: ReadonlySet<string> };
    try {
      result = runQuery(source, query, args);
    } catch (error) {
      watcher.onError(error);
      return;
    }
    listen(result.tables);
    watcher.onValue(result.value);
  }

  rerun();
  return () => {
    stopped = true;
    unsubscribe();
  };
}
