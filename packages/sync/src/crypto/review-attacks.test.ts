// The S27 review's attacks A1-A7, kept as permanent tests: each asserts the attack now FAILS.

import { describe, expect, it } from "vitest";
import { concat, fromHex, lengthPrefixed, u32, utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { openFrame, sealFrame } from "./frame.js";
import { createDeviceIdentity, type DeviceIdentity } from "./identity.js";
import { type Keyring, MAX_EPOCH, rotateKeyring } from "./keys.js";
import { createRecoveryKey, recoveryIdentity } from "./recovery.js";
import { Secret } from "./secret.js";
import { keyringFromKeys } from "./testing.js";
import {
  code,
  ctx,
  GID_SALT,
  newRing,
  pairWith,
  samplePlain,
  sodium,
  testRecovery,
  trustedTo,
} from "./testkit.js";
import {
  openPairingWrap,
  sealForPairing,
  type TrustedSigner,
  unwrapKeys,
  WRAP_VERSION,
  wrapKeys,
} from "./wrap.js";

function trusting(...devices: DeviceIdentity[]): TrustedSigner {
  const keys = new Map(devices.map((d) => [d.deviceId, d.signPublicKey]));
  return (id) => keys.get(id);
}

/** A vault with paired devices; each holds its own ring. */
function vault(n: number) {
  const ring = newRing();
  const ids = Array.from({ length: n }, () => createDeviceIdentity(sodium));
  const rings = ids.map((id, i) => (i === 0 ? ring : pairWith(sodium, ring, id)));
  return { ids, rings, vaultId: ring.vaultId };
}

describe("review attacks now fail", () => {
  it("A1: storage that knows the vault id and a device public key cannot plant an active key", () => {
    const { ids, rings, vaultId } = vault(2);
    const [desktop, phone] = ids as [DeviceIdentity, DeviceIdentity];
    const phoneRing = rings[1] as Keyring;
    const before = phoneRing.active.kid;
    // The attacker's best payload: right vault and recovery pins, guessed gid salt, huge generation.
    const forged = concat(
      utf8("cashu/keys/v3"),
      lengthPrefixed(utf8(vaultId)),
      testRecovery.publicKeys.boxPublicKey,
      testRecovery.publicKeys.signPublicKey,
      new Uint8Array(32),
      Uint8Array.of(0, 1),
      u32(0xffffffff),
      u32(0),
      sodium.randomBytes(32),
    );
    const sealed = sodium.seal(forged, phone.box.publicKey);
    const trust = trusting(desktop);
    // No signing key: an unknown sender id, or the desktop's id with a junk signature.
    const list = concat(Uint8Array.of(0, 1), Buffer.from(phone.deviceId, "hex"));
    const asStranger = concat(
      Uint8Array.of(WRAP_VERSION),
      sodium.randomBytes(16),
      new Uint8Array(64),
      list,
      sealed,
    );
    const asDesktop = concat(
      Uint8Array.of(WRAP_VERSION),
      Buffer.from(desktop.deviceId, "hex"),
      new Uint8Array(64),
      list,
      sealed,
    );
    expect(code(() => unwrapKeys(sodium, asStranger, phone, phoneRing, trust))).toBe(
      "untrusted_sender",
    );
    expect(code(() => unwrapKeys(sodium, asDesktop, phone, phoneRing, trust))).toBe("auth_failed");
    // Even a trusted (later compromised) sender cannot push a generation near u32 max or skip ahead.
    const signedByDesktop = wrapKeys(
      sodium,
      rings[0] as Keyring,
      desktop,
      trustedTo(phone, vaultId),
    );
    expect(unwrapKeys(sodium, signedByDesktop, phone, phoneRing, trust).ring.active.kid).toBe(
      before,
    );
    const ahead = (rings[0] as Keyring).clone(sodium);
    for (let i = 0; i < 5; i++) rotateKeyring(sodium, ahead);
    const skip = wrapKeys(sodium, ahead, desktop, trustedTo(phone, ahead.vaultId), [
      ahead.active.kid,
    ]);
    expect(code(() => unwrapKeys(sodium, skip, phone, phoneRing, trust))).toBe("generation_gap");
    expect(phoneRing.active.kid).toBe(before);
    // And rotation keeps working.
    expect(rotateKeyring(sodium, phoneRing).generation).toBe(2);
  });

  it("A2: a revoked device's frames under its old key are refused by the carrier's generation floor", () => {
    const { ids, rings, vaultId } = vault(2);
    const [desktop, lost] = ids as [DeviceIdentity, DeviceIdentity];
    const desktopRing = rings[0] as Keyring;
    const lostRing = rings[1] as Keyring;
    rotateKeyring(sodium, desktopRing, { epoch: 1 }); // revoke 'lost'
    // 'lost' writes at a future position, even impersonating the desktop.
    for (const deviceId of [lost.deviceId, desktop.deviceId]) {
      const c = ctx(vaultId, { deviceId, segment: 9, offset: 0 });
      const forged = sealFrame(sodium, lostRing, utf8('[{"t":"lease.claimed"}]'), c);
      // The carrier's floor for both writers after the revocation point is generation 2.
      expect(code(() => openFrame(sodium, desktopRing, forged, c, { minGeneration: 2 }))).toBe(
        "key_not_allowed",
      );
    }
  });

  it("A3: concurrent rotation never lets a key wrapped for the revoked device win", () => {
    const base = newRing();
    for (let i = 0; i < 64; i++) {
      const a = base.clone(sodium); // A revokes R
      const b = base.clone(sodium); // B rotates concurrently, wraps for R too
      const ka = rotateKeyring(sodium, a, { epoch: base.active.epoch + 1 });
      rotateKeyring(sodium, b);
      a.merge(b);
      expect(a.active.kid).toBe(ka.kid);
    }
  });

  it("A4: a key relabelled to another generation is another kid, and merges converge in any order", () => {
    const ring = newRing();
    const vaultInfo = { vaultId: ring.vaultId, recovery: ring.recovery, gidSalt: GID_SALT };
    const k = sodium.randomBytes(32);
    const asGen1 = keyringFromKeys(sodium, vaultInfo, [
      { generation: 1, epoch: 0, key: k.slice() },
    ]);
    const relabelled = keyringFromKeys(sodium, vaultInfo, [
      { generation: 1, epoch: 0, key: sodium.randomBytes(32) },
      { generation: 2, epoch: 0, key: k.slice() },
    ]);
    expect(relabelled.get(asGen1.active.kid)).toBeUndefined();
    const x = asGen1.clone(sodium);
    const y = relabelled.clone(sodium);
    x.merge(relabelled);
    y.merge(asGen1);
    expect(x.active.kid).toBe(y.active.kid);
    expect(x.entries().map((e) => e.kid)).toEqual(y.entries().map((e) => e.kid));
  });

  it("A5: malformed frames never crash with a non-CryptoError", () => {
    const ring = newRing();
    const c = ctx(ring.vaultId);
    const good = sealFrame(sodium, ring, samplePlain(), c);
    let other = 0;
    const tryOpen = (f: Uint8Array) => {
      try {
        openFrame(sodium, ring, f, c);
      } catch (e) {
        if (!(e instanceof CryptoError)) other++;
      }
    };
    for (let n = 0; n < good.length + 2; n++) {
      tryOpen(good.subarray(0, n));
      tryOpen(concat(good, new Uint8Array(n)));
    }
    const kid = Buffer.from(ring.active.kid, "hex");
    for (let i = 0; i < 2000; i++) {
      const f = sodium.randomBytes(17 + Math.floor(Math.random() * 200));
      f[0] = 2;
      f.set(kid, 1);
      tryOpen(f);
    }
    expect(other).toBe(0);
  });

  it("A6: device ids with lone surrogates (or any non-hex id) are rejected", () => {
    const ring = newRing();
    for (const deviceId of ["dev\uD800", "dev�", "DEVICE", "a1".repeat(15), "0".repeat(32)]) {
      expect(() => sealFrame(sodium, ring, samplePlain(), ctx(ring.vaultId, { deviceId }))).toThrow(
        RangeError,
      );
    }
    const frame = sealFrame(sodium, ring, samplePlain(), ctx(ring.vaultId));
    expect(() =>
      openFrame(sodium, ring, frame, ctx(ring.vaultId, { deviceId: "dev\uD800" })),
    ).toThrow(RangeError);
  });

  it("A7: recovery accepts mixed case / extra whitespace; rejects prefixes and bad checksum", () => {
    const r = createRecoveryKey(sodium);
    const keys = recoveryIdentity(
      sodium,
      `  ${r.phrase.toUpperCase().split(" ").join("\n  ")} `,
    ).publicKeys;
    expect(keys).toEqual(r.publicKeys);
    const w = r.phrase.split(" ");
    expect(code(() => recoveryIdentity(sodium, w.map((x) => x.slice(0, 4)).join(" ")))).toBe(
      "bad_mnemonic",
    );
    const swapped = [...w];
    [swapped[0], swapped[1]] = [swapped[1] ?? "", swapped[0] ?? ""];
    if (swapped[0] !== swapped[1]) {
      expect(["bad_mnemonic", "no error"]).toContain(
        code(() => recoveryIdentity(sodium, swapped.join(" "))),
      );
    }
  });
});

describe("revocation races and hygiene", () => {
  it("3 devices: revoke vs concurrent rotate, the revoked device never holds the final active key", () => {
    for (let round = 0; round < 16; round++) {
      const { ids, rings, vaultId } = vault(3);
      const [a, b, r] = ids as [DeviceIdentity, DeviceIdentity, DeviceIdentity];
      const [ringA, ringB, ringR] = rings as [Keyring, Keyring, Keyring];
      const all = trusting(a, b, r);
      // A revokes R: epoch + 1, wrapped for B (and itself) only.
      const revoke = rotateKeyring(sodium, ringA, { epoch: 1 });
      const toB = wrapKeys(
        sodium,
        ringA,
        a,
        trustedTo(b, ringA.vaultId),
        [revoke.kid],
        [a.deviceId, b.deviceId],
      );
      // Concurrently B rotates for its stale view {A, B, R}.
      const plain = rotateKeyring(sodium, ringB);
      const stale = [a.deviceId, b.deviceId, r.deviceId];
      const fromB = [a, r].map((d) =>
        wrapKeys(sodium, ringB, b, trustedTo(d, ringB.vaultId), [plain.kid], stale),
      );
      const atB = unwrapKeys(sodium, toB, b, ringB, all);
      unwrapKeys(sodium, fromB[0] as Uint8Array, a, ringA, all);
      unwrapKeys(sodium, fromB[1] as Uint8Array, r, ringR, all);
      // Both remaining devices converge on the revoke key, whose signed recipient list excludes R ...
      expect(ringA.active.kid).toBe(revoke.kid);
      expect(ringB.active.kid).toBe(revoke.kid);
      expect(atB.recipients).not.toContain(r.deviceId);
      // ... and R, which holds B's concurrent key, cannot read what A and B write next.
      expect(ringR.get(plain.kid)).toBeDefined();
      const c = ctx(vaultId, { deviceId: a.deviceId });
      const next = sealFrame(sodium, ringA, samplePlain(), c);
      expect(code(() => openFrame(sodium, ringR, next, c))).toBe("unknown_key");
    }
  });

  it("N1: a still-trusted malicious device cannot win the race by claiming a high epoch", () => {
    const { ids, rings } = vault(3);
    const [a, b, r] = ids as [DeviceIdentity, DeviceIdentity, DeviceIdentity];
    const [ringA, ringB] = rings as [Keyring, Keyring, Keyring];
    const all = trusting(a, b, r);
    const revoke = rotateKeyring(sodium, ringA, { epoch: 1 });
    unwrapKeys(
      sodium,
      wrapKeys(sodium, ringA, a, trustedTo(b, ringA.vaultId), [revoke.kid]),
      b,
      ringB,
      all,
    );
    for (const epoch of [MAX_EPOCH, 5, 3]) {
      const forged = forgeSignedWrap(r, a, ringA, [
        { generation: 2, epoch, key: sodium.randomBytes(32) },
      ]);
      expect(code(() => unwrapKeys(sodium, forged, a, ringA, all))).toBe("epoch_gap");
    }
    expect(ringA.size).toBe(2);
    expect(ringA.active.kid).toBe(revoke.kid);
    // Revocation keeps working: the next revoke-rotation is still possible.
    expect(rotateKeyring(sodium, ringA, { epoch: 2 }).epoch).toBe(2);
  });

  it("N1: an epoch + 1 claim is accepted only if the acceptEpoch hook (S29 registry) allows it", () => {
    const { ids, rings } = vault(2);
    const [a, r] = ids as [DeviceIdentity, DeviceIdentity];
    const ringA = rings[0] as Keyring;
    const all = trusting(a, r);
    const forged = () =>
      forgeSignedWrap(r, a, ringA, [{ generation: 2, epoch: 1, key: sodium.randomBytes(32) }]);
    // The registry knows R applied no revocation, so R may not claim epoch 1.
    const revocationsApplied = new Map([[r.deviceId, 0]]);
    const acceptEpoch = (sender: string, e: { epoch: number }) =>
      e.epoch <= (revocationsApplied.get(sender) ?? 0);
    expect(code(() => unwrapKeys(sodium, forged(), a, ringA, all, { acceptEpoch }))).toBe(
      "untrusted_sender",
    );
    expect(ringA.size).toBe(1);
    revocationsApplied.set(r.deviceId, 1);
    unwrapKeys(sodium, forged(), a, ringA, all, { acceptEpoch });
    expect(ringA.size).toBe(2);
  });

  it("structuredClone (IPC) of secrets, rings and identities carries no key bytes", () => {
    const ring = newRing();
    const id = createDeviceIdentity(sodium);
    const key = sodium.randomBytes(32);
    const secret = new Secret(key.slice());
    expect(structuredClone(secret)).toEqual({});
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
    const dump = (v: unknown) =>
      JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? hex(x) : x)) ?? "";
    const cloned = [structuredClone(ring), structuredClone(id), structuredClone(ring.active)]
      .map(dump)
      .join(" ");
    for (const s of [
      key,
      ring.active.key.expose(),
      ring.active.frameKey.expose(),
      ring.gidSalt().expose(),
      id.box.secretKey.expose(),
      id.signSecretKey.expose(),
    ]) {
      expect(cloned).not.toContain(hex(s));
    }
  });
});

/** A signed wrap with arbitrary key material, as a malicious but trusted device could build it. */
function forgeSignedWrap(
  sender: DeviceIdentity,
  recipient: DeviceIdentity,
  ring: Keyring,
  keys: { generation: number; epoch: number; key: Uint8Array }[],
): Uint8Array {
  const payload = concat(
    utf8("cashu/keys/v3"),
    lengthPrefixed(utf8(ring.vaultId)),
    ring.recovery.boxPublicKey,
    ring.recovery.signPublicKey,
    ring.gidSalt().expose(),
    u32(keys.length),
    ...keys.flatMap((k) => [u32(k.generation), u32(k.epoch), k.key]),
  );
  const sealed = sodium.seal(payload, recipient.box.publicKey);
  const senderId = fromHex(sender.deviceId);
  const list = concat(Uint8Array.of(0, 1), fromHex(recipient.deviceId));
  const body = concat(
    lengthPrefixed(utf8(ring.vaultId)),
    senderId,
    fromHex(recipient.deviceId),
    recipient.box.publicKey,
    list,
    sealed,
  );
  return concat(
    Uint8Array.of(WRAP_VERSION),
    senderId,
    sender.sign("cashu/wrap/v3", body),
    list,
    sealed,
  );
}
