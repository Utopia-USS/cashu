// The revoke flow with re-certification (S29c, lead decision (b)): revoking a device writes ONE batch,
// the revocation plus a re-certification of every remaining device whose only chain ran through it;
// a revoker whose own chain runs through the target needs the recovery words; every affected device
// is listed; a truncated batch never revokes without re-certifying.

import { describe, expect, it } from "vitest";
import type { UnstampedEvent } from "../carrier.js";
import {
  certifyDevice,
  createDeviceId,
  createDeviceIdentity,
  type RecoveryIdentity,
} from "../crypto/index.js";
import {
  buildDeviceAdded,
  buildLeaseClaim,
  DEVICE_ADDED,
  DEVICE_REVOKED,
  type LogEvent,
} from "./events.js";
import { foldLease } from "./lease.js";
import type { PreparedChange } from "./rotation.js";
import {
  type Batch,
  createSimVault,
  newEid,
  pairDevice,
  prepareConsented,
  type SimDevice,
  START_CURSOR,
  sodium,
} from "./testkit.js";

function syncAll(devices: readonly SimDevice[], rounds = 2): void {
  for (let i = 0; i < rounds; i++) for (const d of devices) d.sync();
}

/** A creator, a desktop it paired, and a phone and a laptop the desktop paired. */
async function household() {
  const vault = createSimVault();
  const a = vault.creator;
  const desk = await pairDevice(a, "desktop");
  const phone = await pairDevice(desk, "phone");
  const laptop = await pairDevice(desk, "laptop");
  const b = await pairDevice(a, "tablet");
  syncAll([a, desk, phone, laptop, b]);
  return { vault, a, desk, phone, laptop, b };
}

/** The revoke flow; without the recovery words the target consents (it is in the owner's hands). */
function revoke(revoker: SimDevice, target: SimDevice, recovery?: RecoveryIdentity) {
  if (recovery) {
    return revoker.devices.prepareRevocation(
      [{ device: target.id, cut: revoker.cursors.get(target.id) ?? START_CURSOR }],
      { revoke: newEid(), rotate: newEid(), recertify: newEid },
      recovery,
    );
  }
  return prepareConsented(revoker, [target]);
}

function write(revoker: SimDevice, change: PreparedChange): Batch {
  const batch = revoker.write(change.events);
  change.commit();
  return batch;
}

function claim(d: SimDevice): UnstampedEvent {
  return buildLeaseClaim(d.identity, d.ring.vaultId, newEid(), {
    at: d.now(),
    until: d.now() + 60 * 60 * 1000,
    watermark: Object.fromEntries(d.applied),
    prev: d.devices.lease.head,
  });
}

describe("H2: who may revoke a device", () => {
  it("a device-signed revocation of another device without its consent is refused up front (authority_required)", async () => {
    const { a, desk } = await household();
    const result = a.devices.prepareRevocation(
      [{ device: desk.id, cut: a.cursors.get(desk.id) ?? START_CURSOR }],
      { revoke: newEid(), rotate: newEid(), recertify: newEid },
    );
    expect(result).toEqual({ ok: false, reason: "authority_required", unconsented: [desk.id] });
  });

  it("with the target's consent (in the owner's hands) a device-signed revocation counts", async () => {
    const { a, desk, b } = await household();
    const result = prepareConsented(a, [desk]);
    if (!result.ok) throw new Error(result.reason);
    write(a, result.change);
    syncAll([a, b]);
    expect(b.devices.registry.revoked.get(desk.id)?.signers).toEqual([a.id]);
  });

  it("with the recovery words (lost or stolen) no consent is needed and the revocation is recovery-signed", async () => {
    const { vault, a, desk, b } = await household();
    const result = revoke(a, desk, vault.recovery);
    if (!result.ok) throw new Error(result.reason);
    write(a, result.change);
    syncAll([a, b]);
    expect(b.devices.registry.revoked.get(desk.id)?.signers).toEqual(["0".repeat(32)]);
    expect(b.devices.registry.revoked.get(desk.id)?.contested).toBe(false);
  });

  it("H4: a device paired by the target, revoking it, is refused up front (its own chain needs the words)", async () => {
    const { desk, phone } = await household();
    const refused = revoke(phone, desk);
    expect(refused).toMatchObject({ ok: false, reason: "recovery_required" });
    if (refused.ok || refused.reason !== "recovery_required") throw new Error("expected a refusal");
    expect(refused.affected.find((x) => x.device === phone.id)).toMatchObject({
      recertified: false,
      reason: "recovery_required",
    });
  });
});

