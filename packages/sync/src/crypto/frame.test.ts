import { describe, expect, it } from "vitest";
import { fromUtf8 } from "./encoding.js";
import { FRAME_OVERHEAD, frameKeyId, openFrame, sealFrame } from "./frame.js";
import { createVaultId, Keyring, rotateKeyring } from "./keys.js";
import {
  code,
  ctx,
  DEVICE_B,
  GID_SALT,
  newRing,
  PLAINTEXT_MARKER,
  samplePlain,
  sodium,
  testRecovery,
} from "./testkit.js";

describe("frame roundtrip", () => {
  it("opens what it sealed, ciphertext hides the plaintext, nonces differ", () => {
    const ring = newRing();
    const c = ctx(ring.vaultId);
    const a = sealFrame(sodium, ring, samplePlain(), c);
    const b = sealFrame(sodium, ring, samplePlain(), c);
    expect(a.length).toBe(samplePlain().length + FRAME_OVERHEAD);
    expect(a).not.toEqual(b);
    expect(Buffer.from(a).includes(PLAINTEXT_MARKER)).toBe(false);
    expect(fromUtf8(openFrame(sodium, ring, a, c))).toContain(PLAINTEXT_MARKER);
  });

  it("empty plaintext is a valid frame", () => {
    const ring = newRing();
    const frame = sealFrame(sodium, ring, new Uint8Array(0), ctx(ring.vaultId));
    expect(openFrame(sodium, ring, frame, ctx(ring.vaultId))).toEqual(new Uint8Array(0));
  });
});

describe("tamper", () => {
  const ring = newRing();
  const c = ctx(ring.vaultId);
  const frame = sealFrame(sodium, ring, samplePlain(), c);

  it("every single-bit flip is rejected", () => {
    const seen = new Set<string>();
    for (let i = 0; i < frame.length; i++) {
      for (let bit = 0; bit < 8; bit++) {
        const t = frame.slice();
        t[i] = (t[i] ?? 0) ^ (1 << bit);
        seen.add(code(() => openFrame(sodium, ring, t, c)));
      }
    }
    // version byte -> unsupported_version, key id -> unknown_key, nonce / ciphertext / tag -> auth_failed
    expect([...seen].sort()).toEqual(["auth_failed", "unknown_key", "unsupported_version"]);
  });

  it("every truncation and an appended byte are rejected", () => {
    for (let n = 0; n < frame.length; n++) {
      expect(["truncated", "auth_failed"]).toContain(
        code(() => openFrame(sodium, ring, frame.subarray(0, n), c)),
      );
    }
    const longer = new Uint8Array(frame.length + 1);
    longer.set(frame);
    expect(code(() => openFrame(sodium, ring, longer, c))).toBe("auth_failed");
  });

  it("a key id cannot be claimed for another key: kids are always computed", () => {
    const vault = { vaultId: ring.vaultId, recovery: ring.recovery, gidSalt: GID_SALT };
    const other = Keyring.fromKeys(sodium, vault, [
      { generation: 1, epoch: 0, key: sodium.randomBytes(32) },
    ]);
    expect(other.active.kid).not.toBe(ring.active.kid);
    expect(code(() => openFrame(sodium, other, frame, c))).toBe("unknown_key");
  });

  it("a ring without the frame's key reports unknown_key", () => {
    const other = newRing(sodium, ring.vaultId);
    expect(code(() => openFrame(sodium, other, frame, c))).toBe("unknown_key");
  });

  it("another vault never matches: the kid binds the vault, the AAD binds it again", () => {
    const otherVault = createVaultId(sodium);
    const sameKeysOtherVault = Keyring.fromKeys(
      sodium,
      { vaultId: otherVault, recovery: testRecovery.publicKeys, gidSalt: GID_SALT },
      ring.entries().map((e) => ({ generation: 1, epoch: 0, key: e.key.expose().slice() })),
    );
    expect(sameKeysOtherVault.active.kid).not.toBe(ring.active.kid);
    expect(code(() => openFrame(sodium, sameKeysOtherVault, frame, ctx(otherVault)))).toBe(
      "unknown_key",
    );
    // A context naming a vault the ring does not belong to is refused before decrypting.
    expect(code(() => openFrame(sodium, ring, frame, ctx(otherVault)))).toBe("vault_mismatch");
  });

  it("wrong device, segment or offset (splice, reorder, replay) fails", () => {
    for (const over of [{ deviceId: DEVICE_B }, { segment: 4 }, { offset: 4097 }, { offset: 0 }]) {
      expect(code(() => openFrame(sodium, ring, frame, { ...c, ...over }))).toBe("auth_failed");
    }
  });
});

describe("rotation", () => {
  it("new frames use the new key; old frames still open; a device without the new key cannot read new frames", () => {
    const ring = newRing();
    const c = ctx(ring.vaultId);
    const stale = ring.clone(sodium);
    const before = sealFrame(sodium, ring, samplePlain(), c);
    const gen2 = rotateKeyring(sodium, ring);
    expect(gen2.generation).toBe(2);
    expect(ring.active.kid).toBe(gen2.kid);
    const after = sealFrame(sodium, ring, samplePlain(), c);
    expect(frameKeyId(after)).toBe(gen2.kid);
    expect(frameKeyId(before)).not.toBe(gen2.kid);
    expect(openFrame(sodium, ring, before, c)).toEqual(samplePlain());
    expect(openFrame(sodium, ring, after, c)).toEqual(samplePlain());
    expect(code(() => openFrame(sodium, stale, after, c))).toBe("unknown_key");
  });

  it("concurrent rotations on two devices converge on the same active key", () => {
    const a = newRing();
    const b = a.clone(sodium);
    rotateKeyring(sodium, a);
    rotateKeyring(sodium, b);
    a.merge(b.clone(sodium));
    b.merge(a.clone(sodium));
    expect(a.size).toBe(3);
    expect(a.active.kid).toBe(b.active.kid);
  });

  it("merging another vault's ring is refused", () => {
    expect(code(() => newRing().merge(newRing()))).toBe("vault_mismatch");
  });
});
