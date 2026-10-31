// Multi-device scenarios over the production carrier (own log + folder transport) with a simulated
// sync service between per-device replicas (in memory, deterministic seeds). Synthetic events only.
import { describe, expect, it } from "vitest";
import type { DeviceId, SyncEngine, SyncResult, Transport, UnstampedEvent } from "../carrier.js";
import {
  createKeyring,
  createRecoveryKey,
  type Keyring,
  loadNodeSodium,
  rotateKeyring,
} from "../crypto/index.js";
import { createSyncEngine } from "../engine.js";
import { MemoryClockStore, MemoryTransport } from "../memory.js";
import { ManualClock, MemorySink } from "../testing/index.js";
import { CloudSim, seededRandom } from "../transports/folder/testing/cloud.js";
import { MemoryFolderFs } from "../transports/folder/testing/memory-fs.js";
import { FolderTransport } from "../transports/folder/transport.js";
import { createOwnLogCarrier, type OwnLogCarrier } from "./ownlog/carrier.js";
import { createOwnLogCodec } from "./ownlog/codec.js";

const sodium = await loadNodeSodium();
const recovery = createRecoveryKey(sodium).publicKeys;
const VAULT = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
const A = "a1".repeat(16);
const B = "b2".repeat(16);
const C = "c3".repeat(16);
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

interface DeviceOptions {
  /** Small segments and frames make every scenario cross segment boundaries. */
  readonly maxSegmentBytes?: number;
  readonly maxFrameEvents?: number;
  /** Keep the local log in a folder too (durable across restarts). */
  readonly durableLocal?: boolean;
  /** Use the folder transport without the manifest gate (regression scenario only). */
  readonly ungated?: boolean;
}

class Device {
  readonly id: DeviceId;
  readonly ring: Keyring;
  readonly replica: MemoryFolderFs;
  readonly sink = new MemorySink();
  readonly clockStore = new MemoryClockStore();
  readonly clock: ManualClock;
  readonly local: Transport;
  readonly options: DeviceOptions;
  readonly rejected: SyncResult["rejected"][number][] = [];
  carrier!: OwnLogCarrier;
  engine!: SyncEngine;
  written = 0;
  /** Events written to the shared gid (one register for all of them). */
  shared = 0;

  constructor(id: DeviceId, ring: Keyring, replica: MemoryFolderFs, options: DeviceOptions = {}) {
    this.id = id;
    this.ring = ring;
    this.replica = replica;
    this.options = options;
    this.clock = new ManualClock(T0);
    this.local = options.durableLocal
      ? new FolderTransport({ fs: new MemoryFolderFs() }) // the local log holds every device's frames
      : new MemoryTransport();
  }

  async open(): Promise<void> {
    const codec = createOwnLogCodec({ sodium, ring: this.ring });
    const folder = new FolderTransport({ fs: this.replica, owner: this.id });
    this.carrier = createOwnLogCarrier({ transport: folder, codec, device: this.id });
    this.engine = await createSyncEngine({
      vault: VAULT,
      device: this.id,
      local: this.local,
      remotes: [this.options.ungated ? folder : this.carrier],
      codec,
      sink: this.sink,
      clockStore: this.clockStore,
      physicalClock: this.clock,
      maxSegmentBytes: this.options.maxSegmentBytes ?? 1500,
      maxFrameEvents: this.options.maxFrameEvents ?? 8,
    });
  }

  async restart(): Promise<void> {
    await this.engine.close();
    await this.open();
  }

  async write(count: number, shared?: string): Promise<void> {
    const events: UnstampedEvent[] = [];
    if (shared) this.shared += 1;
    for (let i = 0; i < count; i++) {
      this.written += 1;
      const n = this.written;
      events.push({
        t: "test.set",
        v: 1,
        i: `${this.id.slice(0, 4)}-${n}`,
        g: shared && i === 0 ? shared : `${this.id.slice(0, 4)}-g${n}`,
        a: "2026-10-31T12:00:00.000Z",
        d: { value: `${this.id.slice(0, 4)}:${n}`, note: "synthetic payload ".repeat(3) },
      });
    }
    await this.engine.write(events);
    this.clock.advance(7);
  }

