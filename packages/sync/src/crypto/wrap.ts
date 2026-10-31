// Key wrapping for pairing and recovery: the key payload (keys.ts) sealed with an X25519 sealed box
// (`crypto_box_seal`) for one recipient public key. A sealed box authenticates the content but not
// the sender, so the pairing protocol (S29) must authenticate the exchange (QR code + short
// authentication string); this module only guarantees that nobody but the recipient can open it
// and that keys of one vault are never accepted as another vault's.

import { CryptoError } from "./errors.js";
import { decodeKeyPayload, encodeKeyPayload, type Keyring } from "./keys.js";
import { Secret } from "./secret.js";
import { PUBLIC_KEY_BYTES, type Sodium } from "./sodium.js";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** A device's (or the recovery key's) X25519 key pair; the secret half never leaves the KeyStore. */
export class BoxKeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Secret;

  constructor(publicKey: Uint8Array, secretKey: Secret) {
    if (publicKey.length !== PUBLIC_KEY_BYTES) throw new RangeError("public key must be 32 bytes");
    this.publicKey = publicKey;
    this.secretKey = secretKey;
  }

  static fromBytes(pair: { publicKey: Uint8Array; privateKey: Uint8Array }): BoxKeyPair {
    return new BoxKeyPair(pair.publicKey, new Secret(pair.privateKey));
  }

  wipe(): void {
    this.secretKey.wipe();
  }

  toJSON(): { publicKey: string } {
    return { publicKey: "[public]" };
  }

  [INSPECT](): string {
    return "BoxKeyPair([redacted])";
  }
}

export function createDeviceKeyPair(sodium: Sodium): BoxKeyPair {
  return BoxKeyPair.fromBytes(sodium.boxKeyPair());
}

/**
 * Seals the ring's keys (all of them, or only `kids`, e.g. just the new generation after a
 * revocation) for one recipient. The output is safe to put in a QR code, a synced folder or a relay.
 */
export function wrapKeys(
  sodium: Sodium,
  ring: Keyring,
  recipientPublicKey: Uint8Array,
  kids?: readonly string[],
): Uint8Array {
  if (recipientPublicKey.length !== PUBLIC_KEY_BYTES)
    throw new RangeError("public key must be 32 bytes");
  const payload = encodeKeyPayload(ring, kids);
  try {
    return sodium.seal(payload, recipientPublicKey);
  } finally {
    payload.fill(0);
  }
}

/**
 * Opens a wrap sealed for `recipient`. Throws `auth_failed` when it was sealed for another key or
 * altered, `vault_mismatch` when it carries another vault's keys, `bad_payload` when malformed.
 */
export function unwrapKeys(
  sodium: Sodium,
  wrapped: Uint8Array,
  recipient: BoxKeyPair,
  expectedVaultId: string,
): Keyring {
  const payload = sodium.sealOpen(wrapped, recipient.publicKey, recipient.secretKey.expose());
  try {
    return decodeKeyPayload(sodium, payload, expectedVaultId);
  } catch (e) {
    throw e instanceof CryptoError ? e : new CryptoError("bad_payload");
  } finally {
    payload.fill(0);
  }
}
