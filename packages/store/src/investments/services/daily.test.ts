/** Native service acceptance with actual store, cache, parsed strategy and fake public sources. */
import { D, parseDateTime } from "@cashu/domain";
import { market } from "@cashu/domain/investments";
import { reportStats as macroStats } from "@cashu/domain/investments/macro";
import { describe, expect, it } from "vitest";
import { runCommand, storeWriter } from "../../command.js";
import { createProfile, renameProfile } from "../../core/commands.js";
import { memoryDriver, TEST_VAULT } from "../../testing/store.js";
import { createAlert } from "../commands/alertWrites.js";
import { dailyEvaluation } from "../commands/daily.js";
import { addManualTransaction } from "../commands/manual.js";
import {
  applyRaw,
  brokerage,
  otherVault,
  raw,
  rawGid,
  stock,
  vault,
} from "../commands/testing/fixtures.js";
import { NotificationQueue } from "../local/notificationQueue.js";
import { openSignals, ruleRuns, signalByGid } from "../queries/signals.js";
import { MemoryStrategyDir } from "../testing/strategyFiles.js";
import { type DailyVault, runDaily } from "./daily.js";
import type { DurableWriteUnknown } from "./durable.js";
import oracle from "./fixtures/daily.json" with { type: "json" };
import { DailyPriceLock } from "./prices.js";
import { loadStrategy } from "./strategy.js";

/** Actual FIFO queue with synchronous steps, manually advanced to expose await races. */
class ControlledQueue {
  private readonly jobs: (() => void)[] = [];
  private readonly listeners: (() => void)[] = [];
  active = false;
  runWrite<T>(work: () => T): Promise<T> {
    return new Promise((resolve, reject) => {
      this.jobs.push(() => {
        this.active = true;
        try {
          resolve(work());
        } catch (error) {
          reject(error);
        } finally {
          this.active = false;
        }
      });
      for (const listener of this.listeners.splice(0)) listener();
    });
  }
  queued(): Promise<void> {
    return this.jobs.length
      ? Promise.resolve()
      : new Promise((resolve) => this.listeners.push(resolve));
  }
  step(): void {
    const next = this.jobs.shift();
    if (!next) throw new Error("empty synthetic queue");
    next();
  }
}

