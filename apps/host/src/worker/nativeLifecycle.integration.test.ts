import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { investmentsLocal, mintUlid, renameProfile } from "@cashu/store";
import { mcpProfile } from "@cashu/store/core";
import { ruleRuns } from "@cashu/store/investments/queries";
import { DailyPriceLock, type StrategyFilesPort } from "@cashu/store/investments/services";
import { expect, it } from "vitest";
import { runHostVaultCommand } from "../commands.js";
import { startLocalHost } from "../host.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import type { WorkerBindings, WorkerHostContext } from "./contracts.js";
import { HostWorker } from "./service.js";
import { privateWorkerState } from "./state.js";

// The host's engine refuses its own log when the injected clock is far behind it, so the fixture
// stamps the creator log from this same fixed clock instead of the wall clock.
const NOW = Date.UTC(2026, 10, 3, 12);

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const readOnlyFiles: StrategyFilesPort = {
  read: async () => null,
  exists: async () => false,
  write: async () => {
    throw new Error("synthetic strategy files are read-only");
  },
};

it("holds idle exit for native sync and an encrypted write queued behind it", async () => {
  const fixture = await nativeVaultFixture();
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
    lingerMs: 30,
  });
  const gate = deferred();
  let next: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  try {
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (vault?.native === undefined) throw new Error("admitted native vault absent");
    const original = vault.native.engine.sync.bind(vault.native.engine);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vault.native.engine.sync = async () => {
      entered();
      await gate.promise;
      return original();
    };
    const syncing = host.syncVault(fixture.vaultId);
    await started;
    const queued = runHostVaultCommand(
      vault,
      renameProfile,
      { name: "Queued" },
      mintUlid(Date.now()),
    );
    expect(host.stores.pending()).toBeGreaterThan(0);
    expect(host.status().pendingWrites).toBeGreaterThan(0);
    let exited = false;
    void host.exit.then(() => {
      exited = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(exited).toBe(false);
    gate.release();
    await syncing;
    expect(await queued).toMatchObject({ kind: "completed" });
    expect(await host.exit).toBe(0);
    next = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      vaultSource: fixture.vaultSource,
    });
    const reopened = next.stores.vaults.get(fixture.vaultId);
    expect(reopened?.native?.isCurrent()).toBe(true);
    if (!reopened) throw new Error("reopened native vault absent");
    expect(mcpProfile(reopened.store.read.bind(reopened.store))?.name).toBe("Queued");
  } finally {
    gate.release();
    await next?.stop();
    await host.stop();
    fixture.cleanup();
  }
});

it("daily startup, duplicate wake and restart keep one encrypted completed run", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"], now: () => NOW });
  const privateDir = join(fixture.dataDir, "worker-private");
  mkdirSync(privateDir, { mode: 0o700 });
  const driver = openNodeSqlite(":memory:");
  const state = privateWorkerState(privateDir, () => true);
  const bindings: WorkerBindings = {
    state,
    ownership: { isExclusive: (job) => job === "investments.daily" },
    authority: (vault) => ({ isHolder: () => vault.native?.isCurrent() === true }),
    language: () => "en",
    offline: true,
    investments: {
      prices: new investmentsLocal.SqlPriceCache(driver),
      dailyLock: new DailyPriceLock(),
      files: () => readOnlyFiles,
    },
  };
  const options = {
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
    now: () => NOW,
  } as const;
  let context: WorkerHostContext | undefined;
  const first = await startLocalHost({
    ...options,
    worker: (host) => {
      context = host;
      return bindings;
    },
  });
  let second: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  try {
    await expect
      .poll(
        () => first.status().worker?.jobs.find((row) => row.job === "investments.daily")?.status,
      )
      .toBe("ok");
    const firstVault = first.stores.vaults.get(fixture.vaultId);
    if (!firstVault || !context) throw new Error("admitted native vault absent");
    expect(ruleRuns(firstVault.store.read.bind(firstVault.store))).toHaveLength(1);
    const duplicate = new HostWorker(context, bindings);
    await duplicate.tick();
    await duplicate.stop();
    expect(ruleRuns(firstVault.store.read.bind(firstVault.store))).toHaveLength(1);
    await first.stop();
    second = await startLocalHost({ ...options, worker: () => bindings });
    await expect.poll(() => second?.status().worker?.state).toBe("idle");
    const reopened = second.stores.vaults.get(fixture.vaultId);
    if (!reopened) throw new Error("reopened native vault absent");
    expect(ruleRuns(reopened.store.read.bind(reopened.store))).toHaveLength(1);
  } finally {
    await second?.stop();
    await first.stop();
    driver.close();
    fixture.cleanup();
  }
});

it("safe-mode native startup suppresses the worker and network capability", async () => {
  const fixture = await nativeVaultFixture({ now: () => NOW });
  const options = {
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
    now: () => NOW,
  } as const;
  const first = await startLocalHost(options);
  try {
    await first.stop();
    const now = NOW;
    writeFileSync(
      join(fixture.dataDir, "run", "starts.json"),
      JSON.stringify({
        format: 1,
        unclean: [now - 3000, now - 2000, now - 1000],
      }),
    );
    let loads = 0;
    let constructed = 0;
    const safe = await startLocalHost({
      ...options,
      worker: () => {
        constructed++;
        return {
          state: {
            load: async () => {
              loads++;
              throw new Error("must not load");
            },
            save: async () => {
              throw new Error("must not save");
            },
          },
          ownership: { isExclusive: () => false },
          authority: () => null,
          language: () => "en",
        };
      },
    });
    try {
      expect(safe.safeMode).toBe(true);
      expect(safe.capabilities).toEqual({ jobs: false, network: false });
      expect(safe.status().worker?.state).toBe("safe-mode");
      expect(loads).toBe(0);
      expect(constructed).toBe(0);
    } finally {
      await safe.stop();
    }
  } finally {
    await first.stop();
    fixture.cleanup();
  }
});

it("graceful handover drains native queued work before releasing the host lock", async () => {
  const fixture = await nativeVaultFixture();
  const options = {
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
  } as const;
  const host = await startLocalHost(options);
  const gate = deferred();
  let next: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  try {
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (!vault) throw new Error("admitted native vault absent");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const queued = vault.queue.run(async () => {
      entered();
      await gate.promise;
      return 1;
    });
    await started;
    void host.stop("handover");
    await expect.poll(() => host.status().stopping).toBe(true);
    expect(host.lease.held).toBe(true);
    gate.release();
    expect(await queued).toBe(1);
    expect(await host.exit).toBe(75);
    next = await startLocalHost(options);
    expect(next.stores.vaults.get(fixture.vaultId)?.native?.isCurrent()).toBe(true);
  } finally {
    gate.release();
    await next?.stop();
    await host.stop();
    fixture.cleanup();
  }
});
