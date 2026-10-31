import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { toHex, u32, utf8 } from "./encoding.js";
import { createDeviceIdentity } from "./identity.js";
import {
  createKeyring,
  decodeKeyPayload,
  encodeKeyPayload,
  Keyring,
  MAX_GENERATION,
  MAX_KEYS_PER_GENERATION,
  mergeKeyPayload,
  rotateKeyring,
} from "./keys.js";
import { createRecoveryKey, recoveryIdentity } from "./recovery.js";
import { code, GID_SALT, newRing, sodium, testRecovery } from "./testkit.js";
import {
  openPairingWrap,
  recoveryRecipient,
  sealForPairing,
  unwrapKeys,
  wrapKeys,
} from "./wrap.js";

const gid = (ring: Keyring, input: string) => {
  const salt = ring.gidSalt();
  try {
    return toHex(hmac(sha256, salt.expose(), utf8(input)));
  } finally {
    salt.wipe();
  }
};

const vaultOf = (ring: Keyring) => ({
  vaultId: ring.vaultId,
  recovery: ring.recovery,
  gidSalt: ring.gidSalt().expose(),
});

describe("key ids", () => {
  it("are computed, never supplied: the public constructor refuses callers", () => {
    const ring = newRing();
    const Ctor = Keyring as unknown as new (token: symbol, vault: unknown) => Keyring;
    expect(() => new Ctor(Symbol("x"), vaultOf(ring))).toThrow(TypeError);
  });

  it("bind generation and epoch: the same key bytes relabelled get another kid", () => {
    const key = sodium.randomBytes(32);
    const vault = {
      vaultId: newRing().vaultId,
      recovery: testRecovery.publicKeys,
      gidSalt: GID_SALT,
    };
    const a = Keyring.fromKeys(sodium, vault, [{ generation: 1, epoch: 0, key: key.slice() }]);
    const b = Keyring.fromKeys(sodium, vault, [{ generation: 1, epoch: 1, key: key.slice() }]);
    expect(a.active.kid).not.toBe(b.active.kid);
  });
});

describe("acceptance policy", () => {
  it("a generation gap rejects the whole merge, nothing is added", () => {
    const ring = newRing();
    const ahead = ring.clone(sodium);
    rotateKeyring(sodium, ahead);
    rotateKeyring(sodium, ahead);
    const onlyGen3 = encodeKeyPayload(ahead, [ahead.active.kid]);
    expect(code(() => mergeKeyPayload(sodium, onlyGen3, ring))).toBe("generation_gap");
    expect(ring.size).toBe(1);
    // In order, generation by generation, it is accepted.
    mergeKeyPayload(sodium, encodeKeyPayload(ahead), ring);
    expect(ring.active.kid).toBe(ahead.active.kid);
  });

  it("an empty ring accepts generation 1 first only", () => {
    const ring = newRing();
    rotateKeyring(sodium, ring);
    const gen2 = encodeKeyPayload(ring, [ring.active.kid]);
    expect(
      code(() =>
        Keyring.fromKeys(sodium, vaultOf(ring), [
          { generation: 2, epoch: 0, key: sodium.randomBytes(32) },
        ]),
      ),
    ).toBe("generation_gap");
    expect(decodeKeyPayload(sodium, gen2).size).toBe(1);
  });

  it("generations and epochs outside 1..2^20 are bad_payload; u32 max is rejected", () => {
    const ring = newRing();
    for (const [generation, epoch] of [
      [0, 0],
      [MAX_GENERATION + 1, 0],
      [0xffffffff, 0],
      [1, MAX_GENERATION + 1],
    ] as const) {
      expect(
        code(() =>
          Keyring.fromKeys(sodium, vaultOf(ring), [
            { generation, epoch, key: sodium.randomBytes(32) },
          ]),
        ),
      ).toBe("bad_payload");
    }
    // The same through the wire: a payload naming generation 2^32-1.
    const payload = encodeKeyPayload(ring);
    payload.set(u32(0xffffffff), payload.length - 32 - 8);
    expect(code(() => decodeKeyPayload(sodium, payload))).toBe("bad_payload");
  });

  it("a different pinned recovery key is recovery_key_mismatch", () => {
    const ring = newRing();
    const other = ring.clone(sodium);
    other.replaceRecoveryKey(createRecoveryKey(sodium).publicKeys);
    expect(code(() => ring.merge(other))).toBe("recovery_key_mismatch");
  });

  it("epoch orders keys of one generation: a revoke-rotation beats a plain rotation", () => {
    const base = newRing();
    for (let i = 0; i < 16; i++) {
      const a = base.clone(sodium);
      const b = base.clone(sodium);
      const revoke = rotateKeyring(sodium, a, { epoch: base.active.epoch + 1 });
      rotateKeyring(sodium, b);
      a.merge(b);
      b.merge(a);
      expect(a.active.kid).toBe(revoke.kid);
      expect(b.active.kid).toBe(revoke.kid);
    }
    expect(() => rotateKeyring(sodium, base, { epoch: -1 })).toThrow(RangeError);
  });
});

