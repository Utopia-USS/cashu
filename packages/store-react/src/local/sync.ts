// The synchronous adapter: the store engine runs in this JS runtime (the phone's Hermes with a sync
// SQLite driver, tests on better-sqlite3). A first read returns rows at once, so `useQuery` never
// suspends; commands apply in-process and their touched tables re-run the affected snapshots. A vault
// with a durable handle (the phone's engine-backed vaults) runs its commands through that handle.

import type { Command } from "@cashu/store";
import { watchQuery } from "@cashu/store/query";
import { type CacheOptions, QueryCache } from "../client/cache.js";
import type { Adapter, CommandAttempt, CommandOutcome } from "../client/types.js";
import {
  type DurableOutcome,
  type DurableVaultHandle,
  durableVault,
  isDurable,
  type LocalStores,
  runLocal,
  sourceFor,
} from "./stores.js";

/** A durable answer as a command outcome (an unknown one carries the attempt for `reconcile`). */
function fromDurable(outcome: DurableOutcome, attempt: CommandAttempt): CommandOutcome<unknown> {
  if (outcome.kind !== "outcome_unknown") return outcome;
  return {
    kind: "outcome_unknown",
    key: attempt.key,
    ...(outcome.attemptId === undefined ? {} : { attemptId: outcome.attemptId }),
    attempt,
  };
}

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
      let durable: DurableVaultHandle | undefined;
      try {
        durable = durableVault(stores, target, command);
      } catch {
        return { kind: "outcome_unknown", key: attempt.key, attempt };
      }
      if (durable !== undefined) {
        return fromDurable(
          await durable.execute(command as Command<unknown, unknown>, input, attempt.key),
          attempt,
        );
      }
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
      const handle =
        attempt.target.kind === "vault" ? stores.vaults.get(attempt.target.vault) : undefined;
      if (handle === undefined || !isDurable(handle)) {
        return { kind: "outcome_unknown", key: attempt.key, attempt };
      }
      return fromDurable(await handle.reconcile(attempt.key), attempt);
    },
  };
  return new QueryCache(adapter, { ...options, async: false });
}
