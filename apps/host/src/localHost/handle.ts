// What the `LocalHost` handle offers besides lifecycle: the admin status and the in-process vault
// operations (sliced envelope application for synthetic vaults, inbound sync for native ones).
import { type AdminStatus, HOST_PROTOCOL } from "@cashu/host-protocol";
import type { RunningHost } from "@cashu/node-host";
import type { SyncResult } from "@cashu/sync";
import type { HostStores } from "../stores.js";
import type { HostWorker } from "../worker/service.js";

const DEFAULT_SLICE_EVENTS = 1_000;

export function adminStatus(input: {
  readonly server: RunningHost;
  readonly build: string;
  readonly safeMode: boolean;
  readonly stores: HostStores;
  readonly worker: HostWorker;
}): AdminStatus {
  const { server, stores } = input;
  const currentWorker = input.worker.status();
  return {
    pid: process.pid,
    build: input.build,
    protocol: HOST_PROTOCOL,
    startedAt: server.startedAt.toISOString(),
    dataDir: server.paths.dataDirId,
    sessions: server.sessionCounts(),
    stopping: server.stopping,
    safeMode: input.safeMode,
    vaults: stores.vaults.size,
    pendingWrites: stores.pending(),
    worker: {
      ...currentWorker,
      jobs: [...currentWorker.jobs],
      unavailable: [...currentWorker.unavailable],
    },
  };
}

/**
 * Applies `envelopes` to a synthetic vault in slices (one transaction each) through its write
 * queue, so commands of other sessions run between slices. Resolves with the applied count.
 */
export function applySliced(
  stores: HostStores,
  vaultId: string,
  envelopes: readonly unknown[],
  sliceEvents = DEFAULT_SLICE_EVENTS,
): Promise<number> {
  const vault = stores.vaults.get(vaultId);
  if (vault === undefined) return Promise.reject(new Error("this vault is not open on this host"));
  if (vault.mode === "native")
    return Promise.reject(new Error("durable_apply_authority_unavailable"));
  const size = Math.max(1, Math.floor(sliceEvents));
  function* slices(): Generator<void, number> {
    let applied = 0;
    for (let i = 0; i < envelopes.length; i += size) {
      applied += vault?.store.applyEnvelopes(envelopes.slice(i, i + size)).applied ?? 0;
      if (i + size < envelopes.length) yield;
    }
    return applied;
  }
  return vault.queue.runSliced(slices());
}

/** Native-only authenticated inbound fold/push through the shared vault queue. */
export function syncVault(stores: HostStores, vaultId: string): Promise<SyncResult> {
  const session = stores.vaults.get(vaultId)?.native;
  if (session === undefined) return Promise.reject(new Error("native_sync_unavailable"));
  return session.sync();
}
