import { describe, expect, it } from "vitest";
import { fromUtf8 } from "./encoding.js";
import {
  frameKeyId,
  frameSize,
  MAX_FRAME_PLAINTEXT,
  openFrame,
  padme,
  sealFrame,
} from "./frame.js";
import { decodeHead, encodeHead, sameHead, verifyHeadSignature } from "./head.js";
import { createVaultId, rotateKeyring } from "./keys.js";
import type { Sodium } from "./sodium.js";
import { keyringFromKeys } from "./testing.js";
import {
  backends,
  code,
  ctx,
  DEVICE_B,
  GID_SALT,
  newRing,
  PLAINTEXT_MARKER,
  samplePlain,
  testRecovery,
  writerOf,
} from "./testkit.js";

describe.each(backends)("frames (%s)", (_name, sodium: Sodium) => {
  describe("frame roundtrip", () => {
    it("opens what it sealed, ciphertext hides the plaintext, nonces differ", () => {
      const ring = newRing(sodium);
      const c = ctx(ring.vaultId);
      const a = sealFrame(sodium, ring, samplePlain(), c, writerOf(c)).bytes;
      const b = sealFrame(sodium, ring, samplePlain(), c, writerOf(c)).bytes;
      expect(a.length).toBe(frameSize(samplePlain().length));
      expect(a).not.toEqual(b);
      expect(Buffer.from(a).includes(PLAINTEXT_MARKER)).toBe(false);
      expect(fromUtf8(openFrame(sodium, ring, a, c).plain)).toContain(PLAINTEXT_MARKER);
    });

    it("empty plaintext is a valid frame", () => {
      const ring = newRing(sodium);
      const frame = sealFrame(
        sodium,
        ring,
        new Uint8Array(0),
        ctx(ring.vaultId),
        writerOf(ctx(ring.vaultId)),
      ).bytes;
      expect(openFrame(sodium, ring, frame, ctx(ring.vaultId)).plain).toEqual(new Uint8Array(0));
    });
  });

  describe("tamper", () => {
    const ring = newRing(sodium);
    const c = ctx(ring.vaultId);
    const frame = sealFrame(sodium, ring, samplePlain(), c, writerOf(c)).bytes;

    /** Opens and checks the head signature with the writer's key, as a reader does. */
    const verdict = (t: Uint8Array): string => {
      const opened = code(() => openFrame(sodium, ring, t, c));
      if (opened !== "no error") return opened;
      const { head } = openFrame(sodium, ring, t, c);
      return verifyHeadSignature(c.vaultId, head, writerOf(c).signPublicKey) ? "ok" : "bad_head";
    };

    it("every single-bit flip is rejected", () => {
      const seen = new Set<string>();
      for (let i = 0; i < frame.length; i++) {
        for (let bit = 0; bit < 8; bit++) {
          const t = frame.slice();
          t[i] = (t[i] ?? 0) ^ (1 << bit);
          seen.add(verdict(t));
        }
      }
      // version byte -> unsupported_version, key id -> unknown_key, nonce / ciphertext / tag ->
      // auth_failed, head signature -> bad_head
      expect([...seen].sort()).toEqual([
        "auth_failed",
        "bad_head",
        "unknown_key",
        "unsupported_version",
      ]);
      expect(verdict(frame)).toBe("ok");
    });

    it("every truncation and an appended byte are rejected", () => {
      for (let n = 0; n < frame.length; n++) {
        expect(["truncated", "auth_failed"]).toContain(
          code(() => openFrame(sodium, ring, frame.subarray(0, n), c).plain),
        );
      }
      const longer = new Uint8Array(frame.length + 1);
      longer.set(frame);
      expect(code(() => openFrame(sodium, ring, longer, c).plain)).toBe("auth_failed");
    });

    it("a key id cannot be claimed for another key: kids are always computed", () => {
      const vault = { vaultId: ring.vaultId, recovery: ring.recovery, gidSalt: GID_SALT };
      const other = keyringFromKeys(sodium, vault, [
        { generation: 1, epoch: 0, key: sodium.randomBytes(32) },
      ]);
      expect(other.active.kid).not.toBe(ring.active.kid);
      expect(code(() => openFrame(sodium, other, frame, c).plain)).toBe("unknown_key");
    });

    it("a ring without the frame's key reports unknown_key", () => {
      const other = newRing(sodium, ring.vaultId);
      expect(code(() => openFrame(sodium, other, frame, c).plain)).toBe("unknown_key");
    });

    it("another vault never matches: the kid binds the vault, the AAD binds it again", () => {
      const otherVault = createVaultId(sodium);
      const sameKeysOtherVault = keyringFromKeys(
        sodium,
        { vaultId: otherVault, recovery: testRecovery.publicKeys, gidSalt: GID_SALT },
        ring.entries().map((e) => ({ generation: 1, epoch: 0, key: e.key.expose().slice() })),
      );
      expect(sameKeysOtherVault.active.kid).not.toBe(ring.active.kid);
      expect(code(() => openFrame(sodium, sameKeysOtherVault, frame, ctx(otherVault)).plain)).toBe(
        "unknown_key",
      );
      // A context naming a vault the ring does not belong to is refused before decrypting.
      expect(code(() => openFrame(sodium, ring, frame, ctx(otherVault)).plain)).toBe(
        "vault_mismatch",
      );
    });

    it("wrong device, segment or offset (splice, reorder, replay) fails", () => {
      for (const over of [
        { deviceId: DEVICE_B },
        { segment: 4 },
        { offset: 4097 },
        { offset: 0 },
      ]) {
        expect(code(() => openFrame(sodium, ring, frame, { ...c, ...over }).plain)).toBe(
          "auth_failed",
        );
      }
    });
  });

  describe("rotation", () => {
    it("new frames use the new key; old frames still open; a device without the new key cannot read new frames", () => {
      const ring = newRing(sodium);
      const c = ctx(ring.vaultId);
      const stale = ring.clone(sodium);
      const before = sealFrame(sodium, ring, samplePlain(), c, writerOf(c)).bytes;
      const gen2 = rotateKeyring(sodium, ring);
      expect(gen2.generation).toBe(2);
      expect(ring.active.kid).toBe(gen2.kid);
      const after = sealFrame(sodium, ring, samplePlain(), c, writerOf(c)).bytes;
      expect(frameKeyId(after)).toBe(gen2.kid);
      expect(frameKeyId(before)).not.toBe(gen2.kid);
      expect(openFrame(sodium, ring, before, c).plain).toEqual(samplePlain());
      expect(openFrame(sodium, ring, after, c).plain).toEqual(samplePlain());
      expect(code(() => openFrame(sodium, stale, after, c).plain)).toBe("unknown_key");
    });

    it("concurrent rotations on two devices converge on the same active key", () => {
      const a = newRing(sodium);
      const b = a.clone(sodium);
      rotateKeyring(sodium, a);
      rotateKeyring(sodium, b);
      a.merge(b.clone(sodium));
      b.merge(a.clone(sodium));
      expect(a.size).toBe(3);
      expect(a.active.kid).toBe(b.active.kid);
    });

    it("merging another vault's ring is refused", () => {
      expect(code(() => newRing(sodium).merge(newRing(sodium)))).toBe("vault_mismatch");
    });
  });

  describe("padding (Padme inside the AEAD)", () => {
    it("Padme matches an exact BigInt reference around every power of two up to 2^27", () => {
      const reference = (n: number): number => {
        if (n < 2) return n;
        const big = BigInt(n);
        const e = big.toString(2).length - 1;
        const s = e.toString(2).length;
        const mask = 1n << BigInt(e - s);
        return Number(((big + mask - 1n) / mask) * mask);
      };
      for (let k = 1; k <= 27; k++) {
        for (const n of [2 ** k - 1, 2 ** k, 2 ** k + 1]) expect(padme(n)).toBe(reference(n));
      }
      // Frozen vector shared with other runtimes (Hermes must produce the same sizes).
      expect([9, 17, 33, 65, 129, 1025, 65537, 2 ** 26 + 4].map(padme)).toEqual([
        10, 18, 36, 72, 144, 1088, 67584, 69206016,
      ]);
    });

    it("sizes follow Padme(len + 4) and leak at most a few bits of the length", () => {
      expect([0, 1, 4, 9, 100, 1000, 65536].map((n) => padme(n + 4))).toEqual([
        4, 5, 8, 14, 104, 1024, 67584,
      ]);
      for (let n = 0; n < 5000; n += 7) {
        const p = padme(n + 4);
        expect(p).toBeGreaterThanOrEqual(n + 4);
        expect(p).toBeLessThanOrEqual(Math.ceil((n + 4) * 1.125) + 1);
      }
      const ring = newRing(sodium);
      const c = ctx(ring.vaultId);
      // 590 and 600 bytes of plaintext produce frames of the same size.
      const a = sealFrame(sodium, ring, new Uint8Array(590), c, writerOf(c)).bytes;
      const b = sealFrame(sodium, ring, new Uint8Array(600), c, writerOf(c)).bytes;
      expect(a.length).toBe(b.length);
      expect(openFrame(sodium, ring, b, c).plain).toEqual(new Uint8Array(600));
    });

    it("non-zero padding, a length past the end or a non-Padme size is bad_padding", () => {
      const ring = newRing(sodium);
      const c = ctx(ring.vaultId);
      const key = ring.active.frameKey.expose();
      const kid = Buffer.from(ring.active.kid, "hex");
      const nonce = sodium.randomBytes(24);
      const craft = (padded: Uint8Array) => {
        // A writer holding the key could produce any padded plaintext; emulate it with the AAD layout.
        const enc = new TextEncoder();
        const lp = (t: string) => [0, 0, 0, t.length, ...enc.encode(t)];
        const aad = new Uint8Array([
          ...enc.encode("cashu/frame/v3"),
          3,
          ...kid,
          ...lp(c.vaultId),
          ...lp(c.deviceId),
          0,
          0,
          0,
          c.segment,
          0,
          0,
          0,
          0,
          0,
          0,
          0x10,
          0x00,
        ]);
        return new Uint8Array([
          3,
          ...kid,
          ...nonce,
          ...sodium.aeadEncrypt(padded, aad, nonce, key),
          ...new Uint8Array(64), // head signature (not checked by openFrame)
        ]);
      };
      // Valid crafted frame first, to prove the crafting matches the format.
      // Padme(5 + 4) = 10: five data bytes and one padding byte.
      expect(
        openFrame(sodium, ring, craft(new Uint8Array([0, 0, 0, 5, 1, 2, 3, 4, 5, 0])), c).plain,
      ).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
      for (const bad of [
        new Uint8Array([0, 0, 0, 5, 1, 2, 3, 4, 5, 1]), // non-zero padding
        new Uint8Array([0, 0, 0, 9, 1, 2, 3, 4, 5, 0]), // length past the end
        new Uint8Array([0, 0, 0, 1, 7, 0]), // longer than Padme(1 + 4) = 5
      ]) {
        expect(code(() => openFrame(sodium, ring, craft(bad), c).plain)).toBe("bad_padding");
      }
    });

    it("plaintext above 64 MiB is refused on seal; oversized frames are refused before decrypting", () => {
      const ring = newRing(sodium);
      const c = ctx(ring.vaultId);
      expect(
        code(
          () =>
            sealFrame(sodium, ring, new Uint8Array(MAX_FRAME_PLAINTEXT + 1), c, writerOf(c)).bytes,
        ),
      ).toBe("frame_too_large");
      const huge = new Uint8Array(frameSize(MAX_FRAME_PLAINTEXT) + 1);
      huge[0] = 3;
      huge.set(Buffer.from(ring.active.kid, "hex"), 1);
      expect(code(() => openFrame(sodium, ring, huge, c).plain)).toBe("frame_too_large");
    });
  });

  describe("signed heads (v3)", () => {
    it("the head ends where the frame ends, verifies under the writer's key only, and chains", () => {
      const ring = newRing(sodium);
      const c = ctx(ring.vaultId, { segment: 1, offset: 0 });
      const first = sealFrame(sodium, ring, samplePlain(), c, writerOf(c));
      expect(first.head.offset).toBe(c.offset + 4 + first.bytes.length);
      expect(first.head.seg).toBe(1);
      expect(first.head.stream).toBe(1);
      expect(verifyHeadSignature(c.vaultId, first.head, writerOf(c).signPublicKey)).toBe(true);
      expect(verifyHeadSignature(c.vaultId, first.head, writerOf(DEVICE_B).signPublicKey)).toBe(
        false,
      );
      expect(
        verifyHeadSignature(createVaultId(sodium), first.head, writerOf(c).signPublicKey),
      ).toBe(false);
      // The next frame links to the first one's chain: opened with another `prev`, its head no
      // longer matches what the writer signed (reorder, splice or rewrite of an earlier frame).
      const c2 = { ...c, offset: first.head.offset, prev: first.head.chain };
      const second = sealFrame(sodium, ring, samplePlain(), c2, writerOf(c));
      const opened = openFrame(sodium, ring, second.bytes, c2);
      expect(sameHead(opened.head, second.head)).toBe(true);
      expect(verifyHeadSignature(c.vaultId, opened.head, writerOf(c).signPublicKey)).toBe(true);
      const spliced = openFrame(sodium, ring, second.bytes, { ...c2, prev: c.prev });
      expect(verifyHeadSignature(c.vaultId, spliced.head, writerOf(c).signPublicKey)).toBe(false);
      // A device signs only its own frames.
      expect(() => sealFrame(sodium, ring, samplePlain(), c, writerOf(DEVICE_B))).toThrow(
        RangeError,
      );
    });

    it("heads encode canonically and decode strictly", () => {
      const ring = newRing(sodium);
      const c = ctx(ring.vaultId);
      const { head } = sealFrame(sodium, ring, samplePlain(), c, writerOf(c));
      const hex = encodeHead(head);
      const back = decodeHead(hex);
      expect(back && sameHead(back, head)).toBe(true);
      expect(back?.sig).toEqual(head.sig);
      for (const bad of [hex.slice(2), `${hex}00`, hex.toUpperCase(), 7, null]) {
        expect(decodeHead(bad)).toBeUndefined();
      }
    });
  });
});
