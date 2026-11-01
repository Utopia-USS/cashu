// The carrier contract suite (S28a). Every carrier adapter runs it unchanged:
//
//   import { describeCarrierContract } from "@cashu/sync/testing";
//   describeCarrierContract({ name: "folder", createMedium: (vault) => ({ remoteFor, codecFor, ... }) });
//
// A carrier = the remote `Transport` (synced folder S28c, relay S28d, ...) + the vault's `FrameCodec`
// (S27 crypto via S28b). The suite drives the real engine over it, with the reference `MemorySink`
// and fault-injecting decorators, so no adapter needs test hooks of its own.
import { afterEach, describe, expect, it } from "vitest";
import type {
  Awaitable,
  DeviceId,
  FrameCodec,
  FrameGate,
  SyncEngine,
  SyncResult,
  Transport,
  UnstampedEvent,
  VaultId,
} from "../carrier.js";
import { createSyncEngine, type SyncEngineOptions } from "../engine.js";
import { SyncError, TransportError } from "../errors.js";
import { parseHlc } from "../hlc.js";
import { MemoryClockStore, MemoryTransport } from "../memory.js";
import { settlesWithin, utf8Encode } from "../runtime.js";
import { scanFrames } from "../segment.js";
import { FaultInjector, ManualClock } from "./faults.js";
import { checkPropagationClaim } from "./propagation.js";
import { MemorySink } from "./sink.js";

/** One shared remote medium for one vault: what several devices replicate through. */
export interface CarrierMedium {
  /** The remote transport as one device sees it (a client of the relay, its view of the folder). */
  remoteFor(device: DeviceId): Awaitable<Transport>;
  /** The frame codec of `device` (the vault's keys on every device; it signs as `device`). */
  codecFor(device: DeviceId): Awaitable<FrameCodec>;
  /** The frame gate of `device` (verifies every device's signed heads). */
  gateFor(device: DeviceId): Awaitable<FrameGate>;
  /** A device's local log store. Default: a fresh `MemoryTransport` per device. */
  localFor?(device: DeviceId): Awaitable<Transport>;
  /** Resolve once appends through one handle are visible through every other handle. */
  settle?(): Promise<void>;
  /**
   * Let `ms` of the medium's time pass without forcing anything visible (simulated clock, or a real
   * wait). Needed by the propagation check when the transport declares a non-zero bound.
   */
  elapse?(ms: number): Promise<void>;
  dispose?(): Promise<void>;
}

export interface CarrierUnderTest {
  readonly name: string;
  /** A fresh, empty medium per call. Two calls must give independent media. */
  createMedium(vault: VaultId): Awaitable<CarrierMedium>;
  /** Per-test timeout in ms (default 30 s), for transports over a network. */
  readonly timeoutMs?: number;
}

export const CONTRACT_VAULT = "c0ffee00c0ffee00c0ffee00c0ffee00";
const OTHER_VAULT = "0badbeef0badbeef0badbeef0badbeef";
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);
const MINUTE = 60_000;
/** A synthetic plaintext marker: it must never show up in remote bytes. */
const CANARY = "CANARY-PLAINTEXT-7f3a";

// Fixed 16-char device ids.
const A = "daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "dccccccccccccccccccccccccccccccc";
const D = "dddddddddddddddddddddddddddddddd";
const EVIL = "deeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

interface DeviceOptions {
  readonly clockOffsetMs?: number;
  readonly supported?: Readonly<Record<string, number>>;
  readonly maxFrameEvents?: number;
  readonly maxSegmentBytes?: number;
  /** Extra media this device also replicates through (idempotency across remotes). */
  readonly extraMedia?: readonly CarrierMedium[];
}

class TestDevice {
  engine!: SyncEngine;
  readonly remotes: FaultInjector[] = [];
  readonly id: DeviceId;
  readonly ctx: Ctx;
  readonly clock: ManualClock;
  readonly sink: MemorySink;
  clockStore: MemoryClockStore;
  readonly local: Transport;
  readonly codec: FrameCodec;
  readonly gate: FrameGate;
  readonly options: DeviceOptions;
  #eid = 0;

