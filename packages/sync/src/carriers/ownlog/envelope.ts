// The own-log frame envelope: what the carrier puts inside an S27 frame (and so inside the AEAD).
//
//   envelope = 0x00 | body                                  stored (compression did not pay off)
//            | 0x01 | u32 BE body length | DEFLATE(body)    raw DEFLATE (RFC 1951), fflate
//
// S27 frame version 2 means "Padme padding, no codec"; the codec byte lives here, inside the
// authenticated plaintext, so it is as tamper-proof as the AAD would make it and a frame never opens
// under two interpretations. `body` is the engine's frame payload (segment.ts, `{"f":1,...}`).
//
// Compression happens before encryption and the S27 frame pads with Padme, which bounds the
// compressibility leak (crypto README m9). The declared length is capped and inflation stops as soon
// as the output would pass it, so a key holder (a revoked device, say) cannot ship a zip bomb.
import { deflateSync, Inflate } from "fflate";
import { FrameRejectedError } from "../../errors.js";

export const ENVELOPE_STORED = 0x00;
export const ENVELOPE_DEFLATE = 0x01;
/** Largest body an envelope may declare: the S27 per-frame plaintext limit. */
export const MAX_ENVELOPE_BODY = 64 * 1024 * 1024;
const DEFLATE_HEADER = 5;
/** Compressed input per inflate step: bounds the transient output of one step (DEFLATE max ratio ~1032). */
const INFLATE_STEP = 32 * 1024;
/** Bodies shorter than this are stored: DEFLATE cannot win much and costs a header. */
const MIN_COMPRESS = 64;

export type CompressionLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface EnvelopeOptions {
  /** DEFLATE level, or `false` to always store (default 6). */
  readonly compression?: CompressionLevel | false;
}

export function encodeEnvelope(body: Uint8Array, options: EnvelopeOptions = {}): Uint8Array {
  if (body.length > MAX_ENVELOPE_BODY) throw new RangeError("frame body over the envelope limit");
  const level = options.compression ?? 6;
  if (level !== false && body.length >= MIN_COMPRESS) {
    const packed = deflateSync(body, { level });
    if (packed.length + DEFLATE_HEADER < body.length + 1) {
      const out = new Uint8Array(DEFLATE_HEADER + packed.length);
      out[0] = ENVELOPE_DEFLATE;
      new DataView(out.buffer).setUint32(1, body.length, false);
      out.set(packed, DEFLATE_HEADER);
      return out;
    }
  }
  const out = new Uint8Array(1 + body.length);
  out[0] = ENVELOPE_STORED;
  out.set(body, 1);
  return out;
}

/**
 * Inverse of `encodeEnvelope`. Throws `FrameRejectedError`: `frame-format` for an unknown codec byte
 * (a newer writer: the engine flags needsUpgrade), `malformed` for a bad length or DEFLATE stream,
 * `too-large` when the body would pass `maxBody`.
 */
export function decodeEnvelope(envelope: Uint8Array, maxBody = MAX_ENVELOPE_BODY): Uint8Array {
  const codec = envelope[0];
  if (codec === ENVELOPE_STORED) {
    if (envelope.length - 1 > maxBody) throw new FrameRejectedError("too-large");
    return envelope.subarray(1);
  }
  if (codec !== ENVELOPE_DEFLATE) {
    throw new FrameRejectedError(codec === undefined ? "malformed" : "frame-format");
  }
  if (envelope.length <= DEFLATE_HEADER) throw new FrameRejectedError("malformed");
  const declared = new DataView(
    envelope.buffer,
    envelope.byteOffset,
    envelope.byteLength,
  ).getUint32(1, false);
  if (declared > maxBody || declared > MAX_ENVELOPE_BODY) throw new FrameRejectedError("too-large");
  return inflateExactly(envelope.subarray(DEFLATE_HEADER), declared);
}

function inflateExactly(packed: Uint8Array, declared: number): Uint8Array {
  const out = new Uint8Array(declared);
  let filled = 0;
  let overflow = false;
  const inflater = new Inflate((chunk) => {
    if (overflow) return;
    if (filled + chunk.length > declared) {
      overflow = true;
      return;
    }
    out.set(chunk, filled);
    filled += chunk.length;
  });
  try {
    for (let p = 0; p < packed.length; p += INFLATE_STEP) {
      const end = Math.min(p + INFLATE_STEP, packed.length);
      inflater.push(packed.subarray(p, end), end === packed.length);
      if (overflow) break;
    }
  } catch {
    throw new FrameRejectedError("malformed");
  }
  if (overflow) throw new FrameRejectedError("too-large");
  if (filled !== declared) throw new FrameRejectedError("malformed");
  return out;
}
