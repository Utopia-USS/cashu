// The recovery identity from its 32 bytes of entropy (recovery.ts explains the derivation): HKDF-SHA256
// -> an X25519 seed and an Ed25519 seed. Kept apart from the BIP39 phrase so code that never shows or
// reads the words (the phone's demo vault, the phone's crypto self-test) does not bundle the wordlist.

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8 } from "./encoding.js";
import { RecoveryIdentity } from "./identity.js";
import { Secret } from "./secret.js";
import type { Sodium } from "./sodium.js";

export const RECOVERY_ENTROPY_BYTES = 32;
const HKDF_SALT = utf8("cashu/recovery/v2");
const HKDF_INFO_BOX = utf8("x25519-seed");
const HKDF_INFO_SIGN = utf8("ed25519-seed");

/** Not public API: the derivation `recovery.ts` shares. The caller wipes `entropy`. */
export function identityFromEntropy(sodium: Sodium, entropy: Uint8Array): RecoveryIdentity {
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

/**
 * A fresh recovery identity with no phrase: for a vault whose recovery is never shown to anyone (the
 * phone's demo vault, the crypto self-test). Nobody can restore such a vault from words; a real vault
 * gets its key from `createRecoveryKey`, whose words the owner writes down.
 */
export function createRecoveryIdentity(sodium: Sodium): RecoveryIdentity {
  const entropy = sodium.randomBytes(RECOVERY_ENTROPY_BYTES);
  try {
    return identityFromEntropy(sodium, entropy);
  } finally {
    entropy.fill(0);
  }
}
