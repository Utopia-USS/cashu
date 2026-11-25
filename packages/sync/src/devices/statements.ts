// Ed25519 signatures over device statements: registry events, lease events and pairing messages.
//
//   signed = context | body          (crypto `sign` / `verifyContextSignature`, strict RFC 8032)
//
// The three contexts (`cashu/registry/v1`, `cashu/lease/v1`, `cashu/pairing/v1`) are crypto
// `SigningContext`s, distinct from `cashu/wrap/v3` and `cashu/cert/v1` and never a prefix of one, so a
// signature made for one purpose never verifies for another. Bodies are built by the callers from
// length-prefixed fields and canonical JSON; nothing signs raw caller bytes. Key material never
// leaves crypto: devices/ only calls `identity.sign`.

import {
  type DeviceIdentity,
  type RecoveryIdentity,
  verifyContextSignature,
} from "../crypto/core.js";

export type StatementContext =
  | "cashu/registry/v1"
  | "cashu/lease/v1"
  | "cashu/gossip/v1"
  | "cashu/pairing/v1"
  /** Signed stream heads (crypto head.ts): one per frame, checked only through acceptance.ts. */
  | "cashu/head/v1"
  /** A device's own gate state snapshot (gateState.ts), checked only with its own key. */
  | "cashu/state/v1";

export const SIGNATURE_BYTES = 64;

export function signStatement(
  signer: DeviceIdentity | RecoveryIdentity,
  context: StatementContext,
  body: Uint8Array,
): Uint8Array {
  return signer.sign(context, body);
}

/**
 * Strict verification. Wrong lengths and malformed or forged signatures are simply invalid; an
 * exception from the library is a broken runtime (`unsupported_runtime`), never "tampered".
 */
export function verifyStatement(
  context: StatementContext,
  body: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  return verifyContextSignature(context, body, signature, publicKey);
}

/** Checks a statement signature; `memoizedVerifier` caches results across folds. */
export type StatementVerifier = (
  context: StatementContext,
  body: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
) => boolean;

/**
 * A verifier that remembers results by (context, key, signature, body): folds re-run over the whole
 * event set on every change, so without it each pass would re-verify every statement. The cache key is
 * those exact bytes, one character per byte, length-prefixed so it cannot be split two ways: no hash,
 * so no collision, and far cheaper than the JS BLAKE2b of the body it replaced (which cost about as
 * much as the check it saved and made a host's start replay take minutes). Bounded by entries and by
 * key characters; the oldest entries are dropped first (no cliff where everything is re-verified).
 */
export function memoizedVerifier(
  maxEntries = 200_000,
  maxChars = 32 * 1024 * 1024,
): StatementVerifier {
  const cache = new Map<string, boolean>();
  let chars = 0;
  return (context, body, signature, publicKey) => {
    const key = `${context}\0${publicKey.length}\0${signature.length}\0${latin1(publicKey)}${latin1(signature)}${latin1(body)}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const ok = verifyStatement(context, body, signature, publicKey);
    cache.set(key, ok);
    chars += key.length;
    while (cache.size > maxEntries || chars > maxChars) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
      chars -= oldest.value.length;
    }
    return ok;
  };
}

/** One character (code 0-255) per byte: a cheap, exact string form of bytes for a map key. */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; at += 4096)
    out += String.fromCharCode(...bytes.subarray(at, at + 4096));
  return out;
}
