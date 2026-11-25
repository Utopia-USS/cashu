import { describe, expect, it } from "vitest";
import type { FrameCodec, FramePosition } from "../../carrier.js";
import {
  createDeviceIdentity,
  createKeyring,
  createRecoveryKey,
  type DeviceIdentity,
  FRAME_OVERHEAD,
  type Keyring,
  loadNodeSodium,
  rotateKeyring,
  verifyHeadSignature,
} from "../../crypto/index.js";
import { rejectionCode } from "../../errors.js";
import { utf8Encode } from "../../runtime.js";
import { encodePayload } from "../../segment.js";
import { createOwnLogCodec, type OwnLogCodecOptions } from "./codec.js";

const sodium = await loadNodeSodium();
const VAULT = "5ca1ab1e5ca1ab1e5ca1ab1e5ca1ab1e";
const A = "a1".repeat(16);
const B = "b2".repeat(16);
const CANARY = "SYNTHETIC-CANARY-codec-41";

function newRing() {
  return createKeyring(sodium, createRecoveryKey(sodium).publicKeys, VAULT);
}

function at(seg: number, offset: number, device = A): FramePosition {
  return { vault: VAULT, device, seg, offset };
}

const identities = new Map<string, DeviceIdentity>([
  [A, createDeviceIdentity(sodium, A)],
  [B, createDeviceIdentity(sodium, B)],
]);

/** A codec over `ring` signing as `device` (default A). */
function codecOf(ring: Keyring, device = A, extra: Partial<OwnLogCodecOptions> = {}): FrameCodec {
  return createOwnLogCodec({ sodium, ring, signer: identities.get(device), ...extra });
}

/** The genesis chain of `device`'s data stream (every frame here is a stream's first). */
const GENESIS = (device = A) => codecOf(newRing()).genesis(VAULT, device, 1);

async function seal(codec: FrameCodec, plain: Uint8Array, pos: FramePosition) {
  return (await codec.seal(plain, pos, GENESIS(pos.device))).sealed;
}

async function open(codec: FrameCodec, sealed: Uint8Array, pos: FramePosition) {
  return (await codec.open(sealed, pos, GENESIS(pos.device))).plain;
}

function payload(n: number, marker = "x"): Uint8Array {
  const events = Array.from({ length: n }, (_, i) => ({
    t: "txn.imported",
    v: 1,
    h: `0mvwcmtc0-${i.toString(36).padStart(4, "0")}-${A}`,
    i: `eid-${i}`,
    d: { merchant: `${marker}-${i % 5}`, amount: "12.50", currency: "PLN" },
  }));
  return encodePayload({ events });
}

async function codeOf(codec: FrameCodec, sealed: Uint8Array, pos: FramePosition) {
  try {
    await open(codec, sealed, pos);
    return "opened";
  } catch (e) {
    return rejectionCode(e);
  }
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe("own-log codec", () => {
  it("round-trips, compresses before sealing and never shows the plaintext", async () => {
    const ring = newRing();
    const codec = codecOf(ring);
    const plain = payload(200, CANARY);
    const sealed = await seal(codec, plain, at(1, 0));
    expect(await open(codec, sealed, at(1, 0))).toEqual(plain);
    expect(contains(sealed, utf8Encode(CANARY))).toBe(false);
    const stored = codecOf(ring, A, { compression: false });
    const big = await seal(stored, plain, at(1, 0));
    expect(sealed.length).toBeLessThan(big.length / 4);
    expect(big.length).toBeGreaterThan(plain.length + FRAME_OVERHEAD);
    // Either side reads both (the codec byte travels inside the frame).
    expect(await open(codec, big, at(1, 0))).toEqual(plain);
    expect(await open(stored, sealed, at(1, 0))).toEqual(plain);
  });

  it("binds a frame to its vault, device, segment and offset", async () => {
    const ring = newRing();
    const codec = codecOf(ring);
    const sealed = await seal(codec, payload(3), at(2, 128));
    expect(await codeOf(codec, sealed, at(2, 128))).toBe("opened");
    expect(await codeOf(codec, sealed, at(2, 129))).toBe("auth_failed");
    expect(await codeOf(codec, sealed, at(3, 128))).toBe("auth_failed");
    expect(await codeOf(codec, sealed, at(2, 128, B))).toBe("auth_failed");
    const flipped = sealed.slice();
    flipped[flipped.length - 67] = (flipped[flipped.length - 67] ?? 0) ^ 1; // the AEAD tag
    expect(await codeOf(codec, flipped, at(2, 128))).toBe("auth_failed");
    expect(await codeOf(codec, sealed.slice(0, 30), at(2, 128))).toBe("truncated");
    const other = codecOf(newRing());
    expect(await codeOf(other, sealed, at(2, 128))).toBe("unknown_key");
  });

  it("follows key rotation: one log holds frames under two generations", async () => {
    const ringA = newRing();
    const ringB = ringA.clone(sodium);
    const a = codecOf(ringA);
    const b = codecOf(ringB);
    const g1 = await seal(a, payload(2), at(1, 0));
    rotateKeyring(sodium, ringA);
    const g2 = await seal(a, payload(2), at(1, 500));
    expect(await codeOf(b, g1, at(1, 0))).toBe("opened");
    expect(await codeOf(b, g2, at(1, 500))).toBe("unknown_key");
    ringB.merge(ringA); // S29 delivers the wrap
    expect(await codeOf(b, g2, at(1, 500))).toBe("opened");
    expect(await codeOf(a, g1, at(1, 0))).toBe("opened");
  });

  it("signs as its device and chains: the head verifies under the writer's key, link() needs no key", async () => {
    const ring = newRing();
    const codec = codecOf(ring);
    const first = await codec.seal(payload(2), at(1, 0), GENESIS());
    const second = await codec.seal(payload(2), at(1, first.head.offset), first.head.chain);
    const a = identities.get(A) as DeviceIdentity;
    const b = identities.get(B) as DeviceIdentity;
    expect(verifyHeadSignature(VAULT, second.head, a.signPublicKey)).toBe(true);
    expect(verifyHeadSignature(VAULT, second.head, b.signPublicKey)).toBe(false);
    expect(codec.link(second.sealed, at(1, first.head.offset), first.head.chain)).toEqual(
      second.head.chain,
    );
    const opened = await codecOf(ring, B).open(
      second.sealed,
      at(1, first.head.offset),
      first.head.chain,
    );
    expect(opened.head.chain).toEqual(second.head.chain);
    // Opened after another previous frame (reorder, splice, rewrite): the signature no longer fits.
    const spliced = await codec.open(second.sealed, at(1, first.head.offset), GENESIS());
    expect(verifyHeadSignature(VAULT, spliced.head, a.signPublicKey)).toBe(false);
    // A device seals only its own frames; a read-only codec opens but never seals.
    expect(() => codec.seal(payload(1), at(1, 0, B), GENESIS(B))).toThrow(RangeError);
    const readOnly = createOwnLogCodec({ sodium, ring });
    expect(await codeOf(readOnly, first.sealed, at(1, 0))).toBe("opened");
    expect(() => readOnly.seal(payload(1), at(1, 0), GENESIS())).toThrow(/read only/);
  });
});
