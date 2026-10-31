// Segment frame encryption (XChaCha20-Poly1305, random 24-byte nonce).
//
//   frame = version (1 byte) | key id (16 bytes) | nonce (24 bytes) | ciphertext + tag (16 bytes)
//   AAD   = "cashu/frame/v1" | version | key id | len|vault id | len|device id | u32 segment | u64 offset
//
// The AAD binds a frame to its vault (profile), writer device and position, so a frame copied into
// another vault, another device's log or another position fails authentication: no splice, reorder
// or replay. Length framing (the u32 before each frame in a segment file) and compression belong to
// the carrier (S28b); this module sees one frame at a time.

import { concat, fromHex, lengthPrefixed, toHex, u32, u64, utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { assertDeviceId } from "./identity.js";
import { assertVaultId, type Keyring, KID_BYTES } from "./keys.js";
import { NONCE_BYTES, type Sodium, TAG_BYTES } from "./sodium.js";

export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 1 + KID_BYTES + NONCE_BYTES;
export const FRAME_OVERHEAD = FRAME_HEADER_BYTES + TAG_BYTES;
const AAD_CONTEXT = utf8("cashu/frame/v1");

export interface FrameContext {
  vaultId: string;
  /** The writer device's id: 32 lowercase hex characters (`createDeviceId`). */
  deviceId: string;
  segment: number;
  /** Byte offset of the frame inside its segment file. */
  offset: number;
}

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
  const active = ring.active;
  const kid = fromHex(active.kid);
  const cipher = sodium.aeadEncrypt(plain, frameAad(kid, ctx), nonce, active.frameKey.expose());
  return concat(Uint8Array.of(FRAME_VERSION), kid, nonce, cipher);
}

/** The key id a frame was sealed with, without decrypting it (to look up a missing key). */
export function frameKeyId(frame: Uint8Array): string {
  if (frame.length < FRAME_OVERHEAD) throw new CryptoError("truncated");
  if (frame[0] !== FRAME_VERSION) throw new CryptoError("unsupported_version");
  return toHex(frame.subarray(1, 1 + KID_BYTES));
}

/**
 * Decrypts and authenticates one frame. Throws `CryptoError` with code `truncated`,
 * `unsupported_version`, `unknown_key` or `auth_failed`; never returns unauthenticated bytes.
 */
export function openFrame(
  sodium: Sodium,
  ring: Keyring,
  frame: Uint8Array,
  ctx: FrameContext,
): Uint8Array {
  const kidHex = frameKeyId(frame);
  if (ctx.vaultId !== ring.vaultId) throw new CryptoError("vault_mismatch");
  const entry = ring.get(kidHex);
  if (!entry) throw new CryptoError("unknown_key");
  const kid = frame.subarray(1, 1 + KID_BYTES);
  const nonce = frame.subarray(1 + KID_BYTES, FRAME_HEADER_BYTES);
  const cipher = frame.subarray(FRAME_HEADER_BYTES);
  return sodium.aeadDecrypt(cipher, frameAad(kid, ctx), nonce, entry.frameKey.expose());
}
