// The synchronous adapter: the store engine runs in this JS runtime (the phone's Hermes with a sync
// SQLite driver, tests on better-sqlite3). A first read returns rows at once, so `useQuery` never
// suspends; commands apply in-process and their touched tables re-run the affected snapshots.

import { watchQuery } from "@cashu/store/query";
import { type CacheOptions, QueryCache } from "../client/cache.js";
import type { Adapter } from "../client/types.js";
import { type LocalStores, runLocal, sourceFor } from "./stores.js";

export function createSyncClient(
  stores: LocalStores,
  options: Omit<CacheOptions, "async"> = {},
): QueryCache {
  const adapter: Adapter = {
    vaults: [...stores.vaults.keys()],
    open(target, query, args, sink) {
      let source: ReturnType<typeof sourceFor>;
      try {
        source = sourceFor(stores, target, query);
      } catch (error) {
        sink.error(error);
        return () => {};
      }
      return watchQuery(source, query, args, { onValue: sink.value, onError: sink.error });
    },
    async run(target, command, input, attempt) {
      try {
        const result = runLocal(stores, target, command, input);
        return result.ok
          ? { kind: "completed" as const, value: result.value }
          : { kind: "refused" as const, reason: result.reason };
      } catch {
        return { kind: "outcome_unknown", key: attempt.key, attempt };
      }
    },
    async reconcile(attempt) {
      return { kind: "outcome_unknown", key: attempt.key, attempt };
    },
  };
  return new QueryCache(adapter, { ...options, async: false });
}