describe("revoke flow with re-certification", () => {
  it("revoking the desktop that certified the phone re-certifies the phone in the same batch; its lease and watermark statements count", async () => {
    const { a, desk, phone, laptop, b } = await household();
    const result = revoke(a, desk);
    if (!result.ok) throw new Error(result.reason);
    expect(result.change.affected.map((x) => [x.device, x.name, x.recertified]).sort()).toEqual(
      [
        [phone.id, "phone", true],
        [laptop.id, "laptop", true],
      ].sort(),
    );
    const types = result.change.events.map((e) => e.t);
    expect(types[0]).toBe(DEVICE_REVOKED);
    expect(types.filter((t) => t === DEVICE_ADDED)).toHaveLength(2);
    write(a, result.change);
    syncAll([a, b, phone, laptop]);
    // The phone claims the lease with its watermark right after the batch: it counts everywhere.
    phone.write([claim(phone)]);
    syncAll([a, b, phone, laptop]);
    for (const d of [a, b, laptop]) {
      const reg = d.devices.registry;
      expect(reg.revoked.has(desk.id), d.name).toBe(true);
      expect(reg.isTrusted(phone.id), d.name).toBe(true);
      expect(d.devices.lease.holder, d.name).toBe(phone.id);
      expect(Object.keys(d.devices.lease.catchUp).length, d.name).toBeGreaterThan(0);
      expect(d.devices.lease.catchUpSources.get(a.id), d.name).toBe(d.devices.lease.head);
    }
    // The next rotation wraps for the phone and the laptop, never for the desktop.
    expect(result.change.recipients).toEqual(expect.arrayContaining([phone.id, laptop.id]));
    expect(result.change.recipients).not.toContain(desk.id);
  });

  it("a revoker whose chain runs through the revoked device is refused without the recovery key and succeeds with it", async () => {
    const { vault, a, desk, phone, laptop, b } = await household();
    const refused = revoke(phone, desk);
    expect(refused).toMatchObject({ ok: false, reason: "recovery_required" });
    if (refused.ok || refused.reason !== "recovery_required") throw new Error("expected a refusal");
    expect(refused.affected.map((x) => x.device).sort()).toEqual([phone.id, laptop.id].sort());
    expect(refused.affected.every((x) => !x.recertified && x.reason === "recovery_required")).toBe(
      true,
    );
    const done = revoke(phone, desk, vault.recovery);
    if (!done.ok) throw new Error(done.reason);
    expect(done.change.affected.every((x) => x.recertified)).toBe(true);
    write(phone, done.change);
    syncAll([a, b, phone, laptop]);
    for (const d of [a, b, phone, laptop]) {
      const reg = d.devices.registry;
      expect(reg.revoked.has(desk.id), d.name).toBe(true);
      expect(reg.revoked.get(desk.id)?.signers, d.name).toEqual(["0".repeat(32)]);
      expect([...reg.trusted.keys()].sort(), d.name).toEqual(
        [a.id, b.id, phone.id, laptop.id].sort(),
      );
    }
  });

  it("a device the flow cannot re-certify (the revoker's certificate window is full) is listed, never silently dropped", async () => {
    const { a, desk, phone, laptop, b } = await household();
    // A has issued certificates for the desktop and the tablet; 62 more fill its window.
    const keys = createDeviceIdentity(sodium);
    const fill: UnstampedEvent[] = Array.from({ length: 62 }, () => {
      const subject = {
        deviceId: createDeviceId(sodium),
        signPublicKey: keys.signPublicKey,
        boxPublicKey: keys.box.publicKey,
      };
      const cert = certifyDevice(sodium, a.identity, subject, a.ring.vaultId);
      return buildDeviceAdded(a.identity, a.ring.vaultId, newEid(), subject, "spare", cert);
    });
    a.write(fill);
    expect(a.devices.registry.certificatesIssuedBy(a.id)).toBe(64);
    const result = revoke(a, desk);
    if (!result.ok) throw new Error(result.reason);
    expect(result.change.affected.map((x) => [x.device, x.recertified, x.reason]).sort()).toEqual(
      [
        [phone.id, false, "capacity"],
        [laptop.id, false, "capacity"],
      ].sort(),
    );
    write(a, result.change);
    syncAll([a, b]);
    expect(a.devices.registry.isTrusted(phone.id)).toBe(false); // as the result told the caller
  });

  it("atomicity: a truncated batch (revocation without its re-certifications) never counts; the whole batch does", async () => {
    const { a, desk, phone, laptop, b } = await household();
    const result = revoke(a, desk);
    if (!result.ok) throw new Error(result.reason);
    const full = write(a, result.change);
    // Untrusted storage (or a partial delivery) holds the batch without its tail.
    const cut = (keep: (e: LogEvent, i: number) => boolean): Batch => ({
      ...full,
      events: full.events.filter(keep),
    });
    for (const truncated of [
      cut((e) => e.type === DEVICE_REVOKED), // the revocation alone
      cut((_, i) => i <= 1), // the revocation and one of the two re-certifications
    ]) {
      a.remote.publish(full);
      a.remote.replace(truncated);
      b.rebuild();
      const reg = b.devices.registry;
      expect(reg.revoked.has(desk.id)).toBe(false);
      expect(reg.isTrusted(phone.id)).toBe(true);
      expect(reg.isTrusted(laptop.id)).toBe(true);
      expect(reg.ignored).toContainEqual({ eid: full.events[0]?.eid, reason: "incomplete_batch" });
      expect(foldLease(reg, []).holder).toBeNull();
    }
    a.remote.replace(full);
    b.rebuild();
    expect(b.devices.registry.revoked.has(desk.id)).toBe(true);
    expect(b.devices.registry.isTrusted(phone.id)).toBe(true);
    expect(b.devices.registry.isTrusted(laptop.id)).toBe(true);
    expect(desk.devices.registry.isTrusted(desk.id)).toBe(true); // desk has not pulled yet
  });
});
