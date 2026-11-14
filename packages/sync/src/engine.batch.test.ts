// The engine's batch API (S29c-B3, spec 9): every batch of a sync pass reaches the sink in ONE
// `applyBatches` transaction, chunked at `maxBatchEvents` / `maxBatchBytes`; a sink failure applies
// nothing (cursors unchanged) and the next pass re-delivers everything. A write is one atomic append:
// a crash during a multi-frame write never leaves part of its frame group in the stream.
import { describe, expect, it } from "vitest";
import type { Transport } from "./carrier.js";
import { createSyncEngine, type SyncEngineOptions } from "./engine.js";
import { insecureTestCodec, insecureTestGate, ManualClock, MemorySink } from "./testing/index.js";
import { MemoryClockStore, MemoryTransport } from "./testing/memory.js";
import { MemoryFolderFs } from "./transports/folder/testing/memory-fs.js";
import { FolderTransport } from "./transports/folder/transport.js";

const VAULT = "0123456789abcdef0123456789abcdef";
const A = "daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "dccccccccccccccccccccccccccccccc";
const T0 = Date.UTC(2026, 9, 31, 12);

function open(
  device: string,
  remote: Transport,
  sink = new MemorySink(),
  extra: Partial<SyncEngineOptions> = {},
) {
  return createSyncEngine({
    vault: VAULT,
    device,
    local: new MemoryTransport(),
    remotes: [remote],
    codec: insecureTestCodec(),
    gate: insecureTestGate(),
    sink,
    clockStore: new MemoryClockStore(),
    physicalClock: new ManualClock(T0),
    ...extra,
  });
}

let n = 0;
const ev = (g: string) => {
  n += 1;
  return { t: "test.set", v: 1, i: `e-${n}`, g, d: { value: n } };
};

/** A remote holding `writes` single-frame writes of A (sizes) and two of B. */
async function populated(sizes: readonly number[]): Promise<MemoryTransport> {
  const remote = new MemoryTransport();
  const a = await open(A, remote);
  for (const [w, size] of sizes.entries()) {
    await a.write(Array.from({ length: size }, (_, i) => ev(`a-${w}-${i}`)));
  }
  await a.sync();
  const b = await open(B, remote);
  await b.write([ev("b-1")]);
  await b.write([ev("b-2"), ev("b-3")]);
  await b.sync();
  return remote;
}

describe("engine batch API (one sink transaction per pull)", () => {
  it("applies a whole pull in one transaction", async () => {
    const remote = await populated([1, 2, 3]);
    const sink = new MemorySink();
    const c = await open(C, remote, sink);
    const r = await c.sync();
    expect(r.batches).toBe(5);
    expect(r.applied).toBe(9);
    expect(sink.transactions).toEqual([{ batches: 5, events: 9 }]);
    expect((await c.sync()).batches).toBe(0);
    expect(sink.transactions).toHaveLength(1);
  });

  it("is atomic: a sink failure applies nothing and the next pass applies everything", async () => {
    const remote = await populated([1, 2, 3]);
    const sink = new MemorySink();
    const c = await open(C, remote, sink);
    sink.failAtBatch = 3;
    await expect(c.sync()).rejects.toThrow("injected sink failure");
    expect(sink.deliveries).toEqual([]);
    expect(sink.cursors().size).toBe(0);
    expect(sink.size).toBe(0);
    const again = await c.sync();
    expect(again.applied).toBe(9);
    const reference = new MemorySink();
    await (await open(C, remote, reference)).sync();
    expect(sink.snapshot()).toBe(reference.snapshot());
    expect(sink.cursors()).toEqual(reference.cursors());
  });

  it("chunks a large pull at maxBatchEvents without changing the view", async () => {
    const remote = await populated(Array.from({ length: 19 }, () => 5));
    const chunked = new MemorySink();
    const r = await (await open(C, remote, chunked, { maxBatchEvents: 10 })).sync();
    expect(r.applied).toBe(98);
    // 19 batches of 5 then B's 1 and 2: every transaction holds at most 10 events.
    expect(chunked.transactions.map((t) => t.events)).toEqual([
      10, 10, 10, 10, 10, 10, 10, 10, 10, 8,
    ]);
    const whole = new MemorySink();
    await (await open(C, remote, whole)).sync();
    expect(whole.transactions).toHaveLength(1);
    expect(chunked.snapshot()).toBe(whole.snapshot());
    expect(chunked.cursors()).toEqual(whole.cursors());
  });

  it("chunks at maxBatchBytes; a single batch larger than the cap is still one transaction", async () => {
    const remote = await populated([40, 1, 1]);
    const sink = new MemorySink();
    await (await open(C, remote, sink, { maxBatchBytes: 200 })).sync();
    expect(sink.transactions[0]).toEqual({ batches: 1, events: 40 });
    expect(sink.transactions.reduce((x, t) => x + t.events, 0)).toBe(45);
    expect(sink.transactions.length).toBeGreaterThan(2);
  });
});

class Crash extends Error {}

describe("atomic batch append (a write's frames in one append)", () => {
  it("a crash during a multi-frame write leaves no partial frame group behind", async () => {
    // The local log is a folder: an append writes a temp file and renames it over the segment.
    // The power goes out right after the torn write's FIRST rename completed (a write appending
    // frame by frame has then made only its first frame durable).
    const fs = new MemoryFolderFs();
    let renames = 0;
    let crashAfter = 0;
    const crashing = new Proxy(fs, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return async (...args: unknown[]) => {
          const out = await v.apply(target, args);
          if (prop === "rename") {
            renames += 1;
            if (renames === crashAfter) throw new Crash("power loss");
          }
          return out;
        };
      },
    });
    const remote = new MemoryTransport();
    const sink = new MemorySink();
    const options = {
      maxFrameEvents: 2,
      local: new FolderTransport({ fs: crashing, owner: A }),
      clockStore: new MemoryClockStore(),
    };
    const a = await open(A, remote, sink, options);
    await a.write([ev("before")]);
    const torn = Array.from({ length: 6 }, (_, i) => ev(`torn-${i}`));
    crashAfter = renames + 1;
    await expect(a.write(torn)).rejects.toThrow("power loss");
    crashAfter = 0;

    // Restart on the same disk: the torn write is in the stream whole (or not at all), and the
    // stream goes on cleanly.
    const again = await open(A, remote, sink, options);
    const after = await again.write(Array.from({ length: 5 }, (_, i) => ev(`after-${i}`)));
    expect(after.frames).toBe(3);
    const own = await again.sync();
    expect(own.rejected).toEqual([]);
    const b = new MemorySink();
    const pulled = await (await open(B, remote, b)).sync();
    expect(pulled.rejected).toEqual([]);
    expect(b.value("before")).toBeDefined();
    const tornHeld = torn.filter((e) => b.value(e.g) !== undefined).length;
    expect([0, torn.length]).toContain(tornHeld);
    for (let i = 0; i < 5; i++) expect(b.value(`after-${i}`)).toBeDefined();
    expect(sink.snapshot()).toBe(b.snapshot());
  });

  it("appends a multi-frame write with one append", async () => {
    const local = new MemoryTransport();
    let appends = 0;
    const counting = new Proxy(local, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (prop === "append") appends += 1;
          return v.apply(target, args);
        };
      },
    });
    const a = await open(A, new MemoryTransport(), new MemorySink(), {
      local: counting,
      maxFrameEvents: 10,
    });
    const w = await a.write(Array.from({ length: 65 }, (_, i) => ev(`bulk-${i}`)));
    expect(w.frames).toBe(7);
    expect(appends).toBe(1);
  });
});
