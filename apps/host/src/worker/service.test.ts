import { market } from "@cashu/domain/investments";
import { investmentsCommands } from "@cashu/store";
import { ruleRuns } from "@cashu/store/investments/queries";
import type { DailySources } from "@cashu/store/investments/services";
import { DurableWriteUnknown } from "@cashu/store/investments/services";
import { afterEach, expect, it, vi } from "vitest";
import { investmentsRunningQuery } from "../investmentsRunning.js";
import { cleanup, storeClient } from "../testing/harness.js";
import { command, seedWorkerHolding, workerFixture } from "../testing/worker.js";
import { emptyWorkerState, type WorkerBindings } from "./contracts.js";
import { nativeInvestmentJobs } from "./investments.js";
import { localDay } from "./schedule.js";
import { HostWorker, startWorker, WorkerTickBusy } from "./service.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

it("keeps an uncertain durable key across restart and suppresses fresh daily work", async () => {
  const f = await workerFixture();
  const vault = f.vaults[0];
  if (vault === undefined) throw new Error("synthetic vault absent");
  const saved = emptyWorkerState();
  saved.uncertain[vault.id] = {
    job: "investments.daily",
    phase: "prepared",
    command: "investments.dailyEvaluation",
    key: "01K9B2W0000000000000000000",
  };
  await f.bindings.state.save(saved);
  // The append happens, then the process loses its outcome before updating worker state.
  const jobs = nativeInvestmentJobs(f.context, f.bindings);
  if (jobs === undefined) throw new Error("synthetic worker jobs absent");
  await jobs.daily([vault]);
  expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
  const worker = new HostWorker(f.context, f.bindings);
  try {
    await worker.tick(true);
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
    expect((await f.bindings.state.load()).uncertain[vault.id]).toEqual(saved.uncertain[vault.id]);
  } finally {
    await worker.stop();
    await f.close();
  }
});

it("retains a prepared backfill key when shutdown precedes the unknown catch", async () => {
  const f = await workerFixture();
  const vault = f.vaults[0];
  if (vault === undefined) throw new Error("synthetic vault absent");
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new HostWorker(f.context, f.bindings);
  Object.defineProperty(worker, "investments", {
    value: {
      daily: async () => new Map([[vault.id, { status: "ok" }]]),
      backfillEnabled: () => true,
      async backfill() {
        const state = await f.bindings.state.load();
        state.uncertain[vault.id] = {
          job: "investments.backfill",
          phase: "prepared",
          command: "investments.createInstrument",
          key: "01K9B2W0000000000000000000",
        };
        await f.bindings.state.save(state);
        entered();
        await gate;
        throw new DurableWriteUnknown("01K9B2W0000000000000000000", "investments.createInstrument");
      },
    },
  });
  try {
    const tick = worker.tick(true);
    await started;
    const stopping = worker.stop();
    release();
    await Promise.all([tick, stopping]);
    expect((await f.bindings.state.load()).uncertain[vault.id]).toEqual({
      job: "investments.backfill",
      phase: "prepared",
      command: "investments.createInstrument",
      key: "01K9B2W0000000000000000000",
    });
  } finally {
    release();
    await worker.stop();
    await f.close();
  }
});

