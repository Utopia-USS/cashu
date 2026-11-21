// The synchronous adapter: the store engine runs in this JS runtime (the phone's Hermes with a sync
// SQLite driver, tests on better-sqlite3). A first read returns rows at once, so `useQuery` never
// suspends; commands apply in-process and their touched tables re-run the affected snapshots. A vault
// with a durable handle (the phone's engine-backed vaults) runs its commands through that handle.
// With a `reruns` scheduler (the phone) the re-runs leave the write: a command or a sync part returns
// once its events are applied and the woken queries re-run after it, coalesced (`reruns.ts`).

import type { Command } from "@cashu/store";
import { watchQuery } from "@cashu/store/query";
import { type CacheOptions, QueryCache } from "../client/cache.js";
import type { Adapter, CommandAttempt, CommandOutcome } from "../client/types.js";
import type { RerunScheduler } from "./reruns.js";
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

export interface SyncClientOptions extends Omit<CacheOptions, "async"> {
  /** Defer live-query re-runs off the write path (default: re-run inside the notifying apply). */
  readonly reruns?: RerunScheduler;
}

export function createSyncClient(stores: LocalStores, options: SyncClientOptions = {}): QueryCache {
  const { reruns, ...cache } = options;
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
      return watchQuery(reruns === undefined ? source : reruns.wrap(source), query, args, {
        onValue: sink.value,
        onError: sink.error,
      });
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
  return new QueryCache(adapter, { ...cache, async: false });
}
