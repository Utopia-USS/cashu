// A native vault used on ONE device: nothing else runs a sync pass (no paired peer sends a carrier
// request), so the production fetch paths must obtain the lease's pull evidence themselves. These
// tests never call `sync()` by hand; the market answers from a synthetic stub, never the network.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CliExecParams, HostFrame } from "@cashu/host-protocol";
import { connectHost } from "@cashu/node-host";
import { ruleRuns } from "@cashu/store/investments/queries";
import {
  devices,
  type Transport,
  TransportError,
  type TransportUnavailableReason,
} from "@cashu/sync";
import { FaultInjector, MemoryTransport } from "@cashu/sync/testing";
import { afterEach, expect, it, vi } from "vitest";
import { fetchAuthorityIssue, refreshFetchAuthority } from "../fetchAuthority.js";
import { type LocalHost, startLocalHost } from "../host.js";
import { createProductionMarket, type ProductionMarket } from "../market/production.js";
import { type NativeVaultFixture, nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import { renameVault } from "../testing/relayFixture.js";
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
 * Resolves once `done()` holds, re-checked on every change of the host's worker status. No deadline
 * of its own: a slow run on a loaded runner is waited for (within the test's budget), never raced
 * against a poll that reports whatever the status was when it gave up.
 */
function untilStatus(host: LocalHost, done: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (!done()) return;
      stop();
      resolve();
    };
    const stop = host.statusChanges.subscribe(check);
    check();
  });
}

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
    /** S6: own bytes one pass pushes at most (the engine option through the vault source). */
    maxPushBytesPerPass?: number;
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
              ...(options.maxPushBytesPerPass === undefined
                ? {}
                : { maxPushBytesPerPass: options.maxPushBytesPerPass }),
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
  /** The outcome of the start-up daily run, once it finished (while it runs it reads `failed`). */
  const daily = async () => {
    const run = () => host.status().worker?.jobs.find((row) => row.job === "investments.daily");
    await untilStatus(host, () => run()?.finishedAt != null);
    return run()?.status;
  };
  return { fixture, host, vault, market, stub, passes, daily };
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

