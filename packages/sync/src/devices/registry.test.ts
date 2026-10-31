import { describe, expect, it } from "vitest";
import type { UnstampedEvent } from "../carrier.js";
import { certifyDevice, createDeviceIdentity, type DeviceIdentity } from "../crypto/index.js";
import { buildDeviceAdded, buildDeviceRevoked, type LogEvent } from "./events.js";
import { foldRegistry, type Registry } from "./registry.js";
import {
  createSimVault,
  hlcAt,
  newEid,
  pairDevice,
  type SimDevice,
  START_TIME,
  sodium,
} from "./testkit.js";

function stamp(e: UnstampedEvent, writer: string, wall: number, offset = wall): LogEvent {
  return {
    eid: e.i,
    hlc: hlcAt(writer, wall),
    writer,
    position: { seg: 1, offset },
    type: e.t,
    v: e.v,
    data: e.d,
  };
}

function subjectOf(d: DeviceIdentity) {
  return { deviceId: d.deviceId, signPublicKey: d.signPublicKey, boxPublicKey: d.box.publicKey };
}

function fold(device: SimDevice, events: readonly LogEvent[]): Registry {
  return foldRegistry(
    sodium,
    { vaultId: device.ring.vaultId, recovery: device.ring.recovery },
    events,
  );
}

