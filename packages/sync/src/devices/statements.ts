// Ed25519 signatures over device statements: registry events, lease events and pairing messages.
//
//   signed = context | body          (Ed25519, strict RFC 8032 verification)
//
// Each purpose has its own context, distinct from crypto's "cashu/wrap/v3" and "cashu/cert/v1" and
// never a prefix of one, so a signature made for one purpose never verifies for another. Bodies are
// built by the callers from length-prefixed fields and canonical JSON; nothing signs raw caller bytes.
//
// TRANSITIONAL(S29-crypto): crypto's `SigningContext` lists only the wrap and certificate contexts and
// crypto is read-only for S29, so this file signs with the identity's seed through @noble/curves (the
// same library and calls crypto uses). The follow-up adds these three contexts to crypto's
// `SigningContext` and exports `verifySignature`; then `signStatement` becomes `signer.sign(context, body)`.

import { ed25519 } from "@noble/curves/ed25519.js";
import { CryptoError, type DeviceIdentity, type RecoveryIdentity } from "../crypto/index.js";
import { concat, toHex, utf8 } from "./bytes.js";

export type StatementContext = "cashu/registry/v1" | "cashu/lease/v1" | "cashu/pairing/v1";

export const SIGNATURE_BYTES = 64;
const PUBLIC_KEY_BYTES = 32;

export function signStatement(
  signer: DeviceIdentity | RecoveryIdentity,
  context: StatementContext,
  body: Uint8Array,
): Uint8Array {
  return ed25519.sign(concat(utf8(context), body), signer.signSecretKey.expose());
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
  if (signature.length !== SIGNATURE_BYTES || publicKey.length !== PUBLIC_KEY_BYTES) return false;
  try {
    return ed25519.verify(signature, concat(utf8(context), body), publicKey, { zip215: false });
  } catch {
    throw new CryptoError("unsupported_runtime");
  }
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
 * event set on every change, so without it each pass would re-verify every statement.
 */
export function memoizedVerifier(maxEntries = 100_000): StatementVerifier {
  const cache = new Map<string, boolean>();
  return (context, body, signature, publicKey) => {
    const key = `${context}|${toHex(publicKey)}|${toHex(signature)}|${toHex(body)}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const ok = verifyStatement(context, body, signature, publicKey);
    if (cache.size >= maxEntries) cache.clear();
    cache.set(key, ok);
    return ok;
  };
}
