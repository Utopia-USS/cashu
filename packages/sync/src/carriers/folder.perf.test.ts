// Performance on the spike's workload (spike-result.md "Synthetic workload": 62,000 transaction imports
// incl. 2,000 duplicate re-imports, 1,940 merchant category edits / deletes over 400 merchants, 300
// decisions, 100 transaction deletes = 64,340 events), through the production carrier: envelope
// (DEFLATE) + S27 frames + manifest gate + folder transport on a real disk. Synthetic data only.
//
// The sink only counts (the spike's numbers include its SQLite materializer, which is S23's cost
// here), so these numbers are the carrier's share. Ceilings are generous for CI machines and apply to
// the CPU time of this thread: wall time on a loaded machine (a parallel gate, other workers) measures
// the scheduler, not the carrier. Wall and CPU numbers are printed and recorded in the S28b checkpoint. Spike own-log reference (Node 23.9, M-series):
// bulk write + apply 453-483 ms, new device build 315-320 ms, full rebuild 324-329 ms, cold start
// 33-36 ms, incremental 10 edits 0.3 ms / 1000 tx 3.6 ms, log 16.0 MB uncompressed.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  ApplyOutcome,
  DeviceId,
  EventSink,
  InboundBatch,
  SegmentCursor,
  Transport,
  UnstampedEvent,
} from "../carrier.js";
import { createKeyring, createRecoveryKey, loadNodeSodium } from "../crypto/index.js";
import { createSyncEngine } from "../engine.js";
import { MemoryClockStore, MemoryTransport } from "../memory.js";
import { ManualClock } from "../testing/index.js";
import { seededRandom } from "../transports/folder/testing/cloud.js";
import { NodeFolderFs } from "../transports/folder/testing/node-fs.js";
import { FolderTransport } from "../transports/folder/transport.js";
import { createOwnLogCarrier } from "./ownlog/carrier.js";
import { createOwnLogCodec } from "./ownlog/codec.js";

const sodium = await loadNodeSodium();
const VAULT = "9e5f9e5f9e5f9e5f9e5f9e5f9e5f9e5f";
const A = "a1".repeat(16);
const B = "b2".repeat(16);
const C = "c3".repeat(16);
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

/** The spike generator's shapes and counts (spike/gen/generate.mjs), seeded. */
function workload(): UnstampedEvent[] {
  const rnd = seededRandom(0x5eed1234);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join("");
  const SYL = ["ka", "zo", "mi", "tur", "lex", "po", "ran", "vel", "qu", "dor", "sin", "ta", "bro"];
  const KIND = [
    "Sklep",
    "Market",
    "Bistro",
    "Serwis",
    "Apteka",
    "Studio",
    "Kino",
    "Stacja",
    "Hurt",
  ];
  const CATEGORIES = [
    "groceries",
    "restaurants",
    "transport",
    "fuel",
    "health",
    "utilities",
    "other",
  ];
  const merchants = Array.from({ length: 400 }, (_, i) => {
    const name = `${pick(KIND)} ${pick(SYL)}${pick(SYL)}${pick(SYL)}${i}`;
    return { key: name.toLowerCase().replace(/\s+/g, "-"), name };
  });
  const accounts = [
    { id: "acc-pln-main", currency: "PLN" },
    { id: "acc-pln-card", currency: "PLN" },
    { id: "acc-eur", currency: "EUR" },
  ];
  const events: UnstampedEvent[] = [];
  let eid = 0;
  const push = (t: string, d: Record<string, unknown>) => {
    eid += 1;
    events.push({ t, v: 1, i: `01JC${String(eid).padStart(22, "0")}`, d });
  };
  const txs: Record<string, unknown>[] = [];
  const start = Date.UTC(2021, 9, 1);
  for (let i = 0; i < 60_000; i++) {
    const acc = rnd() < 0.15 ? accounts[2] : accounts[rnd() < 0.6 ? 0 : 1];
    const m = pick(merchants);
    const income = rnd() < 0.04;
    const cents = income
      ? Math.floor(200000 + rnd() * 800000)
      : -Math.floor(100 + rnd() ** 2 * 60000);
    const date = new Date(start + i * 2_628_000).toISOString().slice(0, 10);
    const tx = {
      id: hex(32),
      account: acc?.id,
      date,
      amount: (cents / 100).toFixed(2),
      currency: acc?.currency,
      merchant: m.key,
      title: income ? "Przelew przychodzacy" : `Platnosc karta ${m.name}`,
    };
    txs.push(tx);
    push("txn.imported", tx);
  }
  for (const m of merchants)
    push("merchant.categorySet", { merchant: m.key, category: pick(CATEGORIES) });
  for (let i = 0; i < 1500; i++) {
    push("merchant.categorySet", { merchant: pick(merchants).key, category: pick(CATEGORIES) });
  }
  for (let i = 0; i < 40; i++) push("merchant.categoryDeleted", { merchant: pick(merchants).key });
  for (let i = 0; i < 300; i++) {
    push("decision.recorded", {
      id: `dec-${String(i).padStart(5, "0")}`,
      instrument: pick(["SYN-ETF-A", "SYN-ETF-B", "SYN-STOCK-C"]),
      action: pick(["buy", "sell", "hold", "skip"]),
      note: `Synthetic decision ${i}`,
    });
  }
  for (let i = 0; i < 100; i++) push("txn.deleted", { id: (pick(txs) as { id: string }).id });
  for (let i = 0; i < 2000; i++) push("txn.imported", pick(txs));
  return events;
}