function allEvents(...devices: SimDevice[]): LogEvent[] {
  return devices.flatMap((d) => d.stream.flatMap((s) => s.events));
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

async function vaultOfThree() {
  const { creator: a, recovery } = createSimVault();
  const b = await pairDevice(a, "phone");
  const c = await pairDevice(b, "laptop"); // certified by B, not by A
  for (const d of [a, b, c]) d.sync();
  return { a, b, c, recovery };
}

describe("device registry", () => {
  it("the fold depends only on the set of events (any order, duplicates)", async () => {
    const { a, b, c } = await vaultOfThree();
    const vaultId = a.ring.vaultId;
    // B revokes C while C revokes B: the first by (hlc, eid) wins, the other signer is then revoked.
    const bRevokesC = stamp(
      buildDeviceRevoked(b.identity, vaultId, newEid(), [
        { device: c.id, cut: { seg: 1, offset: 0 } },
      ]),
      b.id,
      START_TIME + 1e7,
      1e6,
    );
    const cRevokesB = stamp(
      buildDeviceRevoked(c.identity, vaultId, newEid(), [
        { device: b.id, cut: { seg: 1, offset: 0 } },
      ]),
      c.id,
      START_TIME + 2e7,
      1e6,
    );
    const events = [...allEvents(a, b, c), bRevokesC, cRevokesB];
    const reference = fold(a, events);
    expect(reference.revoked.has(c.id)).toBe(true);
    expect(reference.revoked.has(b.id)).toBe(false);
    expect(reference.revocationCount).toBe(1);
    expect(reference.ignored).toContainEqual({ eid: cRevokesB.eid, reason: "after_revocation" });
    for (let seed = 1; seed <= 25; seed++) {
      const r = fold(a, shuffle([...events, ...events.slice(0, seed % events.length)], seed));
      expect([...r.trusted.keys()].sort()).toEqual([...reference.trusted.keys()].sort());
      expect([...r.revoked.keys()]).toEqual([...reference.revoked.keys()]);
      expect(r.revocationCount).toBe(1);
    }
  });

  it("ignores forged statements: tampered, another eid, another vault, signer not the writer", async () => {
    const { a, b, c } = await vaultOfThree();
    const vaultId = a.ring.vaultId;
    const revoke = buildDeviceRevoked(b.identity, vaultId, newEid(), [
      { device: c.id, cut: { seg: 1, offset: 0 } },
    ]);
    const tampered = stamp(
      { ...revoke, d: { ...revoke.d, devices: [{ device: a.id, cut: { seg: 1, offset: 0 } }] } },
      b.id,
      START_TIME + 1e7,
    );
    const reKeyed = stamp({ ...revoke, i: newEid() }, b.id, START_TIME + 1e7 + 1);
    const otherVault = stamp(
      buildDeviceRevoked(b.identity, "ab".repeat(16), newEid(), [
        { device: c.id, cut: { seg: 1, offset: 0 } },
      ]),
      b.id,
      START_TIME + 1e7 + 2,
    );
    const wrongWriter = stamp({ ...revoke, i: newEid() }, a.id, START_TIME + 1e7 + 3);
    const r = fold(a, [...allEvents(a, b, c), tampered, reKeyed, otherVault, wrongWriter]);
    expect(r.revocationCount).toBe(0);
    expect(r.ignored.map((i) => i.reason).sort()).toEqual([
      "bad_signature",
      "bad_signature",
      "bad_signature",
      "untrusted_signer",
    ]);
  });

  it("revoking a device untrusts its certificate subtree until another trusted device re-certifies", async () => {
    const { a, b, c } = await vaultOfThree();
    const vaultId = a.ring.vaultId;
    const revokeB = stamp(
      buildDeviceRevoked(a.identity, vaultId, newEid(), [
        { device: b.id, cut: { seg: 1, offset: 1e6 } },
      ]),
      a.id,
      START_TIME + 1e8,
      1e6,
    );
    const r = fold(a, [...allEvents(a, b, c), revokeB]);
    expect(r.isTrusted(c.id)).toBe(false); // C was certified only by B
    expect(r.devices.get(c.id)?.name).toBe("laptop");
    const recert = certifyDevice(sodium, a.identity, subjectOf(c.identity), vaultId);
    const added = stamp(
      buildDeviceAdded(a.identity, vaultId, newEid(), subjectOf(c.identity), "laptop", recert),
      a.id,
      START_TIME + 1e8 + 1,
      1e6 + 1,
    );
    expect(fold(a, [...allEvents(a, b, c), revokeB, added]).isTrusted(c.id)).toBe(true);
  });

  it("names need the declared keys to match the certified ones; duplicate eids are corruption", async () => {
    const { a, b, c } = await vaultOfThree();
    const vaultId = a.ring.vaultId;
    const other = createDeviceIdentity(sodium);
    const cert = certifyDevice(sodium, a.identity, subjectOf(c.identity), vaultId);
    const lying = stamp(
      buildDeviceAdded(
        a.identity,
        vaultId,
        newEid(),
        { ...subjectOf(c.identity), signPublicKey: other.signPublicKey },
        "evil",
        cert,
      ),
      a.id,
      START_TIME - 1, // sorts first: it must still not rename C
    );
    const original = allEvents(a, b, c);
    const first = original[0] as LogEvent;
    const duplicate = { ...first, data: { ...first.data, name: "changed" } };
    const r = fold(a, [...original, lying, duplicate]);
    expect(r.devices.get(c.id)?.name).toBe("laptop");
    expect(r.ignored.map((i) => i.reason).sort()).toEqual(["duplicate_eid", "key_mismatch"]);
  });

  it("a revocation of an unknown device does not count; the recovery identity may revoke from any writer", async () => {
    const { a, b, c, recovery } = await vaultOfThree();
    const vaultId = a.ring.vaultId;
    const ghost = createDeviceIdentity(sodium).deviceId;
    const unknown = stamp(
      buildDeviceRevoked(a.identity, vaultId, newEid(), [
        { device: ghost, cut: { seg: 1, offset: 0 } },
      ]),
      a.id,
      START_TIME + 1e7,
    );
    const restorer = createDeviceIdentity(sodium);
    const byRecovery = stamp(
      buildDeviceRevoked(
        recovery,
        vaultId,
        newEid(),
        [a, b, c].map((d) => ({ device: d.id, cut: { seg: 1, offset: 1e6 } })),
      ),
      restorer.deviceId,
      START_TIME + 2e7,
    );
    const r = fold(a, [...allEvents(a, b, c), unknown, byRecovery]);
    expect(r.ignored).toContainEqual({ eid: unknown.eid, reason: "no_effect" });
    expect(r.revocationCount).toBe(1); // one event revoking three devices is one epoch step
    expect(r.trusted.size).toBe(0);
    expect(r.trustedSigner("0".repeat(32))).toEqual(a.ring.recovery.signPublicKey);
  });
});
