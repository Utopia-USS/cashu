// A native vault used on ONE device: nothing else runs a sync pass (no paired peer sends a carrier
// request), so the production fetch paths must obtain the lease's pull evidence themselves. These
// tests never call `sync()` by hand; the market answers from a synthetic stub, never the network.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CliExecParams, HostFrame } from "@cashu/host-protocol";
import { connectHost } from "@cashu/node-host";
import { ruleRuns } from "@cashu/store/investments/queries";
import type { Transport } from "@cashu/sync";
import { FaultInjector, MemoryTransport } from "@cashu/sync/testing";
import { afterEach, expect, it, vi } from "vitest";
import { fetchAuthorityIssue, refreshFetchAuthority } from "../fetchAuthority.js";
import { startLocalHost } from "../host.js";
import { createProductionMarket, type ProductionMarket } from "../market/production.js";
import { type NativeVaultFixture, nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import { createProductionWorkerBindings } from "./production.js";

// The host's engine refuses its own log when the injected clock is far behind it, so the fixture
// stamps the creator log from this same clock instead of the wall clock.
const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 86_400_000;

const fixtures: NativeVaultFixture[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/** Synthetic NBP answers (one USD rate on the last requested day); anything else is a 404. */
function stubMarket() {
  const urls: string[] = [];
  const hooks: { onRequest?: () => void } = {};
  const fetch = async (url: string) => {
    urls.push(url);
    hooks.onRequest?.();
    const range =
      /\/api\/exchangerates\/(rates\/A\/usd|tables\/A)\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\//.exec(
        url,
      );
    const day = range?.[3];
    const rate = { no: "212/A/NBP/2026", effectiveDate: day, mid: 4.0123 };
    const body =
      range === null
        ? null
        : range[1] === "tables/A"
          ? JSON.stringify([
              { ...rate, table: "A", rates: [{ currency: "dolar", code: "USD", mid: 4.0123 }] },
            ])
          : JSON.stringify({ table: "A", currency: "dolar", code: "USD", rates: [rate] });
    return {
      status: body === null ? 404 : 200,
      headers: { get: () => null },
      text: async () => body ?? "",
    };
  };
  return { urls, fetch, hooks };
}

const fxRequested = (urls: readonly string[]) =>
  urls.some((url) => url.includes("api.nbp.pl/api/exchangerates/"));

/**
 * `denyLease` stands in for a device the lease does not name: the worker never holds the lease.
 * `pairPeer` adds a second registered device; `remotes` adds extra sync remotes to the vault.
 */
async function singleDeviceHost(
  clock: () => number,
  options: {
    denyLease?: boolean;
    pairPeer?: boolean;
    remotes?: readonly Transport[];
    /** Start on this vault's data dir again (a restart) instead of a new fixture. */
    reuse?: NativeVaultFixture;
  } = {},
) {
  const fixture =
    options.reuse ??
    (await nativeVaultFixture({
      modules: ["investments"],
      now: clock,
      ...(options.pairPeer ? { pairPeer: true } : {}),
    }));
  if (options.reuse === undefined) fixtures.push(fixture);
  const stub = stubMarket();
  let market: ProductionMarket | undefined;
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource:
      options.remotes === undefined
        ? fixture.vaultSource
        : {
            ...fixture.vaultSource,
            provider: {
              ...fixture.vaultSource.provider,
              bootstrapCertificates: () => fixture.vaultSource.provider.bootstrapCertificates(),
              remoteTransports: () => options.remotes ?? [],
            },
          },
    now: clock,
    marketFactory: (stores, isCurrent, now) => {
      market = createProductionMarket({
        stores,
        isCurrent,
        now,
        fetch: stub.fetch,
        sleep: async () => {},
      });
      return market;
    },
    // Production wiring (main.ts): the real native fetch lease and its pull refresh.
    worker: (context) => {
      if (!market) throw new Error("production market was not bound");
      return createProductionWorkerBindings(context, {
        dataDir: fixture.dataDir,
        assertAdmission() {},
        strategyDirectory: (vault) => vault.native?.strategyDirectoryAuthority() ?? null,
        canFetchPublicMarket: (vault) =>
          options.denyLease !== true && (vault.native?.canFetchPublicMarket() ?? false),
        refreshFetchAuthority,
        fetchAuthorityIssue,
        market,
        language: () => "en",
      });
    },
  });
  const vault = host.stores.vaults.get(fixture.vaultId);
  if (vault?.mode !== "native" || !market) throw new Error("synthetic native vault absent");
  // Every engine pass of this vault from here on, whoever starts it.
  const passes = { count: 0, gate: null as Promise<void> | null, fail: null as Error | null };
  const engine = vault.native.engine;
  const original = engine.sync.bind(engine);
  engine.sync = async () => {
    passes.count++;
    if (passes.gate) await passes.gate;
    if (passes.fail) {
      const fault = passes.fail;
      passes.fail = null;
      throw fault;
    }
    return original();
  };
  return { fixture, host, vault, market, stub, passes };
}

