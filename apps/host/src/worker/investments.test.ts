import { D, parseDateTime } from "@cashu/domain";
import { Currencies, market, priceBar } from "@cashu/domain/investments";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup } from "../testing/harness.js";
import { seedWorkerHolding, workerFixture } from "../testing/worker.js";
import type { WorkerBindings } from "./contracts.js";
import { nativeInvestmentJobs } from "./investments.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});
it("keeps backfill network outside the real vault queue and refuses cache mutation after lease loss", async () => {
  const f = await workerFixture();
  const vault = f.vaults[0],
    ports = f.bindings.investments;
  if (vault === undefined || ports === undefined) throw new Error("synthetic vault absent");
  await seedWorkerHolding(vault, f.time());
  let active = false,
    revoke = true,
    fetches = 0;
  const queued = vault.queue.run.bind(vault.queue);
  vi.spyOn(vault.queue, "run").mockImplementation((work) =>
    queued(() => {
      active = true;
      try {
        return work();
      } finally {
        active = false;
      }
    }),
  );
  const observed: boolean[] = [],
    unsubscribe = f.prices.subscribe(() => observed.push(active));
  const bindings: WorkerBindings = {
    state: f.bindings.state,
    ownership: f.bindings.ownership,
    authority: (v) => f.bindings.authority(v),
    language: (v) => f.bindings.language(v),
    investments: {
      prices: f.prices,
      notifications: f.notifications,
      dailyLock: ports.dailyLock,
      files: (v) => ports.files(v),
      sources: () => ({
        priceSource: {
          id: "yahoo",
          async fetch(instrument, _start, end) {
            expect(active).toBe(false);
            fetches++;
            if (revoke) f.holders.delete(vault.id);
            return market.priceHistory({
              currency: Currencies.PLN,
              bars: [
                priceBar({
                  instrumentId: instrument.id,
                  date: end,
                  close: D("11"),
                  source: "yahoo",
                  currency: Currencies.PLN,
                  fetchedAt: parseDateTime(new Date(f.time()).toISOString()),
                }),
              ],
            });
          },
        },
        fxSource: {
          id: "nbp",
          async rates() {
            expect(active).toBe(false);
            return [];
          },
        },
        close() {},
      }),
    },
  };
  try {
    const jobs = nativeInvestmentJobs(f.context, bindings);
    if (jobs === undefined) throw new Error("synthetic jobs absent");
    const before = f.prices.version();
    await expect(jobs.backfill(vault)).rejects.toThrow("worker_authority_lost");
    expect(f.prices.version()).toBe(before);
    expect(observed).toEqual([]);
    expect(fetches).toBe(1);
    f.holders.add(vault.id);
    revoke = false;
    expect(await jobs.backfill(vault)).toBe("finished");
    expect(f.prices.version()).toBeGreaterThan(before);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(Boolean)).toBe(true);
  } finally {
    unsubscribe();
    await f.close();
  }
});
