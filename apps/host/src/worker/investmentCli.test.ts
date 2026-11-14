import { D } from "@cashu/domain";
import { ruleRuns } from "@cashu/store/investments/queries";
import type { DurableWriteUnknown } from "@cashu/store/investments/services";
import { afterEach, expect, it } from "vitest";
import { cleanup } from "../testing/harness.js";
import { workerFixture } from "../testing/worker.js";
import type { WorkerBindings } from "./contracts.js";
import { emptyWorkerState } from "./contracts.js";
import { localDay } from "./schedule.js";
import { HostWorker } from "./service.js";

afterEach(cleanup);

it("runs only the explicitly selected vault through the guarded offline investment worker", async () => {
  const f = await workerFixture({ two: true });
  const [first, second] = f.vaults;
  if (!first || !second) throw new Error("synthetic vaults absent");
  const worker = new HostWorker(f.context, f.bindings);
  try {
    const result = await worker.runInvestmentCli([first], true, () => true);
    expect(result.report?.status).toBe("ran");
    expect(result.report?.profiles.map((row) => row.vault)).toEqual([first.id]);
    expect(ruleRuns(first.store.read.bind(first.store))).toHaveLength(1);
    expect(ruleRuns(second.store.read.bind(second.store))).toHaveLength(0);
    expect(result.outcomes.has(second.id)).toBe(false);
    await expect(worker.runInvestmentCli([second], true, () => false)).rejects.toThrow();
    expect(ruleRuns(second.store.read.bind(second.store))).toHaveLength(0);
  } finally {
    await worker.stop();
    await f.close();
  }
});

it("loads a cold persisted uncertain attempt before CLI run and shuts down after rejection", async () => {
  const f = await workerFixture();
  const vault = f.vaults[0];
  if (!vault) throw new Error("synthetic vault absent");
  const original = {
    job: "investments.daily" as const,
    phase: "prepared" as const,
    command: "investments.dailyEvaluation",
    key: "01K9B2W0000000000000000000",
  };
  const state = emptyWorkerState();
  state.uncertain[vault.id] = original;
  await f.bindings.state.save(state);
  const worker = new HostWorker(f.context, f.bindings);
  try {
    await expect(worker.runInvestmentCli([vault], true, () => true)).rejects.toMatchObject({
      key: original.key,
      commandId: original.command,
    } satisfies Partial<DurableWriteUnknown>);
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(0);
    expect((await f.bindings.state.load()).uncertain[vault.id]).toEqual(original);
    await expect(worker.stop()).resolves.toBeUndefined();
  } finally {
    await worker.stop();
    await f.close();
  }
});

it("refuses manual investment work when persisted worker state cannot load", async () => {
  const f = await workerFixture();
  const vault = f.vaults[0];
  if (!vault) throw new Error("synthetic vault absent");
  const worker = new HostWorker(f.context, {
    ...f.bindings,
    state: {
      ...f.bindings.state,
      async load() {
        throw new Error("synthetic_state_unavailable");
      },
    },
  });
  try {
    await expect(worker.runInvestmentCli([vault], true, () => true)).rejects.toThrow();
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(0);
    await expect(worker.stop()).resolves.toBeUndefined();
  } finally {
    await worker.stop();
    await f.close();
  }
});

it("refreshes macro through the selected guarded source without running daily evaluation", async () => {
  const f = await workerFixture();
  const vault = f.vaults[0];
  if (!vault || !f.bindings.investments) throw new Error("synthetic vault absent");
  let charts = 0;
  let closes = 0;
  let mode: "empty" | "success" | "error" = "empty";
  const bindings: WorkerBindings = {
    ...f.bindings,
    offline: false,
    fetchAuthority: (selected) => f.bindings.authority(selected),
    investments: {
      ...f.bindings.investments,
      macroBars: (series) => f.prices.macroBars(series),
      macroStore: { apply: (report, now) => f.prices.applyMacroReport(report, now) },
      sources: (ids) => {
        expect(ids).toEqual([vault.id]);
        return {
          priceSource: {
            id: "unused",
            async fetch() {
              throw new Error("unexpected_price_fetch");
            },
          },
          fxSource: {
            id: "unused",
            async rates() {
              throw new Error("unexpected_fx_fetch");
            },
          },
          macro: {
            async chart() {
              charts++;
              if (mode === "error") throw new Error("synthetic_source_error");
              if (mode === "success")
                return {
                  bars: [{ date: localDay(f.time()), close: D("10"), source: "synthetic" }],
                };
              return { bars: [] };
            },
          },
          close() {
            closes++;
          },
        };
      },
    },
  };
  const worker = new HostWorker(f.context, bindings);
  try {
    const result = await worker.refreshMacroCli(vault, () => true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("synthetic macro unavailable");
    expect(result.regimes).toHaveLength(5);
    expect(result.stored.series_ok).toBe(0);
    expect(result.stored.series_no_data).toBeGreaterThan(0);
    expect(charts).toBeGreaterThan(0);
    expect(closes).toBe(1);
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(0);
    mode = "success";
    const successful = await worker.refreshMacroCli(vault, () => true);
    expect(successful.status).toBe("ok");
    if (successful.status !== "ok") throw new Error("synthetic success unavailable");
    expect(successful.stored.series_ok).toBeGreaterThan(0);
    mode = "error";
    const failed = await worker.refreshMacroCli(vault, () => true);
    expect(failed.status).toBe("ok");
    if (failed.status !== "ok") throw new Error("synthetic error unavailable");
    expect(failed.stored.series_ok).toBe(0);
    expect(failed.stored.series_error).toBeGreaterThan(0);
    f.network(false);
    await expect(worker.refreshMacroCli(vault, () => true)).rejects.toThrow();
    expect(closes).toBe(3);
  } finally {
    await worker.stop();
    await f.close();
  }
});
