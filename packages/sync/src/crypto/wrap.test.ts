import { describe, expect, it } from "vitest";
import { CryptoError } from "./errors.js";
import { openFrame, sealFrame } from "./frame.js";
import { createDeviceIdentity, type DeviceIdentity } from "./identity.js";
import { createVaultId, type Keyring, rotateKeyring } from "./keys.js";
import { ctx, newRing, samplePlain, sodium } from "./testkit.js";
import { openPairingWrap, sealForPairing } from "./wrap.js";

/** One simulated device: its own identity and, once paired, its own copy of the vault's ring. */
interface Device {
  id: string;
  pair: DeviceIdentity;
  ring?: Keyring;
}

const device = (_name: string): Device => {
  const pair = createDeviceIdentity(sodium);
  return { id: pair.deviceId, pair };
};

function expectCode(fn: () => unknown, code: string) {
  expect(fn).toThrowError(CryptoError);
  try {
    fn();
  } catch (e) {
    expect((e as CryptoError).code).toBe(code);
  }
}

describe("pairing across two simulated devices", () => {
  it("desktop wraps the ring for the phone; both read each other's frames", () => {
    const desktop = device("desktop");
    const phone = device("phone");
    desktop.ring = newRing();
    const vaultId = desktop.ring.vaultId;

    // Only the phone's public key crosses to the desktop; only the wrap crosses back.
    const wrapped = sealForPairing(sodium, desktop.ring, phone.pair.box.publicKey);
    phone.ring = openPairingWrap(sodium, wrapped, phone.pair, vaultId);
    expect(phone.ring.active.kid).toBe(desktop.ring.active.kid);

    const fromDesktop = sealFrame(
      sodium,
      desktop.ring,
      samplePlain(),
      ctx(vaultId, { deviceId: desktop.id }),
    );
    const fromPhone = sealFrame(
      sodium,
      phone.ring,
      samplePlain(),
      ctx(vaultId, { deviceId: phone.id }),
    );
    expect(
      openFrame(sodium, phone.ring, fromDesktop, ctx(vaultId, { deviceId: desktop.id })),
    ).toEqual(samplePlain());
    expect(
      openFrame(sodium, desktop.ring, fromPhone, ctx(vaultId, { deviceId: phone.id })),
    ).toEqual(samplePlain());
  });

  it("the whole ring travels, so the new device reads frames of older generations", () => {
    const desktop = device("desktop");
    const phone = device("phone");
    desktop.ring = newRing();
    const c = ctx(desktop.ring.vaultId);
    const old = sealFrame(sodium, desktop.ring, samplePlain(), c);
    rotateKeyring(sodium, desktop.ring);
    phone.ring = openPairingWrap(
      sodium,
      sealForPairing(sodium, desktop.ring, phone.pair.box.publicKey),
      phone.pair,
      c.vaultId,
    );
    expect(phone.ring.size).toBe(2);
    expect(openFrame(sodium, phone.ring, old, c)).toEqual(samplePlain());
  });

  it("a third device cannot open a wrap meant for the phone", () => {
    const ring = newRing();
    const wrapped = sealForPairing(sodium, ring, device("phone").pair.box.publicKey);
    expectCode(
      () => openPairingWrap(sodium, wrapped, device("eavesdropper").pair, ring.vaultId),
      "auth_failed",
    );
  });

  it("a tampered or truncated wrap is rejected", () => {
    const phone = device("phone");
    const ring = newRing();
    const wrapped = sealForPairing(sodium, ring, phone.pair.box.publicKey);
    for (const i of [0, 31, 32, 47, 48, wrapped.length - 1]) {
      const t = wrapped.slice();
      t[i] = (t[i] ?? 0) ^ 0x01;
      expectCode(() => openPairingWrap(sodium, t, phone.pair, ring.vaultId), "auth_failed");
    }
    expectCode(
      () => openPairingWrap(sodium, wrapped.subarray(0, 40), phone.pair, ring.vaultId),
      "auth_failed",
    );
  });

  it("keys of another vault are refused even when sealed for this device", () => {
    const phone = device("phone");
    const ring = newRing();
    const wrapped = sealForPairing(sodium, ring, phone.pair.box.publicKey);
    expectCode(
      () => openPairingWrap(sodium, wrapped, phone.pair, createVaultId(sodium)),
      "vault_mismatch",
    );
  });

  it("a validly sealed but malformed payload is bad_payload", () => {
    const phone = device("phone");
    const junk = sodium.seal(new Uint8Array([1, 2, 3]), phone.pair.box.publicKey);
    expectCode(
      () => openPairingWrap(sodium, junk, phone.pair, createVaultId(sodium)),
      "bad_payload",
    );
  });
});

describe("revocation is rotation going forward", () => {
  it("the new key goes only to remaining devices; the revoked one keeps history but cannot read new frames", () => {
    const desktop = device("desktop");
    const phone = device("phone");
    const lost = device("lost-tablet");
    desktop.ring = newRing();
    const vaultId = desktop.ring.vaultId;
    for (const d of [phone, lost]) {
      d.ring = openPairingWrap(
        sodium,
        sealForPairing(sodium, desktop.ring, d.pair.box.publicKey),
        d.pair,
        vaultId,
      );
    }

    rotateKeyring(sodium, desktop.ring);
    const onlyNew = sealForPairing(sodium, desktop.ring, phone.pair.box.publicKey);
    phone.ring?.merge(openPairingWrap(sodium, onlyNew, phone.pair, vaultId));

    const c = ctx(vaultId, { deviceId: desktop.id });
    const frame = sealFrame(sodium, desktop.ring, samplePlain(), c);
    expect(phone.ring && openFrame(sodium, phone.ring, frame, c)).toEqual(samplePlain());
    expectCode(() => lost.ring && openFrame(sodium, lost.ring, frame, c), "unknown_key");
  });

  it("wrapping a key id the ring does not hold is refused", () => {
    const ring = newRing();
    expectCode(
      () => sealForPairing(sodium, ring, device("x").pair.box.publicKey, ["00".repeat(16)]),
      "unknown_key",
    );
  });
});
