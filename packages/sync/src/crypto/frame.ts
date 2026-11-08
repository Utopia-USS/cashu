// Segment frame encryption and signing (XChaCha20-Poly1305 with the key's frame subkey, then the
// writer's signed head, head.ts). Frame version 3 (S29c phase B2; v2, unsigned, is gone: nothing was
// deployed and an unsigned reader would be a downgrade target).
//
//   frame  = 0x03 | key id (16) | nonce (24) | ciphertext + tag (16) | head signature (64)
//   AAD    = "cashu/frame/v3" | 0x03 | key id | lp(vault id) | lp(device id) | u32 segment | u64 offset
//   plain' = u32 length | data | zero bytes up to Padme(length + 4)   (inside the AEAD)
//   head   = (device, stream, segment, end, chain) signed by the writer (head.ts), where
//            chain = chain(prev, digest(frame without the signature)) and end = offset + 4 + frame size
//
// The AAD binds a frame to its vault (profile), writer device and position, so a frame copied into
// another vault, another device's log or another position fails authentication. The head binds it to
// the writer's whole stream before it (`prev`) and to the writer's signing key: only the writer can
// sign it, so a key holder that is not the writer (a revoked device keeps old data keys) can no longer
// forge its frames. `openFrame` recomputes the chain and returns the head with the frame's signature;
// it does NOT know the writer's key, so the signature is checked by the caller (devices/ through its
// acceptance gate, with the registry's keys). Length framing (the u32 before each frame in a segment
// file) belongs to the carrier; this module sees one frame.

import { concat, fromHex, lengthPrefixed, toHex, u32, u64, utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import {
  CHAIN_BYTES,
  frameDigest,
  nextChain,
  type SignedHead,
  signHead,
  streamOf,
} from "./head.js";
import { assertDeviceId, type DeviceIdentity, SIGNATURE_BYTES } from "./identity.js";
import { assertVaultId, type KeyEntry, type Keyring, KID_BYTES } from "./keys.js";
import { NONCE_BYTES, type Sodium, TAG_BYTES } from "./sodium.js";

export const FRAME_VERSION = 3;
const FRAME_HEADER_BYTES = 1 + KID_BYTES + NONCE_BYTES;
/** Fixed bytes around the padded plaintext: header + tag + head signature. */
export const FRAME_OVERHEAD = FRAME_HEADER_BYTES + TAG_BYTES + SIGNATURE_BYTES;
/** Largest plaintext one frame carries (64 MiB). */
export const MAX_FRAME_PLAINTEXT = 64 * 1024 * 1024;
const LENGTH_BYTES = 4;
const AAD_CONTEXT = utf8("cashu/frame/v3");

export interface FrameContext {
  vaultId: string;
  /** The writer device's id: 32 lowercase hex characters (`createDeviceId`). */
  deviceId: string;
  segment: number;
  /** Byte offset of the frame inside its segment file (where its u32 length prefix starts). */
  offset: number;
  /** Chain of the writer's previous frame in this stream (`genesisChain` before the first one). */
  prev: Uint8Array;
}

export interface SealedFrame {
  readonly bytes: Uint8Array;
  readonly head: SignedHead;
}

export interface OpenedFrame {
  readonly plain: Uint8Array;
  readonly entry: KeyEntry;
  /** The frame's head with its signature bytes: NOT verified here (the caller holds the keys). */
  readonly head: SignedHead;
}

/**
 * Padme (Nikitin et al., PURBs, 2019): rounds a length up so that at most O(log log L) bits of it
 * leak, with at most ~12% overhead.
 */
export function padme(length: number): number {
  if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) {
    throw new RangeError("padme length out of range");
  }
  if (length < 2) return length;
  // Integer bit lengths only (no Math.log2), so every JS engine computes the same sizes.
  const e = bitLength(length) - 1; // floor(log2 length)
  const s = bitLength(e); // floor(log2 e) + 1
  const mask = 2 ** (e - s);
  return Math.ceil(length / mask) * mask;
}