it("runs the worker daily on a single-device vault and stores fresh market data", async () => {
  // Only the worker's start-up tick runs (its interval is faked); nothing calls sync() by hand.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { host, vault, market, stub, daily } = await singleDeviceHost(() => NOW);
  try {
    expect(await daily()).toBe("ok");
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
    expect(await first.daily()).toBe("ok");
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
  const { fixture, host, vault, stub, daily } = await singleDeviceHost(() => time);
  try {
    expect(await daily()).toBe("ok");
    await idle(host);
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
    await idle(host);
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

const idle = (host: LocalHost) => untilStatus(host, () => host.status().worker?.state === "idle");

it("keeps fetch authority through a daily run longer than the lease's pull deadline", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let time = NOW;
  const { host, vault, stub, passes, daily } = await singleDeviceHost(() => time);
  const at: number[] = [];
  // Each public request takes 20 s of the vault's clock.
  stub.hooks.onRequest = () => {
    at.push(time);
    time += 20_000;
  };
  try {
    expect(await daily()).toBe("ok");
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
  // Two devices share a carrier here: with sync off (no remote) and no complete pull ever recorded,
  // the creator would not lead at all while the peer could (the offline rule, guards.ts).
  const { fixture, host, vault, passes } = await singleDeviceHost(() => time, {
    pairPeer: true,
    remotes: [new MemoryTransport()],
  });
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
  const { host, passes, daily } = await singleDeviceHost(() => time);
  try {
    expect(await daily()).toBe("ok");
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
  const { host, vault, passes, daily } = await singleDeviceHost(() => time);
  try {
    expect(await daily()).toBe("ok");
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

it("keeps fetching on a pinned leader while an extra remote is offline (D6)", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let time = NOW;
  const relay = new FaultInjector(new MemoryTransport());
  const { host, vault, passes, daily } = await singleDeviceHost(() => time, { remotes: [relay] });
  const pull = () =>
    vault.native.engine.fetchLeaseEvidence(
      () => true,
      () => true,
    ).pull;
  try {
    expect(await daily()).toBe("ok");
    await idle(host);
    expect(vault.native.canFetchPublicMarket()).toBe(true);
    expect(pull()).toEqual({ kind: "pulled" });
    relay.setOnline(false);
    passes.count = 0;
    time += 40_000;
    const pausedAt = time;
    // The refresh pass misses the relay; it reached everything else, so the pinned leader acts.
    expect(await vault.native.refreshFetchAuthority()).toBe(true);
    expect(passes.count).toBe(1);
    expect(pull()).toEqual({ kind: "offline", since: pausedAt, reachedAt: pausedAt });
    // 70 s after the last complete pull: the strict rule alone would refuse here.
    time += 30_000;
    expect(vault.native.canFetchPublicMarket()).toBe(true);
    expect(vault.native.fetchAuthorityIssue()).toBeNull();
    // Two days later, still offline: one refresh pass each time it went stale, then a real fetch.
    time += 2 * DAY;
    expect(vault.native.canFetchPublicMarket()).toBe(false);
    expect(vault.native.mayObtainFetchAuthority()).toBe(true);
    expect(await vault.native.refreshFetchAuthority()).toBe(true);
    expect(passes.count).toBe(2);
    expect(pull()).toEqual({ kind: "offline", since: pausedAt, reachedAt: time });
    // Back online: the next pass is a complete pull again.
    relay.setOnline(true);
    time += 31_000;
    expect(await vault.native.refreshFetchAuthority()).toBe(true);
    expect(passes.count).toBe(3);
    expect(pull()).toEqual({ kind: "pulled" });
  } finally {
    await host.stop();
  }
});

const always = () => true;

/**
 * A relay remote over memory that, while `down` names a reason, answers every call `unavailable` with
 * it: the Firestore transport's mapping of a deleted member doc (`refused`), a replaced identity
 * (`identity-lost`), a 429 or a network failure (`outage`).
 */
function reasonedRelay(): Transport & { down: TransportUnavailableReason | null } {
  const inner = new MemoryTransport();
  const relay = {
    down: null as TransportUnavailableReason | null,
    consistency: inner.consistency,
    check(): void {
      if (relay.down !== null) throw new TransportError("unavailable", "synthetic", relay.down);
    },
    list: async (v: string) => {
      relay.check();
      return inner.list(v);
    },
    read: async (v: string, d: string, sg: number, o: number) => {
      relay.check();
      return inner.read(v, d, sg, o);
    },
    append: async (v: string, d: string, sg: number, o: number, b: Uint8Array) => {
      relay.check();
      return inner.append(v, d, sg, o, b);
    },
  };
  return relay;
}

it("stops leading at once when the relay refuses this Mac or lost its identity; a quota day is offline (G1)", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  for (const [reason, leads] of [
    ["refused", false],
    ["identity-lost", false],
    ["outage", true],
  ] as const) {
    let time = NOW;
    const relay = reasonedRelay();
    const { fixture, host, vault, passes, daily, stub } = await singleDeviceHost(() => time, {
      remotes: [relay],
    });
    try {
      expect(await daily()).toBe("ok");
      await idle(host);
      expect(vault.native.canFetchPublicMarket()).toBe(true);
      // The member doc is deleted (this Mac removed, or another admin purged), the identity was
      // replaced, or the quota ran out.
      relay.down = reason;
      passes.count = 0;
      time += 40_000;
      // The complete pull 40 s ago still counts for the rest of its deadline, whatever the pass said.
      expect(await vault.native.refreshFetchAuthority(), reason).toBe(true);
      expect(passes.count, reason).toBe(1);
      expect(vault.native.engine.fetchLeaseEvidence(always, always).pull.kind, reason).toBe(
        leads ? "offline" : "incomplete",
      );
      time += 30_000;
      // 70 s after the last complete pull: only an outage keeps the pinned leader acting.
      expect(vault.native.canFetchPublicMarket(), reason).toBe(leads);
      expect(vault.native.fetchAuthorityIssue() === null, reason).toBe(leads);
      // A leader action now: `invest run` fetches market data only while the lease holds.
      stub.urls.splice(0);
      const { result, out } = await cli(fixture, ["-p", fixture.profileSlug, "invest", "run"]);
      expect(result, out).toEqual({ kind: "exit", code: 0 });
      expect(fxRequested(stub.urls), reason).toBe(leads);
      expect(out.includes("skipped"), reason).toBe(!leads);
    } finally {
      await host.stop();
    }
  }
});

it("bounds the offline lead to 7 days after the last complete pull when another device could lead (G2)", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  for (const pairPeer of [true, false]) {
    let time = NOW;
    const relay = reasonedRelay();
    const { host, vault, daily } = await singleDeviceHost(() => time, {
      remotes: [relay],
      pairPeer,
    });
    const label = pairPeer ? "with a second device" : "alone";
    try {
      expect(await daily()).toBe("ok");
      await idle(host);
      const last = vault.native.engine.pullHistory().lastCompleteAt as number;
      expect(last, label).toBeGreaterThanOrEqual(NOW);
      relay.down = "outage";
      // Each check is fresh offline evidence (a pass right then), so only the bound decides.
      const offlineAt = async (at: number) => {
        time = at;
        await vault.native.sync();
        return vault.native.canFetchPublicMarket();
      };
      expect(await offlineAt(last + 6 * DAY), label).toBe(true);
      expect(await offlineAt(last + 7 * DAY), label).toBe(true);
      // One millisecond past 7 days: a second Mac might lead by now; alone, nobody else can.
      expect(await offlineAt(last + 7 * DAY + 1), label).toBe(!pairPeer);
      expect(await offlineAt(last + 30 * DAY), label).toBe(!pairPeer);
      // The relay back: a complete pull ends the question either way.
      relay.down = null;
      await vault.native.sync();
      expect(vault.native.canFetchPublicMarket(), label).toBe(true);
    } finally {
      await host.stop();
    }
  }
});

it("keeps fetch authority through a large first push the budget splits into passes (G3, S6)", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let time = NOW;
  const remote = new MemoryTransport();
  const { host, vault, daily } = await singleDeviceHost(() => time, {
    remotes: [remote],
    maxPushBytesPerPass: 1,
  });
  const ownBytes = async (t: Transport) =>
    (await t.list(vault.native.id))
      .filter((s) => s.device === vault.native.device)
      .reduce((n, s) => n + s.size, 0);
  try {
    expect(await daily()).toBe("ok");
    await idle(host);
    // A large first push: ten own frames the 1-byte budget moves one per pass.
    for (let i = 0; i < 10; i++) await renameVault(host, vault.native.id, `Name ${i}`);
    const local = vault.native.engine;
    let capped = 0;
    for (let i = 0; i < 200; i++) {
      // Each pass more than the publish deadline after the one before: only its own pull counts.
      time += 2 * devices.DEFAULT_LEASE_CONFIG.publishDeadlineMs;
      expect(vault.native.canFetchPublicMarket()).toBe(false);
      expect(await vault.native.refreshFetchAuthority()).toBe(true);
      expect(vault.native.canFetchPublicMarket()).toBe(true);
      const result = await vault.native.sync();
      expect(vault.native.canFetchPublicMarket()).toBe(true);
      if (!result.pushPending) break;
      capped += 1;
    }
    expect(capped).toBeGreaterThan(1);
    expect(local.pullHistory().pausedSince).toBeUndefined();
    // Right after the push finished: still allowed, and the remote holds the whole own log.
    expect(vault.native.canFetchPublicMarket()).toBe(true);
    expect(vault.native.fetchAuthorityIssue()).toBeNull();
    expect(await ownBytes(remote)).toBeGreaterThan(0);
    expect((await vault.native.sync()).pushedBytes).toBe(0);
  } finally {
    await host.stop();
  }
});

it("waits for a pass already running instead of giving up", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let time = NOW;
  const { host, vault, passes, daily } = await singleDeviceHost(() => time);
  try {
    expect(await daily()).toBe("ok");
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
