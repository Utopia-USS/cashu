import { describe, expect, it } from "vitest";
import type { GateStateStore, Transport } from "../carrier.js";
import { createOwnLogCodec } from "../carriers/ownlog/codec.js";
import {
  certifyDevice,
  createDeviceIdentity,
  createRecoveryKey,
  createVaultWithRecovery,
  type DeviceIdentity,
  encodeHead,
  type Keyring,
  recoveryIdentity,
  signHead,
} from "../crypto/index.js";
import { createSyncEngine } from "../engine.js";
import { MemoryClockStore, MemoryTransport } from "../memory.js";
import { ManualClock, MemorySink } from "../testing/index.js";
import { buildDeviceAdded, buildHeadsGossiped } from "./events.js";
import { DeviceFrameGate } from "./gate.js";
import { MemoryProvenanceStore } from "./provenance.js";
import { newEid, sodium } from "./testkit.js";
import { VaultDevices } from "./vaultDevices.js";

const T0 = Date.UTC(2026, 10, 1, 12);

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing synthetic fixture");
  return value;
}

function subjectOf(d: DeviceIdentity) {
  return { deviceId: d.deviceId, signPublicKey: d.signPublicKey, boxPublicKey: d.box.publicKey };
}

class MemoryGateState implements GateStateStore {
  value: string | undefined;
  evidence: string[] = [];
  load() {
    return this.value;
  }
  save(value: string) {
    this.value = value;
  }
  loadEvidence() {
    return [...this.evidence];
  }
  appendEvidence(records: readonly string[]) {
    for (const record of records) if (!this.evidence.includes(record)) this.evidence.push(record);
  }
}

async function node(
  identity: DeviceIdentity,
  ring: Keyring,
  cert: Uint8Array,
  remote: Transport,
  disk?: {
    local: MemoryTransport;
    sink: MemorySink;
    clock: MemoryClockStore;
    state: MemoryGateState;
  },
) {
  const local = disk?.local ?? new MemoryTransport();
  const sink = disk?.sink ?? new MemorySink();
  const clock = disk?.clock ?? new MemoryClockStore();
  const state = disk?.state ?? new MemoryGateState();
  const devices = new VaultDevices({
    sodium,
    identity,
    ring,
    provenance: new MemoryProvenanceStore(),
    clock: () => T0,
    bootstrapCertificates: [cert],
  });
  const gate = new DeviceFrameGate(devices, { sodium });
  const engine = await createSyncEngine({
    vault: ring.vaultId,
    device: identity.deviceId,
    local,
    remotes: [remote],
    codec: createOwnLogCodec({ sodium, ring, signer: identity }),
    gate,
    sink,
    clockStore: clock,
    gateState: state,
    physicalClock: new ManualClock(T0),
    gossipEid: newEid,
  });
  const intro = () =>
    buildDeviceAdded(identity, ring.vaultId, newEid(), subjectOf(identity), "device", cert);
  return { identity, engine, gate, local, sink, clock, state, intro };
}

