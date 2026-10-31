import { describe, expect, it } from "vitest";
import { certifyDevice, TrustedDevice, verifyCertificates } from "./cert.js";
import { createDeviceIdentity, DeviceIdentity } from "./identity.js";
import { createKeyring } from "./keys.js";
import { createRecoveryKey, recoveryIdentity } from "./recovery.js";
import { Secret } from "./secret.js";
import { anyEpoch, code, sodium, subjectOf } from "./testkit.js";
import { recoveryRecipient, unwrapKeys, wrapKeys } from "./wrap.js";

function vault() {
  const recovery = createRecoveryKey(sodium);
  const root = recoveryIdentity(sodium, recovery.phrase);
  const ring = createKeyring(sodium, recovery.publicKeys);
  return { root, ring, vaultId: ring.vaultId };
}

/** A device whose id the attacker chose (any id but the all-zero recovery id). */
function deviceWithId(prefix: string): DeviceIdentity {
  const id = `${`${prefix}${"0".repeat(32)}`.slice(0, 31)}1`;
  return new DeviceIdentity(
    id,
    new Secret(sodium.randomBytes(32)),
    new Secret(sodium.randomBytes(32)),
  );
}

/** M's own keys certified under another device's id. */
function shadowOf(m: DeviceIdentity, id: string) {
  return { ...subjectOf(m), deviceId: id };
}

function bothOrders(
  vaultId: string,
  rootKey: Uint8Array,
  certs: Uint8Array[],
): ReturnType<typeof verifyCertificates>[] {
  return [certs, [...certs].reverse()].map((c) => verifyCertificates(sodium, vaultId, rootKey, c));
}

describe("certificates fail closed on conflicts (D13)", () => {
  it("C1: a certified device that certifies its own key under an honest id with a deeper chain", () => {
    const { root, vaultId } = vault();
    const [c, a, m, p, h] = Array.from({ length: 5 }, () => createDeviceIdentity(sodium)) as [
      DeviceIdentity,
      DeviceIdentity,
      DeviceIdentity,
      DeviceIdentity,
      DeviceIdentity,
    ];
    const certs = [
      certifyDevice(sodium, root, subjectOf(c), vaultId),
      certifyDevice(sodium, c, subjectOf(a), vaultId),
      certifyDevice(sodium, c, subjectOf(m), vaultId),
      certifyDevice(sodium, a, subjectOf(p), vaultId),
      certifyDevice(sodium, p, subjectOf(h), vaultId),
      certifyDevice(sodium, m, shadowOf(m, h.deviceId), vaultId),
    ];
    for (const { devices, conflicts } of bothOrders(vaultId, root.signPublicKey, certs)) {
      expect(devices.has(h.deviceId)).toBe(false);
      expect(conflicts).toEqual([h.deviceId]);
      expect([...devices.keys()].sort()).toEqual(
        [c.deviceId, a.deviceId, m.deviceId, p.deviceId].sort(),
      );
    }
  });

  it("C2: same depth with an attacker-chosen small id never picks a winner", () => {
    const { root, vaultId } = vault();
    const c = deviceWithId("f");
    const a = deviceWithId("8");
    const m = deviceWithId("01");
    const h = createDeviceIdentity(sodium);
    const certs = [
      certifyDevice(sodium, root, subjectOf(c), vaultId),
      certifyDevice(sodium, c, subjectOf(a), vaultId),
      certifyDevice(sodium, c, subjectOf(m), vaultId),
      certifyDevice(sodium, a, subjectOf(h), vaultId),
      certifyDevice(sodium, m, shadowOf(m, h.deviceId), vaultId),
    ];
    for (const { devices, conflicts } of bothOrders(vaultId, root.signPublicKey, certs)) {
      expect(devices.get(h.deviceId)).toBeUndefined();
      expect(conflicts).toEqual([h.deviceId]);
    }
  });

  it("trust does not flow through a conflicted id; the recovery-certified root can be blocked, never shadowed", () => {
    const { root, vaultId } = vault();
    const [c, m, child] = [0, 1, 2].map(() => createDeviceIdentity(sodium)) as [
      DeviceIdentity,
      DeviceIdentity,
      DeviceIdentity,
    ];
    const certs = [
      certifyDevice(sodium, root, subjectOf(c), vaultId),
      certifyDevice(sodium, root, subjectOf(m), vaultId),
      certifyDevice(sodium, c, subjectOf(child), vaultId),
      certifyDevice(sodium, m, shadowOf(m, c.deviceId), vaultId),
    ];
    for (const { devices, conflicts } of bothOrders(vaultId, root.signPublicKey, certs)) {
      expect(conflicts).toEqual([c.deviceId]);
      // C is untrusted, and so is everything trusted only through C.
      expect([...devices.keys()]).toEqual([m.deviceId]);
    }
  });

  it("the same key pair certified twice is not a conflict", () => {
    const { root, vaultId } = vault();
    const [c, a, h] = [0, 1, 2].map(() => createDeviceIdentity(sodium)) as [
      DeviceIdentity,
      DeviceIdentity,
      DeviceIdentity,
    ];
    const certs = [
      certifyDevice(sodium, root, subjectOf(c), vaultId),
      certifyDevice(sodium, root, subjectOf(a), vaultId),
      certifyDevice(sodium, c, subjectOf(h), vaultId),
      certifyDevice(sodium, a, subjectOf(h), vaultId),
    ];
    const { devices, conflicts } = verifyCertificates(sodium, vaultId, root.signPublicKey, certs);
    expect(conflicts).toEqual([]);
    expect(devices.get(h.deviceId)?.signPublicKey).toEqual(h.signPublicKey);
  });

  it("a second box key for the same id (same signing key) is also a conflict", () => {
    const { root, vaultId } = vault();
    const [c, h] = [0, 1].map(() => createDeviceIdentity(sodium)) as [
      DeviceIdentity,
      DeviceIdentity,
    ];
    const swapped = { ...subjectOf(h), boxPublicKey: createDeviceIdentity(sodium).box.publicKey };
    const certs = [
      certifyDevice(sodium, root, subjectOf(c), vaultId),
      certifyDevice(sodium, c, subjectOf(h), vaultId),
      certifyDevice(sodium, c, swapped, vaultId),
    ];
    expect(verifyCertificates(sodium, vaultId, root.signPublicKey, certs).conflicts).toEqual([
      h.deviceId,
    ]);
  });
});

