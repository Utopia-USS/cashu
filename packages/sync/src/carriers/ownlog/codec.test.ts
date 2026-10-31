import { describe, expect, it } from "vitest";
import type { FrameCodec, FramePosition } from "../../carrier.js";
import {
  createKeyring,
  createRecoveryKey,
  FRAME_OVERHEAD,
  loadNodeSodium,
  rotateKeyring,
} from "../../crypto/index.js";
import { rejectionCode } from "../../errors.js";
import { utf8Encode } from "../../runtime.js";
import { encodePayload } from "../../segment.js";
import { createOwnLogCodec } from "./codec.js";
import { WriterKeyFloor } from "./floor.js";

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
    await codec.open(sealed, pos);
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
    const codec = createOwnLogCodec({ sodium, ring });
    const plain = payload(200, CANARY);
    const sealed = await codec.seal(plain, at(1, 0));
    expect(await codec.open(sealed, at(1, 0))).toEqual(plain);
    expect(contains(sealed, utf8Encode(CANARY))).toBe(false);
    const stored = createOwnLogCodec({ sodium, ring, compression: false });
    const big = await stored.seal(plain, at(1, 0));
    expect(sealed.length).toBeLessThan(big.length / 4);
    expect(big.length).toBeGreaterThan(plain.length + FRAME_OVERHEAD);
    // Either side reads both (the codec byte travels inside the frame).
    expect(await codec.open(big, at(1, 0))).toEqual(plain);
    expect(await stored.open(sealed, at(1, 0))).toEqual(plain);
  });

  it("binds a frame to its vault, device, segment and offset", async () => {
    const ring = newRing();
    const codec = createOwnLogCodec({ sodium, ring });
    const sealed = await codec.seal(payload(3), at(2, 128));
    expect(await codeOf(codec, sealed, at(2, 128))).toBe("opened");
    expect(await codeOf(codec, sealed, at(2, 129))).toBe("auth_failed");
    expect(await codeOf(codec, sealed, at(3, 128))).toBe("auth_failed");
    expect(await codeOf(codec, sealed, at(2, 128, B))).toBe("auth_failed");
    const flipped = sealed.slice();
    flipped[flipped.length - 3] = (flipped[flipped.length - 3] ?? 0) ^ 1;
    expect(await codeOf(codec, flipped, at(2, 128))).toBe("auth_failed");
    expect(await codeOf(codec, sealed.slice(0, 30), at(2, 128))).toBe("truncated");
    const other = createOwnLogCodec({ sodium, ring: newRing() });
    expect(await codeOf(other, sealed, at(2, 128))).toBe("unknown_key");
  });

  it("follows key rotation: one log holds frames under two generations", async () => {
    const ringA = newRing();
    const ringB = ringA.clone(sodium);
    const a = createOwnLogCodec({ sodium, ring: ringA });
    const b = createOwnLogCodec({ sodium, ring: ringB });
    const g1 = await a.seal(payload(2), at(1, 0));
    rotateKeyring(sodium, ringA);
    const g2 = await a.seal(payload(2), at(1, 500));
    expect(await codeOf(b, g1, at(1, 0))).toBe("opened");
    expect(await codeOf(b, g2, at(1, 500))).toBe("unknown_key");
    ringB.merge(ringA); // S29 delivers the wrap
    expect(await codeOf(b, g2, at(1, 500))).toBe("opened");
    expect(await codeOf(a, g1, at(1, 0))).toBe("opened");
  });

  it("generation floor: refuses old-key frames after a writer's first frame at the floor", async () => {
    const ring = newRing();
    const writer = createOwnLogCodec({ sodium, ring: ring.clone(sodium) });
    const floor = new WriterKeyFloor();
    const reader = createOwnLogCodec({ sodium, ring, floor });
    const oldA1 = await writer.seal(payload(1), at(1, 0));
    const oldA3 = await writer.seal(payload(1), at(1, 300)); // a revoked device forging A's id
    const oldB = await writer.seal(payload(1), at(1, 0, B));
    rotateKeyring(sodium, ring, { epoch: 1 }); // the revocation key, generation 2
    const newA = createOwnLogCodec({ sodium, ring });
    const newA2 = await newA.seal(payload(1), at(1, 100));
    floor.raise(2);
    expect(await codeOf(reader, oldA1, at(1, 0))).toBe("opened");
    expect(await codeOf(reader, newA2, at(1, 100))).toBe("opened");
    expect(await codeOf(reader, oldA3, at(1, 300))).toBe("key_not_allowed");
    // History before the mark stays readable (a new device replays it).
    expect(await codeOf(reader, oldA1, at(1, 0))).toBe("opened");
    // B has not written at the new generation yet: the window only signatures close (S28d).
    expect(await codeOf(reader, oldB, at(1, 0, B))).toBe("opened");
    const restored = new WriterKeyFloor(floor.state());
    const again = createOwnLogCodec({ sodium, ring, floor: restored });
    expect(await codeOf(again, oldA3, at(1, 300))).toBe("key_not_allowed");
    expect(JSON.stringify(floor.state())).toBe(
      JSON.stringify({ generation: 2, marks: { [`${VAULT}/${A}`]: { seg: 1, offset: 100 } } }),
    );
    expect(() => floor.raise(0)).toThrow(RangeError);
  });

  it("passes an extra S27 policy per frame (S29 hook)", async () => {
    const ring = newRing();
    const codec = createOwnLogCodec({
      sodium,
      ring,
      policy: (pos) => (pos.device === B ? { minGeneration: 2 } : undefined),
    });
    const fromA = await codec.seal(payload(1), at(1, 0));
    const fromB = await codec.seal(payload(1), at(1, 0, B));
    expect(await codeOf(codec, fromA, at(1, 0))).toBe("opened");
    expect(await codeOf(codec, fromB, at(1, 0, B))).toBe("key_not_allowed");
  });
});
