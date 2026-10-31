// TRANSITIONAL(useQuery-engine): a minimal live read for the scaffold's screens. The typed
// `useQuery(query, args)` of data-flow.md (query objects, row decoders, structural sharing) does not
// exist yet; this hook keeps its contract (rows directly, re-run when a read table is touched, never
// suspends on mobile) so screens move to it by changing one import.
import type { SqlValue, Store } from "@cashu/store";
import { useSyncExternalStore } from "react";

const cache = new WeakMap<Store, Map<string, { version: number; rows: unknown[] }>>();

function rowsAt<R>(store: Store, sql: string, params: readonly SqlValue[], version: number): R[] {
  let byKey = cache.get(store);
  if (!byKey) {
    byKey = new Map();
    cache.set(store, byKey);
  }
  const key = `${sql}\u0000${JSON.stringify(params)}`;
  const hit = byKey.get(key);
  if (hit && hit.version === version) return hit.rows as R[];
  const rows = store.read<R>(sql, ...params);
  byKey.set(key, { version, rows });
  return rows;
}

export function useStoreRows<R>(store: Store, sql: string, ...params: SqlValue[]): R[] {
  const tables = store.tablesRead(sql);
  const version = useSyncExternalStore(
    (onChange) => store.subscribe(tables, onChange),
    () => store.version(tables),
  );
  return rowsAt<R>(store, sql, params, version);
}