/** One `cashu` command over the host's CLI socket: its exit and everything it printed. */
async function cli(fixture: NativeVaultFixture, argv: string[], lang = "en") {
  const connection = await connectHost({ dataDir: fixture.dataDir, role: "cli", build: "test" });
  try {
    const out: string[] = [];
    const answer = new Promise<unknown>((resolve, reject) => {
      connection.onFrame((frame: HostFrame) => {
        if (frame.t === "note" && frame.id === 1) out.push(JSON.stringify(frame.params));
        if (frame.t === "res" && frame.id === 1) {
          if (frame.outcome.ok) resolve(frame.outcome.result);
          else reject(new Error(frame.outcome.error.code));
        }
      });
    });
    const params: CliExecParams = {
      argv,
      cwd: fixture.dataDir,
      paths: { home: fixture.home },
      env: { CASHU_LANG: lang },
      tty: { stdin: false, stdout: false, stderr: false },
    };
    connection.send({ t: "req", id: 1, method: "cli.exec", params });
    return { result: await answer, out: out.join("\n") };
  } finally {
    connection.close();
  }
}

const dailyStatus = (host: Awaited<ReturnType<typeof singleDeviceHost>>["host"]) =>
  host.status().worker?.jobs.find((row) => row.job === "investments.daily")?.status;

it("runs the worker daily on a single-device vault and stores fresh market data", async () => {
  // Only the worker's start-up tick runs (its interval is faked); nothing calls sync() by hand.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { host, vault, market, stub } = await singleDeviceHost(() => NOW);
  try {
    await expect.poll(() => dailyStatus(host)).toBe("ok");
    expect(fxRequested(stub.urls)).toBe(true);
    expect(market.fxNewest()).not.toBeNull();
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
    expect(vault.native.canFetchPublicMarket()).toBe(true);
    expect(
      (host.status().worker?.unavailable ?? []).filter(
        (row) => row.code === "fetch_authority_unavailable",
      ),
    ).toEqual([]);
  } finally {
    await host.stop();
  }
});

it("opens the vault again after a daily run recorded its fetch report", async () => {
  // A completed fetch report is a device-layer lease event, not a store event; the open-time
  // history check once looked for it in the store's log and refused every later start.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const first = await singleDeviceHost(() => NOW);
  try {
    await expect.poll(() => dailyStatus(first.host)).toBe("ok");
  } finally {
    await first.host.stop();
  }
  // The run left a completed fetch report in the vault's attempt journal.
  const journal = new DatabaseSync(
    join(first.fixture.dataDir, "vaults", first.fixture.vaultId, "private.db"),
    { readOnly: true },
  );
  try {
    const row = journal
      .prepare(
        "SELECT count(*) AS n FROM host_attempts WHERE command_id='native.devices.fetchReport' AND phase='completed'",
      )
      .get() as { n: number };
    expect(row.n).toBeGreaterThan(0);
  } finally {
    journal.close();
  }
  const second = await singleDeviceHost(() => NOW + 60_000, { reuse: first.fixture });
  try {
    expect(ruleRuns(second.vault.store.read.bind(second.vault.store))).toHaveLength(1);
  } finally {
    await second.host.stop();
  }
});

