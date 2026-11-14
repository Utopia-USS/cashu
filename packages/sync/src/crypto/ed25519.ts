// The Ed25519 verification port. Every signature check of the sync layer (frame heads, certificates,
// wraps, registry statements, the gate snapshot) ends in `verifySignature` (identity.ts), which calls the
// verifier bound here. The default is @noble/curves in strict mode (`zip215: false`): the hosts and the
// tests never bind anything. The phone binds the native libsodium of `react-native-libsodium`
// (`crypto_sign_verify_detached`), because @noble's BigInt arithmetic on Hermes (no JIT) made a vault open
// cost seconds per thousand frames.
//
// Parity: both implementations must accept exactly the same signatures, or a frame the Mac accepts would
// stop the phone's copy of that stream (or worse, the other way round). They agree on valid signatures,
// tampered R / S / message, a non-canonical S (S + L), non-canonical or small-order public keys and a
// small-order R. They differ on a MIXED-ORDER public key (a prime-order key plus a torsion point, which no
// honest key generation produces): @noble checks the cofactored equation and accepts, libsodium checks the
// cofactorless one and rejects unless the challenge is a multiple of 8. Cofactorless acceptance implies the
// cofactored one, and libsodium's encoding checks are at least as strict, so what libsodium accepts @noble
// accepts too; the native verifier therefore asks @noble whenever libsodium says no (rare: only tampered or
// hostile input), and the result is @noble's answer on every input (`ed25519.test.ts` pins the classes).
//
// Lengths are checked before any implementation runs (`verifySignature`, and again inside the native
// verifier, which is public): the native function reads 64 and 32 bytes from whatever buffer it is
// given. A throw of the native call is answered by @noble too, so a hostile frame reads as a failed
// verification on the phone exactly as on the Mac (never as a runtime fault).

import { ed25519 } from "@noble/curves/ed25519.js";
import { CryptoError } from "./errors.js";

/** Strict Ed25519 verification of a detached signature; false for every invalid input. */
export interface Ed25519Verifier {
  /** Which implementation (diagnostics and tests). */
  readonly kind: "noble" | "native";
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
}

/** The pure-JS reference (strict RFC 8032 encodings, cofactored equation). */
export const nobleEd25519Verifier: Ed25519Verifier = {
  kind: "noble",
  verify: (signature, message, publicKey) =>
    ed25519.verify(signature, message, publicKey, { zip215: false }),
};

/** The functions of libsodium (react-native-libsodium, libsodium-wrappers) the native verifier uses. */
export interface LibsodiumSignLike {
  crypto_sign_verify_detached(
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array,
  ): boolean;
}

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

// RFC 8032 section 7.1, test 2 (one-byte message 0x72).
const KAT = {
  publicKey: hex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"),
  message: Uint8Array.of(0x72),
  signature: hex(
    "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  ),
};
// A small-order public key: the identity point, with R = identity and S = 0. The cofactorless equation
// holds for every message ([0]B = R + [k]A), so only the small-order check refuses it.
const SMALL_ORDER = {
  publicKey: hex("0100000000000000000000000000000000000000000000000000000000000000"),
  signature: hex(
    "01000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  ),
};
// The group order L, little endian (S + L is the classic non-canonical S).
const ORDER = hex("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010");

function addOrder(s: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  let carry = 0;
  for (let i = 0; i < 32; i++) {
    const sum = (s[i] ?? 0) + (ORDER[i] ?? 0) + carry;
    out[i] = sum & 0xff;
    carry = sum >> 8;
  }
  return out;
}

/**
 * The native verifier over libsodium. Runs a known-answer test first (valid, message changed, S changed,
 * S + L, small-order public key) and throws `unsupported_runtime` when the library lacks the function or
 * answers wrongly: the caller then keeps @noble (correct, only slower). After that, wrong lengths are
 * false without a native call, and a native `false` or throw gets @noble's answer.
 */
export function libsodiumEd25519Verifier(lib: LibsodiumSignLike): Ed25519Verifier {
  if (typeof lib.crypto_sign_verify_detached !== "function") {
    throw new CryptoError("unsupported_runtime");
  }
  const native = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean =>
    lib.crypto_sign_verify_detached.call(lib, signature, message, publicKey) === true;
  try {
    const { publicKey, message, signature } = KAT;
    const changedS = signature.slice();
    changedS[40] = (changedS[40] ?? 0) ^ 1;
    const nonCanonical = signature.slice();
    nonCanonical.set(addOrder(signature.subarray(32)), 32);
    const ok =
      native(signature, message, publicKey) &&
      !native(signature, Uint8Array.of(0x73), publicKey) &&
      !native(changedS, message, publicKey) &&
      !native(nonCanonical, message, publicKey) &&
      !native(SMALL_ORDER.signature, message, SMALL_ORDER.publicKey);
    if (!ok) throw new Error("ed25519 known answer");
  } catch {
    throw new CryptoError("unsupported_runtime");
  }
  return {
    kind: "native",
    verify: (signature, message, publicKey) => {
      if (signature.length !== 64 || publicKey.length !== 32) return false;
      try {
        if (native(signature, message, publicKey)) return true;
      } catch {
        // Fall through: @noble answers, as on every platform that never bound a native verifier.
      }
      return nobleEd25519Verifier.verify(signature, message, publicKey);
    },
  };
}

let bound: Ed25519Verifier = nobleEd25519Verifier;

/** The verifier `verifySignature` uses (@noble unless the platform bound another one). */
export function ed25519Verifier(): Ed25519Verifier {
  return bound;
}

/** Binds the process-wide verifier (the phone at boot); returns the previous one (tests restore it). */
export function bindEd25519Verifier(verifier: Ed25519Verifier): Ed25519Verifier {
  const previous = bound;
  bound = verifier;
  return previous;
}
