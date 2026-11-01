// Boolean verify paths for the two authenticated opens, in pure JS (@noble). libsodium and its
// bindings report "does not authenticate" only by throwing, and each binding words (or wraps) that
// throw differently: react-native-libsodium on Android arrives as "Exception in HostFunction: ...".
// So `sodium.ts` never reads an error message: when a backend throws, these functions decide from the
// inputs alone whether a correct implementation would have refused them. They run only on that
// failure path, never on a successful open.

import { xchacha20, xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hsalsa, xsalsa20, xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { equalBytes, u8, u32 } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";

const TAG = 16;
const POLY_KEY = 32;
const X25519_BYTES = 32;

/**
 * True when `cipher` (ciphertext || tag) authenticates as XChaCha20-Poly1305 (IETF) under `key`,
 * `nonce` and `aad`. Inputs must be well formed (32-byte key, 24-byte nonce, at least a tag).
 */
export function aeadAuthentic(
  cipher: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
): boolean {
  // Decrypt without checking (the IETF AEAD encrypts from block 1), re-encrypt with the tag and
  // compare: the result equals `cipher` exactly when its tag is the right one.
  const body = cipher.subarray(0, cipher.length - TAG);
  const guess = xchacha20(key, nonce, body, undefined, 1);
  return equalBytes(xchacha20poly1305(key, nonce, aad).encrypt(guess), cipher);
}

/**
 * True when `cipher` is a libsodium sealed box (`crypto_box_seal`) that opens with this key pair.
 * Inputs must be well formed (32-byte keys, at least 48 bytes of box).
 */
export function sealAuthentic(
  cipher: Uint8Array,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
): boolean {
  const ephemeral = cipher.subarray(0, X25519_BYTES);
  // libsodium refuses a low-order ephemeral key (crypto_scalarmult fails), so such a box never opens.
  if (lowOrder(ephemeral)) return false;
  const shared = x25519.getSharedSecret(privateKey, ephemeral);
  const key = beforenm(shared);
  const nonce = blake2b(concat(ephemeral, publicKey), { dkLen: 24 });
  const boxed = cipher.subarray(X25519_BYTES); // tag || ciphertext
  // Same trick as the AEAD: XSalsa20 keystream bytes 0..32 are the Poly1305 key, the message
  // follows; decrypt unchecked, re-encrypt with the tag, compare.
  const stream = xsalsa20(key, nonce, concat(new Uint8Array(POLY_KEY), boxed.subarray(TAG)));
  return equalBytes(xsalsa20poly1305(key, nonce).encrypt(stream.subarray(POLY_KEY)), boxed);
}

// crypto_box_beforenm: HSalsa20(shared secret, 16 zero bytes). Word views as @noble's own XSalsa20
// passes them on little-endian hosts; the self-test checks this path against libsodium's sealed box.
const SIGMA = u32(new TextEncoder().encode("expand 32-byte k"));

function beforenm(shared: Uint8Array): Uint8Array {
  const out = new Uint32Array(8);
  hsalsa(SIGMA, u32(shared.slice()), new Uint32Array(4), out);
  return u8(out);
}

// The Curve25519 u-coordinates of order dividing the cofactor (the blocklist libsodium carries):
// 0, 1, p - 1 and the two points of order 8. Decoding clears bit 255 and reduces mod p.
const P = 2n ** 255n - 19n;
const LOW_ORDER = new Set([
  0n,
  1n,
  P - 1n,
  325606250916557431795983626356110631294008115727848805560023387167927233504n,
  39382357235489614581723060781553021112529911719440698176882885853963445705823n,
]);

function lowOrder(u: Uint8Array): boolean {
  let n = 0n;
  for (let i = u.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(u[i] ?? 0);
  return LOW_ORDER.has((n & (2n ** 255n - 1n)) % P);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