/** Counts and keeps cursors; idempotent by eid like the store sink. */
class CountingSink implements EventSink {
  readonly #cursors = new Map<DeviceId, SegmentCursor>();
  readonly #eids = new Set<string>();
  cursors() {
    return new Map(this.#cursors);
  }
  apply(batch: InboundBatch): ApplyOutcome {
    let applied = 0;
    let duplicates = 0;
    for (const e of batch.events) {
      if (this.#eids.has(e.i)) duplicates += 1;
      else {
        this.#eids.add(e.i);
        applied += 1;
      }
    }
    this.#cursors.set(batch.device, batch.cursor);
    return { applied, duplicates, parked: 0 };
  }
  reset() {
    this.#cursors.clear();
    this.#eids.clear();
  }
  get size() {
    return this.#eids.size;
  }
}

/** The result, the wall time and this thread's CPU time (ms) of `fn`. */
async function time<T>(fn: () => Promise<T>): Promise<[T, number, number]> {
  const t = performance.now();
  const cpu = process.threadCpuUsage();
  const out = await fn();
  const used = process.threadCpuUsage(cpu);
  const round = (ms: number) => Math.round(ms * 10) / 10;
  return [out, round(performance.now() - t), round((used.user + used.system) / 1000)];
}

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `cashu-s28b-perf-${name}-`));
  roots.push(dir);
  return dir;
}

