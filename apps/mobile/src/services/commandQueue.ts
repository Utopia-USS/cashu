// One promise chain per vault: every command and every sync pass of a vault runs through it, one at a
// time (the durable command contract: the queue that serializes command preparation must serialize
// every sync entry point too), so a pass never overlaps a command. Not reentrant: a task must not wait
// on another task of the same vault. A closed queue refuses new work; work already queued still runs.

import type { VaultCommandQueue } from "@cashu/store/sync";

export interface PhoneVaultQueue extends VaultCommandQueue {
  /** Tasks queued or running for `vault` (0 when idle). */
  pending(vault: string): number;
  /** Refuse every later `run` (the services are closing); resolves when the queued work settled. */
  close(): Promise<void>;
}

export class QueueClosedError extends Error {
  constructor() {
    super("vault_queue_closed");
    this.name = "QueueClosedError";
  }
}

export function createVaultQueue(): PhoneVaultQueue {
  const tails = new Map<string, Promise<unknown>>();
  const counts = new Map<string, number>();
  let closed = false;
  return {
    run<T>(vault: string, task: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new QueueClosedError());
      counts.set(vault, (counts.get(vault) ?? 0) + 1);
      const previous = tails.get(vault) ?? Promise.resolve();
      const result = previous.then(task, task);
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(vault, settled);
      void settled.then(() => {
        const left = (counts.get(vault) ?? 1) - 1;
        if (left === 0) {
          counts.delete(vault);
          if (tails.get(vault) === settled) tails.delete(vault);
        } else counts.set(vault, left);
      });
      return result;
    },
    pending: (vault) => counts.get(vault) ?? 0,
    async close() {
      closed = true;
      await Promise.all([...tails.values()]);
    },
  };
}
