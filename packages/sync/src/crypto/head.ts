// Signed heads over a per-device hash chain (S29c phase B2). Every frame a device writes ends with
// its SIGNED HEAD: an Ed25519 statement of the writer about its whole stream up to the end of that
// frame. A reader recomputes the chain from the frames it holds, so a reordered, spliced, rewritten
// or (with a later head in hand) truncated stream no longer matches what the writer signed.
//
//   digest(f)  = BLAKE2b-256("cashu/frame-digest/v1" | frame bytes without the trailing signature)
//   chain(0)   = BLAKE2b-256("cashu/chain/v1/genesis" | lp(vault id) | lp(device id) | u8 stream)
//   chain(f)   = BLAKE2b-256("cashu/chain/v1" | lp(vault id) | lp(device id) | u8 stream | u32 seg
//                            | u64 start | u64 end | chain(previous frame) | digest(f))
//   head body  = lp(vault id) | lp(device id) | u8 stream | u32 seg | u64 end | chain(f)
//   head sig   = Ed25519 over "cashu/head/v1" | head body     (identity.ts SigningContext)
//
// - `stream` 0 is the carrier's manifest (segment 0), 1 the data segments (>= 1). Each stream has one
//   chain; the data chain runs across segment boundaries (frame (N, 0) links to the last frame of
//   N - 1), so a reader holding (N, 0) knows N - 1's final chain.
// - `start` is the frame's offset (the AAD offset, where its u32 length prefix starts) and `end` the
//   cursor after it (`start + 4 + sealed length`): the stream positions of devices/positions.ts.
// - Encrypt-then-sign: the signature covers the ciphertext, so it reveals nothing about the plaintext
//   and binds the exact bytes in storage.
// - The chain and digest strings are hash domains, not signing contexts. Verification lives in
//   `verifyHeadSignature`; devices/ calls it only through its acceptance gate (acceptance.ts).

import { blake2b } from "@noble/hashes/blake2.js";
import { concat, fromHex, lengthPrefixed, toHex, u32, u64, utf8 } from "./encoding.js";
import {
  assertDeviceId,
  DEVICE_ID_BYTES,
  type DeviceIdentity,
  SIGNATURE_BYTES,
  verifyContextSignature,
} from "./identity.js";
import { assertVaultId } from "./keys.js";

export const CHAIN_BYTES = 32;
const HEAD_CONTEXT = "cashu/head/v1";
/** Encoded head: device id (16) | u8 stream | u32 seg | u64 offset | chain (32) | signature (64). */
export const HEAD_BYTES = DEVICE_ID_BYTES + 1 + 4 + 8 + CHAIN_BYTES + SIGNATURE_BYTES;

/** 0 = the carrier's manifest stream (segment 0), 1 = the data segments. */
export type StreamKind = 0 | 1;

export interface ChainContext {
  readonly vaultId: string;
  readonly deviceId: string;
  readonly stream: StreamKind;
}

/** The writer's statement about its stream up to `seg:offset` (the end of a frame). */
export interface UnsignedHead {
  readonly device: string;
  readonly stream: StreamKind;
  readonly seg: number;
  readonly offset: number;
  readonly chain: Uint8Array;
}

export interface SignedHead extends UnsignedHead {
  readonly sig: Uint8Array;
}

const DIGEST = utf8("cashu/frame-digest/v1");
const GENESIS = utf8("cashu/chain/v1/genesis");
const LINK = utf8("cashu/chain/v1");

function hash(message: Uint8Array): Uint8Array {
  return blake2b(message, { dkLen: CHAIN_BYTES });
}

function prefix(ctx: ChainContext): Uint8Array {
  assertVaultId(ctx.vaultId);
  assertDeviceId(ctx.deviceId);
  return concat(
    lengthPrefixed(utf8(ctx.vaultId)),
    lengthPrefixed(utf8(ctx.deviceId)),
    Uint8Array.of(ctx.stream),
  );
}