describe("box keys only from certificates (D14)", () => {
  it("verified devices carry the certified box key; a storage-swapped key is never sealed for", () => {
    const { root, ring, vaultId } = vault();
    const desktop = createDeviceIdentity(sodium);
    const phone = createDeviceIdentity(sodium);
    const storage = createDeviceIdentity(sodium); // the box key a registry file in storage claims
    const certs = [
      certifyDevice(sodium, root, subjectOf(desktop), vaultId),
      certifyDevice(sodium, desktop, subjectOf(phone), vaultId),
    ];
    const { devices } = verifyCertificates(sodium, vaultId, root.signPublicKey, certs);
    const target = devices.get(phone.deviceId);
    if (!target) throw new Error("phone not trusted");
    expect(target.boxPublicKey).toEqual(phone.box.publicKey);

    // A caller holding the registry's (swapped) box key cannot build a recipient from it.
    const forgedRecipient = { ...target, boxPublicKey: storage.box.publicKey };
    expect(() =>
      wrapKeys(sodium, ring, desktop, forgedRecipient as unknown as TrustedDevice),
    ).toThrow(TypeError);
    expect(
      () =>
        new (TrustedDevice as unknown as new (...a: unknown[]) => unknown)(
          Symbol("x"),
          phone.deviceId,
          phone.signPublicKey,
          storage.box.publicKey,
        ),
    ).toThrow(TypeError);

    // The real wrap goes to the certified key: the phone opens it, the swapped key cannot.
    const wire = wrapKeys(sodium, ring, desktop, target);
    const trust = (id: string) => devices.get(id)?.signPublicKey;
    const pinned = { vaultId, recoveryPublicKey: ring.recovery };
    expect(unwrapKeys(sodium, wire, phone, pinned, trust, anyEpoch).senderDeviceId).toBe(
      desktop.deviceId,
    );
    expect(code(() => unwrapKeys(sodium, wire, storage, pinned, trust, anyEpoch))).toBe(
      "auth_failed",
    );
    expect(() => wrapKeys(sodium, ring, desktop, recoveryRecipient(ring))).not.toThrow();
  });
});
