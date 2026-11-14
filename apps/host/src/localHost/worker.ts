// The host's job worker: its context (what is current, whether jobs and network may run) and the
// injected bindings. Bindings are asked for only when jobs may run and a vault is open; a failing
// binding leaves the worker unbound (logged), never the host down.
import type { RunningHost } from "@cashu/node-host";
import type { NotificationQueue } from "@cashu/store/investments/local";
import { errorName, type HostLog } from "../log.js";
import type { HostNotificationCapability } from "../notificationCapability.js";
import type { HostStores } from "../stores.js";
import type { WorkerBindings, WorkerHostContext } from "../worker/contracts.js";
import { type HostWorker, startWorker } from "../worker/service.js";
import type { LocalHostOptions } from "./options.js";

export function startHostWorker(input: {
  readonly factory: LocalHostOptions["worker"];
  readonly server: RunningHost;
  readonly stores: HostStores;
  readonly now: () => number;
  /** What may run besides serving sessions (nothing in safe mode or without bindings). */
  readonly capabilities: { readonly jobs: boolean; readonly network: boolean };
  readonly stopRequested: () => boolean;
  readonly bundleReplaced: () => boolean;
  readonly notifications: HostNotificationCapability | undefined;
  readonly queue: NotificationQueue;
  readonly log: HostLog;
}): HostWorker {
  const { server, stores, now, capabilities, stopRequested, bundleReplaced } = input;
  const context: WorkerHostContext = {
    stores,
    now: () => now(),
    isCurrent: (vault) =>
      !stopRequested() &&
      !bundleReplaced() &&
      stores.vaults.get(vault.id) === vault &&
      (vault.native === undefined || vault.native.canRunSideEffects()),
    jobsEnabled: () => capabilities.jobs && !stopRequested() && !bundleReplaced(),
    networkEnabled: () => capabilities.network && !stopRequested() && !bundleReplaced(),
    uiCount: () => server.sessionCounts().ui,
  };
  let bindings: WorkerBindings | undefined;
  try {
    bindings =
      context.jobsEnabled() && stores.vaults.size > 0
        ? input.factory?.(context, input.notifications, input.queue, server.lock)
        : undefined;
  } catch (error) {
    input.log.warn("worker.binding-failed", { error: errorName(error) });
  }
  return startWorker(context, bindings);
}