function bitLength(n: number): number {
  return 32 - Math.clz32(n);
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

function headOf(ctx: FrameContext, withoutSignature: Uint8Array) {
  if (ctx.prev.length !== CHAIN_BYTES) throw new RangeError("prev chain must be 32 bytes");
  const stream = streamOf(ctx.segment);
  const end = ctx.offset + LENGTH_BYTES + withoutSignature.length + SIGNATURE_BYTES;
  const chain = nextChain(
    { vaultId: ctx.vaultId, deviceId: ctx.deviceId, stream },
    { seg: ctx.segment, start: ctx.offset, end },
    ctx.prev,
    frameDigest(withoutSignature),
  );
  return { device: ctx.deviceId, stream, seg: ctx.segment, offset: end, chain };
}

/** The chain after a frame from its bytes alone (no key needed): rebuilds the chains of a stored log. */
export function frameChain(frame: Uint8Array, ctx: FrameContext): Uint8Array {
  if (frame.length < SIGNATURE_BYTES) throw new CryptoError("truncated");
  return headOf(ctx, frame.subarray(0, frame.length - SIGNATURE_BYTES)).chain;
}

/** Encrypts one frame with the ring's active key and signs its head as `signer` (the writer). */
export function sealFrame(
  sodium: Sodium,
  ring: Keyring,
  plain: Uint8Array,
  ctx: FrameContext,
  signer: DeviceIdentity,
): SealedFrame {
  return sealFrameWithNonce(sodium, ring, plain, ctx, signer, sodium.randomBytes(NONCE_BYTES));
}

/** Test seam for golden vectors; production code always goes through `sealFrame`. */
export function sealFrameWithNonce(
  sodium: Sodium,
  ring: Keyring,
  plain: Uint8Array,
  ctx: FrameContext,
  signer: DeviceIdentity,
  nonce: Uint8Array,
): SealedFrame {
  if (ctx.vaultId !== ring.vaultId) throw new CryptoError("vault_mismatch");
  if (signer.deviceId !== ctx.deviceId) throw new RangeError("a device signs only its own frames");
  if (nonce.length !== NONCE_BYTES) throw new RangeError("nonce must be 24 bytes");
  if (plain.length > MAX_FRAME_PLAINTEXT) throw new CryptoError("frame_too_large");
  const active = ring.active;
  const kid = fromHex(active.kid);
  const padded = pad(plain);
  let body: Uint8Array;
  try {
    const cipher = sodium.aeadEncrypt(padded, frameAad(kid, ctx), nonce, active.frameKey.expose());
    body = concat(Uint8Array.of(FRAME_VERSION), kid, nonce, cipher);
  } finally {
    padded.fill(0);
  }
  const head = signHead(signer, ctx.vaultId, headOf(ctx, body));
  return { bytes: concat(body, head.sig), head };
}

/** The key id a frame was sealed with, without decrypting it (to look up a missing key). */
export function frameKeyId(frame: Uint8Array): string {
  if (frame.length < FRAME_OVERHEAD + LENGTH_BYTES) throw new CryptoError("truncated");
  if (frame[0] !== FRAME_VERSION) throw new CryptoError("unsupported_version");
  return toHex(frame.subarray(1, 1 + KID_BYTES));
}

/**
 * Decrypts and authenticates one frame and recomputes its head from `ctx.prev`. Throws
 * `CryptoError` with code `truncated`, `unsupported_version`, `frame_too_large`, `unknown_key`,
 * `auth_failed` or `bad_padding`; never returns unauthenticated bytes. The returned head's
 * signature is the frame's, unverified: the caller verifies it with the writer's keys.
 */
export function openFrame(
  sodium: Sodium,
  ring: Keyring,
  frame: Uint8Array,
  ctx: FrameContext,
): OpenedFrame {
  const kidHex = frameKeyId(frame);
  if (frame.length > MAX_FRAME_BYTES) throw new CryptoError("frame_too_large");
  if (ctx.vaultId !== ring.vaultId) throw new CryptoError("vault_mismatch");
  const entry = ring.get(kidHex);
  if (!entry) throw new CryptoError("unknown_key");
  const body = frame.subarray(0, frame.length - SIGNATURE_BYTES);
  const kid = frame.subarray(1, 1 + KID_BYTES);
  const nonce = frame.subarray(1 + KID_BYTES, FRAME_HEADER_BYTES);
  const cipher = body.subarray(FRAME_HEADER_BYTES);
  const padded = sodium.aeadDecrypt(cipher, frameAad(kid, ctx), nonce, entry.frameKey.expose());
  let plain: Uint8Array;
  try {
    plain = unpad(padded);
  } finally {
    padded.fill(0);
  }
  const head = { ...headOf(ctx, body), sig: frame.slice(frame.length - SIGNATURE_BYTES) };
  return { plain, entry, head };
}
