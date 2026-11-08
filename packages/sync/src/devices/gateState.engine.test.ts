// The persisted gate state (S29c-B3): a restart restores the devices state from the snapshot and
// replays only the frames after its positions; a corrupt, forged or foreign snapshot, or one that
// does not match the local log, is detected and the whole log is replayed (the same state either
// way). Real engine, own-log codec, `DeviceFrameGate` over `VaultDevices`. Synthetic data only.

import { describe, expect, it } from "vitest";
import type { FrameCodec, GateStateStore, Transport } from "../carrier.js";
import { createOwnLogCodec } from "../carriers/ownlog/codec.js";
import {
  certifyDevice,
  createDeviceIdentity,
  createRecoveryKey,
  createVaultWithRecovery,
  type DeviceIdentity,
  decodeHead,
  encodeHead,
  type Keyring,
  recoveryIdentity,
  signHead,
} from "../crypto/index.js";
import { createSyncEngine } from "../engine.js";
import { scanFrames } from "../segment.js";
import { newEid, sodium } from "../testing/devices/testkit.js";
import { ManualClock, MemorySink } from "../testing/index.js";
import { MemoryClockStore, MemoryTransport } from "../testing/memory.js";
import { concat, fromHex, lp, toHex, utf8 } from "./bytes.js";
import { buildDeviceAdded, buildDeviceRevoked } from "./events.js";
import { DeviceFrameGate } from "./gate.js";
import { MemoryProvenanceStore } from "./provenance.js";
import { VaultDevices } from "./vaultDevices.js";

const T0 = Date.UTC(2026, 10, 1, 12);
/** Data frames in the world's log: A 8, B 7, C 2. */
const FRAMES = 17;
const set = (g: string) => ({ t: "test.set", v: 1, i: newEid(), g, d: { value: g } });

function subjectOf(d: DeviceIdentity) {
  return { deviceId: d.deviceId, signPublicKey: d.signPublicKey, boxPublicKey: d.box.publicKey };
}

class MemoryGateState implements GateStateStore {
  value: string | undefined;
  saves = 0;
  load() {
    return this.value;
  }
  save(state: string) {
    this.value = state;
    this.saves += 1;
  }
  evidence: string[] = [];
  loadEvidence() {
    return [...this.evidence];
  }
  appendEvidence(records: readonly string[]) {
    for (const r of records) if (!this.evidence.includes(r)) this.evidence.push(r);
  }
}

interface Disk {
  readonly local: Transport;
  readonly sink: MemorySink;
  readonly clock: MemoryClockStore;
  readonly state: MemoryGateState;
}

const disk = (): Disk => ({
  local: new MemoryTransport(),
  sink: new MemorySink(),
  clock: new MemoryClockStore(),
  state: new MemoryGateState(),
});

async function node(
  identity: DeviceIdentity,
  ring: Keyring,
  cert: Uint8Array,
  remote: Transport,
  d: Disk = disk(),
  persist = true,
) {
  const devices = new VaultDevices({
    sodium,
    identity,
    ring,
    provenance: new MemoryProvenanceStore(),
    clock: () => T0,
    bootstrapCertificates: [cert],
  });
  const gate = new DeviceFrameGate(devices, { sodium });
  const real = createOwnLogCodec({ sodium, ring, signer: identity });
  const counter = { opens: 0, restored: 0 };
  const importState = gate.importState.bind(gate);
  gate.importState = (state) => {
    const imported = importState(state);
    return (
      imported && {
        positions: imported.positions,
        heldHeads: imported.heldHeads,
        restore: () => {
          counter.restored += 1;
          imported.restore();
        },
      }
    );
  };
  const codec: FrameCodec = {
    ...real,
    open: (sealed, at, prev) => {
      counter.opens += 1;
      return real.open(sealed, at, prev);
    },
  };
  const engine = await createSyncEngine({
    vault: ring.vaultId,
    device: identity.deviceId,
    local: d.local,
    remotes: [remote],
    codec,
    gate,
    sink: d.sink,
    clockStore: d.clock,
    ...(persist ? { gateState: d.state } : {}),
    physicalClock: new ManualClock(T0),
  });
  const intro = () =>
    buildDeviceAdded(identity, ring.vaultId, newEid(), subjectOf(identity), "device", cert);
  return { identity, engine, devices, gate, counter, disk: d, intro };
}

