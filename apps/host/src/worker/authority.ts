import { enabledModuleIds } from "@cashu/store/core";
import type { OpenVault } from "../stores.js";
import type { WorkerBindings, WorkerHostContext, WorkerJob } from "./contracts.js";

export class WorkerAuthorityLost extends Error {
  constructor() {
    super("worker_authority_lost");
    this.name = "WorkerAuthorityLost";
  }
}
export function workerGuard(
  host: WorkerHostContext,
  bindings: WorkerBindings,
  vault: OpenVault,
  job: WorkerJob,
  options: { readonly network?: boolean; readonly ui?: boolean } = {},
): () => void {
  return () => {
    try {
      if (
        host.jobsEnabled() === true &&
        host.stores.vaults.get(vault.id) === vault &&
        host.isCurrent(vault) === true &&
        bindings.ownership.isExclusive(job, vault) === true &&
        bindings.authority(vault)?.isHolder() === true &&
        (!options.network ||
          (host.networkEnabled() === true &&
            bindings.fetchAuthority?.(vault, job)?.isHolder() === true)) &&
        (!options.ui || host.uiCount() > 0)
      ) {
        const module = job === "budget.sync" ? "budget" : "investments";
        if (
          job === "connectors.fetch" ||
          enabledModuleIds(vault.store.read.bind(vault.store)).has(module)
        )
          return;
      }
    } catch {
      /* A throwing capability never grants authority. */
    }
    throw new WorkerAuthorityLost();
  };
}
export function guardedLease(guard: () => void): { isHolder(): boolean } {
  return {
    isHolder() {
      try {
        guard();
        return true;
      } catch {
        return false;
      }
    },
  };
}