describe("epochs and flood limits", () => {
  it("an epoch more than one above the highest held is epoch_gap; rotation cannot jump either", () => {
    const ring = newRing();
    expect(
      code(() =>
        Keyring.fromKeys(sodium, vaultOf(ring), [
          { generation: 1, epoch: 0, key: sodium.randomBytes(32) },
          { generation: 2, epoch: 2, key: sodium.randomBytes(32) },
        ]),
      ),
    ).toBe("epoch_gap");
    expect(() => rotateKeyring(sodium, ring, { epoch: 2 })).toThrow(RangeError);
    expect(rotateKeyring(sodium, ring, { epoch: 1 }).epoch).toBe(1);
  });

  it("an empty ring takes the first key's epoch as its base", () => {
    const ring = newRing();
    const late = Keyring.fromKeys(sodium, vaultOf(ring), [
      { generation: 1, epoch: 7, key: sodium.randomBytes(32) },
      { generation: 2, epoch: 8, key: sodium.randomBytes(32) },
    ]);
    expect(late.active.epoch).toBe(8);
  });

  it("one generation holds at most MAX_KEYS_PER_GENERATION keys", () => {
    const ring = newRing();
    const keys = Array.from({ length: MAX_KEYS_PER_GENERATION + 1 }, () => ({
      generation: 1,
      epoch: 0,
      key: sodium.randomBytes(32),
    }));
    // fromKeys takes ownership of (and wipes) the bytes it is given, so each call gets copies.
    const copies = (n: number) => keys.slice(0, n).map((k) => ({ ...k, key: k.key.slice() }));
    expect(code(() => Keyring.fromKeys(sodium, vaultOf(ring), copies(keys.length)))).toBe(
      "bad_payload",
    );
    expect(Keyring.fromKeys(sodium, vaultOf(ring), copies(MAX_KEYS_PER_GENERATION)).size).toBe(
      MAX_KEYS_PER_GENERATION,
    );
  });
});

describe("gid salt (D9)", () => {
  it("a wiped ring refuses to hand out its salt", () => {
    const ring = newRing();
    ring.wipe();
    expect(code(() => ring.gidSalt())).toBe("wiped");
  });

  it("paired devices and a recovered device derive identical gids; rotation keeps the salt", () => {
    const recovery = createRecoveryKey(sodium);
    const desktop = createKeyring(sodium, recovery.publicKeys);
    const phone = createDeviceIdentity(sodium);
    const phoneRing = openPairingWrap(
      sodium,
      sealForPairing(sodium, desktop, phone.box.publicKey),
      phone,
      desktop.vaultId,
    );
    const before = gid(desktop, "synthetic-import-row-1");
    expect(gid(phoneRing, "synthetic-import-row-1")).toBe(before);

    rotateKeyring(sodium, desktop);
    expect(gid(desktop, "synthetic-import-row-1")).toBe(before);

    const restoring = recoveryIdentity(sodium, recovery.phrase);
    const { ring: recovered } = unwrapKeys(
      sodium,
      wrapKeys(sodium, desktop, phone, recoveryRecipient(desktop)),
      restoring,
      { vaultId: desktop.vaultId, recoveryPublicKey: recovery.publicKeys },
      () => phone.signPublicKey,
    );
    expect(gid(recovered, "synthetic-import-row-1")).toBe(before);
  });

  it("a payload carrying a different salt is rejected atomically", () => {
    const ring = newRing();
    const forged = Keyring.fromKeys(sodium, { ...vaultOf(ring), gidSalt: sodium.randomBytes(32) }, [
      { generation: 1, epoch: 0, key: sodium.randomBytes(32) },
    ]);
    rotateKeyring(sodium, forged);
    expect(code(() => mergeKeyPayload(sodium, encodeKeyPayload(forged), ring))).toBe(
      "gid_salt_mismatch",
    );
    expect(ring.size).toBe(1);
  });

  it("salts differ between vaults and print redacted", () => {
    const a = newRing();
    expect(gid(a, "x")).not.toBe(gid(newRing(), "x"));
    expect(String(a.gidSalt())).toBe("[redacted]");
    expect(JSON.stringify(a)).not.toContain(toHex(a.gidSalt().expose()));
  });
});
