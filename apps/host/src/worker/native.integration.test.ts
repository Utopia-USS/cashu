import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { investmentsLocal } from "@cashu/store";
import { ruleRuns } from "@cashu/store/investments/queries";
import { DailyPriceLock, type StrategyFilesPort } from "@cashu/store/investments/services";
import { expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import type { WorkerBindings } from "./contracts.js";
import { privateWorkerState } from "./state.js";

it("appends a native daily result and reopens its encrypted view", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  const privateDir = join(fixture.dataDir, "worker-private");
  mkdirSync(privateDir, { mode: 0o700 });
  const priceDriver = openNodeSqlite(":memory:");
  const state = privateWorkerState(privateDir, () => true);
  const files: StrategyFilesPort = {
    read: async () => null,
    write: async () => {
      throw new Error("synthetic files are read-only");
    },
    exists: async () => false,
  };
  const bindings: WorkerBindings = {
    state,
    ownership: { isExclusive: (job) => job === "investments.daily" },
    authority: () => ({ isHolder: () => true }),
    language: () => "en",
    offline: true,
    investments: {
      prices: new investmentsLocal.SqlPriceCache(priceDriver),
      dailyLock: new DailyPriceLock(),
      files: () => files,
    },
  };
  const options = {
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
    now: () => Date.UTC(2026, 10, 3, 12),
  } as const;
  const first = await startLocalHost({ ...options, worker: () => bindings });
  let reopened: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  try {
    await expect
      .poll(
        () => first.status().worker?.jobs.find((job) => job.job === "investments.daily")?.status,
      )
      .toBe("ok");
    const vault = first.stores.vaults.get(fixture.vaultId);
    if (!vault) throw new Error("synthetic native vault absent");
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
    await first.stop();
    const metadata = openNodeSqlite(
      join(fixture.dataDir, "vaults", fixture.vaultId, "private.db"),
      { readOnly: true },
    );
    const attempt = metadata
      .prepare("SELECT key FROM host_attempts WHERE command_id = ?")
      .get<{ key: string }>("investments.dailyEvaluation");
    metadata.close();
    if (!attempt) throw new Error("missing synthetic worker attempt");
    reopened = await startLocalHost(options);
    const read = reopened.stores.vaults.get(fixture.vaultId);
    if (!read) throw new Error("synthetic reopened vault absent");
    expect(ruleRuns(read.store.read.bind(read.store))).toHaveLength(1);
    expect(
      read.native?.attempts.status(fixture.vaultId, attempt.key, "investments.dailyEvaluation"),
    ).toMatchObject({ phase: "completed" });
  } finally {
    await reopened?.stop();
    await first.stop();
    priceDriver.close();
    fixture.cleanup();
  }
});

it("persists an uncertain native daily append and suppresses a fresh write after encrypted reopen", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  const privateDir = join(fixture.dataDir, "worker-private");
  mkdirSync(privateDir, { mode: 0o700 });
  const priceDriver = openNodeSqlite(":memory:");
  const prices = new investmentsLocal.SqlPriceCache(priceDriver);
  const state = privateWorkerState(privateDir, () => true);
  let releaseLoad = () => {};
  const loadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  const files: StrategyFilesPort = {
    read: async () => null,
    write: async () => {
      throw new Error("synthetic files are read-only");
    },
    exists: async () => false,
  };
  const bindings: WorkerBindings = {
    state: {
      load: async () => {
        await loadGate;
        return state.load();
      },
      save: (value) => state.save(value),
    },
    ownership: { isExclusive: (job) => job === "investments.daily" },
    authority: () => ({ isHolder: () => true }),
    language: () => "en",
    offline: true,
    investments: {
      prices,
      dailyLock: new DailyPriceLock(),
      files: () => files,
    },
  };
  const options = {
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
    now: () => Date.UTC(2026, 10, 3, 12),
  } as const;
  const first = await startLocalHost({ ...options, worker: () => bindings });
  let second: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  try {
    const vault = first.stores.vaults.get(fixture.vaultId);
    const native = vault?.native;
    if (!vault || !native) throw new Error("synthetic native vault absent");
    const originalWrite = native.engine.write.bind(native.engine);
    let writes = 0;
    let preparedDuringWrite: unknown;
    native.engine.write = async (...args) => {
      writes++;
      preparedDuringWrite = (await state.load()).uncertain[fixture.vaultId];
      await originalWrite(...args);
      throw new Error("synthetic fault after encrypted append");
    };
    releaseLoad();
    await expect
      .poll(() => first.status().worker?.jobs.find((job) => job.job === "investments.daily")?.code)
      .toBe("outcome_unknown");
    const persisted = await state.load();
    const unknown = persisted.uncertain[fixture.vaultId];
    expect(preparedDuringWrite).toMatchObject({
      job: "investments.daily",
      phase: "prepared",
      command: "investments.dailyEvaluation",
    });
    expect(unknown).toMatchObject({
      job: "investments.daily",
      phase: "outcome_unknown",
      command: "investments.dailyEvaluation",
    });
    expect(unknown?.key).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(writes).toBe(1);
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
    await first.stop();
    second = await startLocalHost({ ...options, worker: () => ({ ...bindings, state }) });
    const reopened = second.stores.vaults.get(fixture.vaultId);
    if (!reopened) throw new Error("synthetic reopened vault absent");
    await expect.poll(() => second?.status().worker?.state).toBe("idle");
    expect(ruleRuns(reopened.store.read.bind(reopened.store))).toHaveLength(1);
    expect((await state.load()).uncertain[fixture.vaultId]).toEqual(unknown);
    expect(
      reopened.native?.attempts.status(fixture.vaultId, unknown?.key ?? "", unknown?.command ?? ""),
    ).toMatchObject({ phase: "may_append" });
  } finally {
    releaseLoad();
    await second?.stop();
    await first.stop();
    priceDriver.close();
    fixture.cleanup();
  }
});