  async sync(): Promise<SyncResult> {
    const r = await this.engine.sync();
    this.rejected.push(...r.rejected);
    return r;
  }
}

function ringPair(): Keyring {
  return createKeyring(sodium, recovery, VAULT);
}

async function makeWorld(seed: number, ids: DeviceId[], options: DeviceOptions = {}, rates = {}) {
  const sim = new CloudSim({ seed, partialRate: 0.35, conflictRate: 0.35, maxDelay: 6, ...rates });
  const ring = ringPair();
  const devices: Device[] = [];
  for (const id of ids) {
    const replica = new MemoryFolderFs();
    sim.addReplica(id, replica);
    const d = new Device(id, ring.clone(sodium), replica, options);
    await d.open();
    devices.push(d);
  }
  return { sim, devices };
}

async function settleAll(sim: CloudSim, devices: Device[]): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await sim.flush();
    for (const d of devices) await d.sync();
  }
  await sim.flush();
}

function expectConverged(devices: Device[]): void {
  const [first, ...rest] = devices;
  if (!first) return;
  for (const d of rest) expect(d.sink.snapshot()).toBe(first.sink.snapshot());
}

/** Copy one file from one replica to another (a sync tool moving exactly that file). */
function deliver(from: MemoryFolderFs, to: MemoryFolderFs, path: string, upTo?: number): void {
  const bytes = from.get(path);
  if (!bytes) throw new Error(`no file ${path}`);
  to.put(path, bytes.slice(0, upTo ?? bytes.length));
}

const segPath = (device: DeviceId, seg: number) =>
  `${VAULT}/${device}/${String(seg).padStart(6, "0")}.seg`;

describe("folder carrier: devices syncing through one folder", () => {
  for (const [label, ids] of [
    ["two devices", [A, B]],
    ["three devices", [A, B, C]],
  ] as const) {
    it(`${label}: random delays, reordering, partial downloads and conflict copies converge`, async () => {
      let conflicts = 0;
      let partials = 0;
      for (const seed of [11, 23, 37, 41, 59]) {
        const { sim, devices } = await makeWorld(seed, [...ids]);
        const random = seededRandom(seed * 7919);
        for (let step = 0; step < 40; step++) {
          const d = devices[Math.floor(random() * devices.length)] as Device;
          const roll = random();
          if (roll < 0.45)
            await d.write(1 + Math.floor(random() * 12), random() < 0.3 ? "shared" : undefined);
          else if (roll < 0.8) await d.sync();
          await sim.churn(10);
        }
        await settleAll(sim, devices);
        expectConverged(devices);
        // Every event arrived everywhere: one register per event, one for all shared-gid writes.
        const written = devices.reduce((n, d) => n + d.written, 0);
        const shared = devices.reduce((n, d) => n + d.shared, 0);
        expect(devices[0]?.sink.size).toBe(written - shared + (shared > 0 ? 1 : 0));
        for (const d of devices) {
          expect(d.rejected).toEqual([]);
          expect(d.carrier.status(VAULT).every((s) => s.held === undefined)).toBe(true);
        }
        conflicts += sim.conflicts;
        partials += sim.partials;
      }
      // The scenarios really exercised the sync-tool behaviour.
      expect(conflicts).toBeGreaterThan(0);
      expect(partials).toBeGreaterThan(0);
    });
  }

  it("applies every event exactly: per-device eids all present after convergence", async () => {
    const { sim, devices } = await makeWorld(101, [A, B, C]);
    const random = seededRandom(5);
    for (let step = 0; step < 60; step++) {
      const d = devices[step % 3] as Device;
      await d.write(1 + Math.floor(random() * 9));
      if (random() < 0.5) await d.sync();
      await sim.churn(6);
    }
    await settleAll(sim, devices);
    const written = devices.reduce((n, d) => n + d.written, 0);
    for (const d of devices) {
      expect(d.sink.size).toBe(written); // no shared gids here: one register per event
      expect(d.rejected).toEqual([]);
    }
    expectConverged(devices);
  });
});

