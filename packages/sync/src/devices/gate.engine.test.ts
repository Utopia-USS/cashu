// The frame gate in the real engine (S29c phase B2): own-log codec with signed heads, the engine's
// chains, `DeviceFrameGate` over `VaultDevices`. A frame in another writer's stream that its writer
// did not sign is never copied or applied; data a revocation no longer accepts is removed by a full
// rebuild (D8); a restart replays the local log into a fresh gate and keeps the same view.

import { describe, expect, it } from "vitest";
import type { Transport } from "../carrier.js";
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
import { frameBytes, scanFrames } from "../segment.js";
import { ManualClock, MemorySink } from "../testing/index.js";
import { buildDeviceAdded, buildDeviceRevoked } from "./events.js";
import { DeviceFrameGate } from "./gate.js";
import { MemoryProvenanceStore } from "./provenance.js";
import { newEid, sodium } from "./testkit.js";
import { VaultDevices } from "./vaultDevices.js";

const T0 = Date.UTC(2026, 10, 1, 12);
const set = (g: string) => ({ t: "test.set", v: 1, i: newEid(), g, d: { value: g } });

function subjectOf(d: DeviceIdentity) {
  return { deviceId: d.deviceId, signPublicKey: d.signPublicKey, boxPublicKey: d.box.publicKey };
}

async function node(
  identity: DeviceIdentity,
  ring: Keyring,
  cert: Uint8Array,
  remote: Transport,
  local: Transport = new MemoryTransport(),
  sink = new MemorySink(),
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
  const engine = await createSyncEngine({
    vault: ring.vaultId,
    device: identity.deviceId,
    local,
    remotes: [remote],
    codec: createOwnLogCodec({ sodium, ring, signer: identity }),
    gate,
    sink,
    clockStore: new MemoryClockStore(),
    physicalClock: new ManualClock(T0),
  });
  // Every device introduces itself in its first frame (recovery-issued certificate, self lane).
  const intro = () =>
    buildDeviceAdded(identity, ring.vaultId, newEid(), subjectOf(identity), "device", cert);
  return { identity, engine, sink, local, devices, gate, intro };
}

describe("frame gate in the engine", () => {
  it("rejects a frame its writer did not sign, rebuilds after a cut (D8), and replays after a restart", async () => {
    const recovery = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    const ids = [0, 1, 2].map(() => createDeviceIdentity(sodium)) as [
      DeviceIdentity,
      DeviceIdentity,
      DeviceIdentity,
    ];
    const vault = createVaultWithRecovery(sodium, recovery, ids[0]);
    const vaultId = vault.ring.vaultId;
    const certs = ids.map((d) => certifyDevice(sodium, recovery, subjectOf(d), vaultId));
    const remote = new MemoryTransport();
    const cert = (i: number) => certs[i] as Uint8Array;
    const a = await node(ids[0], vault.ring.clone(sodium), cert(0), remote);
    const b = await node(ids[1], vault.ring.clone(sodium), cert(1), remote);
    const c = await node(ids[2], vault.ring.clone(sodium), cert(2), remote);
    await a.engine.write([a.intro(), set("g1")]);
    await b.engine.write([b.intro(), set("g2")]);
    await c.engine.write([c.intro(), set("g3")]);
    const cFirstEnd =
      (await c.local.list(vaultId)).find((s) => s.device === c.identity.deviceId)?.size ?? 0;
    await c.engine.write([set("g4")]);
    for (let i = 0; i < 2; i++) for (const d of [a, b, c]) await d.engine.sync();
    expect(["g1", "g2", "g3", "g4"].map((g) => a.sink.value(g))).toEqual(["g1", "g2", "g3", "g4"]);

    // A key holder appends a frame to B's stream: AEAD-valid (it holds the data key), chained to
    // B's real last frame, but signed with a key nobody certified for B.
    const bId = b.identity.deviceId;
    const forger = createOwnLogCodec({
      sodium,
      ring: vault.ring,
      signer: createDeviceIdentity(sodium, bId),
    });
    const bytes = await remote.read(vaultId, bId, 1, 0);
    let prev = forger.genesis(vaultId, bId, 1);
    for (const f of scanFrames(bytes, 0).frames) {
      prev = forger.link(f.sealed, { vault: vaultId, device: bId, seg: 1, offset: f.offset }, prev);
    }
    const at = { vault: vaultId, device: bId, seg: 1, offset: bytes.length };
    const plain = new TextEncoder().encode(
      JSON.stringify({ f: 1, e: [{ ...set("forged"), h: `0mvwcmtc0-0000-${bId}` }] }),
    );
    const forged = await forger.seal(plain, at, prev);
    await remote.append(vaultId, bId, 1, bytes.length, frameBytes(forged.sealed));
    const pulled = await a.engine.sync();
    expect(pulled.rejected).toContainEqual({
      device: bId,
      seg: 1,
      offset: bytes.length,
      code: "bad_head_signature",
    });
    expect(a.sink.value("forged")).toBeUndefined();
    expect((await a.local.list(vaultId)).find((s) => s.device === bId)?.size).toBe(bytes.length);

    // The words revoke C with a cut after its first frame (written on A; B's slot in storage holds
    // the forgery): A held g4 from C's second frame.
    const written = await a.engine.write([
      buildDeviceRevoked(recovery, vaultId, newEid(), [
        { device: c.identity.deviceId, cut: { seg: 1, offset: cFirstEnd } },
      ]),
    ]);
    expect(written.events).toBe(1);
    const after = await a.engine.sync();
    // The write applied the revocation and rebuilt the view at once (D8).
    expect(a.gate.rejections).toContainEqual({
      device: c.identity.deviceId,
      after: { seg: 1, offset: cFirstEnd },
      reason: "revoked_writer",
    });
    // C's frame after the cut stays in the log but its data is reported and never applied.
    expect(after.rejected).toContainEqual({
      device: c.identity.deviceId,
      seg: 1,
      offset: cFirstEnd,
      code: "revoked_writer",
    });
    expect(a.sink.value("g3")).toBe("g3");
    expect(a.sink.value("g4")).toBeUndefined();

    // Restart: a fresh devices state and gate over the same local log and view.
    const again = await node(
      a.identity,
      vault.ring.clone(sodium),
      cert(0),
      remote,
      a.local,
      a.sink,
    );
    const restarted = await again.engine.sync();
    expect(restarted.rebuilt).toBe(false);
    expect(again.devices.registry.revoked.has(c.identity.deviceId)).toBe(true);
    expect(a.sink.value("g4")).toBeUndefined();
    expect(a.sink.value("g2")).toBe("g2");
  });
});