/** The stream kind of a segment: 0 for the manifest (segment 0), 1 for data. */
export function streamOf(segment: number): StreamKind {
  return segment === 0 ? 0 : 1;
}

/** The chain before the first frame of a device's stream. */
export function genesisChain(ctx: ChainContext): Uint8Array {
  return hash(concat(GENESIS, prefix(ctx)));
}

export function frameDigest(frameWithoutSignature: Uint8Array): Uint8Array {
  return hash(concat(DIGEST, frameWithoutSignature));
}

export function nextChain(
  ctx: ChainContext,
  at: { readonly seg: number; readonly start: number; readonly end: number },
  prev: Uint8Array,
  digest: Uint8Array,
): Uint8Array {
  if (prev.length !== CHAIN_BYTES || digest.length !== CHAIN_BYTES) {
    throw new RangeError("chain and digest must be 32 bytes");
  }
  return hash(concat(LINK, prefix(ctx), u32(at.seg), u64(at.start), u64(at.end), prev, digest));
}

/** The signed bytes of a head (without the context, which `sign` / verification prepend). */
export function headBody(vaultId: string, head: UnsignedHead): Uint8Array {
  if (head.chain.length !== CHAIN_BYTES) throw new RangeError("chain must be 32 bytes");
  return concat(
    prefix({ vaultId, deviceId: head.device, stream: head.stream }),
    u32(head.seg),
    u64(head.offset),
    head.chain,
  );
}

/** Signs a head of `signer`'s own stream (never another device's). */
export function signHead(signer: DeviceIdentity, vaultId: string, head: UnsignedHead): SignedHead {
  if (head.device !== signer.deviceId) throw new RangeError("a device signs only its own heads");
  return {
    ...head,
    chain: head.chain.slice(),
    sig: signer.sign(HEAD_CONTEXT, headBody(vaultId, head)),
  };
}

/**
 * Strict Ed25519 check of a head under `publicKey` (never throws for bad input). devices/ calls it
 * only through the acceptance gate, with keys from a named source.
 */
export function verifyHeadSignature(
  vaultId: string,
  head: SignedHead,
  publicKey: Uint8Array,
): boolean {
  let body: Uint8Array;
  try {
    body = headBody(vaultId, head);
  } catch {
    return false;
  }
  return verifyContextSignature(HEAD_CONTEXT, body, head.sig, publicKey);
}

export function sameHead(a: UnsignedHead, b: UnsignedHead): boolean {
  return (
    a.device === b.device &&
    a.stream === b.stream &&
    a.seg === b.seg &&
    a.offset === b.offset &&
    toHex(a.chain) === toHex(b.chain)
  );
}

/** Canonical lower-case hex of a head, for JSON statements (revocation cuts). */
export function encodeHead(head: SignedHead): string {
  return toHex(
    concat(
      fromHex(head.device),
      Uint8Array.of(head.stream),
      u32(head.seg),
      u64(head.offset),
      head.chain,
      head.sig,
    ),
  );
}

/** Strict decode of `encodeHead` output: undefined for anything else. */
export function decodeHead(value: unknown): SignedHead | undefined {
  if (typeof value !== "string" || value.length !== HEAD_BYTES * 2 || !/^[0-9a-f]+$/.test(value)) {
    return undefined;
  }
  const bytes = fromHex(value);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const device = toHex(bytes.subarray(0, DEVICE_ID_BYTES));
  const stream = bytes[DEVICE_ID_BYTES];
  if (stream !== 0 && stream !== 1) return undefined;
  const seg = view.getUint32(DEVICE_ID_BYTES + 1);
  const offset = view.getBigUint64(DEVICE_ID_BYTES + 5);
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const chainAt = DEVICE_ID_BYTES + 13;
  try {
    assertDeviceId(device);
  } catch {
    return undefined;
  }
  return {
    device,
    stream,
    seg,
    offset: Number(offset),
    chain: bytes.slice(chainAt, chainAt + CHAIN_BYTES),
    sig: bytes.slice(chainAt + CHAIN_BYTES),
  };
}
