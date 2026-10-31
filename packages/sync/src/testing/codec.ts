// A deterministic, position-bound, NOT secure frame codec for tests. It has the properties the
// contract checks of the real codec (S27 via S28b): any changed byte, a wrong secret or a frame moved
// to another position fails to open, and the sealed bytes do not contain the plaintext. It is not
// encryption: never use it outside tests.
import type { FrameCodec, FramePosition } from "../carrier.js";
import { FrameRejectedError } from "../errors.js";
import { utf8Encode } from "../runtime.js";

const MAGIC = [0x54, 0x43, 0x30, 0x31]; // "TC01"
const HEADER = MAGIC.length + 4;

function fnv1a(seed: number, bytes: Uint8Array): number {
  let h = seed >>> 0;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function positionSeed(secret: string, at: FramePosition): number {
  const aad = utf8Encode(`${secret}|${at.vault}|${at.device}|${at.seg}|${at.offset}`);
  return fnv1a(0x811c9dc5, aad);
}

/** Position-dependent keystream (xorshift32), so equal plaintexts at different positions differ. */
function xorStream(seed: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let x = seed || 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = (bytes[i] ?? 0) ^ (x & 0xff);
  }
  return out;
}

export function insecureTestCodec(secret = "contract-test-secret"): FrameCodec {
  return {
    seal(plain, at) {
      const seed = positionSeed(secret, at);
      const out = new Uint8Array(HEADER + plain.length);
      out.set(MAGIC, 0);
      new DataView(out.buffer).setUint32(MAGIC.length, fnv1a(seed, plain), false);
      out.set(xorStream(seed, plain), HEADER);
      return out;
    },
    open(sealed, at) {
      if (sealed.length < HEADER || MAGIC.some((b, i) => sealed[i] !== b)) {
        throw new FrameRejectedError("bad-header");
      }
      const seed = positionSeed(secret, at);
      const plain = xorStream(seed, sealed.subarray(HEADER));
      const sum = new DataView(sealed.buffer, sealed.byteOffset, sealed.byteLength).getUint32(
        MAGIC.length,
        false,
      );
      if (fnv1a(seed, plain) !== sum) throw new FrameRejectedError("tampered");
      return plain;
    },
  };
}