it("runs `invest run` on a single-device vault whose pull evidence went stale", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let time = NOW;
  const { fixture, host, vault, stub } = await singleDeviceHost(() => time);
  try {
    await expect.poll(() => dailyStatus(host)).toBe("ok");
    // Two days later the start-up pull is stale and no tick runs: only the command can refresh it.
    time += 2 * DAY;
    stub.urls.splice(0);
    expect(vault.native.canFetchPublicMarket()).toBe(false);
    expect(vault.native.mayObtainFetchAuthority()).toBe(true);
    const { result, out } = await cli(fixture, ["-p", fixture.profileSlug, "invest", "run"]);
    expect(result, out).toEqual({ kind: "exit", code: 0 });
    expect(out).not.toContain("skipped");
    expect(fxRequested(stub.urls)).toBe(true);
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(2);
  } finally {
    await host.stop();
  }
});

it("prints why `invest run` skipped a profile, in English and Polish", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { fixture, host, vault } = await singleDeviceHost(() => NOW, { denyLease: true });
  try {
    await expect.poll(() => host.status().worker?.state).toBe("idle");
    const argv = ["-p", fixture.profileSlug, "invest", "run"];
    const en = await cli(fixture, argv, "en");
    expect(en.result, en.out).toEqual({ kind: "exit", code: 0 });
    // The console wraps long lines, so the reason code and the start of its text are checked.
    expect(en.out).toContain(
      `${fixture.profileSlug}: skipped (reason: fetch_authority_unavailable - this device may not`,
    );
    const pl = await cli(fixture, argv, "pl");
    expect(pl.result, pl.out).toEqual({ kind: "exit", code: 0 });
    expect(pl.out).toContain(
      `${fixture.profileSlug}: pominięto (powód: fetch_authority_unavailable - to urządzenie`,
    );
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(0);
  } finally {
    await host.stop();
  }
});

const idle = (host: Awaited<ReturnType<typeof singleDeviceHost>>["host"]) =>
  expect.poll(() => host.status().worker?.state).toBe("idle");

it("keeps fetch authority through a daily run longer than the lease's pull deadline", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let time = NOW;
  const { host, vault, stub, passes } = await singleDeviceHost(() => time);
  const at: number[] = [];
  // Each public request takes 20 s of the vault's clock.
  stub.hooks.onRequest = () => {
    at.push(time);
    time += 20_000;
  };
  try {
    await expect.poll(() => dailyStatus(host)).toBe("ok");
    const first = at[0] ?? NOW;
    const last = at.at(-1) ?? NOW;
    // Requests kept reaching the provider long after the start-up pull went stale: the transport
    // refreshed the pull between them (a refused request never reaches the stub).
    expect(last - first).toBeGreaterThan(60_000);
    expect(passes.count).toBeGreaterThanOrEqual(2);
    expect(fxRequested(stub.urls)).toBe(true);
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
  } finally {
    await host.stop();
  }
});

it("never runs a pass through this path on a device the lease does not name", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let time = NOW;
  const { fixture, host, vault, passes } = await singleDeviceHost(() => time, { pairPeer: true });
  try {
    await idle(host);
    const peer = fixture.peerDevice;
    if (!peer) throw new Error("synthetic peer unavailable");
    expect(await vault.native.refreshFetchAuthority()).toBe(true);
    const prepared = await vault.native.leaderPrepare(peer, false);
    if (prepared.kind !== "prepared") throw new Error("leader pin not prepared");
    expect(
      await vault.native.leaderCommit(
        peer,
        false,
        prepared.confirmationText,
        prepared.head,
        "01K9B2W0000000000000000092",
      ),
    ).toBe("completed");
    passes.count = 0;
    time += 2 * DAY;
    for (let tick = 0; tick < 5; tick++) {
      time += 60_000;
      expect(await vault.native.refreshFetchAuthority()).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    const run = await cli(fixture, ["-p", fixture.profileSlug, "invest", "run"]);
    expect(run.out).toContain("fetch_authority_unavailable");
    expect(passes.count).toBe(0);
    expect(vault.native.fetchAuthorityIssue()).toBe("fetch_not_leader");
    expect(host.status().worker?.unavailable).toContainEqual({
      job: "investments.daily",
      ordinal: 0,
      code: "fetch_not_leader",
    });
  } finally {
    await host.stop();
  }
});