const YAML = `version: 1
base_currency: PLN
data: {max_stale_weight: 1}
rules:
  - {id: concentration, kind: position_concentration, severity: action, params: {max_weight: 0.3}}
`;
/** A synthetic strategy directory holding `yaml` (null: no strategy.yaml). */
const dir = (yaml: string | null = YAML, vault = TEST_VAULT) => {
  const files = new MemoryStrategyDir(vault);
  if (yaml !== null) files.texts.set("strategy.yaml", yaml);
  return { files, sync: files.sync };
};
function setup(v = vault()) {
  v.value(createProfile, { slug: "synthetic", name: "Synthetic", baseCurrency: "PLN" });
  const account = brokerage(v);
  const instrument = stock(v, "AAA", "PL0000000AAA", {
    aliases: [{ namespace: "yahoo", value: "AAA.WA" }],
  });
  applyRaw(v, [raw.watchAdded(v, instrument)]);
  v.value(addManualTransaction, {
    account,
    type: "deposit",
    tradeDate: "2026-10-30",
    cashAmount: "100",
  });
  v.value(addManualTransaction, {
    account,
    instrument,
    type: "buy",
    tradeDate: "2026-10-30",
    quantity: "10",
    price: "10",
  });
  const prices = new market.InMemoryPriceCache();
  const row: DailyVault = {
    store: v.store,
    writer: storeWriter(v.store),
    env: v.env,
    ...dir(YAML, v.store.vault),
    enabled: true,
    lang: "en",
    async runWrite<T>(work: () => T) {
      return work();
    },
  };
  return { v, instrument, prices, row, lock: new DailyPriceLock() };
}
const input = { asOf: "2026-10-31", trigger: "worker", offline: true };
function cache(s: ReturnType<typeof setup>) {
  s.prices.upsertBars(
    { provider: "yahoo", symbol: "AAA.WA" },
    [
      {
        date: input.asOf,
        close: D("12"),
        open: null,
        high: null,
        low: null,
        volume: null,
        currency: null,
        fetchedAt: null,
      },
    ],
    parseDateTime("2026-10-31T12:00:00Z"),
  );
}
describe("daily native composition", () => {
  it("preserves an unknown durable evaluation and does not append a fresh failure", async () => {
    const s = setup();
    let calls = 0;
    const row: DailyVault = {
      ...s.row,
      ...dir(null),
      runWrite: async () => {
        throw new Error("outer_queue_entered");
      },
      durableWrite: async (command) => {
        calls++;
        expect(command.id).toBe("investments.dailyEvaluation");
        return { kind: "outcome_unknown", key: "01K9B2W0000000000000000000" };
      },
    };
    await expect(
      runDaily({ vaults: [row], lock: s.lock, prices: s.prices }, input),
    ).rejects.toMatchObject({
      key: "01K9B2W0000000000000000000",
      commandId: "investments.dailyEvaluation",
      vault: row.store.vault,
    } satisfies Partial<DurableWriteUnknown>);
    expect(calls).toBe(1);
    expect(ruleRuns(s.v.store.read.bind(s.v.store))).toHaveLength(0);
  });
  it("rechecks queued preparation authority before version or benchmark proxy writes", async () => {
    const s = setup();
    const queue = new ControlledQueue();
    const before = s.v.store.read("SELECT gid FROM inv_instruments").length;
    const running = runDaily(
      {
        ...s,
        vaults: [
          {
            ...s.row,
            ...dir(`${YAML}benchmark: {id: msci_acwi, proxy: REFX.DE}\n`),
            runWrite: (work) => queue.runWrite(work),
          },
        ],
      },
      input,
    );
    await queue.queued();
    s.v.env.holder = false;
    queue.step();
    const result = await running;
    expect(result.profiles[0]?.status).toBe("failed");
    expect(s.v.store.read("SELECT gid FROM inv_strategy_versions")).toHaveLength(0);
    expect(s.v.store.read("SELECT gid FROM inv_instruments")).toHaveLength(before);
  });
  it("leaves queue free during source await and rechecks lease when evaluation finally runs", async () => {
    const s = setup();
    const queue = new ControlledQueue();
    let started: () => void = () => {};
    const networkStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let answer: (history: market.PriceHistory) => void = () => {};
    const network = new Promise<market.PriceHistory>((resolve) => {
      answer = resolve;
    });
    const writer = {
      append(events: Parameters<ReturnType<typeof storeWriter>["append"]>[0]) {
        expect(queue.active).toBe(true);
        storeWriter(s.v.store).append(events);
      },
    };
    const running = runDaily(
      {
        ...s,
        vaults: [{ ...s.row, writer, runWrite: (work) => queue.runWrite(work) }],
        sources: () => ({
          priceSource: {
            id: "yahoo",
            async fetch() {
              started();
              return network;
            },
          },
          fxSource: {
            id: "nbp",
            async rates() {
              return [];
            },
          },
          close() {},
        }),
      },
      { ...input, offline: false },
    );
    await queue.queued();
    queue.step();
    await networkStarted;
    let ownerFinished = false;
    const owner = queue.runWrite(() => {
      s.v.value(renameProfile, { name: "Updated synthetic" });
      ownerFinished = true;
    });
    queue.step();
    await owner;
    expect(ownerFinished).toBe(true);
    answer(market.priceHistory());
    await queue.queued();
    s.v.env.holder = false;
    queue.step();
    const result = await running;
    expect(result.profiles[0]?.status).toBe("refused");
    expect(ruleRuns(s.v.store.read.bind(s.v.store))).toHaveLength(0);
  });
  it("retains wake severity before same-run escalation and dedupes already claimed severities", async () => {
    const s = setup();
    cache(s);
    const driver = memoryDriver();
    const notifications = new NotificationQueue(driver);
    const gid = rawGid(71);
    applyRaw(s.v, [
      raw.signalOpened(gid, `concentration|i:${s.instrument}`, {
        instrument: s.instrument,
        severity: "info",
      }),
      { type: "signal.acknowledged", gid, data: {} },
      { type: "signal.snoozed", gid, data: { until: "2026-10-31T11:00:00Z" } },
    ]);
    const allPolicy = `${YAML}\nnotifications: {immediate: [info, action]}\n`;
    const result = await runDaily(
      { ...s, vaults: [{ ...s.row, ...dir(allPolicy) }], notifications },
      input,
    );
    expect(result.profiles[0]?.result?.notificationIntents.map((i) => i.severity)).toEqual([
      "info",
      "action",
    ]);
    expect(result.profiles[0]?.result?.stats.notifications).toBe(1);
    for (const row of notifications.pending(s.v.store.vault))
      notifications.claim(s.v.store.vault, row.id, "2026-10-31T12:00:00Z", "test");
    await runDaily(
      {
        ...s,
        vaults: [{ ...s.row, ...dir(allPolicy.replace("severity: action", "severity: info")) }],
        notifications,
      },
      input,
    );
    const again = await runDaily(
      { ...s, vaults: [{ ...s.row, ...dir(allPolicy) }], notifications },
      input,
    );
    expect(again.profiles[0]?.result?.stats.notifications).toBe(0);
    expect(again.profiles[0]?.result?.notificationIntents).toHaveLength(0);
    expect(notifications.pending(s.v.store.vault)).toHaveLength(0);
    driver.close();
  });
  it("closes sources before evaluation and preserves old USD lot needs beside macro window", async () => {
    const s = setup();
    const account = brokerage(s.v, "Synthetic USD brokerage");
    const usd = stock(s.v, "USDOLD", "US0000000001", {
      currency: "USD",
      aliases: [{ namespace: "yahoo", value: "USDOLD" }],
    });
    applyRaw(s.v, [raw.watchAdded(s.v, usd)]);
    s.v.value(addManualTransaction, {
      account,
      instrument: usd,
      type: "buy",
      tradeDate: "2010-01-01",
      quantity: "1",
      price: "1",
    });
    let closed = false;
    const fxStarts: string[] = [];
    let applied = 0;
    const writer = {
      append(events: Parameters<ReturnType<typeof storeWriter>["append"]>[0]) {
        if (events.some((e) => e.type === "ruleRun.finished")) expect(closed).toBe(true);
        storeWriter(s.v.store).append(events);
      },
    };
    const result = await runDaily(
      {
        ...s,
        vaults: [{ ...s.row, writer }],
        sources: () => ({
          priceSource: {
            id: "yahoo",
            async fetch() {
              return market.priceHistory();
            },
          },
          fxSource: {
            id: "nbp",
            async rates(_c, start) {
              fxStarts.push(start);
              return [];
            },
          },
          macro: {
            async chart() {
              return { bars: [] };
            },
          },
          close() {
            closed = true;
          },
        }),
        macroStore: {
          apply(report) {
            applied++;
            return macroStats(report);
          },
        },
      },
      { ...input, offline: false },
    );
    expect(result.status).toBe("ran");
    expect(applied).toBe(1);
    expect(fxStarts.some((d) => d <= "2010-01-01")).toBe(true);
  });
  it("matches actual Python daily counters and plan failure shape on synthetic input", async () => {
    for (const label of ["valid", "missing", "invalid", "plan_failed"] as const) {
      const s = setup();
      cache(s);
      const source = dir(label === "missing" ? null : label === "invalid" ? "version: [" : YAML);
      const strategy = await loadStrategy(s.v.store, source.files, {
        record: true,
        writer: storeWriter(s.v.store),
        env: s.v.env,
        sync: source.sync,
      });
      const command = dailyEvaluation({
        strategy,
        market: { prices: s.prices },
        lang: "en",
        ...(label === "plan_failed"
          ? {
              planPass() {
                throw new Error("synthetic");
              },
            }
          : {}),
      });
      const assertOracle = (key: keyof typeof oracle) => {
        const out = s.v.run(command, input);
        if (!out.ok) throw new Error(out.reason);
        const expected = oracle[key];
        expect(D(String(out.value.stats.total_base)).eq(D(expected.stats.total_base))).toBe(true);
        const {
          alerts_expired: unsupportedExpiryCounter,
          total_base: _total,
          ...expectedStats
        } = expected.stats;
        expect(unsupportedExpiryCounter).toBe(0);
        const { total_base: _nativeTotal, ...actualStats } = out.value.stats;
        expect(actualStats).toEqual(expectedStats);
        expect({
          status: out.value.status,
          errors: out.value.errors.length,
          new: out.value.created.length,
          escalated: out.value.escalated.length,
        }).toEqual({
          status: expected.status,
          errors: expected.errors,
          new: expected.new,
          escalated: expected.escalated,
        });
      };
      assertOracle(label);
      if (label === "valid") {
        assertOracle("second");
        const signal = openSignals(s.v.store.read.bind(s.v.store))[0];
        if (!signal) throw new Error("missing signal");
        applyRaw(s.v, [
          { type: "signal.acknowledged", gid: signal.gid, data: {} },
          { type: "signal.snoozed", gid: signal.gid, data: { until: "2026-10-31T11:00:00Z" } },
        ]);
        assertOracle("wake");
      }
    }
  });
  it("runs actual rules and alerts in one evaluation append, idempotently", async () => {
    const s = setup();
    cache(s);
    s.v.value(createAlert, {
      instrument: s.instrument,
      kind: "price_above",
      params: { level: 11 },
      title: "Synthetic",
      severity: "action",
    });
    const batches: string[][] = [];
    const writer = {
      append(events: Parameters<ReturnType<typeof storeWriter>["append"]>[0]) {
        batches.push(events.map((e) => e.type));
        storeWriter(s.v.store).append(events);
      },
    };
    const deps = { ...s, vaults: [{ ...s.row, writer }] };
    const first = await runDaily(deps, input);
    expect(first.profiles[0]?.status).toBe("ok");
    expect(first.profiles[0]?.result?.created).toHaveLength(2);
    const evaluation = batches.filter((b) => b.includes("ruleRun.finished"));
    expect(evaluation).toHaveLength(1);
    expect(evaluation[0]?.filter((t) => t === "signal.opened")).toHaveLength(2);
    expect(openSignals(s.v.store.read.bind(s.v.store))).toHaveLength(2);
    const second = await runDaily(deps, input);
    expect(second.profiles[0]?.result?.created).toHaveLength(0);
    expect(ruleRuns(s.v.store.read.bind(s.v.store))).toHaveLength(2);
  });
  it("isolates plan failure but propagates final append failure", async () => {
    const s = setup();
    cache(s);
    const strategy = await loadStrategy(s.v.store, s.row.files);
    const command = dailyEvaluation({
      strategy,
      market: { prices: s.prices },
      lang: "en",
      planPass() {
        throw new Error("synthetic");
      },
    });
    const result = s.v.run(command, input);
    expect(result.ok && result.value.status).toBe("partial");
    expect(openSignals(s.v.store.read.bind(s.v.store))).toHaveLength(1);
    const before = ruleRuns(s.v.store.read.bind(s.v.store)).length;
    expect(() =>
      runCommand(
        s.v.store,
        {
          append() {
            throw new Error("append failed");
          },
        },
        command,
        input,
        s.v.env,
      ),
    ).toThrow("append failed");
    expect(ruleRuns(s.v.store.read.bind(s.v.store))).toHaveLength(before);
  });
  it("wakes acknowledged expired snooze before reconciliation without premature reads", async () => {
    const s = setup();
    cache(s);
    const gid = rawGid(51);
    applyRaw(s.v, [
      raw.signalOpened(gid, `concentration|i:${s.instrument}`, {
        instrument: s.instrument,
        severity: "action",
      }),
      { type: "signal.acknowledged", gid, data: {} },
      { type: "signal.snoozed", gid, data: { until: "2026-10-31T10:00:00.000Z" } },
    ]);
    const result = await runDaily({ ...s, vaults: [s.row] }, input);
    expect(result.profiles[0]?.result?.stats.signals_woken).toBe(1);
    expect(signalByGid(s.v.store.read.bind(s.v.store), gid)?.status).toBe("active");
    expect(result.profiles[0]?.result?.escalated).toHaveLength(0);
  });
  it("refuses nonleader, shares lock and isolates one broken profile", async () => {
    const s = setup();
    s.v.env.holder = false;
    expect((await runDaily({ ...s, vaults: [s.row] }, input)).profiles[0]?.status).toBe("refused");
    const release = s.lock.tryAcquire();
    expect((await runDaily({ ...s, vaults: [s.row] }, input)).status).toBe("busy");
    release?.();
    s.v.env.holder = true;
    const broken = {
      ...s.row,
      files: {
        async read(): Promise<string> {
          throw new Error("synthetic");
        },
        async exists() {
          return true;
        },
        async write() {},
      },
    };
    const other = setup(otherVault());
    const result = await runDaily(
      { ...s, vaults: [broken, { ...other.row, ...dir(null, other.v.store.vault) }] },
      input,
    );
    expect(result.profiles.map((p) => p.status)).toEqual(["failed", "ok"]);
  });
  it("losing authority during file IO prevents version/evaluation writes", async () => {
    const s = setup();
    const source = dir();
    const files = source.sync.files;
    const sync = {
      ...source.sync,
      files: {
        ...files,
        async read() {
          s.v.env.holder = false;
          return files.read();
        },
      },
    };
    const result = await runDaily(
      { ...s, vaults: [{ ...s.row, files: source.files, sync }] },
      input,
    );
    expect(result.profiles[0]?.status).toBe("failed");
    expect(s.v.store.read("SELECT * FROM inv_strategy_versions")).toHaveLength(0);
    expect(ruleRuns(s.v.store.read.bind(s.v.store))).toHaveLength(0);
  });
});
