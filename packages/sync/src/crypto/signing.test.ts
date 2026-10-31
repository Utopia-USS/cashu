import { describe, expect, it } from "vitest";
import { CertificateCache, CertificateIndex, certifyDevice, verifyCertificates } from "./cert.js";
import {
  createDeviceIdentity,
  RECOVERY_SIGNER_ID,
  type SigningContext,
  verifyContextSignature,
  verifySignature,
} from "./identity.js";
import { createKeyring } from "./keys.js";
import { createRecoveryKey, recoveryIdentity } from "./recovery.js";
import { sodium, subjectOf } from "./testkit.js";
import { recoveryRecipient, verifyWrapSignature, wrapKeys, wrapSenderId } from "./wrap.js";

const CONTEXTS: SigningContext[] = [
  "cashu/wrap/v3",
  "cashu/cert/v1",
  "cashu/registry/v1",
  "cashu/lease/v1",
  "cashu/pairing/v1",
];

describe("signing contexts (S29b)", () => {
  it("a signature made for one context verifies for that context only", () => {
    const device = createDeviceIdentity(sodium);
    const body = new TextEncoder().encode("synthetic body");
    for (const signed of CONTEXTS) {
      const sig = device.sign(signed, body);
      for (const checked of CONTEXTS) {
        expect(verifyContextSignature(checked, body, sig, device.signPublicKey)).toBe(
          signed === checked,
        );
      }
    }
    for (const a of CONTEXTS) {
      for (const b of CONTEXTS) if (a !== b) expect(b.startsWith(a)).toBe(false);
    }
  });

  it("refuses unknown contexts and treats malformed signatures as invalid", () => {
    const device = createDeviceIdentity(sodium);
    const body = new Uint8Array([1, 2, 3]);
    expect(() => device.sign("cashu/frame/v9" as SigningContext, body)).toThrow(RangeError);
    expect(() =>
      verifyContextSignature(
        "cashu/registry" as SigningContext,
        body,
        new Uint8Array(64),
        device.signPublicKey,
      ),
    ).toThrow(RangeError);
    expect(verifySignature(new Uint8Array(63), body, device.signPublicKey)).toBe(false);
    expect(
      verifyContextSignature(
        "cashu/lease/v1",
        body,
        new Uint8Array(64).fill(255),
        device.signPublicKey,
      ),
    ).toBe(false);
  });
});

describe("certificate index (S29b, review M4)", () => {
  function vault() {
    const recovery = createRecoveryKey(sodium);
    const root = recoveryIdentity(sodium, recovery.phrase);
    const ring = createKeyring(sodium, recovery.publicKeys);
    return { root, ring, vaultId: ring.vaultId };
  }

  it("matches verifyCertificates, admits at most maxDevices breadth first, and reads a cut device's key", () => {
    const { root, vaultId } = vault();
    const a = createDeviceIdentity(sodium);
    const kids = Array.from({ length: 5 }, () => createDeviceIdentity(sodium));
    const certs = [
      certifyDevice(sodium, root, subjectOf(a), vaultId),
      ...kids.map((k) => certifyDevice(sodium, a, subjectOf(k), vaultId)),
    ];
    const cache = new CertificateCache(3); // tiny: eviction must not change results
    const index = new CertificateIndex(sodium, vaultId, root.signPublicKey, certs, { cache });
    const plain = verifyCertificates(sodium, vaultId, root.signPublicKey, certs, new Set());
    expect([...index.verify(new Set()).devices.keys()].sort()).toEqual(
      [...plain.devices.keys()].sort(),
    );
    const capped = new CertificateIndex(sodium, vaultId, root.signPublicKey, certs, {
      maxDevices: 3,
    });
    const ids = capped.closure(new Set()).ids();
    expect(ids).toHaveLength(3);
    expect(ids).toContain(a.deviceId); // depth 1 before depth 2
    const cut = index.closure(new Set([a.deviceId]));
    expect(cut.keysOf(a.deviceId)).toEqual([]);
    expect(cut.certifiedKeysOf(a.deviceId).map((k) => k.signPublicKey)).toEqual([a.signPublicKey]);
    expect(cut.ids()).toEqual([]); // a's subtree is cut with it
    expect(index.isSignedBy(certs[1] as Uint8Array, a.signPublicKey)).toBe(true);
    expect(index.isSignedBy(certs[1] as Uint8Array, root.signPublicKey)).toBe(false);
  });

  it("verifies a wrap's signature without opening it, and reads its claimed sender", () => {
    const { root, ring, vaultId } = vault();
    const wire = wrapKeys(sodium, ring, root, recoveryRecipient(ring));
    const recipient = { deviceId: RECOVERY_SIGNER_ID, boxPublicKey: ring.recovery.boxPublicKey };
    expect(wrapSenderId(wire)).toBe(RECOVERY_SIGNER_ID);
    expect(
      verifyWrapSignature(wire, vaultId, recipient, RECOVERY_SIGNER_ID, root.signPublicKey),
    ).toBe(true);
    const other = createDeviceIdentity(sodium);
    expect(
      verifyWrapSignature(wire, vaultId, recipient, RECOVERY_SIGNER_ID, other.signPublicKey),
    ).toBe(false);
    const tampered = wire.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(
      verifyWrapSignature(tampered, vaultId, recipient, RECOVERY_SIGNER_ID, root.signPublicKey),
    ).toBe(false);
    expect(wrapSenderId(new Uint8Array(3))).toBeUndefined();
  });
});
