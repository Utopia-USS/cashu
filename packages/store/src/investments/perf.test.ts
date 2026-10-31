// Investments perf (S25 spec 7.4, budgets in the cashu-ts-architecture performance reference: a day's
// apply <= 100 ms, a desktop rebuild <= 3 s). Workload: a synthetic investments vault of 5k inv
// transactions over 300 instruments with 2 aliases each, 2k signals with refresh churn, 500 notes,
// 50 alerts evaluated daily for a year (18k events), 200 thesis updates; then a day's events (one rule
// run, 40 signal events, 50 evaluations) and one instrument merge. Synthetic data.
//
// The default tier runs a tenth of the vault with generous CPU ceilings (CI machines, a loaded dev
// Mac). The full vault is an announced benchmark: CASHU_PERF=1 runs it and prints one `S25_PERF`
// line (CPU ms per phase); the measured numbers are recorded in the performance reference.
import { describe, expect, it } from "vitest";
import type { Store } from "../materialize.js";
import { rng } from "../testing/random.js";
import { openTestStore, type TestEnvelope } from "../testing/store.js";
import { account, claim, det, Events, ulid } from "./testkit.js";

interface Shape {
  instruments: number;
  txns: number;
  signals: number;
  notes: number;
  alerts: number;
  days: number;
  thesisUpdates: number;
}

const FULL: Shape = {
  instruments: 300,
  txns: 5_000,
  signals: 2_000,
  notes: 500,
  alerts: 50,
  days: 365,
  thesisUpdates: 200,
};
const SMALL: Shape = {
  instruments: 30,
  txns: 500,
  signals: 200,
  notes: 50,
  alerts: 5,
  days: 36,
  thesisUpdates: 20,
};

const DAY_MS = 86_400_000;
const iso = (wall: number) => new Date(1_793_448_000_000 + wall).toISOString();

function vault(shape: Shape) {
  const ev = new Events();
  const r = rng(7);
  const out: TestEnvelope[] = [];
  let wall = 0;
  const next = () => ++wall;
  const acc = ulid(1);
  out.push(account(ev, acc, [], { wall: next() }));
  const insts: string[] = [];
  for (let i = 0; i < shape.instruments; i++) {
    const alias: [string, string] = ["xtb", `I${i}.PL`];
    const g = det("inv_instruments", `${alias[0]}:${alias[1]}`);
    insts.push(g);
    out.push(
      ev.make(
        "instrument.created",
        g,
        { creationAlias: `${alias[0]}:${alias[1]}` },
        { wall: next() },
      ),
    );
    out.push(claim(ev, g, alias, { wall: next() }));
    out.push(claim(ev, g, ["stooq", `i${i}`], { wall: next() }));
  }
  for (let n = 0; n < shape.txns; n++) {
    const h = n.toString(16).padStart(64, "0");
    out.push(
      ev.make(
        "invTxn.imported",
        det("inv_transactions", acc, h),
        { account: acc, dedupHash: h, instrument: insts[n % insts.length] },
        { wall: next() },
      ),
    );
  }
  const sigs: string[] = [];
  for (let n = 0; n < shape.signals; n++) {
    const g = ulid(10_000 + n);
    sigs.push(g);
    const key = `dd|i:${insts[n % insts.length]}|s:${n}`;
    out.push(ev.make("signal.opened", g, { dedupKey: key, run: null }, { wall: next() }));
    out.push(ev.make("signal.refreshed", g, { run: null, seenAt: iso(wall) }, { wall: next() }));
    if (r() < 0.5) {
      out.push(ev.make("signal.closed", g, { status: "resolved", reason: "x" }, { wall: next() }));
    }
  }
  for (let n = 0; n < shape.notes; n++) {
    const g = ulid(20_000 + n);
    out.push(ev.make("note.added", g, { instrument: insts[n % insts.length] }, { wall: next() }));
    if (r() < 0.5) out.push(ev.make("note.read", g, {}, { wall: next() }));
  }
  const alerts: string[] = [];
  for (let n = 0; n < shape.alerts; n++) {
    const g = ulid(30_000 + n);
    alerts.push(g);
    out.push(
      ev.make("alert.created", g, { instrument: insts[n % insts.length] }, { wall: next() }),
    );
  }
  for (let d = 0; d < shape.days; d++) {
    for (const g of alerts) {
      out.push(
        ev.make(
          "alert.evaluated",
          g,
          { triggered: r() < 0.1, lastCheckedAt: iso(d * DAY_MS), lastValue: "1.0" },
          { wall: next() },
        ),
      );
    }
  }
  const th = ulid(40_000);
  out.push(ev.make("thesis.created", th, { instrument: insts[0] }, { wall: next() }));
  for (let n = 0; n < shape.thesisUpdates; n++) {
    out.push(ev.make("thesis.updated", th, { thesis: `Teza ${n}` }, { wall: next() }));
  }
  // A day's events: one rule run, 40 signal events, an evaluation of every alert.
  const day: TestEnvelope[] = [ev.make("ruleRun.finished", ulid(50_000), {}, { wall: next() })];
  for (let n = 0; n < 40; n++) {
    day.push(
      ev.make(
        "signal.refreshed",
        sigs[n] as string,
        { run: ulid(50_000), seenAt: iso(wall) },
        {
          wall: next(),
        },
      ),
    );
  }
  for (const g of alerts) {
    day.push(
      ev.make(
        "alert.evaluated",
        g,
        { triggered: false, lastCheckedAt: iso(wall) },
        { wall: next() },
      ),
    );
  }
  const merge = ev.make(
    "instrument.merged",
    insts[1] as string,
    { source: insts[1], target: insts[0], reason: "owner" },
    { wall: next() },
  );
  return { bulk: out, day, merge };
}

