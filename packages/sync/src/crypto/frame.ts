// Segment frame encryption (XChaCha20-Poly1305, random 24-byte nonce, the key's frame subkey).
//
//   frame  = version 0x02 | key id (16 bytes) | nonce (24 bytes) | ciphertext + tag (16 bytes)
//   AAD    = "cashu/frame/v2" | version | key id | lp(vault id) | lp(device id) | u32 segment | u64 offset
//   plain' = u32 length | data | zero bytes up to Padme(length + 4)   (inside the AEAD)
//
// Version 2 means "Padme v1 padding, no codec": a carrier that compresses must record the codec in
// the version / AAD and cap the decompressed size. The AAD binds a frame to its vault (profile),
// writer device and position, so a frame copied into another vault, another device's log or
// another position fails authentication: no splice, reorder or replay. Length framing (the u32
// before each frame in a segment file) belongs to the carrier (S28b); this module sees one frame.

import { concat, fromHex, lengthPrefixed, toHex, u32, u64, utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { assertDeviceId } from "./identity.js";
import { assertVaultId, type KeyEntry, type Keyring, KID_BYTES } from "./keys.js";
import { NONCE_BYTES, type Sodium, TAG_BYTES } from "./sodium.js";

export const FRAME_VERSION = 2;
export const FRAME_HEADER_BYTES = 1 + KID_BYTES + NONCE_BYTES;
/** Fixed bytes around the padded plaintext: header + tag. */
export const FRAME_OVERHEAD = FRAME_HEADER_BYTES + TAG_BYTES;
/** Largest plaintext one frame carries (64 MiB). */
export const MAX_FRAME_PLAINTEXT = 64 * 1024 * 1024;
const LENGTH_BYTES = 4;
const AAD_CONTEXT = utf8("cashu/frame/v2");

export interface FrameContext {
  vaultId: string;
  /** The writer device's id: 32 lowercase hex characters (`createDeviceId`). */
  deviceId: string;
  segment: number;
  /** Byte offset of the frame inside its segment file. */
  offset: number;
}

/**
 * Which keys the carrier accepts for this frame's writer, checked before decrypting
 * (`key_not_allowed`). Example: a per-device generation floor so a revoked device cannot keep
 * writing frames under its old key.
 */
export interface FramePolicy {
  minGeneration?: number;
  acceptKid?: (entry: KeyEntry) => boolean;
}

/**
 * Padme (Nikitin et al., PURBs, 2019): rounds a length up so that at most O(log log L) bits of it
 * leak, with at most ~12% overhead.
 */
export function padme(length: number): number {
  if (length < 2) return length;
  const e = Math.floor(Math.log2(length));
  const s = Math.floor(Math.log2(e)) + 1;
  const lastBits = e - s;
  const mask = 2 ** lastBits;
  return Math.ceil(length / mask) * mask;
}

/** Ciphertext size of a frame whose plaintext is `length` bytes. */
export function frameSize(length: number): number {
  return FRAME_OVERHEAD + padme(length + LENGTH_BYTES);
}

const MAX_FRAME_BYTES = frameSize(MAX_FRAME_PLAINTEXT);

function frameAad(kid: Uint8Array, ctx: FrameContext): Uint8Array {
  assertVaultId(ctx.vaultId);
  assertDeviceId(ctx.deviceId);
  return concat(
    AAD_CONTEXT,
    Uint8Array.of(FRAME_VERSION),
    kid,
    lengthPrefixed(utf8(ctx.vaultId)),
    lengthPrefixed(utf8(ctx.deviceId)),
    u32(ctx.segment),
    u64(ctx.offset),
  );
}

function pad(plain: Uint8Array): Uint8Array {
  const out = new Uint8Array(padme(plain.length + LENGTH_BYTES));
  out.set(u32(plain.length), 0);
  out.set(plain, LENGTH_BYTES);
  return out;
}

/** Strict: the length fits, the size is exactly Padme(length + 4) and every padding byte is zero. */
function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < LENGTH_BYTES) throw new CryptoError("bad_padding");
  const length = new DataView(padded.buffer, padded.byteOffset, LENGTH_BYTES).getUint32(0);
  if (length > padded.length - LENGTH_BYTES || padded.length !== padme(length + LENGTH_BYTES)) {
    throw new CryptoError("bad_padding");
  }
  for (let i = LENGTH_BYTES + length; i < padded.length; i++) {
    if (padded[i] !== 0) throw new CryptoError("bad_padding");
  }
  return padded.slice(LENGTH_BYTES, LENGTH_BYTES + length);
}

