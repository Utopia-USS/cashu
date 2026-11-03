import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "../testing/harness.js";
import { workerFixture } from "../testing/worker.js";
import {
  BANK_BACKOFF_MS,
  BANK_INTERVAL_MS,
  budgetBlockedUntil,
  budgetDaysToFetch,
} from "./budget.js";
import type { BudgetSyncPort, WorkerBindings, WorkerStatePort } from "./contracts.js";
import { HostWorker } from "./service.js";

afterEach(cleanup);
function budgetBindings(
  f: Awaited<ReturnType<typeof workerFixture>>,
  port: BudgetSyncPort,
  state: WorkerStatePort = f.bindings.state,
): WorkerBindings {
  return {
    state,
    ownership: f.bindings.ownership,
    authority: (v) => f.bindings.authority(v),
    language: (v) => f.bindings.language(v),
    budget: port,
  };
}
describe("native bank worker durability", () => {
  it("interprets naive legacy times as UTC and never truncates an attempt deadline early", () => {
    const at = Date.parse("2026-01-01T00:00:00Z");
    expect(budgetBlockedUntil({ last_attempt: "2026-01-01T00:00:00" }, at + 72_000_000)).toBeNull();
    expect(
      budgetBlockedUntil({ last_attempt: "2026-01-01T01:00:00+01:00" }, at + 72_000_000 - 1),
    ).toBe(at + 72_000_000);
    expect(
      budgetBlockedUntil({ last_attempt: "2026-01-01T00:00:00.000001Z" }, at + 72_000_000),
    ).toBe(at + 72_000_000 + 1);
  });
  it("matches source interval/window boundaries and rate-limit backoff across restart", async () => {
    const f = await workerFixture({ modules: ["budget"] });
    let calls = 0;
    const port: BudgetSyncPort = {
      configured: () => true,
      hasSavedSessions: () => true,
      async sync(_v, days, guard) {
        guard();
        expect(days).toBe(90);
        calls++;
        return calls === 1
          ? { ok: true, errors: ["synthetic HTTP429"] }
          : { ok: true, inserted: 1, banks: 1 };
      },
    };
    let worker = new HostWorker(f.context, budgetBindings(f, port));
    try {
      await worker.tick();
      expect(calls).toBe(1);
      const vault = f.vaults[0];
      if (vault === undefined) throw new Error("missing synthetic vault");
      const state = await f.bindings.state.load(),
        book = state.budget[vault.id];
      expect(book?.last_status).toBe("partial");
      expect(Date.parse(book?.throttled_until ?? "") - f.time()).toBe(172_800_000);
      expect(
        budgetDaysToFetch(
          { last_success: new Date(f.time() - 8 * 86_400_000 - 1).toISOString() },
          f.time(),
        ),
      ).toBe(12);
      expect(
        budgetBlockedUntil(
          { last_attempt: new Date(f.time()).toISOString() },
          f.time() + BANK_INTERVAL_MS,
        ),
      ).toBeNull();
      await worker.stop();
      f.advance(BANK_INTERVAL_MS);
      worker = new HostWorker(f.context, budgetBindings(f, port));
      await worker.tick(true);
      expect(calls).toBe(1);
      f.advance(BANK_BACKOFF_MS - BANK_INTERVAL_MS);
      await worker.tick(true);
      expect(calls).toBe(2);
    } finally {
      await worker.stop();
      await f.close();
    }
  });
  it.each(["before_attempt_save", "after_attempt_save", "after_fetch", "after_result_save"])(
    "never repeats a bank fetch inside20h after %s",
    async (point) => {
      const f = await workerFixture({ modules: ["budget"] });
      let calls = 0,
        fault = true;
      const state: WorkerStatePort = {
        load: () => f.bindings.state.load(),
        async save(value) {
          const book = Object.values(value.budget)[0];
          if (
            fault &&
            point === "before_attempt_save" &&
            book?.last_attempt !== undefined &&
            book.last_status === undefined
          ) {
            fault = false;
            throw new Error("synthetic interrupted save");
          }
          await f.bindings.state.save(value);
          if (
            fault &&
            ((point === "after_attempt_save" &&
              book?.last_attempt !== undefined &&
              book.last_status === undefined) ||
              (point === "after_result_save" && book?.last_status === "ok"))
          ) {
            fault = false;
            throw new Error("synthetic interrupted save");
          }
        },
      };
      const port: BudgetSyncPort = {
        configured: () => true,
        hasSavedSessions: () => true,
        async sync(_v, _days, guard) {
          guard();
          calls++;
          if (fault && point === "after_fetch") {
            fault = false;
            throw new Error("synthetic interrupted reply");
          }
          return { ok: true };
        },
      };
      let worker = new HostWorker(f.context, budgetBindings(f, port, state));
      try {
        await worker.tick();
        const previousCalls = calls;
        await worker.stop();
        const persistedAttempt = Object.values((await f.bindings.state.load()).budget)[0]
          ?.last_attempt;
        fault = false;
        worker = new HostWorker(f.context, budgetBindings(f, port));
        f.advance(19 * 60 * 60_000);
        await worker.tick(true);
        expect(calls).toBe(persistedAttempt === undefined ? 1 : previousCalls);
        const last = await f.bindings.state.load();
        expect(Object.values(last.budget)[0]?.last_attempt).toBeDefined();
      } finally {
        await worker.stop();
        await f.close();
      }
    },
  );
  it("refuses corruption and ownership/lease loss before egress", async () => {
    const f = await workerFixture({ modules: ["budget"] });
    let calls = 0;
    const port: BudgetSyncPort = {
      configured: () => true,
      hasSavedSessions: () => true,
      async sync() {
        calls++;
        return { ok: true };
      },
    };
    let worker = new HostWorker(f.context, budgetBindings(f, port));
    try {
      f.owned.clear();
      await worker.tick();
      expect(calls).toBe(0);
      await worker.stop();
      f.owned.add("budget.sync");
      const state: WorkerStatePort = {
        load: () => f.bindings.state.load(),
        async save(value) {
          await f.bindings.state.save(value);
          if (Object.values(value.budget).some((book) => book.last_attempt !== undefined))
            f.holders.clear();
        },
      };
      worker = new HostWorker(f.context, budgetBindings(f, port, state));
      await worker.tick();
      expect(calls).toBe(0);
      expect(worker.status().jobs[0]?.code).toBe("authority_lost");
      await worker.stop();
      writeFileSync(join(f.directory, "native-state.json"), "{", { mode: 0o600 });
      worker = new HostWorker(f.context, budgetBindings(f, port));
      await worker.tick(true);
      expect(worker.status().state).toBe("error");
      expect(calls).toBe(0);
      expect(readFileSync(join(f.directory, "native-state.json"), "utf8")).toBe("{");
    } finally {
      await worker.stop();
      await f.close();
    }
  });
});
