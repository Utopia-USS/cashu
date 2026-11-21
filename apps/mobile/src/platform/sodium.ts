// The mobile crypto path (packages/sync/src/crypto/README.md): react-native-libsodium for box / seal /
// BLAKE2b / randomness, @noble/ciphers for the XChaCha20-Poly1305 AEAD (react-native-libsodium 1.7
// rejects binary additional data). Pass the module namespace: the default export lacks crypto_box_seal.
import type { crypto } from "@cashu/sync/engine";
import * as libsodium from "react-native-libsodium";

/**
 * The native library for `crypto.fromLibsodium(nativeLibsodium, { aead: "noble" })` (the self-test
 * builds it that way and also probes the library's own AEAD).
 */
export const nativeLibsodium: crypto.LibsodiumLike = libsodium as unknown as crypto.LibsodiumLike;

/**
 * The same module as `crypto.libsodiumEd25519Verifier`'s input: its `crypto_sign_verify_detached` (JSI)
 * verifies frame heads natively (`packages/sync/src/crypto/ed25519.ts`).
 */
export const nativeSignLibsodium: crypto.LibsodiumSignLike =
  libsodium as unknown as crypto.LibsodiumSignLike;