const cpu = () => process.cpuUsage();
const cpuMs = (t0: NodeJS.CpuUsage) => {
  const d = process.cpuUsage(t0);
  return Math.round((d.user + d.system) / 1000);
};

function measure(shape: Shape) {
  const w = vault(shape);
  const store: Store = openTestStore();
  let t = cpu();
  for (let i = 0; i < w.bulk.length; i += 1000) store.applyEnvelopes(w.bulk.slice(i, i + 1000));
  const bulk = cpuMs(t);
  t = cpu();
  store.rebuild();
  const rebuild = cpuMs(t);
  t = cpu();
  const day = store.applyEnvelopes(w.day);
  const dayMs = cpuMs(t);
  t = cpu();
  store.applyEnvelopes([w.merge]);
  const merge = cpuMs(t);
  expect(day.applied).toBe(w.day.length);
  return { events: w.bulk.length, bulk, rebuild, day: dayMs, merge, store };
}

describe("investments perf", () => {
  it("a tenth of a desktop vault: bulk, rebuild, a day's events, a merge within CPU ceilings", () => {
    const m = measure(SMALL);
    expect(m.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM inv_transactions")[0]?.n).toBe(
      SMALL.txns,
    );
    // Ceilings, not targets: the budgets are checked on the full vault (CASHU_PERF=1).
    expect(m.day).toBeLessThan(500);
    expect(m.rebuild).toBeLessThan(3_000);
  });

  it.skipIf(process.env.CASHU_PERF !== "1")(
    "the full vault against the budgets (announced benchmark)",
    { timeout: 120_000 },
    () => {
      const m = measure(FULL);
      console.log(
        `S25_PERF ${JSON.stringify({ events: m.events, bulkCpu: m.bulk, rebuildCpu: m.rebuild, dayCpu: m.day, mergeCpu: m.merge })}`,
      );
      expect(m.day).toBeLessThan(100);
      expect(m.rebuild).toBeLessThan(3_000);
    },
  );
});