  private constructor(init: {
    id: DeviceId;
    ctx: Ctx;
    local: Transport;
    codec: FrameCodec;
    gate: FrameGate;
    options: DeviceOptions;
  }) {
    this.id = init.id;
    this.ctx = init.ctx;
    this.local = init.local;
    this.codec = init.codec;
    this.gate = init.gate;
    this.options = init.options;
    this.clock = new ManualClock(T0 + (init.options.clockOffsetMs ?? 0));
    this.sink = new MemorySink(init.options.supported);
    this.clockStore = new MemoryClockStore();
  }

  static async create(ctx: Ctx, id: DeviceId, options: DeviceOptions = {}): Promise<TestDevice> {
    const local = (await ctx.medium.localFor?.(id)) ?? new MemoryTransport();
    const codec = await ctx.medium.codecFor(id);
    const gate = await ctx.medium.gateFor(id);
    const device = new TestDevice({ id, ctx, local, codec, gate, options });
    for (const m of [ctx.medium, ...(options.extraMedia ?? [])]) {
      device.remotes.push(new FaultInjector(await m.remoteFor(id)));
    }
    await device.open();
    ctx.devices.push(device);
    return device;
  }

  get remote(): FaultInjector {
    const r = this.remotes[0];
    if (!r) throw new Error("device has no remote");
    return r;
  }

  async open(overrides: Partial<SyncEngineOptions> = {}): Promise<void> {
    this.engine = await createSyncEngine({
      vault: this.ctx.vault,
      device: this.id,
      local: this.local,
      remotes: this.remotes,
      codec: this.codec,
      gate: this.gate,
      sink: this.sink,
      clockStore: this.clockStore,
      physicalClock: this.clock,
      ...(this.options.maxFrameEvents ? { maxFrameEvents: this.options.maxFrameEvents } : {}),
      ...(this.options.maxSegmentBytes ? { maxSegmentBytes: this.options.maxSegmentBytes } : {}),
      ...overrides,
    });
  }

  async restart(): Promise<void> {
    await this.engine.close();
    await this.open();
  }

  ev(gid: string, value: unknown, extra: Partial<UnstampedEvent> = {}): UnstampedEvent {
    this.#eid += 1;
    return {
      t: "test.set",
      v: 1,
      i: `${this.id}-${this.#eid}`,
      g: gid,
      a: "2026-10-31T12:00:00.000Z",
      d: { value },
      ...extra,
    };
  }

  async write(...events: UnstampedEvent[]) {
    const result = await this.engine.write(events);
    this.clock.advance(1);
    return result;
  }

  async sync(): Promise<SyncResult> {
    await this.ctx.medium.settle?.();
    const result = await this.engine.sync();
    await this.ctx.medium.settle?.();
    return result;
  }
}

interface Ctx {
  readonly vault: VaultId;
  readonly medium: CarrierMedium;
  readonly devices: TestDevice[];
  readonly media: CarrierMedium[];
}

async function syncAll(...devices: TestDevice[]): Promise<void> {
  for (let round = 0; round < 2; round++) {
    for (const d of devices) await d.sync();
  }
}

function expectConverged(...devices: TestDevice[]): void {
  const [first, ...rest] = devices;
  if (!first) return;
  for (const d of rest) expect(d.sink.snapshot()).toBe(first.sink.snapshot());
}

