// Engine behaviour outside the carrier contract: input validation, lifecycle, a local log that is
// itself a synced folder (partial frames in `local`), a newer frame format.
import { describe, expect, it } from "vitest";
import type { SyncEngine, Transport } from "./carrier.js";
import { createSyncEngine } from "./engine.js";
import { SyncError } from "./errors.js";
import { MemoryClockStore, MemoryTransport } from "./memory.js";
import { utf8Encode } from "./runtime.js";
import { frameBytes } from "./segment.js";
import {
  FaultInjector,
  insecureTestCodec,
  insecureTestGate,
  ManualClock,
  MemorySink,
} from "./testing/index.js";

const VAULT = "0123456789abcdef0123456789abcdef";
const A = "daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const T0 = Date.UTC(2026, 9, 31, 12);
const codec = insecureTestCodec();
const gate = insecureTestGate();

async function engine(
  device: string,
  local: Transport,
  remotes: Transport[] = [],
  sink = new MemorySink(),
) {
  return createSyncEngine({
    vault: VAULT,
    device,
    local,
    remotes,
    codec,
    gate,
    sink,
    clockStore: new MemoryClockStore(),
    physicalClock: new ManualClock(T0),
  });
}

const ev = (i: string, g = "g1") => ({ t: "test.set", v: 1, i, g, d: { value: i } });

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  const e = await p.catch((err: unknown) => err);
  return e instanceof SyncError ? e.code : undefined;
}

describe("SyncEngine", () => {
  it("validates its configuration", async () => {
    const local = new MemoryTransport();
    expect(await codeOf(engine("UPPER-CASE-ID-00", local))).toBe("invalid-config");
    await expect(
      createSyncEngine({
        vault: "../escape",
        device: A,
        local,
        codec,
        gate,
        sink: new MemorySink(),
        clockStore: new MemoryClockStore(),
      }),
    ).rejects.toMatchObject({ code: "invalid-config" });
  });

  it("rejects empty batches, malformed events and pre-stamped events", async () => {
    const e = await engine(A, new MemoryTransport());
    expect(await codeOf(e.write([]))).toBe("invalid-event");
    const bad: unknown[] = [
      { t: "", v: 1, i: "x", d: {} },
      { t: "test.set", v: 0, i: "x", d: {} },
      { t: "test.set", v: 1, i: "", d: {} },
      { t: "test.set", v: 1, i: "x", d: null },
      { t: "test.set", v: 1, i: "x", d: {}, h: "0mvwcmtc0-0000-daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ];
    for (const b of bad) {
      expect(await codeOf(e.write([b as never]))).toBe("invalid-event");
    }
    expect((await e.sync()).batches).toBe(0);
  });

  it("refuses work after close and notifies listeners until unsubscribed", async () => {
    const e: SyncEngine = await engine(A, new MemoryTransport());
    const seen: number[] = [];
    const off = e.onApplied((info) => seen.push(info.events));
    await e.write([ev("e1"), ev("e2", "g2")]);
    off();
    await e.write([ev("e3")]);
    expect(seen).toEqual([2]);
    await e.close();
    expect(await codeOf(e.write([ev("e4")]))).toBe("closed");
    expect(await codeOf(e.sync())).toBe("closed");
  });

  it("serializes concurrent operations on one engine", async () => {
    const sink = new MemorySink();
    const e = await engine(A, new MemoryTransport(), [], sink);
    await Promise.all(Array.from({ length: 20 }, (_, n) => e.write([ev(`e${n}`, `g${n}`)])));
    expect(sink.size).toBe(20);
    const hlcs = sink.deliveries.flatMap((d) => d.hlcs);
    expect(hlcs).toEqual([...hlcs].sort());
  });

  it("waits on a partial frame in a local log that is a synced folder", async () => {
    const folder = new MemoryTransport();
    const a = await engine(A, new MemoryTransport(), [folder]);
    await a.write([ev("e1")]);
    await a.write([ev("e2", "g2")]);
    await a.sync();
    const size = (await folder.list(VAULT))[0]?.size ?? 0;
    const bLocal = new FaultInjector(folder);
    bLocal.capSize(A, 1, size - 2);
    const sink = new MemorySink();
    const b = await engine(B, bLocal, [], sink);
    const first = await b.sync();
    expect(first.applied).toBe(1);
    expect(first.rejected).toEqual([]);
    bLocal.uncap(A, 1);
    expect((await b.sync()).applied).toBe(1);
    expect(sink.size).toBe(2);
  });

  it("stops a stream at a newer frame format and asks for an upgrade", async () => {
    const remote = new MemoryTransport();
    const plain = utf8Encode(
      JSON.stringify({
        f: 2,
        e: [{ t: "test.set", v: 1, h: `0mvwcmtc0-0000-${A}`, i: "x", d: {} }],
      }),
    );
    const sealed = (
      await codec.seal(
        plain,
        { vault: VAULT, device: A, seg: 1, offset: 0 },
        codec.genesis(VAULT, A, 1),
      )
    ).sealed;
    await remote.append(VAULT, A, 1, 0, frameBytes(sealed));
    const b = await engine(B, new MemoryTransport(), [remote]);
    const r = await b.sync();
    expect(r.needsUpgrade).toBe(true);
    expect(r.rejected).toEqual([{ device: A, seg: 1, offset: 0, code: "frame-format" }]);
    expect(r.applied).toBe(0);
  });

  it("reports bounded propagation for the lease only while every bounded remote was reachable", async () => {
    const clock = new ManualClock(T0);
    // A relay whose calls take a second each (so pull start and push end differ).
    const slow = (inner: Transport, ms: number): Transport => ({
      consistency: { kind: "bounded", propagationMs: ms },
      list: async (v) => {
        clock.advance(1000);
        return inner.list(v);
      },
      read: (v, d, s, o) => inner.read(v, d, s, o),
      append: async (v, d, s, at, b) => {
        clock.advance(1000);
        return inner.append(v, d, s, at, b);
      },
    });
    const relay = new FaultInjector(slow(new MemoryTransport(), 120_000));
    const folder = new FaultInjector(new MemoryTransport());
    const eventualFolder: Transport = {
      consistency: { kind: "eventual" },
      list: (v) => folder.list(v),
      read: (v, d, s, o) => folder.read(v, d, s, o),
      append: (v, d, s, at, b) => folder.append(v, d, s, at, b),
    };
    const e = await createSyncEngine({
      vault: VAULT,
      device: A,
      local: new MemoryTransport(),
      remotes: [eventualFolder, relay],
      codec,
      gate,
      sink: new MemorySink(),
      clockStore: new MemoryClockStore(),
      physicalClock: clock,
    });
    expect(e.leaseTransport()).toEqual({ kind: "eventual" }); // before the first pass
    await e.write([ev("e1")]);
    await e.sync();
    expect(e.leaseTransport()).toEqual({
      kind: "bounded",
      propagationMs: 120_000,
      lastPullAt: T0,
      lastPushAt: T0 + 2000,
    });
    relay.setOnline(false);
    await e.sync();
    expect(e.leaseTransport()).toEqual({ kind: "eventual" });
    relay.setOnline(true);
    await e.sync();
    expect(e.leaseTransport().kind).toBe("bounded");
    // Only eventual remotes (a synced folder): never bounded.
    const f = await engine(B, new MemoryTransport(), [eventualFolder]);
    await f.sync();
    expect(f.leaseTransport()).toEqual({ kind: "eventual" });
  });
});
