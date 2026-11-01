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
  type Keyring,
  recoveryIdentity,
} from "../crypto/index.js";
import { createSyncEngine } from "../engine.js";
import { MemoryClockStore, MemoryTransport } from "../memory.js";
import { scanFrames } from "../segment.js";
import { ManualClock, MemorySink } from "../testing/index.js";
import { concat, fromHex, lp, toHex, utf8 } from "./bytes.js";
import { buildDeviceAdded, buildDeviceRevoked } from "./events.js";
import { DeviceFrameGate } from "./gate.js";
import { MemoryProvenanceStore } from "./provenance.js";
import { newEid, sodium } from "./testkit.js";
import { VaultDevices } from "./vaultDevices.js";

const T0 = Date.UTC(2026, 10, 1, 12);
/** Data frames in the world's log: A 14, B 13, C 2. */
const FRAMES = 29;
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
  for (let i = 1; i <= 12; i++) {
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
  const restart = (d: Disk, persist = true) => node(ids[0], ring(), cert(0), remote, d, persist);
  return { a, b, c, ids, vaultId, restart };
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
    const variants: [string, string][] = [
      ["flipped byte in the body", flip(genuine, Math.floor(cut / 2))],
      ["flipped byte in the signature", flip(genuine, genuine.length - 3)],
      ["truncated", genuine.slice(0, Math.floor(genuine.length / 2))],
      ["not a snapshot", "garbage"],
      ["dropped revocation, signed by another key", `${forgedJson}\n${toHex(forgedSig)}`],
      ["B's own genuine snapshot", w.b.disk.state.value ?? ""],
    ];
    expect(fromHex(genuine.slice(cut + 1)).length).toBe(64);
    for (const [name, text] of variants) {
      const d = { ...w.a.disk, sink: new MemorySink(), state: new MemoryGateState() };
      d.state.value = text;
      const again = await w.restart(d);
      await again.engine.sync();
      expect(again.counter.opens, name).toBeGreaterThanOrEqual(FRAMES);
      expect(again.counter.restored, name).toBe(0);
      expect(again.devices.registry.revoked.has(w.ids[2].deviceId), name).toBe(true);
      expect(again.disk.sink.value("c1"), name).toBeUndefined();
      expect(again.disk.sink.value("b12"), name).toBe("b12");
    }
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
    expect(again.disk.sink.value("b12")).toBe("b12");
    expect(again.disk.sink.value("c1")).toBeUndefined();
  });
});
