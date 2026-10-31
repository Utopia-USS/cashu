import { describe, expect, it } from "vitest";
import { openFrame, sealFrame } from "./frame.js";
import { createDeviceIdentity, type DeviceIdentity } from "./identity.js";
import { createKeyring, createVaultId, type Keyring, rotateKeyring } from "./keys.js";
import { createRecoveryKey, recoveryIdentity } from "./recovery.js";
import type { Sodium } from "./sodium.js";
import {
  anyEpoch,
  backends,
  code,
  ctx,
  newRing,
  pairWith,
  samplePlain,
  testRecovery,
  trustedTo,
} from "./testkit.js";
import {
  openPairingWrap,
  pairingWrapHash,
  sealForPairing,
  type TrustedSigner,
  unwrapKeys,
  WRAP_VERSION,
  wrapKeys,
} from "./wrap.js";

/** One simulated device: its identity and, once paired, its own copy of the vault's ring. */
interface Device {
  id: DeviceIdentity;
  ring: Keyring;
}

/** A registry view: the signing keys of devices a device trusts. */
function trusting(...devices: DeviceIdentity[]): TrustedSigner {
  const keys = new Map(devices.map((d) => [d.deviceId, d.signPublicKey]));
  return (id) => keys.get(id);
}

describe.each(backends)("pairing hop (%s)", (_name, sodium: Sodium) => {
  it("desktop seals the ring for the phone; both read each other's frames", () => {
    const desktop = createDeviceIdentity(sodium);
    const phone = createDeviceIdentity(sodium);
    const ring = newRing(sodium);
    const vaultId = ring.vaultId;
    // Only the phone's public key crosses to the desktop (authenticated out of band); the box crosses back.
    const phoneRing = pairWith(sodium, ring, phone);
    expect(phoneRing.active.kid).toBe(ring.active.kid);
    expect(phoneRing.recovery).toEqual(ring.recovery);

    const fromDesktop = sealFrame(
      sodium,
      ring,
      samplePlain(),
      ctx(vaultId, { deviceId: desktop.deviceId }),
    );
    const fromPhone = sealFrame(
      sodium,
      phoneRing,
      samplePlain(),
      ctx(vaultId, { deviceId: phone.deviceId }),
    );
    expect(
      openFrame(sodium, phoneRing, fromDesktop, ctx(vaultId, { deviceId: desktop.deviceId })),
    ).toEqual(samplePlain());
    expect(openFrame(sodium, ring, fromPhone, ctx(vaultId, { deviceId: phone.deviceId }))).toEqual(
      samplePlain(),
    );
  });

  it("the whole ring travels, so the new device reads frames of older generations", () => {
    const phone = createDeviceIdentity(sodium);
    const ring = newRing(sodium);
    const c = ctx(ring.vaultId);
    const old = sealFrame(sodium, ring, samplePlain(), c);
    rotateKeyring(sodium, ring);
    const phoneRing = pairWith(sodium, ring, phone);
    expect(phoneRing.size).toBe(2);
    expect(openFrame(sodium, phoneRing, old, c)).toEqual(samplePlain());
  });

  it("a third device cannot open it; tampered, truncated or another vault's boxes are refused", () => {
    const phone = createDeviceIdentity(sodium);
    const ring = newRing(sodium);
    const sealed = sealForPairing(sodium, ring, phone.box.publicKey);
    const open = (box: Uint8Array, who = phone, vaultId = ring.vaultId) =>
      code(() => openPairingWrap(sodium, box, who, vaultId, pairingWrapHash(sodium, box)));
    expect(open(sealed, createDeviceIdentity(sodium))).toBe("auth_failed");
    for (const i of [0, 31, 32, 47, 48, sealed.length - 1]) {
      const t = sealed.slice();
      t[i] = (t[i] ?? 0) ^ 0x01;
      expect(open(t)).toBe("auth_failed");
    }
    expect(open(sealed.subarray(0, 40))).toBe("auth_failed");
    expect(open(sealed, phone, createVaultId(sodium))).toBe("vault_mismatch");
    expect(open(sodium.seal(new Uint8Array([1, 2, 3]), phone.box.publicKey))).toBe("bad_payload");
  });

  it("the SAS-compared hash is required: a box with another hash is refused before opening", () => {
    const phone = createDeviceIdentity(sodium);
    const ring = newRing(sodium);
    const honest = sealForPairing(sodium, ring, phone.box.publicKey);
    const swapped = sealForPairing(sodium, newRing(sodium, ring.vaultId), phone.box.publicKey);
    const compared = pairingWrapHash(sodium, honest);
    expect(code(() => openPairingWrap(sodium, swapped, phone, ring.vaultId, compared))).toBe(
      "auth_failed",
    );
    expect(openPairingWrap(sodium, honest, phone, ring.vaultId, compared).active.kid).toBe(
      ring.active.kid,
    );
  });
});

