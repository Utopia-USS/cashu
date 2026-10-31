// One crypto interface for every runtime. Desktop / Node loads `libsodium-wrappers-sumo`; the mobile
// app passes `react-native-libsodium` (same function names) to `fromLibsodium`, so this package never
// imports a React Native module.

import { CryptoError } from "./errors.js";

export interface KeyPairBytes {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** The libsodium-wrappers functions cashU uses; `react-native-libsodium` exposes the same names. */
export interface LibsodiumLike {
  randombytes_buf(length: number): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: Uint8Array,
    additionalData: Uint8Array | null,
    secretNonce: null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(
    secretNonce: null,
    ciphertext: Uint8Array,
    additionalData: Uint8Array | null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  crypto_box_keypair(): KeyPairBytes;
  crypto_box_seed_keypair(seed: Uint8Array): KeyPairBytes;
  crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  crypto_box_seal_open(
    ciphertext: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
  ): Uint8Array;
  crypto_generichash(length: number, message: Uint8Array, key: Uint8Array | null): Uint8Array;
}

export const KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const TAG_BYTES = 16;
export const PUBLIC_KEY_BYTES = 32;
export const SEAL_OVERHEAD = 48;

/** Primitives with fixed algorithms: XChaCha20-Poly1305 (IETF), X25519 sealed boxes, BLAKE2b. */
export interface Sodium {
  randomBytes(length: number): Uint8Array;
  aeadEncrypt(plain: Uint8Array, aad: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
  /** Throws `CryptoError("auth_failed")` on any authentication failure. */
  aeadDecrypt(cipher: Uint8Array, aad: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
  boxKeyPair(): KeyPairBytes;
  boxSeedKeyPair(seed: Uint8Array): KeyPairBytes;
  seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  /** Throws `CryptoError("auth_failed")` when the box was not sealed for this key pair. */
  sealOpen(cipher: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array;
  hash(length: number, message: Uint8Array, key?: Uint8Array): Uint8Array;
}

const REQUIRED: (keyof LibsodiumLike)[] = [
  "randombytes_buf",
  "crypto_aead_xchacha20poly1305_ietf_encrypt",
  "crypto_aead_xchacha20poly1305_ietf_decrypt",
  "crypto_box_keypair",
  "crypto_box_seed_keypair",
  "crypto_box_seal",
  "crypto_box_seal_open",
  "crypto_generichash",
];

export function fromLibsodium(lib: LibsodiumLike): Sodium {
  for (const name of REQUIRED) {
    if (typeof lib[name] !== "function") throw new CryptoError("unsupported_runtime");
  }
  return {
    randomBytes: (length) => lib.randombytes_buf(length),
    aeadEncrypt: (plain, aad, nonce, key) =>
      lib.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, aad, null, nonce, key),
    aeadDecrypt: (cipher, aad, nonce, key) => {
      try {
        return lib.crypto_aead_xchacha20poly1305_ietf_decrypt(null, cipher, aad, nonce, key);
      } catch {
        // libsodium's own message is generic too, but the code is what callers branch on.
        throw new CryptoError("auth_failed");
      }
    },
    boxKeyPair: () => lib.crypto_box_keypair(),
    boxSeedKeyPair: (seed) => lib.crypto_box_seed_keypair(seed),
    seal: (message, publicKey) => lib.crypto_box_seal(message, publicKey),
    sealOpen: (cipher, publicKey, privateKey) => {
      try {
        return lib.crypto_box_seal_open(cipher, publicKey, privateKey);
      } catch {
        throw new CryptoError("auth_failed");
      }
    },
    hash: (length, message, key) => lib.crypto_generichash(length, message, key ?? null),
  };
}

let nodeSodium: Promise<Sodium> | undefined;

/** libsodium (WebAssembly) for Node and Electron; loaded once. */
export function loadNodeSodium(): Promise<Sodium> {
  nodeSodium ??= import("libsodium-wrappers-sumo").then(async ({ default: lib }) => {
    await lib.ready;
    // The package's overloads (output formats) are wider than LibsodiumLike; the byte forms match.
    return fromLibsodium(lib as unknown as LibsodiumLike);
  });
  return nodeSodium;
}
