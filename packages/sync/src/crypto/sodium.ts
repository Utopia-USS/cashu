// One crypto interface for every runtime. Desktop / Node loads `libsodium-wrappers` (the standard
// build: it has every function used here, the sumo build only adds unused ones such as Argon2id);
// the mobile app passes `react-native-libsodium` to `fromLibsodium` with `aead: "noble"`, so this
// package never imports a React Native module. Construction runs a known-answer self-test, so a
// runtime that lacks or mangles a primitive (libsodium's, or @noble's Ed25519 / X25519 that identities
// use) fails at startup with `unsupported_runtime` instead of
// reporting every frame as tampered.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { CryptoError } from "./errors.js";

export interface KeyPairBytes {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * The libsodium-wrappers functions cashU uses. `react-native-libsodium` exposes the same names as
 * named exports (pass the module namespace: `import * as sodium from "react-native-libsodium"`).
 */
export interface LibsodiumLike {
  randombytes_buf(length: number): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_encrypt?(
    message: Uint8Array,
    additionalData: Uint8Array | null,
    secretNonce: null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt?(
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
  /** Throws `auth_failed` on an authentication failure, `unsupported_runtime` on anything else. */
  aeadDecrypt(cipher: Uint8Array, aad: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
  boxKeyPair(): KeyPairBytes;
  boxSeedKeyPair(seed: Uint8Array): KeyPairBytes;
  seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  /** `auth_failed` when the box was not sealed for this key pair; `unsupported_runtime` otherwise. */
  sealOpen(cipher: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array;
  hash(length: number, message: Uint8Array, key?: Uint8Array): Uint8Array;
}

export interface SodiumOptions {
  /**
   * Which AEAD implementation to use: "libsodium" (default) or "noble" (`@noble/ciphers`, pure
   * JS). Use "noble" with react-native-libsodium, whose AEAD rejects binary additional data.
   */
  aead?: "libsodium" | "noble";
}

const BASE_REQUIRED = [
  "randombytes_buf",
  "crypto_box_keypair",
  "crypto_box_seed_keypair",
  "crypto_box_seal",
  "crypto_box_seal_open",
  "crypto_generichash",
] as const;
const AEAD_REQUIRED = [
  "crypto_aead_xchacha20poly1305_ietf_encrypt",
  "crypto_aead_xchacha20poly1305_ietf_decrypt",
] as const;

// The exact messages libraries use for "this ciphertext does not authenticate". Anything else
// (TypeError, "input type not yet implemented", a missing binding) is a runtime problem, never tampering.
const AEAD_AUTH_FAILURES = new Set([
  "ciphertext cannot be decrypted using that key", // libsodium-wrappers
  "invalid tag", // @noble/ciphers
  "[react-native-libsodium][crypto_aead_xchacha20poly1305_ietf_decrypt] crypto_aead_xchacha20poly1305_ietf_decrypt failed",
]);
const SEAL_AUTH_FAILURES = new Set([
  "incorrect key pair for the given ciphertext", // libsodium-wrappers
  "[react-native-libsodium][crypto_box_seal_open] crypto_box_seal_open failed",
]);

function classify(error: unknown, authFailures: Set<string>): CryptoError {
  const message = error instanceof Error ? error.message : undefined;
  return new CryptoError(
    message !== undefined && authFailures.has(message) ? "auth_failed" : "unsupported_runtime",
  );
}

function runtime<T>(fn: () => T): T {
  try {
    return fn();
  } catch {
    throw new CryptoError("unsupported_runtime");
  }
}

export function fromLibsodium(lib: LibsodiumLike, options: SodiumOptions = {}): Sodium {
  const aead = options.aead ?? "libsodium";
  const required: readonly (keyof LibsodiumLike)[] =
    aead === "libsodium" ? [...BASE_REQUIRED, ...AEAD_REQUIRED] : BASE_REQUIRED;
  for (const name of required) {
    if (typeof lib[name] !== "function") throw new CryptoError("unsupported_runtime");
  }

  const aeadEncrypt: Sodium["aeadEncrypt"] =
    aead === "noble"
      ? (plain, aad, nonce, key) => runtime(() => xchacha20poly1305(key, nonce, aad).encrypt(plain))
      : (plain, aad, nonce, key) =>
          runtime(() => {
            const encrypt = lib.crypto_aead_xchacha20poly1305_ietf_encrypt;
            if (!encrypt) throw new CryptoError("unsupported_runtime");
            return encrypt.call(lib, plain, aad, null, nonce, key);
          });
  const aeadDecrypt: Sodium["aeadDecrypt"] = (cipher, aad, nonce, key) => {
    // Too short to hold a tag: reject here, before any library sees a length it may mishandle.
    if (cipher.length < TAG_BYTES) throw new CryptoError("auth_failed");
    try {
      return aead === "noble"
        ? xchacha20poly1305(key, nonce, aad).decrypt(cipher)
        : libDecrypt(lib)(null, cipher, aad, nonce, key);
    } catch (e) {
      throw classify(e, AEAD_AUTH_FAILURES);
    }
  };

  const sodium: Sodium = {
    randomBytes: (length) => runtime(() => lib.randombytes_buf(length)),
    aeadEncrypt,
    aeadDecrypt,
    boxKeyPair: () => runtime(() => lib.crypto_box_keypair()),
    boxSeedKeyPair: (seed) => runtime(() => lib.crypto_box_seed_keypair(seed)),
    seal: (message, publicKey) => runtime(() => lib.crypto_box_seal(message, publicKey)),
    sealOpen: (cipher, publicKey, privateKey) => {
      // react-native-libsodium computes `length - 48` unchecked; never hand it a shorter box.
      if (cipher.length < SEAL_OVERHEAD) throw new CryptoError("auth_failed");
      try {
        return lib.crypto_box_seal_open(cipher, publicKey, privateKey);
      } catch (e) {
        throw classify(e, SEAL_AUTH_FAILURES);
      }
    },
    hash: (length, message, key) =>
      runtime(() => lib.crypto_generichash(length, message, key ?? null)),
  };
  selfTest(sodium);
  return sodium;
}

function libDecrypt(
  lib: LibsodiumLike,
): NonNullable<LibsodiumLike["crypto_aead_xchacha20poly1305_ietf_decrypt"]> {
  const decrypt = lib.crypto_aead_xchacha20poly1305_ietf_decrypt;
  if (!decrypt) throw new CryptoError("unsupported_runtime");
  return decrypt.bind(lib);
}

// ---- known-answer self-test -------------------------------------------------------------------

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const seq = (from: number, n: number) => Uint8Array.from({ length: n }, (_, i) => from + i);
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// draft-irtf-cfrg-xchacha-03 A.3.1: XChaCha20-Poly1305 with BINARY additional data.
const KAT_AEAD = {
  plain: new TextEncoder().encode(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
  ),
  aad: hex("50515253c0c1c2c3c4c5c6c7"),
  nonce: seq(0x40, 24),
  key: seq(0x80, 32),
  cipher: hex(
    "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39" +
      "ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9" +
      "21f9664c97637da9768812f615c68b13b52ec0875924c1c7987947deafd8780acf49",
  ),
};
// crypto_box_seed_keypair(32 zero bytes): X25519 of SHA-512(seed)[0..32] (checked with @noble).
const KAT_SEED_PUBLIC = hex("5bf55c73b82ebe22be80f3430667af570fae2556a6415e6b30d4065300aa947d");
// RFC 8032 section 7.1, test 1 (Ed25519, empty message), run on @noble/curves.
const KAT_ED25519 = {
  secret: hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"),
  public: hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
  signature: hex(
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  ),
};
// BLAKE2b-256(key = 00..1f, "cashu/selftest") (checked with @noble/hashes).
const KAT_HASH = hex("0a77bc9f206ab9767fc28bd7b79e0336c6a006df046573a09c0b208225a6c19f");

function selfTest(sodium: Sodium): void {
  try {
    const { plain, aad, nonce, key, cipher } = KAT_AEAD;
    if (!same(sodium.aeadEncrypt(plain, aad, nonce, key), cipher)) throw new Error("aead");
    if (!same(sodium.aeadDecrypt(cipher, aad, nonce, key), plain)) throw new Error("aead");
    const tampered = cipher.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expectAuthFailure(() => sodium.aeadDecrypt(tampered, aad, nonce, key));

    const pair = sodium.boxSeedKeyPair(new Uint8Array(32));
    if (!same(pair.publicKey, KAT_SEED_PUBLIC)) throw new Error("seed keypair");
    // BoxKeyPair derives public keys with @noble/curves: it must agree with libsodium.
    if (!same(x25519.getPublicKey(pair.privateKey), pair.publicKey)) throw new Error("x25519");
    const { secret, public: edPublic, signature } = KAT_ED25519;
    if (!same(ed25519.getPublicKey(secret), edPublic)) throw new Error("ed25519");
    if (!same(ed25519.sign(new Uint8Array(0), secret), signature)) throw new Error("ed25519");
    if (!ed25519.verify(signature, new Uint8Array(0), edPublic, { zip215: false })) {
      throw new Error("ed25519");
    }
    if (ed25519.verify(signature, Uint8Array.of(1), edPublic, { zip215: false })) {
      throw new Error("ed25519");
    }
    const box = sodium.seal(plain, pair.publicKey);
    if (!same(sodium.sealOpen(box, pair.publicKey, pair.privateKey), plain))
      throw new Error("seal");
    box[box.length - 1] = (box.at(-1) ?? 0) ^ 1;
    expectAuthFailure(() => sodium.sealOpen(box, pair.publicKey, pair.privateKey));

    if (!same(sodium.hash(32, new TextEncoder().encode("cashu/selftest"), seq(0, 32)), KAT_HASH)) {
      throw new Error("generichash");
    }
    if (sodium.randomBytes(32).length !== 32) throw new Error("random");
  } catch {
    throw new CryptoError("unsupported_runtime");
  }
}

function expectAuthFailure(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof CryptoError && e.code === "auth_failed") return;
  }
  throw new Error("authentication failure not recognised");
}

let nodeSodium: Promise<Sodium> | undefined;

function loadWith(options: SodiumOptions): Promise<Sodium> {
  return import("libsodium-wrappers").then(async ({ default: lib }) => {
    await lib.ready;
    return fromLibsodium(lib, options);
  });
}

/** libsodium (WebAssembly) for Node and Electron; the default backend is loaded and self-tested once. */
export function loadNodeSodium(options: SodiumOptions = {}): Promise<Sodium> {
  if (options.aead === "noble") return loadWith(options);
  nodeSodium ??= loadWith(options);
  return nodeSodium;
}