describe.each(backends)("signed wraps (%s)", (_name, sodium: Sodium) => {
  function pairedVault(names: number): { devices: Device[]; trust: TrustedSigner } {
    const first = createDeviceIdentity(sodium);
    const ring = createKeyring(sodium, testRecovery.publicKeys);
    const devices: Device[] = [{ id: first, ring }];
    for (let i = 1; i < names; i++) {
      const id = createDeviceIdentity(sodium);
      devices.push({
        id,
        ring: pairWith(sodium, ring, id),
      });
    }
    return { devices, trust: trusting(...devices.map((d) => d.id)) };
  }

  it("a rotation wrap from a trusted device merges and names its sender", () => {
    const { devices, trust } = pairedVault(2);
    const [desktop, phone] = devices as [Device, Device];
    const gen2 = rotateKeyring(sodium, desktop.ring);
    const wire = wrapKeys(
      sodium,
      desktop.ring,
      desktop.id,
      trustedTo(phone.id, desktop.ring.vaultId),
      [gen2.kid],
    );
    expect(wire[0]).toBe(WRAP_VERSION);
    const out = unwrapKeys(sodium, wire, phone.id, phone.ring, trust, anyEpoch);
    expect(out.ring).toBe(phone.ring);
    expect(out.senderDeviceId).toBe(desktop.id.deviceId);
    expect(phone.ring.active.kid).toBe(gen2.kid);
  });

  it("an unknown or untrusted signer is untrusted_sender, checked before opening", () => {
    const { devices } = pairedVault(2);
    const [desktop, phone] = devices as [Device, Device];
    rotateKeyring(sodium, desktop.ring);
    const wire = wrapKeys(
      sodium,
      desktop.ring,
      desktop.id,
      trustedTo(phone.id, desktop.ring.vaultId),
      [desktop.ring.active.kid],
    );
    expect(
      code(() => unwrapKeys(sodium, wire, phone.id, phone.ring, trusting(phone.id), anyEpoch)),
    ).toBe("untrusted_sender");
    expect(phone.ring.size).toBe(1);
  });

  it("every flipped bit of the header, signature or sealed part is rejected", () => {
    const { devices, trust } = pairedVault(2);
    const [desktop, phone] = devices as [Device, Device];
    rotateKeyring(sodium, desktop.ring);
    const wire = wrapKeys(
      sodium,
      desktop.ring,
      desktop.id,
      trustedTo(phone.id, desktop.ring.vaultId),
      [desktop.ring.active.kid],
    );
    const seen = new Set<string>();
    for (let i = 0; i < wire.length; i += 3) {
      const t = wire.slice();
      t[i] = (t[i] ?? 0) ^ 0x01;
      seen.add(code(() => unwrapKeys(sodium, t, phone.id, phone.ring, trust, anyEpoch)));
    }
    // A flipped recipient count that overruns the wire is truncated before the signature check.
    expect([...seen].sort()).toEqual([
      "auth_failed",
      "truncated",
      "unsupported_version",
      "untrusted_sender",
    ]);
    expect(
      code(() => unwrapKeys(sodium, wire.subarray(0, 50), phone.id, phone.ring, trust, anyEpoch)),
    ).toBe("truncated");
    expect(phone.ring.size).toBe(1);
  });

  it("a wrap for one device is useless for another, and the signature binds the vault", () => {
    const { devices, trust } = pairedVault(3);
    const [desktop, phone, tablet] = devices as [Device, Device, Device];
    rotateKeyring(sodium, desktop.ring);
    const wire = wrapKeys(
      sodium,
      desktop.ring,
      desktop.id,
      trustedTo(phone.id, desktop.ring.vaultId),
      [desktop.ring.active.kid],
    );
    expect(code(() => unwrapKeys(sodium, wire, tablet.id, tablet.ring, trust, anyEpoch))).toBe(
      "auth_failed",
    );
    const elsewhere = newRing(sodium);
    expect(code(() => unwrapKeys(sodium, wire, phone.id, elsewhere, trust, anyEpoch))).toBe(
      "auth_failed",
    );
  });

  it("the vault's recovery pins must match", () => {
    const { devices } = pairedVault(2);
    const [desktop, phone] = devices as [Device, Device];
    const target = {
      vaultId: desktop.ring.vaultId,
      recoveryPublicKey: createRecoveryKey(sodium).publicKeys,
    };
    // Only the words may seed a base ring, so the base wrap is recovery-signed.
    const words = recoveryIdentity(sodium, testRecovery.phrase);
    const wire = wrapKeys(sodium, desktop.ring, words, trustedTo(phone.id, desktop.ring.vaultId));
    expect(
      code(() => unwrapKeys(sodium, wire, phone.id, target, () => words.signPublicKey, anyEpoch)),
    ).toBe("recovery_key_mismatch");
  });

  it("one wrap adds at most one generation; the whole ring travels only by pairing", () => {
    const { devices, trust } = pairedVault(2);
    const [desktop, phone] = devices as [Device, Device];
    rotateKeyring(sodium, desktop.ring);
    rotateKeyring(sodium, desktop.ring);
    const all = wrapKeys(
      sodium,
      desktop.ring,
      desktop.id,
      trustedTo(phone.id, desktop.ring.vaultId),
    );
    expect(code(() => unwrapKeys(sodium, all, phone.id, phone.ring, trust, anyEpoch))).toBe(
      "generation_gap",
    );
    expect(phone.ring.size).toBe(1);
    for (const e of desktop.ring.entries().slice(1)) {
      unwrapKeys(
        sodium,
        wrapKeys(sodium, desktop.ring, desktop.id, trustedTo(phone.id, desktop.ring.vaultId), [
          e.kid,
        ]),
        phone.id,
        phone.ring,
        trust,
        anyEpoch,
      );
    }
    expect(phone.ring.active.kid).toBe(desktop.ring.active.kid);
  });

  it("the signed recipient list comes back and cannot be altered", () => {
    const { devices, trust } = pairedVault(3);
    const [desktop, phone, tablet] = devices as [Device, Device, Device];
    const gen2 = rotateKeyring(sodium, desktop.ring);
    const list = [phone.id.deviceId, tablet.id.deviceId];
    const wire = wrapKeys(
      sodium,
      desktop.ring,
      desktop.id,
      trustedTo(phone.id, desktop.ring.vaultId),
      [gen2.kid],
      list,
    );
    expect(
      unwrapKeys(sodium, wire, phone.id, phone.ring.clone(sodium), trust, anyEpoch).recipients,
    ).toEqual(list);
    // Swap the listed tablet id for another id: the signature no longer matches.
    const altered = wire.slice();
    const at = 1 + 16 + 64 + 2 + 16;
    altered.set(Buffer.from(desktop.id.deviceId, "hex"), at);
    expect(code(() => unwrapKeys(sodium, altered, phone.id, phone.ring, trust, anyEpoch))).toBe(
      "auth_failed",
    );
    expect(() =>
      wrapKeys(
        sodium,
        desktop.ring,
        desktop.id,
        trustedTo(phone.id, desktop.ring.vaultId),
        [gen2.kid],
        [tablet.id.deviceId],
      ),
    ).toThrow(RangeError);
  });

  it("wrapping a key id the ring does not hold is refused", () => {
    const { devices } = pairedVault(2);
    const [desktop, phone] = devices as [Device, Device];
    expect(
      code(() =>
        wrapKeys(sodium, desktop.ring, desktop.id, trustedTo(phone.id, desktop.ring.vaultId), [
          "00".repeat(16),
        ]),
      ),
    ).toBe("unknown_key");
  });
});

describe.each(backends)("revocation is rotation going forward (%s)", (_name, sodium: Sodium) => {
  it("the new key goes only to remaining devices; the revoked one keeps history but cannot read new frames", () => {
    const desktop = createDeviceIdentity(sodium);
    const phone = createDeviceIdentity(sodium);
    const lost = createDeviceIdentity(sodium);
    const ring = newRing(sodium);
    const vaultId = ring.vaultId;
    const pair = (d: DeviceIdentity) => pairWith(sodium, ring, d);
    const phoneRing = pair(phone);
    const lostRing = pair(lost);

    const gen2 = rotateKeyring(sodium, ring, { epoch: 1 });
    const onlyNew = wrapKeys(sodium, ring, desktop, trustedTo(phone, ring.vaultId), [gen2.kid]);
    unwrapKeys(sodium, onlyNew, phone, phoneRing, trusting(desktop), anyEpoch);

    const c = ctx(vaultId, { deviceId: desktop.deviceId });
    const frame = sealFrame(sodium, ring, samplePlain(), c);
    expect(openFrame(sodium, phoneRing, frame, c)).toEqual(samplePlain());
    expect(code(() => openFrame(sodium, lostRing, frame, c))).toBe("unknown_key");
  });
});