async function frameOffsets(t: Transport, vault: VaultId, device: DeviceId, seg: number) {
  return scanFrames(await t.read(vault, device, seg, 0), 0).frames.map((f) => f.offset);
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function describeCarrierContract(carrier: CarrierUnderTest): void {
  const timeout = carrier.timeoutMs ?? 30_000;

  describe(`carrier contract: ${carrier.name}`, () => {
    const live: Ctx[] = [];

    afterEach(async () => {
      for (const ctx of live.splice(0)) {
        for (const d of ctx.devices) await d.engine.close();
        for (const m of ctx.media) await m.dispose?.();
      }
    });

    async function setup(): Promise<Ctx> {
      const medium = await carrier.createMedium(CONTRACT_VAULT);
      const ctx: Ctx = { vault: CONTRACT_VAULT, medium, devices: [], media: [medium] };
      live.push(ctx);
      return ctx;
    }

    async function extraMedium(ctx: Ctx): Promise<CarrierMedium> {
      const m = await carrier.createMedium(CONTRACT_VAULT);
      ctx.media.push(m);
      return m;
    }

    describe("transport", () => {
      it(
        "keeps its declared consistency: every append reaches every other handle within the bound",
        async () => {
          const ctx = await setup();
          const verdict = await checkPropagationClaim(ctx.medium, ctx.vault);
          expect(verdict.violations).toEqual([]);
          expect(verdict.ok).toBe(true);
        },
        timeout,
      );

      it(
        "lists nothing for an empty vault and reads nothing from an unknown segment",
        async () => {
          const ctx = await setup();
          const t = await ctx.medium.remoteFor(A);
          expect(await t.list(ctx.vault)).toEqual([]);
          expect((await t.read(ctx.vault, A, 1, 0)).length).toBe(0);
        },
        timeout,
      );

      it(
        "appends at the current size, reads from an offset, lists the size",
        async () => {
          const ctx = await setup();
          const t = await ctx.medium.remoteFor(A);
          await t.append(ctx.vault, A, 1, 0, new Uint8Array([1, 2, 3]));
          await t.append(ctx.vault, A, 1, 3, new Uint8Array([4, 5]));
          await ctx.medium.settle?.();
          expect(await t.list(ctx.vault)).toEqual([{ device: A, seg: 1, size: 5 }]);
          expect([...(await t.read(ctx.vault, A, 1, 2))]).toEqual([3, 4, 5]);
          expect((await t.read(ctx.vault, A, 1, 5)).length).toBe(0);
        },
        timeout,
      );

      it(
        "rejects an append at a wrong offset with offset-conflict and writes nothing",
        async () => {
          const ctx = await setup();
          const t = await ctx.medium.remoteFor(A);
          await t.append(ctx.vault, A, 1, 0, new Uint8Array([1, 2, 3]));
          for (const at of [0, 2, 4]) {
            const err = await t.append(ctx.vault, A, 1, at, new Uint8Array([9])).catch((e) => e);
            expect(err).toBeInstanceOf(TransportError);
            expect((err as TransportError).code).toBe("offset-conflict");
          }
          const err = await t.append(ctx.vault, A, 2, 1, new Uint8Array([9])).catch((e) => e);
          expect((err as TransportError).code).toBe("offset-conflict");
          await ctx.medium.settle?.();
          expect([...(await t.read(ctx.vault, A, 1, 0))]).toEqual([1, 2, 3]);
        },
        timeout,
      );

      it(
        "shows one device's segments to another handle, and keeps vaults apart",
        async () => {
          const ctx = await setup();
          const ta = await ctx.medium.remoteFor(A);
          const tb = await ctx.medium.remoteFor(B);
          await ta.append(ctx.vault, A, 1, 0, new Uint8Array([7, 7]));
          await tb.append(ctx.vault, B, 1, 0, new Uint8Array([8]));
          await tb.append(ctx.vault, B, 2, 0, new Uint8Array([9]));
          await ctx.medium.settle?.();
          const seen = [...(await tb.list(ctx.vault))].sort((x, y) =>
            x.device === y.device ? x.seg - y.seg : x.device < y.device ? -1 : 1,
          );
          expect(seen).toEqual([
            { device: A, seg: 1, size: 2 },
            { device: B, seg: 1, size: 1 },
            { device: B, seg: 2, size: 1 },
          ]);
          expect([...(await tb.read(ctx.vault, A, 1, 0))]).toEqual([7, 7]);
          expect(await ta.list(OTHER_VAULT)).toEqual([]);
        },
        timeout,
      );

      it(
        "notifies a watcher when another handle appends (when watch is supported)",
        async () => {
          const ctx = await setup();
          const ta = await ctx.medium.remoteFor(A);
          const tb = await ctx.medium.remoteFor(B);
          if (!tb.watch) return;
          let stop: (() => void) | undefined;
          const fired = new Promise<void>((resolve) => {
            stop = tb.watch?.(ctx.vault, () => resolve());
          });
          await ta.append(ctx.vault, A, 1, 0, new Uint8Array([1]));
          await ctx.medium.settle?.();
          expect(await settlesWithin(fired, timeout / 2)).toBe(true);
          stop?.();
        },
        timeout,
      );
    });

    describe("engine over the carrier", () => {
      it(
        "keeps the remote opaque: no plaintext marker in remote bytes",
        async () => {
          const ctx = await setup();
          const a = await TestDevice.create(ctx, A);
          await a.write(a.ev("g1", CANARY), a.ev("g2", { note: CANARY }));
          await a.sync();
          const t = await ctx.medium.remoteFor(B);
          const segs = await t.list(ctx.vault);
          expect(segs.length).toBeGreaterThan(0);
          const marker = utf8Encode(CANARY);
          for (const s of segs) {
            const bytes = await t.read(ctx.vault, s.device, s.seg, 0);
            expect(indexOfBytes(bytes, marker)).toBe(-1);
          }
        },
        timeout,
      );

      it(
        "ordering: each device stream arrives in write order with strictly increasing HLCs",
        async () => {
          const ctx = await setup();
          const a = await TestDevice.create(ctx, A);
          const b = await TestDevice.create(ctx, B);
          const c = await TestDevice.create(ctx, C);
          const types = new Set<string>();
          c.engine.onApplied((info) => {
            for (const t of info.types) types.add(t);
          });
          const written: Record<string, string[]> = { [A]: [], [B]: [] };
          for (let i = 0; i < 3; i++) {
            const r = await a.write(a.ev(`a${i}`, i), a.ev(`a${i}x`, i));
            written[A]?.push(r.first, r.last);
          }
          for (let i = 0; i < 2; i++) {
            const r = await b.write(b.ev(`b${i}`, i));
            written[B]?.push(r.first);
          }
          await a.sync();
          await b.sync();
          const result = await c.sync();
          expect(result.applied).toBe(8);
          expect(types).toEqual(new Set(["test.set"]));
          for (const device of [A, B]) {
            const hlcs = c.sink.deliveries
              .filter((d) => d.device === device)
              .flatMap((d) => d.hlcs);
            expect(hlcs).toEqual([...hlcs].sort());
            expect(new Set(hlcs).size).toBe(hlcs.length);
            for (const h of written[device] ?? []) expect(hlcs).toContain(h);
            for (const h of hlcs) expect(parseHlc(h).device).toBe(device);
          }
        },
        timeout,
      );

      it(
        "ordering: a write after a sync sorts after everything it saw, even with a slow clock",
        async () => {
          const ctx = await setup();
          const a = await TestDevice.create(ctx, A);
          const b = await TestDevice.create(ctx, B, { clockOffsetMs: -4 * MINUTE });
          const ra = await a.write(a.ev("shared", "from-a"));
          await a.sync();
          await b.sync();
          const rb = await b.write(b.ev("shared", "from-b"));
          expect(rb.first > ra.last).toBe(true);
          await syncAll(a, b);
          expect(a.sink.value("shared")).toBe("from-b");
          expectConverged(a, b);
        },
        timeout,
      );

      it(
        "idempotent re-delivery: lost cursors replay without changing the view",
        async () => {
          const ctx = await setup();
          const a = await TestDevice.create(ctx, A);
          const b = await TestDevice.create(ctx, B);
          await a.write(a.ev("g1", 1), a.ev("g2", 2));
          await a.write(a.ev("g1", 3));
          await a.sync();
          await b.sync();
          const before = b.sink.snapshot();
          b.sink.forgetCursors();
          const again = await b.sync();
          expect(again.applied).toBe(0);
          expect(again.duplicates).toBe(3);
          expect(b.sink.snapshot()).toBe(before);
          expect(b.sink.conflicts).toBe(0);
          const quiet = await b.sync();
          expect(quiet.batches).toBe(0);
        },
        timeout,
      );

      it(
        "idempotent re-delivery: the same frames through two remotes are copied and applied once",
        async () => {
          const ctx = await setup();
          const second = await extraMedium(ctx);
          const a = await TestDevice.create(ctx, A, { extraMedia: [second] });
          const b = await TestDevice.create(ctx, B, { extraMedia: [second] });
          const w = await a.write(a.ev("g1", 1), a.ev("g2", 2));
          await a.write(a.ev("g3", 3));
          const pushed = await a.sync();
          expect(pushed.pushedBytes).toBeGreaterThan(0);
          await second.settle?.();
          const r = await b.sync();
          expect(r.pulledFrames).toBe(w.frames + 1);
          expect(r.applied).toBe(3);
          expect(r.duplicates).toBe(0);
          expect(await b.local.list(ctx.vault)).toEqual(
            (await a.local.list(ctx.vault)).filter((s) => s.device === A),
          );
          expectConverged(a, b);
        },
        timeout,
      );

      it(
        "offline writes stay local, then merge when the remote is back",
        async () => {
          const ctx = await setup();
          const a = await TestDevice.create(ctx, A);
          const b = await TestDevice.create(ctx, B);
          a.remote.setOnline(false);
          for (let i = 0; i < 3; i++) await a.write(a.ev(`a${i}`, i));
          const off = await a.sync();
          expect(off.offlineRemotes).toBe(1);
          expect(a.sink.size).toBe(3);
          await b.write(b.ev("b0", "x"));
          await b.sync();
          a.remote.setOnline(true);
          await syncAll(a, b);
          expect(a.sink.size).toBe(4);
          expectConverged(a, b);
        },
        timeout,
      );

      it(
        "two writers on the same entity converge on the higher HLC",
        async () => {
          const ctx = await setup();
          const a = await TestDevice.create(ctx, A);
          const b = await TestDevice.create(ctx, B, { clockOffsetMs: 1000 });
          await a.write(a.ev("shared", "a1"));
          await b.write(b.ev("shared", "b1"));
          await a.write(a.ev("shared", "a2"), a.ev("onlyA", 1));
          await syncAll(a, b);
          expectConverged(a, b);
          expect(a.sink.value("shared")).toBe("b1");
          expect(a.sink.size).toBe(2);
        },
        timeout,
      );

      it(
        "three writers converge whatever the sync order, and a new device rebuilds the same view",
        async () => {
          const ctx = await setup();
          const a = await TestDevice.create(ctx, A);
          const b = await TestDevice.create(ctx, B, { clockOffsetMs: 500 });
          const c = await TestDevice.create(ctx, C, { clockOffsetMs: -500 });
          const shared: string[] = [];
          for (const [i, dev] of [a, b, c].entries()) {
            const w = await dev.write(dev.ev("shared", dev.id), dev.ev(`own-${i}`, i));
            shared.push(w.first);
          }
          await c.sync();
          shared.push((await a.write(a.ev("shared", "a-after"))).first);
          for (const order of [
            [c, b, a],
            [b, a, c],
            [a, c, b],
          ]) {
            for (const dev of order) await dev.sync();
          }
          expectConverged(a, b, c);
          expect(a.sink.winner("shared")?.h).toBe([...shared].sort().at(-1));
          const d = await TestDevice.create(ctx, D);
          await d.sync();
          expectConverged(a, d);
        },
        timeout,
      );

      it(
        "large batch: a frame group is applied atomically and segments roll over",
        async () => {
          const ctx = await setup();
          const a = await TestDevice.create(ctx, A, {
            maxFrameEvents: 250,
            maxSegmentBytes: 64 * 1024,
          });
          const b = await TestDevice.create(ctx, B);
          const events = Array.from({ length: 5000 }, (_, i) => a.ev(`tx-${i}`, i));
          const w = await a.write(...events);
          expect(w.frames).toBe(20);
          expect(a.sink.size).toBe(5000);
          await a.sync();
          const segs = (await a.local.list(ctx.vault)).filter((s) => s.device === A);
          expect(segs.length).toBeGreaterThan(1);
          const last = segs.reduce((x, y) => (y.seg > x.seg ? y : x));
          b.remote.capSize(A, last.seg, last.size - 3);
          const partial = await b.sync();
          expect(partial.applied).toBe(0);
          expect(partial.rejected).toEqual([]);
          expect(b.sink.size).toBe(0);
          b.remote.uncap(A, last.seg);
          const full = await b.sync();
          expect(full.batches).toBe(1);
          expect(full.applied).toBe(5000);
          expect(b.sink.deliveries.at(-1)?.hlcs.length).toBe(5000);
          expectConverged(a, b);
        },
        timeout,
      );

      it(
        "partial segment: a frame still arriving waits, then is picked up",
        async () => {
          const ctx = await setup();
          const a = await TestDevice.create(ctx, A);
          const b = await TestDevice.create(ctx, B);
          await a.write(a.ev("g1", 1));
          await a.write(a.ev("g2", 2));
          await a.sync();
          const size = (await a.local.list(ctx.vault)).find((s) => s.device === A)?.size ?? 0;
          b.remote.capSize(A, 1, size - 5);
          const first = await b.sync();
          expect(first.applied).toBe(1);
          expect(first.rejected).toEqual([]);
          expect(b.sink.value("g2")).toBeUndefined();
          b.remote.uncap(A, 1);
          const second = await b.sync();
          expect(second.applied).toBe(1);
          expectConverged(a, b);
        },
        timeout,
      );

      it(
        "unknown event types and newer versions pass through parked, flagged needsUpgrade",
        async () => {
          const ctx = await setup();
          const a = await TestDevice.create(ctx, A, {
            supported: { "test.set": 2, "future.thing": 1 },
          });
          const b = await TestDevice.create(ctx, B);
          const future = a.ev("f1", "x", { t: "future.thing", zz: { nested: [1, "two"] } });
          const newer = a.ev("g1", "v2", { v: 2 });
          const known = a.ev("g2", "v1");
          await a.write(future, newer, known);
          await a.sync();
          const r = await b.sync();
          expect(r.parked).toBe(2);
          expect(r.applied).toBe(1);
          expect(r.needsUpgrade).toBe(true);
          const parked = b.sink.parkedEvents();
          expect(parked.map((e) => e.i)).toEqual([future.i, newer.i]);
          expect(parked[0]?.zz).toEqual({ nested: [1, "two"] });
          expect(parked[0]?.t).toBe("future.thing");
          b.sink.upgrade({ "test.set": 2, "future.thing": 1 });
          const rebuilt = await b.engine.rebuild();
          expect(rebuilt.parked).toBe(0);
          expect(rebuilt.applied).toBe(3);
          expect(rebuilt.needsUpgrade).toBe(false);
          expectConverged(a, b);
        },
        timeout,
      );

      it(
        "tamper: a changed byte is rejected by the codec, never applied, retried later",
        async () => {
          const ctx = await setup();
          const a = await TestDevice.create(ctx, A);
          const b = await TestDevice.create(ctx, B);
          for (let i = 0; i < 3; i++) await a.write(a.ev(`g${i}`, i));
          await a.sync();
          const offsets = await frameOffsets(a.local, ctx.vault, A, 1);
          const second = offsets[1] ?? 0;
          b.remote.corrupt(A, 1, second + 10);
          const r = await b.sync();
          expect(r.applied).toBe(1);
          expect(r.rejected).toHaveLength(1);
          expect(r.rejected[0]).toMatchObject({ device: A, seg: 1, offset: second });
          expect((await b.local.list(ctx.vault)).find((s) => s.device === A)?.size).toBe(second);
          b.remote.heal();
          const healed = await b.sync();
          expect(healed.rejected).toEqual([]);
          expect(healed.applied).toBe(2);
          expectConverged(a, b);
        },
        timeout,
      );

      it(
        "tamper: a frame copied under another device is rejected",
        async () => {
          const ctx = await setup();
          const a = await TestDevice.create(ctx, A);
          const b = await TestDevice.create(ctx, B);
          await a.write(a.ev("g1", 1));
          await a.sync();
          await ctx.medium.settle?.();
          const t = await ctx.medium.remoteFor(EVIL);
          const stolen = await t.read(ctx.vault, A, 1, 0);
          await t.append(ctx.vault, EVIL, 1, 0, stolen);
          const r = await b.sync();
          expect(r.applied).toBe(1);
          expect(r.rejected).toEqual([
            expect.objectContaining({ device: EVIL, seg: 1, offset: 0 }),
          ]);
          expect(b.sink.deliveries.every((d) => d.device !== EVIL)).toBe(true);
        },
        timeout,
      );

      it(
        "restart restores the clock; a clock far behind the persisted one refuses to stamp",
        async () => {
          const ctx = await setup();
          const a = await TestDevice.create(ctx, A);
          a.clock.advance(10 * MINUTE);
          const before = await a.write(a.ev("g1", 1));
          a.clock.advance(-4 * MINUTE);
          await a.restart();
          const after = await a.write(a.ev("g1", 2));
          expect(after.first > before.last).toBe(true);
          a.clock.advance(-10 * MINUTE);
          await a.restart();
          const err = await a.engine.write([a.ev("g1", 3)]).catch((e) => e);
          expect(err).toBeInstanceOf(SyncError);
          expect((err as SyncError).code).toBe("clock-behind");
          expect(a.sink.value("g1")).toBe(2);
        },
        timeout,
      );

      it(
        "rollback: a clock behind the device's own log, or a cloned device, refuses to write",
        async () => {
          const ctx = await setup();
          const a = await TestDevice.create(ctx, A);
          await a.write(a.ev("g1", 1));
          await a.sync();
          a.clockStore = new MemoryClockStore();
          await a.restart();
          const err = await a.engine.write([a.ev("g1", 2)]).catch((e) => e);
          expect((err as SyncError).code).toBe("rolled-back");

          const clone = await TestDevice.create(ctx, A);
          const r = await clone.sync();
          expect(r.rolledBack).toBe(true);
          const cloneErr = await clone.engine.write([clone.ev("g9", 1)]).catch((e) => e);
          expect((cloneErr as SyncError).code).toBe("rolled-back");
        },
        timeout,
      );

      it(
        "far-future guard: a remote clock far ahead is applied but does not drag the local clock",
        async () => {
          const ctx = await setup();
          const a = await TestDevice.create(ctx, A);
          const c = await TestDevice.create(ctx, C, { clockOffsetMs: 24 * 60 * MINUTE });
          const rc = await c.write(c.ev("shared", "future"));
          await c.sync();
          const r = await a.sync();
          expect(r.applied).toBe(1);
          expect(r.clockWarnings).toEqual([
            expect.objectContaining({ kind: "remote-far-future", device: C }),
          ]);
          const ra = await a.write(a.ev("mine", 1));
          expect(parseHlc(ra.first).wall).toBeLessThan(parseHlc(rc.first).wall);
          expect(a.sink.value("shared")).toBe("future");
        },
        timeout,
      );
    });
  });
}