it("runs no pass on idle worker ticks", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let time = NOW;
  const { host, passes } = await singleDeviceHost(() => time);
  try {
    await expect.poll(() => dailyStatus(host)).toBe("ok");
    await idle(host);
    passes.count = 0;
    // Ten ticks later the pull is long stale, but nothing is due: nothing syncs.
    for (let tick = 0; tick < 10; tick++) {
      time += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await idle(host);
    expect(passes.count).toBe(0);
  } finally {
    await host.stop();
  }
});

it("keeps the vault readable after a refresh pass fails with a non-transport error", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let time = NOW;
  const { host, vault, passes } = await singleDeviceHost(() => time);
  try {
    await expect.poll(() => dailyStatus(host)).toBe("ok");
    await idle(host);
    time += 70_000; // The start-up pull no longer counts.
    passes.fail = new Error("synthetic pass fault");
    expect(await vault.native.refreshFetchAuthority()).toBe(false);
    // The session was verified and stays current: reads work, the reason is reported.
    expect(vault.native.isCurrent()).toBe(true);
    expect(vault.store.read<{ gid: string }>("SELECT gid FROM profiles")).toHaveLength(1);
    expect(vault.native.fetchAuthorityIssue()).toBe("fetch_pull_failed");
    expect(host.status().worker?.unavailable).toContainEqual({
      job: "investments.daily",
      ordinal: 0,
      code: "fetch_pull_failed",
    });
    // After the back-off the next refresh pulls again and the vault may fetch.
    time += 60_000;
    expect(await vault.native.refreshFetchAuthority()).toBe(true);
    expect(vault.native.fetchAuthorityIssue()).toBeNull();
  } finally {
    await host.stop();
  }
});

it("keeps the last pull and backs off while an extra remote is offline", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let time = NOW;
  const relay = new FaultInjector(new MemoryTransport());
  const { host, vault, passes } = await singleDeviceHost(() => time, { remotes: [relay] });
  try {
    await expect.poll(() => dailyStatus(host)).toBe("ok");
    await idle(host);
    expect(vault.native.canFetchPublicMarket()).toBe(true);
    relay.setOnline(false);
    passes.count = 0;
    time += 40_000;
    // The refresh pass misses the relay, but the 40 s old pull still proves a pull in the deadline.
    expect(await vault.native.refreshFetchAuthority()).toBe(true);
    expect(passes.count).toBe(1);
    time += 30_000;
    expect(vault.native.canFetchPublicMarket()).toBe(false);
    expect(vault.native.fetchAuthorityIssue()).toBe("fetch_pull_incomplete");
    // Ten minutes of per-minute attempts: a growing back-off, not one pass per attempt.
    for (let minute = 0; minute < 10; minute++) {
      time += 60_000;
      await vault.native.refreshFetchAuthority();
    }
    expect(passes.count).toBeLessThanOrEqual(4);
    relay.setOnline(true);
    time += 30 * 60_000;
    expect(await vault.native.refreshFetchAuthority()).toBe(true);
  } finally {
    await host.stop();
  }
});

it("waits for a pass already running instead of giving up", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let time = NOW;
  const { host, vault, passes } = await singleDeviceHost(() => time);
  try {
    await expect.poll(() => dailyStatus(host)).toBe("ok");
    await idle(host);
    time += 70_000;
    let release!: () => void;
    passes.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    passes.count = 0;
    const concurrent = vault.native.sync(); // A carrier or UI pass.
    await expect.poll(() => vault.native.isSyncing()).toBe(true);
    const refreshing = vault.native.refreshFetchAuthority();
    await new Promise((resolve) => setImmediate(resolve));
    passes.gate = null;
    release();
    await concurrent;
    expect(await refreshing).toBe(true);
    expect(passes.count).toBe(1);
  } finally {
    await host.stop();
  }
});
