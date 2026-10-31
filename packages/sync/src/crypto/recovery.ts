// Recovery key: 24 BIP39 words = 256 bits of random entropy + checksum (catches a mistyped word).
// The words derive an X25519 key pair (HKDF-SHA256 -> seed -> crypto_box_seed_keypair). The vault
// keeps only the recovery PUBLIC key, so any device can seal a newly rotated data key for recovery
// without ever holding the words; with the words and the synced vault, a new device opens those wraps.
//
// Why HKDF and not Argon2id: Argon2id stretches low-entropy secrets (passwords). The phrase already
// carries 256 random bits, so stretching adds no security, only seconds of work on a phone. Argon2id
// becomes necessary only if a user-chosen passphrase is ever added on top of the words.
//
// The BIP39 standard seed (PBKDF2 of the words) is not used: we decode the words back to their
// entropy, so the phrase is a plain encoding of a key and not wallet-compatible on purpose.

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import type { Sodium } from "./sodium.js";
import { BoxKeyPair } from "./wrap.js";

export const RECOVERY_WORDS = 24;
const ENTROPY_BYTES = 32;
const HKDF_SALT = utf8("cashu/recovery/v1");
const HKDF_INFO = utf8("x25519-seed");

export interface NewRecoveryKey {
  /** Shown to the owner once, to write down; never stored, logged or synced. */
  phrase: string;
  /** Kept in the vault; rotated data keys are wrapped for it. */
  publicKey: Uint8Array;
}

export function normalizePhrase(phrase: string): string {
  return phrase.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ");
}

function keyPairFromEntropy(sodium: Sodium, entropy: Uint8Array): BoxKeyPair {
  const seed = hkdf(sha256, entropy, HKDF_SALT, HKDF_INFO, 32);
  try {
    return BoxKeyPair.fromBytes(sodium.boxSeedKeyPair(seed));
  } finally {
    seed.fill(0);
  }
}

export function createRecoveryKey(sodium: Sodium): NewRecoveryKey {
  const entropy = sodium.randomBytes(ENTROPY_BYTES);
  try {
    const pair = keyPairFromEntropy(sodium, entropy);
    pair.wipe();
    return { phrase: entropyToMnemonic(entropy, wordlist), publicKey: pair.publicKey };
  } finally {
    entropy.fill(0);
  }
}

/** The recovery key pair for a phrase; throws `bad_mnemonic` (without echoing the words) when invalid. */
export function recoveryKeyPair(sodium: Sodium, phrase: string): BoxKeyPair {
  const normalized = normalizePhrase(phrase);
  if (normalized.split(" ").length !== RECOVERY_WORDS) throw new CryptoError("bad_mnemonic");
  let entropy: Uint8Array;
  try {
    entropy = mnemonicToEntropy(normalized, wordlist);
  } catch {
    throw new CryptoError("bad_mnemonic");
  }
  try {
    return keyPairFromEntropy(sodium, entropy);
  } finally {
    entropy.fill(0);
  }
}