describe("real engine gossip emission", () => {
  it("publishes one authenticated local gossip receipt and pushes it in the same sync", async () => {
    const recovery = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    const first = createDeviceIdentity(sodium);
    const second = createDeviceIdentity(sodium);
    const vault = createVaultWithRecovery(sodium, recovery, first);
    const remote = new MemoryTransport();
    const a = await node(
      first,
      vault.ring.clone(sodium),
      certifyDevice(sodium, recovery, subjectOf(first), vault.ring.vaultId),
      remote,
    );
    const b = await node(
      second,
      vault.ring.clone(sodium),
      certifyDevice(sodium, recovery, subjectOf(second), vault.ring.vaultId),
      remote,
    );
    await a.engine.write([a.intro()]);
    await b.engine.write([b.intro()]);
    await a.engine.sync();
    const before =
      (await b.local.list(vault.ring.vaultId)).find((s) => s.device === second.deviceId)?.size ?? 0;
    const firstPass = await b.engine.sync();
    expect(firstPass.gossip?.emitted).toBe(true);
    expect(firstPass.gossip?.deliveryPending).toBe(false);
    const after =
      (await b.local.list(vault.ring.vaultId)).find((s) => s.device === second.deviceId)?.size ?? 0;
    expect(after).toBeGreaterThan(before);
    expect(
      (await remote.list(vault.ring.vaultId)).find((s) => s.device === second.deviceId)?.size,
    ).toBe(after);
    for (let i = 0; i < 3; i++) {
      expect((await b.engine.sync()).gossip?.emitted).toBe(false);
    }
  });

  it("finds a late lower-position signed fork after compact restart and publishes one proof", async () => {
    const recovery = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    const ids = [0, 1, 2].map(() => createDeviceIdentity(sodium)) as [
      DeviceIdentity,
      DeviceIdentity,
      DeviceIdentity,
    ];
    const vault = createVaultWithRecovery(sodium, recovery, ids[0]);
    const vaultId = vault.ring.vaultId;
    const remote = new MemoryTransport();
    const certs = ids.map((id) => certifyDevice(sodium, recovery, subjectOf(id), vaultId));
    const a = await node(ids[0], vault.ring.clone(sodium), certs[0] as Uint8Array, remote);
    const b = await node(ids[1], vault.ring.clone(sodium), certs[1] as Uint8Array, remote);
    const c = await node(ids[2], vault.ring.clone(sodium), certs[2] as Uint8Array, remote);
    await a.engine.write([a.intro()]);
    await b.engine.write([b.intro()]);
    await c.engine.write([c.intro()]);
    for (const peer of [a, b, c]) await peer.engine.sync();
    const agreed = must(
      a.gate.heads.exportHeads().find(({ head }) => head.device === a.identity.deviceId)?.head,
    );
    await b.engine.write([buildHeadsGossiped(b.identity, vaultId, newEid(), [agreed])]);
    await b.engine.sync();
    await c.engine.sync();
    const set = () => ({ t: "test.set", v: 1, i: newEid(), d: { value: "synthetic" } });
    await a.engine.write([set()]);
    const a1 = must(
      a.gate.heads.exportHeads().find(({ head }) => head.device === a.identity.deviceId)?.head,
    );
    await a.engine.sync();
    await b.engine.sync();
    await c.engine.sync();
    await a.engine.write([set()]);
    await a.engine.sync();
    await b.engine.sync();
    await c.engine.sync();
    const parsed = JSON.parse((c.state.value ?? "{}").split("\n")[0] ?? "{}") as {
      gossip?: unknown[];
    };
    expect(parsed.gossip?.length).toBeLessThanOrEqual(4);
    await c.engine.close();
    const restarted = await node(ids[2], vault.ring.clone(sodium), certs[2] as Uint8Array, remote, {
      local: c.local,
      sink: c.sink,
      clock: c.clock,
      state: c.state,
    });
    const alternate = signHead(ids[0], vaultId, {
      device: ids[0].deviceId,
      stream: 1,
      seg: a1.seg,
      offset: a1.offset,
      chain: new Uint8Array(32).fill(7),
    });
    await b.engine.write([buildHeadsGossiped(b.identity, vaultId, newEid(), [alternate])]);
    await b.engine.sync();
    const historical = restarted.gate.historicalHeadsInFrame.bind(restarted.gate);
    restarted.gate.historicalHeadsInFrame = () => undefined;
    const unavailable = await restarted.engine.sync();
    expect(unavailable.gossip?.historyPending).toBe(true);
    expect(unavailable.gossip?.deliveryPending).toBe(true);
    expect(unavailable.gossip?.emitted).toBe(false);
    expect(restarted.gate.gossipStatus().authorityUncertain).toBe(true);
    expect(restarted.engine.leaseTransport().kind).toBe("eventual");
    await expect(
      restarted.engine.write([{ t: "test.set", v: 1, i: newEid(), d: { value: "blocked" } }]),
    ).rejects.toMatchObject({ code: "authority-unresolved" });
    await expect(
      restarted.engine.write([{ t: "device.revoked", v: 1, i: newEid(), d: {} }]),
    ).rejects.toMatchObject({ code: "authority-unresolved" });
    expect(c.state.evidence).toHaveLength(0);
    restarted.gate.historicalHeadsInFrame = historical;
    let outcome = await restarted.engine.sync();
    for (let round = 0; round < 3 && outcome.gossip?.historyPending; round++) {
      expect(outcome.gossip?.emitted).toBe(false);
      outcome = await restarted.engine.sync();
    }
    expect(restarted.gate.takeHistoricalLookups()).toHaveLength(0);
    expect(outcome.gossip?.historyPending).toBe(false);
    expect(restarted.gate.gossipStatus().authorityUncertain).toBe(false);
    expect(restarted.gate.forks()).toContainEqual({
      device: ids[0].deviceId,
      agreed: { seg: agreed.seg, offset: agreed.offset },
    });
    expect(c.state.evidence).toHaveLength(1);
    expect(outcome.gossip?.emitted).toBe(true);
    expect((await restarted.engine.sync()).gossip?.emitted).toBe(false);
    expect(
      restarted.gate.gossipCandidates().some((head) => encodeHead(head) === encodeHead(alternate)),
    ).toBe(false);
  });
});
