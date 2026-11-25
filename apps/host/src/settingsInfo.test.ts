import { renameProfile } from "@cashu/store";
import type { HostSettingsInfo } from "@cashu/store/core/desktop-settings";
import { watchQuery } from "@cashu/store/query";
import { afterEach, expect, it } from "vitest";
import { settingsInfoQuery } from "./settingsInfo.js";
import { cleanup } from "./testing/harness.js";
import { command, workerFixture } from "./testing/worker.js";
import type { WorkerStatus } from "./worker/contracts.js";

afterEach(cleanup);

it("re-runs the settings worker block when a vault's profile is renamed, with no worker change", async () => {
  const f = await workerFixture();
  const vault = f.vaults[0];
  if (vault === undefined) throw new Error("synthetic vault absent");
  const status: WorkerStatus = {
    state: "idle",
    schedule: "06:30",
    nextRunAt: null,
    lastTickAt: null,
    jobs: [
      {
        job: "investments.daily",
        ordinal: 0,
        status: "ok",
        day: "2026-11-06",
        startedAt: "2026-11-06T06:30:00Z",
        finishedAt: "2026-11-06T06:31:00Z",
      },
    ],
    unavailable: [],
  };
  const query = settingsInfoQuery({
    version: "test",
    changes: { subscribe: () => () => {} },
    dataDir: () => "/synthetic",
    worker: () => status,
    stores: () => f.context.stores,
  });
  const names: string[] = [];
  const stop = watchQuery(
    f.context.stores.device.store,
    query,
    { privacy: false },
    {
      onValue: (value: HostSettingsInfo) => names.push(value.worker?.jobs[0]?.profileName ?? "?"),
      onError: (error) => {
        throw error;
      },
    },
  );
  try {
    await command(vault, renameProfile, { name: "Renamed synthetic" });
    expect(names.at(-1)).toBe("Renamed synthetic");
    expect(names.length).toBe(2);
    stop();
    await command(vault, renameProfile, { name: "After stop" });
    expect(names.length).toBe(2);
  } finally {
    stop();
    await f.close();
  }
});
