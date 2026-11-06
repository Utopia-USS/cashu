import { type HostSettingsInfo, hostSettingsInfo } from "@cashu/store/core/desktop-settings";
import { type ChangeSource, defineQuery } from "@cashu/store/query";
import { launcherPath } from "./launcher.js";
import type { HostStores } from "./stores.js";
import type { WorkerStatus } from "./worker/contracts.js";

/** Host-known app build/data location and the actual S40 open-host worker snapshot, re-run when the
 * worker reports a changed status (no renderer polling). */
export function settingsInfoQuery(deps: {
  readonly version: string;
  /** The worker's status changes (state, last tick, job runs). */
  readonly changes: ChangeSource;
  dataDir(): string | null;
  worker(): WorkerStatus | null;
  stores(): HostStores | null;
}) {
  return defineQuery({
    id: hostSettingsInfo.id,
    scope: "device",
    changes: deps.changes,
    run(_read, args: { readonly privacy: boolean }): HostSettingsInfo {
      if (args.privacy) return { availability: "unavailable" };
      const dataDir = deps.dataDir();
      const stores = deps.stores();
      if (!dataDir || !stores) return { availability: "unavailable" };
      const status = deps.worker();
      const vaults = [...stores.vaults.values()];
      return {
        availability: "ready",
        version: deps.version,
        dataDir,
        launcher: launcherPath(dataDir),
        ...(status === null
          ? {}
          : {
              worker: {
                state: status.state,
                schedule: status.schedule,
                nextRunAt: status.nextRunAt,
                lastTickAt: status.lastTickAt,
                jobs: status.jobs.map((job) => {
                  const vault = vaults[job.ordinal];
                  const profileName =
                    vault?.store.read<{ name: string }>("SELECT name FROM profiles")[0]?.name ?? "";
                  return {
                    job: job.job,
                    vault: vault?.id ?? "",
                    profileName,
                    status: job.status,
                    startedAt: job.startedAt,
                    finishedAt: job.finishedAt,
                    ...(job.code === undefined ? {} : { code: job.code }),
                  };
                }),
              },
            }),
      };
    },
  });
}