describe("folder carrier: why the manifest gate exists", () => {
  async function staleSegmentScenario(ungated: boolean) {
    const ring = ringPair();
    const replicaA = new MemoryFolderFs();
    const replicaB = new MemoryFolderFs();
    const a = new Device(A, ring.clone(sodium), replicaA, { ungated });
    const b = new Device(B, ring.clone(sodium), replicaB, { ungated });
    await a.open();
    await b.open();
    await a.write(4);
    await a.sync();
    deliver(replicaA, replicaB, segPath(A, 1)); // B gets an early, frame-aligned version of segment 1
    for (let i = 0; i < 12; i++) await a.write(4);
    await a.sync();
    const segs = replicaA.paths().filter((p) => p.includes(`/${A}/`));
    expect(segs.length).toBeGreaterThan(2);
    // Every later segment (and the manifest) arrives before segment 1's final version.
    for (const p of segs) if (p !== segPath(A, 1)) deliver(replicaA, replicaB, p);
    await b.sync();
    deliver(replicaA, replicaB, segPath(A, 1));
    await b.sync();
    await b.sync();
    return { a, b };
  }

  it("without it the engine skips the rest of an earlier segment (events missing until a rebuild)", async () => {
    const { a, b } = await staleSegmentScenario(true);
    expect(b.sink.size).toBeLessThan(a.written);
    await b.engine.rebuild();
    expect(b.sink.size).toBe(a.written);
  });

  it("with it the later segments wait and nothing is skipped", async () => {
    const { a, b } = await staleSegmentScenario(false);
    expect(b.sink.size).toBe(a.written);
    expect(b.rejected).toEqual([]);
  });
});

describe("folder carrier: damaged storage", () => {
  it("a conflict-copy file: the newer version as a copy next to an older original", async () => {
    const ring = ringPair();
    const replicaA = new MemoryFolderFs();
    const replicaB = new MemoryFolderFs();
    const a = new Device(A, ring.clone(sodium), replicaA, { maxSegmentBytes: 64 * 1024 });
    const b = new Device(B, ring.clone(sodium), replicaB);
    await a.open();
    await b.open();
    await a.write(3);
    await a.sync();
    const old = replicaA.get(segPath(A, 1)) as Uint8Array;
    await a.write(5);
    await a.sync();
    replicaB.put(segPath(A, 1), old);
    replicaB.put(`${VAULT}/${A}/000001 2.seg`, replicaA.get(segPath(A, 1)) as Uint8Array);
    await b.sync();
    expect(b.sink.size).toBe(8);
    // A diverging copy (a cloned device id): only the common prefix is read, the fork is reported.
    replicaB.put(`${VAULT}/${A}/000001 (1).seg`, Uint8Array.of(...old, 1, 2, 3, 4, 5, 6, 7, 8, 9));
    const folder = new FolderTransport({ fs: replicaB, owner: B });
    await folder.list(VAULT);
    expect(folder.status().forks).toEqual([{ device: A, seg: 1 }]);
    const r = await b.sync();
    expect(r.rejected).toEqual([]);
    expect(b.sink.size).toBe(8);
  });

  it("a truncated segment: complete frames apply, the rest waits; a truncated own file is re-pushed", async () => {
    const ring = ringPair();
    const replicaA = new MemoryFolderFs();
    const replicaB = new MemoryFolderFs();
    const a = new Device(A, ring.clone(sodium), replicaA, { maxSegmentBytes: 64 * 1024 });
    const b = new Device(B, ring.clone(sodium), replicaB);
    await a.open();
    await b.open();
    for (let i = 0; i < 4; i++) await a.write(2);
    await a.sync();
    const full = replicaA.get(segPath(A, 1)) as Uint8Array;
    deliver(replicaA, replicaB, segPath(A, 1), full.length - 11);
    const partial = await b.sync();
    expect(partial.rejected).toEqual([]);
    expect(b.sink.size).toBe(6);
    // A's own copy in the folder loses its tail (a tool restored an older file): A pushes it again.
    replicaA.truncate(segPath(A, 1), 40);
    const healed = await a.sync();
    expect(healed.pushedBytes).toBe(full.length - 40);
    expect(replicaA.get(segPath(A, 1))).toEqual(full);
    deliver(replicaA, replicaB, segPath(A, 1));
    await b.sync();
    expect(b.sink.size).toBe(8);
    expectConverged([a, b]);
  });

  it("tamper: a flipped byte in a segment or in the manifest is never applied, then heals", async () => {
    const { sim, devices } = await makeWorld(7, [A, B], {}, { partialRate: 0, conflictRate: 0 });
    const [a, b] = devices as [Device, Device];
    for (let i = 0; i < 10; i++) await a.write(4);
    await a.sync();
    await sim.flush();
    const replicaB = b.replica;
    replicaB.flip(segPath(A, 1), 30);
    replicaB.flip(segPath(A, 0), 25);
    const r = await b.sync();
    expect(r.rejected).toEqual([
      expect.objectContaining({ device: A, seg: 1, code: "auth_failed" }),
    ]);
    expect(b.sink.size).toBe(0);
    expect(b.carrier.status(VAULT)[0]).toMatchObject({
      held: { seg: 2, reason: "awaiting-manifest" },
      manifestRejected: { offset: 0, code: "auth_failed" },
    });
    await sim.flush(); // the sync service restores the files
    await b.sync();
    expect(b.sink.size).toBe(40);
    expectConverged([a, b]);
  });

  it("an unreachable folder counts as offline; writes stay local and merge later", async () => {
    const { sim, devices } = await makeWorld(9, [A, B]);
    const [a, b] = devices as [Device, Device];
    a.replica.setOnline(false);
    await a.write(5);
    const off = await a.sync();
    expect(off.offlineRemotes).toBe(1);
    expect(a.sink.size).toBe(5);
    a.replica.setOnline(true);
    await settleAll(sim, devices);
    expect(b.sink.size).toBe(5);
  });
});

