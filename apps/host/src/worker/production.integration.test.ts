import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintUlid, setModules } from "@cashu/store";
import { ruleRuns } from "@cashu/store/investments/queries";
import { expect, it, vi } from "vitest";
import { runHostVaultCommand } from "../commands.js";
import { startLocalHost } from "../host.js";
import { ProductionVaultSourceFactory } from "../productionVaultSource.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import { createProductionWorkerBindings } from "./production.js";

it("starts a native first-Create host without constructing a worker or KeyStore", async () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-t53-empty-"));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const factory = new ProductionVaultSourceFactory(dataDir, () => {
    throw new Error("test KeyStore must not open before Create");
  });
  let constructed = 0;
  let host: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  try {
    host = await startLocalHost({
      dataDir,
      home,
      build: "test",
      launcher: false,
      python: null,
      vaultSource: { kind: "native-production", factory },
      worker: () => {
        constructed++;
        throw new Error("worker must not bind before native Create");
      },
    });
    expect(host.stores.vaults.size).toBe(0);
    expect(host.status().worker?.state).toBe("off");
    expect(constructed).toBe(0);
  } finally {
    await host?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

it("takes checked ownership before investments is enabled and follows live module changes", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const fixture = await nativeVaultFixture({ modules: ["budget"] });
  const vaultRoot = join(fixture.dataDir, "vaults", fixture.vaultId);
  chmodSync(vaultRoot, 0o700);
  mkdirSync(join(vaultRoot, "strategy"), { mode: 0o700 });
  let time = Date.UTC(2026, 10, 3, 12);
  let host: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  try {
    host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      python: null,
      vaultSource: fixture.vaultSource,
      now: () => time,
      worker: (context) =>
        createProductionWorkerBindings(context, {
          dataDir: fixture.dataDir,
          assertAdmission() {},
          strategyDirectory: (vault) => vault.native?.strategyDirectoryAuthority() ?? null,
          language: () => "en",
        }),
    });
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (!vault) throw new Error("synthetic native vault absent");
    const owned = JSON.parse(
      readFileSync(join(fixture.dataDir, "worker", "ownership.json"), "utf8"),
    );
    expect(owned.jobs["investments.daily"].vaults).toEqual([fixture.vaultId]);
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(0);
    const key = () => mintUlid(time, (n) => new Uint8Array(n).fill(1));
    expect(
      (
        await runHostVaultCommand(
          vault,
          setModules,
          { moduleIds: ["budget", "investments"] },
          key(),
        )
      ).kind,
    ).toBe("completed");
    await vi.advanceTimersByTimeAsync(60_000);
    await expect.poll(() => ruleRuns(vault.store.read.bind(vault.store)).length).toBe(1);
    time += 86_400_000;
    expect(
      (await runHostVaultCommand(vault, setModules, { moduleIds: ["budget"] }, key())).kind,
    ).toBe("completed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
  } finally {
    await host?.stop();
    fixture.cleanup();
    vi.useRealTimers();
  }
});

it("binds an authenticated local daily run and retains its one native owner after restart", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  const vaultRoot = join(fixture.dataDir, "vaults", fixture.vaultId);
  chmodSync(vaultRoot, 0o700);
  mkdirSync(join(vaultRoot, "strategy"), { mode: 0o700 });
  const options = {
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    python: null,
    vaultSource: fixture.vaultSource,
    now: () => Date.UTC(2026, 10, 3, 12),
    worker: (context: Parameters<typeof createProductionWorkerBindings>[0]) =>
      createProductionWorkerBindings(context, {
        dataDir: fixture.dataDir,
        assertAdmission() {
          if (existsSync(join(fixture.dataDir, "cashu.db"))) throw new Error("legacy present");
        },
        strategyDirectory: (vault) => vault.native?.strategyDirectoryAuthority() ?? null,
        language: () => "en",
      }),
  } as const;
  let first: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  let reopened: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  try {
    first = await startLocalHost(options);
    await expect
      .poll(
        () => first?.status().worker?.jobs.find((row) => row.job === "investments.daily")?.status,
      )
      .toBe("ok");
    const vault = first.stores.vaults.get(fixture.vaultId);
    if (!vault) throw new Error("synthetic native vault absent");
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
    const record = JSON.parse(
      readFileSync(join(fixture.dataDir, "worker", "ownership.json"), "utf8"),
    );
    expect(record.jobs["investments.daily"].vaults).toEqual([fixture.vaultId]);
    await first.stop();
    reopened = await startLocalHost(options);
    await expect.poll(() => reopened?.status().worker?.state).toBe("idle");
    const again = reopened.stores.vaults.get(fixture.vaultId);
    if (!again) throw new Error("synthetic reopened vault absent");
    expect(ruleRuns(again.store.read.bind(again.store))).toHaveLength(1);
  } finally {
    await reopened?.stop();
    await first?.stop();
    fixture.cleanup();
  }
});

it("reports missing file authority without claiming or recording a daily run", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    python: null,
    vaultSource: fixture.vaultSource,
    now: () => Date.UTC(2026, 10, 3, 12),
    worker: (context) =>
      createProductionWorkerBindings(context, {
        dataDir: fixture.dataDir,
        assertAdmission() {},
        strategyDirectory: (vault) => vault.native?.strategyDirectoryAuthority() ?? null,
        language: () => "en",
      }),
  });
  try {
    await expect.poll(() => host.status().worker?.state).toBe("idle");
    expect(host.status().worker?.unavailable).toContainEqual({
      job: "investments.daily",
      ordinal: 0,
      code: "file_authority_unavailable",
    });
    expect(host.status().worker?.jobs).toEqual([]);
    expect(existsSync(join(fixture.dataDir, "worker", "ownership.json"))).toBe(false);
  } finally {
    await host.stop();
    fixture.cleanup();
  }
});

it("claims a budget connector without a strategy directory", async () => {
  const fixture = await nativeVaultFixture({ modules: ["budget"] });
  let fetched = 0;
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    python: null,
    vaultSource: fixture.vaultSource,
    now: () => Date.UTC(2026, 10, 3, 12),
    worker: (context) =>
      createProductionWorkerBindings(context, {
        dataDir: fixture.dataDir,
        assertAdmission() {},
        strategyDirectory: () => null,
        canFetchPublicMarket: () => true,
        connectors: {
          fetch: async (_vault, guard) => {
            guard();
            fetched++;
            return { status: "ok", stats: { stored: 0, skipped: 0, failed: 0 } };
          },
        },
        language: () => "en",
      }),
  });
  try {
    await expect.poll(() => fetched).toBe(1);
    const record = JSON.parse(
      readFileSync(join(fixture.dataDir, "worker", "ownership.json"), "utf8"),
    );
    expect(record.jobs["connectors.fetch"].vaults).toEqual([fixture.vaultId]);
  } finally {
    await host.stop();
    fixture.cleanup();
  }
});
