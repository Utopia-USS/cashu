// Ed25519 signatures over device statements: registry events, lease events and pairing messages.
//
//   signed = context | body          (crypto `sign` / `verifyContextSignature`, strict RFC 8032)
//
// The three contexts (`cashu/registry/v1`, `cashu/lease/v1`, `cashu/pairing/v1`) are crypto
// `SigningContext`s, distinct from `cashu/wrap/v3` and `cashu/cert/v1` and never a prefix of one, so a
// signature made for one purpose never verifies for another. Bodies are built by the callers from
// length-prefixed fields and canonical JSON; nothing signs raw caller bytes. Key material never
// leaves crypto: devices/ only calls `identity.sign`.

import { blake2b } from "@noble/hashes/blake2.js";
import {
  type DeviceIdentity,
  type RecoveryIdentity,
  verifyContextSignature,
} from "../crypto/index.js";
import { concat, toHex, utf8 } from "./bytes.js";

export type StatementContext =
  | "cashu/registry/v1"
  | "cashu/lease/v1"
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
 * A verifier that remembers results by a hash of (context, key, signature, body): folds re-run over
 * the whole event set on every change, so without it each pass would re-verify every statement.
 * Bounded; the oldest entries are dropped first (no cliff where everything is re-verified at once).
 */
export function memoizedVerifier(maxEntries = 200_000): StatementVerifier {
  const cache = new Map<string, boolean>();
  return (context, body, signature, publicKey) => {
    const key = toHex(
      blake2b(concat(utf8(context), new Uint8Array([0]), publicKey, signature, body), {
        dkLen: 32,
      }),
    );
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const ok = verifyStatement(context, body, signature, publicKey);
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, ok);
    return ok;
  };
}