/** Three devices with a history; C is revoked by the words after its first frame. */
async function world() {
  const recovery = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
  const ids = [0, 1, 2].map(() => createDeviceIdentity(sodium)) as [
    DeviceIdentity,
    DeviceIdentity,
    DeviceIdentity,
  ];
  const vault = createVaultWithRecovery(sodium, recovery, ids[0]);
  const vaultId = vault.ring.vaultId;
  const certs = ids.map((d) => certifyDevice(sodium, recovery, subjectOf(d), vaultId));
  const cert = (i: number) => certs[i] as Uint8Array;
  const remote = new MemoryTransport();
  const ring = () => vault.ring.clone(sodium);
  const a = await node(ids[0], ring(), cert(0), remote);
  const b = await node(ids[1], ring(), cert(1), remote);
  const c = await node(ids[2], ring(), cert(2), remote);
  await a.engine.write([a.intro(), set("a0")]);
  await b.engine.write([b.intro(), set("b0")]);
  await c.engine.write([c.intro(), set("c0")]);
  const cut =
    (await c.disk.local.list(vaultId)).find((s) => s.device === c.identity.deviceId)?.size ?? 0;
  await c.engine.write([set("c1")]);
  for (let i = 1; i <= 6; i++) {
    await a.engine.write([set(`a${i}`)]);
    await b.engine.write([set(`b${i}`)]);
  }
  for (let i = 0; i < 2; i++) for (const d of [a, b, c]) await d.engine.sync();
  await a.engine.write([
    buildDeviceRevoked(recovery, vaultId, newEid(), [
      { device: c.identity.deviceId, cut: { seg: 1, offset: cut } },
    ]),
  ]);
  for (let i = 0; i < 2; i++) for (const d of [a, b]) await d.engine.sync();
  // Restart A over the same disk (fresh devices state, gate and engine).
  const restart = (d: Disk, persist = true, from: Transport = remote) =>
    node(ids[0], ring(), cert(0), from, d, persist);
  return { a, b, c, ids, vaultId, recovery, restart };
}

function summary(n: Awaited<ReturnType<typeof node>>) {
  const reg = n.devices.registry;
  return {
    revoked: [...reg.revoked.entries()].map(([d, r]) => [d, r.cut]).sort(),
    registered: ["a", "b", "c"].length,
    view: n.disk.sink.snapshot(),
    heads: n.gate.heads.exportHeads().length,
  };
}