describe("folder carrier performance (spike workload, 64,340 events)", () => {
  it("bulk write, push, new device, rebuild, cold start, incremental", {
    timeout: 120_000,
  }, async () => {
    const events = workload();
    expect(events.length).toBe(64_340);
    const ring = createKeyring(sodium, createRecoveryKey(sodium).publicKeys, VAULT);
    const folder = new NodeFolderFs(await tempDir("folder"));
    const results: Record<string, number> = {};

    const device = async (
      id: DeviceId,
      local: Transport,
      sink: CountingSink,
      clock = new MemoryClockStore(),
    ) => {
      const codec = createOwnLogCodec({ sodium, ring });
      const remote = createOwnLogCarrier({
        transport: new FolderTransport({ fs: folder, owner: id }),
        codec,
        device: id,
      });
      return createSyncEngine({
        vault: VAULT,
        device: id,
        local,
        remotes: [remote],
        codec,
        sink,
        clockStore: clock,
        physicalClock: new ManualClock(T0),
      });
    };

    // Device A: the carrier's share of a bulk import (local log in memory, as the spike's frames
    // were sealed and appended once).
    const sinkA = new CountingSink();
    const a = await device(A, new MemoryTransport(), sinkA);
    const [written, bulk, bulkCpu] = await time(() => a.write(events));
    results.bulkWriteAndApply_ms = bulk;
    results.bulkWriteAndApply_cpu_ms = bulkCpu;
    results.bulkFrames = written.frames;
    expect(sinkA.size).toBe(64_340);

    const [, push] = await time(() => a.sync());
    results.pushToFolder_ms = push;
    const segs = (await folder.list(`${VAULT}/${A}`)) ?? [];
    results.logBytes = segs.reduce((n, e) => n + e.size, 0);
    results.logBytesPerEvent = Math.round(results.logBytes / 64_340);
    results.logSegments = segs.length;

    // Device B: new device, builds from the folder (pull + verify + copy + apply).
    const sinkB = new CountingSink();
    const b = await device(B, new MemoryTransport(), sinkB);
    const [, build, buildCpu] = await time(() => b.sync());
    results.newDeviceBuild_ms = build;
    results.newDeviceBuild_cpu_ms = buildCpu;
    expect(sinkB.size).toBe(64_340);

    const [, rebuild, rebuildCpu] = await time(() => b.rebuild());
    results.fullRebuild_ms = rebuild;
    results.fullRebuild_cpu_ms = rebuildCpu;
    expect(sinkB.size).toBe(64_340);

    // Incremental: A writes, pushes; B pulls and applies.
    const edits = (n: number, prefix: string): UnstampedEvent[] =>
      Array.from({ length: n }, (_, i) => ({
        t: "merchant.categorySet",
        v: 1,
        i: `${prefix}${String(i).padStart(20, "0")}`,
        d: { merchant: `sklep-kazomi${i % 400}`, category: "groceries" },
      }));
    const [, inc10] = await time(async () => {
      await a.write(edits(10, "inc10-"));
      await a.sync();
      await b.sync();
    });
    results.incremental10_endToEnd_ms = inc10;
    const [, inc1000] = await time(async () => {
      await a.write(edits(1000, "inc1k-"));
      await a.sync();
      await b.sync();
    });
    results.incremental1000_endToEnd_ms = inc1000;
    expect(sinkB.size).toBe(64_340 + 1010);

    // Device C: the same import into a durable local log (a private folder on disk). Each frame
    // append replaces the segment file (temp + fsync + rename), so this measures that cost too.
    const localC = new FolderTransport({ fs: new NodeFolderFs(await tempDir("local-c")) });
    const sinkC = new CountingSink();
    const clockC = new MemoryClockStore();
    const c = await device(C, localC, sinkC, clockC);
    const [, bulkDurable] = await time(() => c.write(events.map((e) => ({ ...e, i: `c-${e.i}` }))));
    results.bulkWriteAndApply_durableLocal_ms = bulkDurable;
    await c.sync();
    await c.close();
    // Cold start: reopen over the durable local log, one sync pass with nothing new.
    const [reopened, cold, coldCpu] = await time(async () => {
      const engine = await device(C, localC, sinkC, clockC);
      await engine.sync();
      return engine;
    });
    results.coldStart_ms = cold;
    results.coldStart_cpu_ms = coldCpu;
    await reopened.close();

    console.log(`S28b perf ${JSON.stringify(results)}`);
    // Ceilings: 5x the spike's own-log numbers (CI headroom); the target (2x) is checked on the
    // reference machine and recorded in the checkpoint.
    expect(bulkCpu).toBeLessThan(5 * 483);
    expect(buildCpu).toBeLessThan(5 * 320);
    expect(rebuildCpu).toBeLessThan(5 * 329);
    expect(coldCpu).toBeLessThan(5 * 36);
    expect(results.logBytes).toBeLessThan(16_035_578 / 3);
  });
});