describe("folder carrier: keys and restarts", () => {
  it("key rotation mid-log: frames under two generations, a device without the new key waits", async () => {
    const { sim, devices } = await makeWorld(13, [A, B], {}, { partialRate: 0, conflictRate: 0 });
    const [a, b] = devices as [Device, Device];
    for (let i = 0; i < 6; i++) await a.write(3);
    rotateKeyring(sodium, a.ring);
    for (let i = 0; i < 6; i++) await a.write(3);
    await a.sync();
    await sim.flush();
    const before = await b.sync();
    // Whatever B meets first under the new key waits: a frame, or the manifest record that closes
    // the segment the rotation happened in.
    const waiting = [
      ...before.rejected.map((x) => x.code),
      b.carrier.status(VAULT)[0]?.manifestRejected?.code,
    ];
    expect(waiting).toContain("unknown_key");
    expect(b.sink.size).toBeGreaterThan(0);
    expect(b.sink.size).toBeLessThan(36);
    b.ring.merge(a.ring); // S29 delivers the rotation wrap
    await b.sync();
    expect(b.sink.size).toBe(36);
    // A new device with the current ring rebuilds the whole log.
    const replicaC = new MemoryFolderFs();
    sim.addReplica(C, replicaC);
    const c = new Device(C, a.ring.clone(sodium), replicaC);
    await c.open();
    await sim.flush();
    await c.sync();
    expectConverged([a, b, c]);
  });

  it("restart: local logs, clocks and folder handles come back; HLCs keep increasing", async () => {
    const { sim, devices } = await makeWorld(17, [A, B], { durableLocal: true });
    const random = seededRandom(17);
    for (let step = 0; step < 30; step++) {
      const d = devices[step % 2] as Device;
      await d.write(1 + Math.floor(random() * 5));
      if (random() < 0.5) await d.sync();
      if (random() < 0.3) {
        d.clock.advance(-2 * 60_000); // the wall clock stepped back (within the drift limit)
        await d.restart();
        await d.write(1); // stamped after everything before the restart (clock restored)
        d.clock.advance(2 * 60_000);
      }
      await sim.churn(5);
    }
    await settleAll(sim, devices);
    expectConverged(devices);
    for (const d of devices) {
      expect(d.rejected).toEqual([]);
      for (const device of [A, B]) {
        const hlcs = d.sink.deliveries.filter((x) => x.device === device).flatMap((x) => x.hlcs);
        expect(hlcs).toEqual([...hlcs].sort());
        expect(new Set(hlcs).size).toBe(hlcs.length);
      }
    }
    expect(devices[0]?.sink.size).toBe(devices.reduce((n, d) => n + d.written, 0));
  });
});
