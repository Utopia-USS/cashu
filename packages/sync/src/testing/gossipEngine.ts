// Shared fixtures of the real-engine gossip tests (default and exhaustive tier).
import type { GateStateStore, Transport } from "../carrier.js";
import { createOwnLogCodec } from "../carriers/ownlog/codec.js";
import type { DeviceIdentity, Keyring } from "../crypto/index.js";
import { buildDeviceAdded } from "../devices/events.js";
import { DeviceFrameGate } from "../devices/gate.js";
import { MemoryProvenanceStore } from "../devices/provenance.js";
import { newEid, sodium } from "../devices/testkit.js";
import { VaultDevices } from "../devices/vaultDevices.js";
import { createSyncEngine } from "../engine.js";
import { MemoryClockStore, MemoryTransport } from "../memory.js";
import { ManualClock, MemorySink } from "./index.js";

const T0 = Date.UTC(2026, 10, 1, 12);

export function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing synthetic fixture");
  return value;
}

export function subjectOf(d: DeviceIdentity) {
  return { deviceId: d.deviceId, signPublicKey: d.signPublicKey, boxPublicKey: d.box.publicKey };
}

export class MemoryGateState implements GateStateStore {
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

export async function node(
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
  return { identity, devices, engine, gate, local, sink, clock, state, intro };
}
