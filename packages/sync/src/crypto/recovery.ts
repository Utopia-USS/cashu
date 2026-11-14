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

import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { CryptoError } from "./errors.js";
import type { RecoveryIdentity, RecoveryPublicKeys } from "./identity.js";
import { identityFromEntropy, RECOVERY_ENTROPY_BYTES } from "./recoveryIdentity.js";
import type { Sodium } from "./sodium.js";

export const RECOVERY_WORDS = 24;

const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const INTERNAL = Symbol("recovery-phrase");

/**
 * The 24 words, behind a wrapper that prints `[redacted]` through `String`, `JSON.stringify` and
 * `util.inspect`, so logging a `NewRecoveryKey` by mistake shows no words. `reveal()` returns them,
 * right where the UI shows them to the owner once.
 */
export class RecoveryPhrase {
  readonly #words: string;

  /** Not public API: made by `createRecoveryKey`. */
  constructor(token: typeof INTERNAL, words: string) {
    if (token !== INTERNAL) throw new TypeError("use createRecoveryKey");
    this.#words = words;
  }

  reveal(): string {
    return this.#words;
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [INSPECT](): string {
    return "RecoveryPhrase([redacted])";
  }
}

export interface NewRecoveryKey {
  /** Shown to the owner once, to write down (`reveal()`); never stored, logged or synced. */
  phrase: RecoveryPhrase;
  /** Pinned in the vault's keyrings (`createKeyring`); rotated data keys are wrapped for it. */
  publicKeys: RecoveryPublicKeys;
}

export function normalizePhrase(phrase: string): string {
  return phrase.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ");
}

export function createRecoveryKey(sodium: Sodium): NewRecoveryKey {
  const entropy = sodium.randomBytes(RECOVERY_ENTROPY_BYTES);
  try {
    const identity = identityFromEntropy(sodium, entropy);
    const publicKeys = identity.publicKeys;
    identity.wipe();
    return {
      phrase: new RecoveryPhrase(INTERNAL, entropyToMnemonic(entropy, wordlist)),
      publicKeys,
    };
  } finally {
    entropy.fill(0);
  }
}

/** The recovery identity for a phrase; throws `bad_mnemonic` (without echoing the words) when invalid. */
export function recoveryIdentity(
  sodium: Sodium,
  phrase: string | RecoveryPhrase,
): RecoveryIdentity {
  const normalized = normalizePhrase(typeof phrase === "string" ? phrase : phrase.reveal());
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
