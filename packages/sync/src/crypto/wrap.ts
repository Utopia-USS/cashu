// Key wrapping: the key payload (keys.ts) sealed for one recipient.
//
// Pairing hop (`sealForPairing` / `openPairingWrap`): a plain X25519 sealed box. It authenticates
// the content but NOT the sender, so it is only for the first hop to a new device, and only when the
// exchange is authenticated out of band (QR scanned in person, or a short authentication string).

import { CryptoError } from "./errors.js";
import type { BoxKeyPair } from "./identity.js";
import { decodeKeyPayload, emptyLike, encodeKeyPayload, type Keyring } from "./keys.js";
import { PUBLIC_KEY_BYTES, SEAL_OVERHEAD, type Sodium } from "./sodium.js";

/**
 * FIRST PAIRING HOP ONLY. Seals the ring's keys (with the pinned recovery public keys) for a new
 * device's X25519 public key, which the sender must have authenticated out of band (QR scanned in
 * person or a verified short authentication string). Anyone can produce such a box, so every later
 * wrap uses the signed `wrapKeys`.
 */
export function sealForPairing(
  sodium: Sodium,
  ring: Keyring,
  recipientBoxPublicKey: Uint8Array,
  kids?: readonly string[],
): Uint8Array {
  if (recipientBoxPublicKey.length !== PUBLIC_KEY_BYTES) {
    throw new RangeError("public key must be 32 bytes");
  }
  const payload = encodeKeyPayload(ring, kids);
  try {
    return sodium.seal(payload, recipientBoxPublicKey);
  } finally {
    payload.fill(0);
  }
}

/**
 * FIRST PAIRING HOP ONLY: opens a `sealForPairing` box whose authenticity the pairing protocol
 * established out of band. Returns a new ring for `expectedVaultId` carrying the recovery public
 * keys from the payload (this is how they get pinned on a new device). Throws `auth_failed`,
 * `vault_mismatch`, `generation_gap` or `bad_payload`.
 */
export function openPairingWrap(
  sodium: Sodium,
  sealed: Uint8Array,
  recipient: { box: BoxKeyPair },
  expectedVaultId: string,
): Keyring {
  const payload = openSealed(sodium, sealed, recipient);
  let incoming: Keyring;
  try {
    incoming = decodeKeyPayload(sodium, payload);
  } finally {
    payload.fill(0);
  }
  try {
    if (incoming.vaultId !== expectedVaultId) throw new CryptoError("vault_mismatch");
    const ring = emptyLike(incoming);
    ring.merge(incoming);
    return ring;
  } finally {
    incoming.wipe();
  }
}

function openSealed(
  sodium: Sodium,
  sealed: Uint8Array,
  recipient: { box: BoxKeyPair },
): Uint8Array {
  if (sealed.length < SEAL_OVERHEAD) throw new CryptoError("auth_failed");
  return sodium.sealOpen(sealed, recipient.box.publicKey, recipient.box.secretKey.expose());
}