/** Encrypts one frame with the ring's active key. */
export function sealFrame(
  sodium: Sodium,
  ring: Keyring,
  plain: Uint8Array,
  ctx: FrameContext,
): Uint8Array {
  return sealFrameWithNonce(sodium, ring, plain, ctx, sodium.randomBytes(NONCE_BYTES));
}

/** Test seam for golden vectors; production code always goes through `sealFrame`. */
export function sealFrameWithNonce(
  sodium: Sodium,
  ring: Keyring,
  plain: Uint8Array,
  ctx: FrameContext,
  nonce: Uint8Array,
): Uint8Array {
  if (ctx.vaultId !== ring.vaultId) throw new CryptoError("vault_mismatch");
  if (nonce.length !== NONCE_BYTES) throw new RangeError("nonce must be 24 bytes");
  if (plain.length > MAX_FRAME_PLAINTEXT) throw new CryptoError("frame_too_large");
  const active = ring.active;
  const kid = fromHex(active.kid);
  const padded = pad(plain);
  try {
    const cipher = sodium.aeadEncrypt(padded, frameAad(kid, ctx), nonce, active.frameKey.expose());
    return concat(Uint8Array.of(FRAME_VERSION), kid, nonce, cipher);
  } finally {
    padded.fill(0);
  }
}

/** The key id a frame was sealed with, without decrypting it (to look up a missing key). */
export function frameKeyId(frame: Uint8Array): string {
  if (frame.length < FRAME_OVERHEAD + LENGTH_BYTES) throw new CryptoError("truncated");
  if (frame[0] !== FRAME_VERSION) throw new CryptoError("unsupported_version");
  return toHex(frame.subarray(1, 1 + KID_BYTES));
}

/**
 * Decrypts and authenticates one frame. Throws `CryptoError` with code `truncated`,
 * `unsupported_version`, `frame_too_large`, `unknown_key`, `key_not_allowed` (policy),
 * `auth_failed` or `bad_padding`; never returns unauthenticated bytes.
 */
export function openFrame(
  sodium: Sodium,
  ring: Keyring,
  frame: Uint8Array,
  ctx: FrameContext,
  policy?: FramePolicy,
): Uint8Array {
  const kidHex = frameKeyId(frame);
  if (frame.length > MAX_FRAME_BYTES) throw new CryptoError("frame_too_large");
  if (ctx.vaultId !== ring.vaultId) throw new CryptoError("vault_mismatch");
  const entry = ring.get(kidHex);
  if (!entry) throw new CryptoError("unknown_key");
  if (policy?.minGeneration !== undefined && entry.generation < policy.minGeneration) {
    throw new CryptoError("key_not_allowed");
  }
  if (policy?.acceptKid && !policy.acceptKid(entry)) throw new CryptoError("key_not_allowed");
  const kid = frame.subarray(1, 1 + KID_BYTES);
  const nonce = frame.subarray(1 + KID_BYTES, FRAME_HEADER_BYTES);
  const cipher = frame.subarray(FRAME_HEADER_BYTES);
  const padded = sodium.aeadDecrypt(cipher, frameAad(kid, ctx), nonce, entry.frameKey.expose());
  try {
    return unpad(padded);
  } finally {
    padded.fill(0);
  }
}