describe("persisted gate state", () => {
  it("retains exact applied and held heads when the accepted cursor is behind the verified tail", async () => {
    const w = await world();
    const cId = w.ids[2].deviceId;
    const applied = w.a.devices.guard.entries().find(([device]) => device === cId)?.[1];
    const held = w.a.gate.heads.held(cId);
    expect(applied).toBeDefined();
    expect(held).toBeDefined();
    if (!applied) throw new Error("missing synthetic applied cursor");
    expect(applied).not.toEqual(held);
    const raw = JSON.parse((w.a.disk.state.value ?? "{}").split("\n")[0] ?? "{}") as {
      heads: [string, string[]][];
    };
    const retained = raw.heads.map(([encoded]) => decodeHead(encoded));
    expect(
      retained.some(
        (head) =>
          head?.device === cId && head.seg === applied?.seg && head.offset === applied?.offset,
      ),
    ).toBe(true);
    expect(
      retained.some(
        (head) => head?.device === cId && head.seg === held?.seg && head.offset === held?.offset,
      ),
    ).toBe(true);
    const reopened = await w.restart(w.a.disk);
    await reopened.engine.sync();
    expect(reopened.counter.restored).toBe(1);
    expect(reopened.gate.heads.headAt(cId, applied)).toBeDefined();
    expect(reopened.gate.heads.held(cId)).toEqual(held);
  });

  it("a restart restores the snapshot and replays only the new tail", async () => {
    const w = await world();
    expect(w.a.disk.state.value).toBeDefined();
    expect(w.a.disk.sink.value("c1")).toBeUndefined();
    await w.b.engine.write([set("late-1")]);
    await w.b.engine.write([set("late-2")]);
    await w.b.engine.sync();

    const savesBefore = w.a.disk.state.saves;
    const restored = await w.restart(w.a.disk);
    const r = await restored.engine.sync();
    expect(r.rebuilt).toBe(false);
    expect(r.applied).toBe(2);
    expect(restored.counter.restored).toBe(1);
    // The engine's own last frame (its clock check at start), one open per snapshot position (the
    // log check), the two new frames, and C's frame after its cut (statements of a frame whose data
    // is rejected are observed again on every start).
    expect(restored.counter.opens).toBeLessThanOrEqual(1 + 3 + 2 + 1);

    const full = await w.restart(
      { ...w.a.disk, sink: new MemorySink(), state: new MemoryGateState() },
      false,
    );
    await full.engine.sync();
    expect(full.counter.opens).toBeGreaterThanOrEqual(FRAMES);
    expect(summary(restored)).toEqual(summary(full));
    expect(restored.devices.registry.revoked.has(w.ids[2].deviceId)).toBe(true);
    expect(restored.disk.sink.value("late-2")).toBe("late-2");
    expect(restored.disk.sink.value("c1")).toBeUndefined();
    // The restored engine saved a newer snapshot (it judged new frames).
    expect(restored.disk.state.saves).toBe(savesBefore + 1);
  });

  it("detects a corrupt, truncated, forged or foreign snapshot and replays the whole log", async () => {
    const w = await world();
    const genuine = w.a.disk.state.value ?? "";
    const cut = genuine.lastIndexOf("\n");
    const json = genuine.slice(0, cut);
    const parsed = JSON.parse(json) as { statements: { type: string }[] };
    // The forger drops C's revocation and signs with a key of its own (it cannot use A's).
    const forgedJson = JSON.stringify({
      ...parsed,
      statements: parsed.statements.filter((s) => s.type !== "device.revoked"),
    });
    const forger = createDeviceIdentity(sodium, w.ids[0].deviceId);
    const forgedSig = forger.sign(
      "cashu/state/v1",
      concat(lp(utf8(w.vaultId)), lp(utf8(w.ids[0].deviceId)), utf8(forgedJson)),
    );
    const flip = (text: string, at: number) =>
      text.slice(0, at) + (text[at] === "1" ? "2" : "1") + text.slice(at + 1);
    // An older format version, genuinely signed by A (its shape lacks what restoring needs).
    const v1 = JSON.stringify({ ...parsed, v: 1 });
    const v1Sig = w.a.identity.sign(
      "cashu/state/v1",
      concat(lp(utf8(w.vaultId)), lp(utf8(w.ids[0].deviceId)), utf8(v1)),
    );
    const variants: [string, string][] = [
      ["flipped byte in the body", flip(genuine, Math.floor(cut / 2))],
      ["flipped byte in the signature", flip(genuine, genuine.length - 3)],
      ["truncated", genuine.slice(0, Math.floor(genuine.length / 2))],
      ["not a snapshot", "garbage"],
      ["dropped revocation, signed by another key", `${forgedJson}\n${toHex(forgedSig)}`],
      ["B's own genuine snapshot", w.b.disk.state.value ?? ""],
      ["older format version, signed by A", `${v1}\n${toHex(v1Sig)}`],
    ];
    expect(fromHex(genuine.slice(cut + 1)).length).toBe(64);
    expect(w.a.gate.importState(genuine)).toBeDefined();
    for (const [name, text] of variants) expect(w.a.gate.importState(text), name).toBeUndefined();
    // A restart over the forged snapshot ignores it and replays the whole log to the same state.
    const d = { ...w.a.disk, sink: new MemorySink(), state: new MemoryGateState() };
    d.state.value = variants[4]?.[1];
    const again = await w.restart(d);
    await again.engine.sync();
    expect(again.counter.opens).toBeGreaterThanOrEqual(FRAMES);
    expect(again.counter.restored).toBe(0);
    expect(again.devices.registry.revoked.has(w.ids[2].deviceId)).toBe(true);
    expect(again.disk.sink.value("c1")).toBeUndefined();
    expect(again.disk.sink.value("b6")).toBe("b6");
    // The engine wrote a fresh snapshot of the current format.
    expect(JSON.parse((d.state.value ?? "{}").split("\n")[0] ?? "{}").v).toBe(2);
  });

  it("ignores a genuine snapshot whose positions are not in the local log", async () => {
    const w = await world();
    // A's genuine snapshot over a copy of its local log in which B's stream ends early (its last
    // frames lost): B's position names a frame the log does not hold.
    const local = new MemoryTransport();
    const bId = w.ids[1].deviceId;
    for (const s of await w.a.disk.local.list(w.vaultId)) {
      const bytes = await w.a.disk.local.read(w.vaultId, s.device, s.seg, 0);
      const frames = scanFrames(bytes, 0).frames;
      const half = frames[Math.floor(frames.length / 2)]?.end ?? bytes.length;
      const keep = s.device === bId ? bytes.subarray(0, half) : bytes;
      await local.append(w.vaultId, s.device, s.seg, 0, keep);
    }
    const d = { ...disk(), local, clock: w.a.disk.clock };
    d.state.value = w.a.disk.state.value;
    const again = await w.restart(d);
    await again.engine.sync();
    expect(again.counter.restored).toBe(0);
    expect(again.devices.registry.revoked.has(w.ids[2].deviceId)).toBe(true);
    expect(again.disk.sink.value("b6")).toBe("b6");
    expect(again.disk.sink.value("c1")).toBeUndefined();
  });

  it("keeps a proven fork outside the snapshot: a rolled-back snapshot still freezes the writer", async () => {
    const w = await world();
    const bId = w.ids[1].deviceId;
    // The device as it was before the fork was proven: its snapshot and a copy of its local log.
    const older = w.a.disk.state.value;
    const backup = new MemoryTransport();
    for (const s of await w.a.disk.local.list(w.vaultId)) {
      const bytes = await w.a.disk.local.read(w.vaultId, s.device, s.seg, 0);
      await backup.append(w.vaultId, s.device, s.seg, 0, bytes);
    }
    // B signed a second history ending where A holds B's stream: the words revoke B and carry that
    // head in the cut, which proves the fork (B is frozen at the start: all its data rejected).
    const end = w.a.gate.heads.held(bId) ?? { seg: 1, offset: 0 };
    const forked = signHead(w.ids[1], w.vaultId, {
      device: bId,
      stream: 1,
      seg: end.seg,
      offset: end.offset,
      chain: new Uint8Array(32).fill(7),
    });
    await w.a.engine.write([
      buildDeviceRevoked(w.recovery, w.vaultId, newEid(), [
        { device: bId, cut: end, head: encodeHead(forked) },
      ]),
    ]);
    await w.a.engine.sync();
    expect(w.a.devices.frozen.get(bId)).toEqual({ seg: 1, offset: 0 });
    expect(w.a.disk.sink.value("b0")).toBeUndefined();
    expect(w.a.disk.state.evidence.length).toBeGreaterThan(0);

    // Roll the device back (snapshot and log from before), offline (nothing to re-pull the proof
    // from): with the evidence record B stays frozen; without it B's data would be accepted again.
    for (const kept of [true, false]) {
      const state = new MemoryGateState();
      state.value = older;
      if (kept) state.evidence = [...w.a.disk.state.evidence];
      const d = { local: backup, sink: new MemorySink(), clock: new MemoryClockStore(), state };
      const again = await w.restart(d, true, new MemoryTransport());
      await again.engine.sync();
      expect(again.counter.restored, `kept ${kept}`).toBe(1);
      expect(again.disk.sink.value("b0"), `kept ${kept}`).toBe(kept ? undefined : "b0");
      expect(again.devices.frozen.has(bId), `kept ${kept}`).toBe(kept);
    }
  });
});