it("starts immediately, evaluates the local slot on its60-second timer and tears the timer down", async () => {
  const f = await workerFixture();
  const at = new Date(f.time());
  at.setHours(7, 29, 0, 0);
  f.setTime(at.getTime());
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const worker = startWorker(f.context, f.bindings);
  try {
    await worker.tick();
    const vault = f.vaults[0];
    if (vault === undefined) throw new Error("synthetic vault absent");
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(0);
    f.advance(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await worker.tick();
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
    await worker.stop();
    expect(vi.getTimerCount()).toBe(0);
    f.advance(86_400_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
  } finally {
    await worker.stop();
    vi.useRealTimers();
    await f.close();
  }
});
function online(
  f: Awaited<ReturnType<typeof workerFixture>>,
  sources: () => DailySources,
): WorkerBindings {
  const ports = f.bindings.investments;
  if (ports === undefined) throw new Error("synthetic ports absent");
  return {
    state: f.bindings.state,
    ownership: f.bindings.ownership,
    authority: (v) => f.bindings.authority(v),
    fetchAuthority: (v) => f.bindings.authority(v),
    language: (v) => f.bindings.language(v),
    investments: {
      prices: ports.prices,
      notifications: f.notifications,
      dailyLock: ports.dailyLock,
      files: (v) => ports.files(v),
      sources,
    },
  };
}
async function watch(f: Awaited<ReturnType<typeof workerFixture>>) {
  const vault = f.vaults[0];
  if (vault === undefined) throw new Error("synthetic vault absent");
  const instrument = await command(vault, investmentsCommands.createInstrument, {
    name: "Synthetic worker instrument",
    symbol: "SYN",
    mic: "XWAR",
    assetClass: "equity",
    currency: "PLN",
    aliases: [{ namespace: "yahoo", value: "SYN.WA", guessed: false }],
  });
  await command(vault, investmentsCommands.addToWatchlist, { target: { stored: instrument.gid } });
  return vault;
}
it("stays off by default and safe mode never starts a job", async () => {
  const f = await workerFixture();
  const off = startWorker(f.context),
    safe = new HostWorker(f.context, f.bindings);
  try {
    await off.tick();
    expect(off.status().state).toBe("off");
    f.jobs(false);
    await safe.tick();
    expect(f.vaults.flatMap((v) => ruleRuns(v.store.read.bind(v.store)))).toHaveLength(0);
    expect(off.pending).toBe(0);
  } finally {
    await off.stop();
    await safe.stop();
    await f.close();
  }
});
it("runs cached daily work offline without connector or bank network phases", async () => {
  const f = await workerFixture();
  const connectorFetch = vi.fn(async () => ({ status: "ok" as const }));
  const bankSync = vi.fn(async () => ({ ok: true }));
  const worker = new HostWorker(f.context, {
    ...f.bindings,
    connectors: { fetch: connectorFetch },
    budget: {
      configured: () => true,
      hasSavedSessions: () => true,
      sync: bankSync,
    },
  });
  try {
    await worker.tick(true, { offline: true });
    expect(connectorFetch).not.toHaveBeenCalled();
    expect(bankSync).not.toHaveBeenCalled();
    expect(worker.status().jobs.some((job) => job.job === "investments.daily")).toBe(true);
  } finally {
    await worker.stop();
    await f.close();
  }
});
it("pushes each distinct status snapshot to subscribers instead of being polled", async () => {
  const f = await workerFixture();
  const worker = new HostWorker(f.context, f.bindings);
  const seen: string[] = [];
  const stop = worker.changes.subscribe(() => seen.push(worker.status().state));
  try {
    await worker.tick(true, { offline: true });
    expect(seen[0]).toBe("running");
    expect(seen.at(-1)).toBe("idle");
    const afterTick = seen.length;
    expect(worker.status().jobs.some((job) => job.job === "investments.daily")).toBe(true);
    stop();
    await worker.tick(true, { offline: true });
    expect(seen).toHaveLength(afterTick);
  } finally {
    await worker.stop();
    await f.close();
  }
});

it("serves the in-flight daily check and quote refresh of a vault as the live running query", async () => {
  // Python v2/runState.ts (`run/status.running`) and v2/priceRefresh.ts (`running`): the Home's
  // `reguły w toku` / `odświeżam ceny` tags, here pushed by the worker instead of fetched.
  const f = await workerFixture();
  const vault = f.vaults[0];
  if (vault === undefined) throw new Error("synthetic vault absent");
  const read = vault.store.read.bind(vault.store);
  let worker: HostWorker | undefined;
  const query = investmentsRunningQuery({
    changes: { subscribe: (listener) => worker?.runningChanges.subscribe(listener) ?? (() => {}) },
    running: (id) => worker?.running(id) ?? { prices: false, rules: false },
  });
  const duringFetch: unknown[] = [];
  const bindings = {
    ...online(f, () => ({
      priceSource: {
        id: "yahoo",
        async fetch() {
          duringFetch.push(query.run(read, undefined));
          return market.priceHistory();
        },
      },
      fxSource: {
        id: "nbp",
        async rates() {
          return [];
        },
      },
      close() {},
    })),
    schedule: { hour: 23, minute: 59 },
  };
  await watch(f);
  worker = new HostWorker(f.context, bindings);
  const daily = new HostWorker(f.context, f.bindings);
  const seen: boolean[] = [];
  const stop = daily.runningChanges.subscribe(() => seen.push(daily.running(vault.id).rules));
  let client: Awaited<ReturnType<typeof storeClient>> | undefined;
  try {
    await daily.tick(true, { offline: true });
    expect(seen).toEqual([true, false]);
    expect(daily.running(vault.id)).toEqual({ prices: false, rules: false });
    stop();
    const host = f.hosts[0];
    if (host === undefined) throw new Error("synthetic host absent");
    client = await storeClient(host.server.paths.dataDir);
    expect(query.run(read, undefined)).toEqual({ prices: false, rules: false });
    await worker.tick();
    expect(duringFetch).toEqual([{ prices: true, rules: false }]);
    expect(query.run(read, undefined)).toEqual({ prices: false, rules: false });
  } finally {
    client?.close();
    await daily.stop();
    await worker.stop();
    await f.close();
  }
});

it("refuses an offline invocation while an online tick is active", async () => {
  const f = await workerFixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new HostWorker(f.context, {
    ...f.bindings,
    state: {
      ...f.bindings.state,
      load: async () => {
        entered();
        await held;
        return f.bindings.state.load();
      },
    },
  });
  try {
    const online = worker.tick(true);
    await started;
    await expect(worker.tick(true, { offline: true })).rejects.toBeInstanceOf(WorkerTickBusy);
    release();
    await online;
  } finally {
    release();
    await worker.stop();
    await f.close();
  }
});
it("applies budget and notifier switches only to the requested tick", async () => {
  const f = await workerFixture();
  const bankSync = vi.fn(async () => ({ ok: true }));
  const worker = new HostWorker(f.context, {
    ...f.bindings,
    fetchAuthority: (vault) => f.bindings.authority(vault),
    budget: {
      configured: () => true,
      hasSavedSessions: () => true,
      sync: bankSync,
    },
    notifier: { name: "synthetic", send: vi.fn(async () => ({ state: "accepted" as const })) },
  });
  try {
    expect(worker.hasAppNotifier).toBe(true);
    await worker.tick(true, { budget: false, notifier: "none" });
    expect(bankSync).not.toHaveBeenCalled();
    expect(
      worker
        .status()
        .jobs.some((job) => ["budget.sync", "notifications", "digest"].includes(job.job)),
    ).toBe(false);
    await worker.tick(true, { notifier: "none" });
    expect(bankSync).toHaveBeenCalledTimes(1);
  } finally {
    await worker.stop();
    await f.close();
  }
});
it("projects unavailable job metadata without a synthetic run or changing due state", async () => {
  const f = await workerFixture();
  const worker = new HostWorker(f.context, {
    ...f.bindings,
    unavailable: (_vault, job) =>
      job === "investments.daily" ? "file_authority_unavailable" : null,
  });
  try {
    expect(worker.status().jobs).toHaveLength(0);
    expect(worker.status().unavailable).toEqual([
      { job: "investments.daily", ordinal: 0, code: "file_authority_unavailable" },
    ]);
    expect((await f.bindings.state.load()).runs).toEqual({});
  } finally {
    await worker.stop();
    await f.close();
  }
});
it("isolates one revoked vault during actual daily preparation", async () => {
  const f = await workerFixture({ two: true });
  const first = f.vaults[0],
    second = f.vaults[1];
  if (first === undefined || second === undefined) throw new Error("synthetic vault absent");
  try {
    f.holders.delete(first.id);
    const jobs = nativeInvestmentJobs(f.context, f.bindings);
    if (jobs === undefined) throw new Error("synthetic jobs absent");
    const results = await jobs.daily(f.vaults);
    expect(results.get(first.id)).toEqual({ status: "skipped", code: "authority_lost" });
    expect(ruleRuns(first.store.read.bind(first.store))).toHaveLength(0);
    expect(results.get(second.id)?.status).toBe("ok");
    expect(ruleRuns(second.store.read.bind(second.store))).toHaveLength(1);
  } finally {
    await f.close();
  }
});
it("runs after the configurable local slot, coalesces ticks, persists current-day completion and catches wake once", async () => {
  const f = await workerFixture();
  const bindings: WorkerBindings = { ...f.bindings, schedule: { hour: 9, minute: 10 } };
  let worker = new HostWorker(f.context, bindings);
  try {
    await worker.tick();
    expect(worker.status().jobs).toHaveLength(0);
    const clock = new Date(f.time());
    clock.setHours(9, 10, 0, 0);
    f.setTime(clock.getTime());
    await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
    const vault = f.vaults[0];
    if (vault === undefined) throw new Error("synthetic vault absent");
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
    await worker.stop();
    worker = new HostWorker(f.context, bindings);
    await worker.tick();
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
    f.advance(3 * 86_400_000);
    await worker.tick();
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(2);
    expect(worker.status().jobs.find((j) => j.job === "investments.daily")?.day).toBe(
      localDay(f.time()),
    );
  } finally {
    await worker.stop();
    await f.close();
  }
});
it("retries shared-lock busy next tick but holds failed noncommitted attempts for the source one-hour cadence", async () => {
  const f = await workerFixture();
  let fetches = 0;
  const bindings = online(f, () => ({
    priceSource: {
      id: "yahoo",
      async fetch() {
        fetches++;
        return market.priceHistory();
      },
    },
    fxSource: {
      id: "nbp",
      async rates() {
        return [];
      },
    },
    close() {},
  }));
  const vault = await watch(f),
    worker = new HostWorker(f.context, bindings);
  const release = bindings.investments?.dailyLock.tryAcquire();
  if (release === undefined || release === null) throw new Error("synthetic lock absent");
  const append = vault.writer.append.bind(vault.writer);
  const failure = vi.spyOn(vault.writer, "append").mockImplementation((rows) => {
    if (rows.some((row) => row.type === "ruleRun.finished"))
      throw new Error("synthetic append interruption");
    append(rows);
  });
  try {
    await worker.tick();
    expect(fetches).toBe(0);
    expect(worker.status().jobs.find((j) => j.job === "investments.daily")?.code).toBe("busy");
    release();
    await worker.tick();
    expect(fetches).toBe(1);
    f.advance(60_000);
    await worker.tick();
    expect(fetches).toBe(1);
    f.advance(3_600_000 - 60_000);
    await worker.tick();
    expect(fetches).toBe(2);
    failure.mockRestore();
    f.advance(3_600_000);
    await worker.tick();
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
    f.advance(60_000);
    await worker.tick();
    expect(fetches).toBe(3);
  } finally {
    release();
    failure.mockRestore();
    await worker.stop();
    await f.close();
  }
});
it("refreshes prices only with a real UI session and only every 5 minutes, then stops before stores close", async () => {
  const f = await workerFixture();
  let fetches = 0,
    closed = 0;
  const base = online(f, () => ({
    priceSource: {
      id: "yahoo",
      async fetch() {
        fetches++;
        return market.priceHistory();
      },
    },
    fxSource: {
      id: "nbp",
      async rates() {
        return [];
      },
    },
    close() {
      closed++;
    },
  }));
  const bindings = { ...base, schedule: { hour: 23, minute: 59 } };
  await watch(f);
  const worker = new HostWorker(f.context, bindings);
  let client: Awaited<ReturnType<typeof storeClient>> | undefined;
  try {
    await worker.tick();
    expect(fetches).toBe(0);
    const host = f.hosts[0];
    if (host === undefined) throw new Error("synthetic host absent");
    client = await storeClient(host.server.paths.dataDir);
    await worker.tick();
    expect(fetches).toBe(1);
    f.advance(4 * 60_000);
    await worker.tick();
    expect(fetches).toBe(1);
    f.advance(60_000);
    await worker.tick();
    expect(fetches).toBe(2);
    client.close();
    client = undefined;
    await expect.poll(() => host.server.sessionCounts().ui).toBe(0);
    f.advance(20 * 60_000);
    await worker.tick();
    expect(fetches).toBe(2);
    await worker.stop();
    await worker.tick();
    expect(fetches).toBe(2);
    expect(closed).toBe(2);
  } finally {
    client?.close();
    await worker.stop();
    await f.close();
  }
});

it("does not backfill during repeated daily-lock busy and records successful housekeeping separately", async () => {
  const f = await workerFixture();
  const vault = f.vaults[0];
  if (vault === undefined) throw new Error("synthetic vault absent");
  await seedWorkerHolding(vault, f.time());
  let fetches = 0;
  const bindings = online(f, () => ({
    priceSource: {
      id: "yahoo",
      async fetch() {
        fetches++;
        return market.priceHistory();
      },
    },
    fxSource: {
      id: "nbp",
      async rates() {
        return [];
      },
    },
    close() {},
  }));
  const worker = new HostWorker(f.context, bindings),
    release = bindings.investments?.dailyLock.tryAcquire();
  if (release === undefined || release === null) throw new Error("synthetic lock absent");
  try {
    await worker.tick();
    f.advance(60_000);
    await worker.tick();
    expect(fetches).toBe(0);
    expect((await f.bindings.state.load()).backfills[vault.id]).toBeUndefined();
    release();
    await worker.tick();
    expect(fetches).toBeGreaterThan(0);
    expect((await f.bindings.state.load()).backfills[vault.id]?.status).toBe("ok");
    const done = fetches;
    f.advance(60_000);
    await worker.tick();
    expect(fetches).toBe(done);
  } finally {
    release();
    await worker.stop();
    await f.close();
  }
});

it("recovers backfill after a crash between committed daily and housekeeping without repeating daily", async () => {
  const f = await workerFixture();
  const vault = f.vaults[0];
  if (vault === undefined) throw new Error("synthetic vault absent");
  await seedWorkerHolding(vault, f.time());
  let fetches = 0,
    crash = true;
  const base = online(f, () => ({
    priceSource: {
      id: "yahoo",
      async fetch() {
        fetches++;
        return market.priceHistory();
      },
    },
    fxSource: {
      id: "nbp",
      async rates() {
        return [];
      },
    },
    close() {},
  }));
  const interrupted: WorkerBindings = {
    ...base,
    state: {
      load: () => base.state.load(),
      async save(value) {
        await base.state.save(value);
        if (
          crash &&
          Object.values(value.runs).some((row) => row.finishedAt !== null) &&
          value.backfills[vault.id] === undefined
        ) {
          crash = false;
          throw new Error("synthetic post-daily crash");
        }
      },
    },
  };
  let worker = new HostWorker(f.context, interrupted);
  try {
    await worker.tick();
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
    expect((await base.state.load()).backfills[vault.id]).toBeUndefined();
    const before = fetches;
    await worker.stop();
    worker = new HostWorker(f.context, base);
    await worker.tick();
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
    expect(fetches).toBeGreaterThan(before);
    expect((await base.state.load()).backfills[vault.id]?.status).toBe("ok");
  } finally {
    await worker.stop();
    await f.close();
  }
});
