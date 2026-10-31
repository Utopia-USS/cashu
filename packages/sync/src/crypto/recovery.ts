// Recovery key: 24 BIP39 words = 256 bits of random entropy + checksum (catches a mistyped word).
// The words derive the recovery identity: an X25519 key pair (HKDF-SHA256 -> seed ->
// crypto_box_seed_keypair) that rotated data keys are wrapped for, and an Ed25519 signing key
// (HKDF-SHA256 -> seed) so a recovering device has a trust root of its own. Every keyring pins the
// recovery PUBLIC keys inside the authenticated key payload (never a plain vault file), so any
// device can seal a newly rotated data key for recovery without ever holding the words.
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
import { RecoveryIdentity, type RecoveryPublicKeys } from "./identity.js";
import { Secret } from "./secret.js";
import type { Sodium } from "./sodium.js";

export const RECOVERY_WORDS = 24;
const ENTROPY_BYTES = 32;
const HKDF_SALT = utf8("cashu/recovery/v2");
const HKDF_INFO_BOX = utf8("x25519-seed");
const HKDF_INFO_SIGN = utf8("ed25519-seed");

export interface NewRecoveryKey {
  /** Shown to the owner once, to write down; never stored, logged or synced. */
  phrase: string;
  /** Pinned in the vault's keyrings (`createKeyring`); rotated data keys are wrapped for it. */
  publicKeys: RecoveryPublicKeys;
}

export function normalizePhrase(phrase: string): string {
  return phrase.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ");
}

function identityFromEntropy(sodium: Sodium, entropy: Uint8Array): RecoveryIdentity {
  const boxSeed = hkdf(sha256, entropy, HKDF_SALT, HKDF_INFO_BOX, 32);
  const signSeed = hkdf(sha256, entropy, HKDF_SALT, HKDF_INFO_SIGN, 32);
  try {
    const pair = sodium.boxSeedKeyPair(boxSeed);
    pair.publicKey.fill(0);
    return new RecoveryIdentity(new Secret(pair.privateKey), new Secret(signSeed));
  } finally {
    boxSeed.fill(0);
  }
}

export function createRecoveryKey(sodium: Sodium): NewRecoveryKey {
  const entropy = sodium.randomBytes(ENTROPY_BYTES);
  try {
    const identity = identityFromEntropy(sodium, entropy);
    const publicKeys = identity.publicKeys;
    identity.wipe();
    return { phrase: entropyToMnemonic(entropy, wordlist), publicKeys };
  } finally {
    entropy.fill(0);
  }
}

/** The recovery identity for a phrase; throws `bad_mnemonic` (without echoing the words) when invalid. */
export function recoveryIdentity(sodium: Sodium, phrase: string): RecoveryIdentity {
  const normalized = normalizePhrase(phrase);
  if (normalized.split(" ").length !== RECOVERY_WORDS) throw new CryptoError("bad_mnemonic");
  let entropy: Uint8Array;
  try {
    entropy = mnemonicToEntropy(normalized, wordlist);
  } catch {
    throw new CryptoError("bad_mnemonic");
  }
  try {
    return identityFromEntropy(sodium, entropy);
  } finally {
    entropy.fill(0);
  }
}
