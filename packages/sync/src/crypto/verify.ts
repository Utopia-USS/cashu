// Boolean verify paths for the two authenticated opens, in pure JS (@noble). libsodium and its
// bindings report "does not authenticate" only by throwing, and each binding words (or wraps) that
// throw differently: react-native-libsodium on Android arrives as "Exception in HostFunction: ...".
// So `sodium.ts` never reads an error message: when a backend throws, these functions decide from the
// inputs alone whether a correct implementation would have refused them. They run only on that
// failure path, never on a successful open; the AEAD one computes only the tag.

// @noble/ciphers has no public Poly1305 export; `_poly1305.js` is listed in its exports map but
// internal by name, so the version is pinned exactly in package.json and verify.poly1305.test.ts fails
// when the module's shape or output changes on an upgrade.
import { poly1305 } from "@noble/ciphers/_poly1305.js";
import { xchacha20 } from "@noble/ciphers/chacha.js";
import { hsalsa, xsalsa20, xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { equalBytes, u8, u32 } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";

const TAG = 16;
const POLY_KEY = 32;
const X25519_BYTES = 32;

const ZEROS16 = new Uint8Array(16);

/**
 * True when `cipher` (ciphertext || tag) authenticates as XChaCha20-Poly1305 (IETF) under `key`,
 * `nonce` and `aad`. Inputs must be well formed (32-byte key, 24-byte nonce, at least a tag).
 *
 * Tag only (S29c-B3): it recomputes the Poly1305 tag over the ciphertext as it stands (RFC 8439
 * 2.8: one-time key = the first 32 keystream bytes of block 0; MAC over aad, pad16, ciphertext,
 * pad16, the two lengths) and compares it in constant time. Nothing is decrypted and nothing the
 * size of the frame is allocated, so a tampered 64 MiB frame costs one Poly1305 pass, not a
 * decrypt plus a re-encrypt.
 */
export function aeadAuthentic(
  cipher: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
): boolean {
  const body = cipher.subarray(0, cipher.length - TAG);
  const oneTime = xchacha20(key, nonce, new Uint8Array(POLY_KEY));
  const lengths = new Uint8Array(16);
  const view = new DataView(lengths.buffer);
  view.setBigUint64(0, BigInt(aad.length), true);
  view.setBigUint64(8, BigInt(body.length), true);
  const mac = poly1305.create(oneTime);
  mac.update(aad);
  if (aad.length % 16) mac.update(ZEROS16.subarray(aad.length % 16));
  mac.update(body);
  if (body.length % 16) mac.update(ZEROS16.subarray(body.length % 16));
  mac.update(lengths);
  const tag = mac.digest();
  oneTime.fill(0);
  return equalBytes(tag, cipher.subarray(cipher.length - TAG));
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
