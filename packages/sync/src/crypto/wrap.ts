// Key wrapping: the key payload (keys.ts) sealed for one recipient.
//
// Signed wrap (`wrapKeys` / `unwrapKeys`), for every hop after pairing:
//   wire = 0x02 | sender device id (16) | Ed25519 signature (64) | sealed
//   sealed = crypto_box_seal(key payload v2, recipient box public key)
//   signature over "cashu/wrap/v2" | lp(vault id) | sender id | recipient id | recipient box pk | sealed
// The recipient verifies the signature against the sender's signing key BEFORE opening, and only
// for senders the caller trusts (registered and not revoked, S29), so storage or a relay cannot
// plant keys.
//
// Pairing hop (`sealForPairing` / `openPairingWrap`): a plain X25519 sealed box. It authenticates
// the content but NOT the sender, so it is only for the first hop to a new device, and only when the
// exchange is authenticated out of band (QR scanned in person, or a short authentication string).

import { concat, fromHex, lengthPrefixed, toHex, utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import {
  type BoxKeyPair,
  DEVICE_ID_BYTES,
  type DeviceIdentity,
  isDeviceId,
  RECOVERY_SIGNER_ID,
  type RecoveryIdentity,
  type RecoveryPublicKeys,
  SIGNATURE_BYTES,
  verifySignature,
  type WrapRecipient,
} from "./identity.js";
import {
  assertVaultId,
  decodeKeyPayload,
  emptyLike,
  encodeKeyPayload,
  type Keyring,
} from "./keys.js";
import { PUBLIC_KEY_BYTES, SEAL_OVERHEAD, type Sodium } from "./sodium.js";

export const WRAP_VERSION = 2;
const WRAP_CONTEXT = utf8("cashu/wrap/v2");
const WRAP_HEADER_BYTES = 1 + DEVICE_ID_BYTES + SIGNATURE_BYTES;

/**
 * Returns the Ed25519 public key of a sender this device trusts (registered and not revoked;
 * for `RECOVERY_SIGNER_ID`, the vault's recovery signing key if the caller accepts it), else undefined.
 */
export type TrustedSigner = (deviceId: string) => Uint8Array | undefined;

/** Where wraps for the vault's recovery key are sealed to. */
export function recoveryRecipient(ring: Keyring): WrapRecipient {
  return { deviceId: RECOVERY_SIGNER_ID, boxPublicKey: ring.recovery.boxPublicKey };
}

function signedMessage(
  vaultId: string,
  senderId: Uint8Array,
  recipient: WrapRecipient,
  sealed: Uint8Array,
): Uint8Array {
  return concat(
    WRAP_CONTEXT,
    lengthPrefixed(utf8(vaultId)),
    senderId,
    fromHex(recipient.deviceId),
    recipient.boxPublicKey,
    sealed,
  );
}

function checkRecipient(recipient: WrapRecipient): void {
  if (!isDeviceId(recipient.deviceId) && recipient.deviceId !== RECOVERY_SIGNER_ID) {
    throw new RangeError("recipient device id is invalid");
  }
  if (recipient.boxPublicKey.length !== PUBLIC_KEY_BYTES) {
    throw new RangeError("public key must be 32 bytes");
  }
}

/**
 * Seals the ring's keys (all of them, or only `kids`, e.g. just the new generation after a
 * revocation) for one recipient and signs the result as `sender`. Safe to put in a synced folder
 * or a relay.
 */
export function wrapKeys(
  sodium: Sodium,
  ring: Keyring,
  sender: DeviceIdentity | RecoveryIdentity,
  recipient: WrapRecipient,
  kids?: readonly string[],
): Uint8Array {
  checkRecipient(recipient);
  const payload = encodeKeyPayload(ring, kids);
  let sealed: Uint8Array;
  try {
    sealed = sodium.seal(payload, recipient.boxPublicKey);
  } finally {
    payload.fill(0);
  }
  const senderId = fromHex(sender.deviceId);
  const signature = sender.sign(signedMessage(ring.vaultId, senderId, recipient, sealed));
  return concat(Uint8Array.of(WRAP_VERSION), senderId, signature, sealed);
}

/**
 * Verifies and opens a signed wrap, then merges its keys under the acceptance policy:
 * - into `target` when it is a Keyring (mutated in place, all or nothing), or
 * - into a new ring when `target` names the vault and its recovery public keys (a device with no
 *   keys yet, e.g. one recovering from the words).
 * Throws `truncated` / `unsupported_version` (malformed header), `untrusted_sender` (the signer
 * is unknown to `trustedSigner`), `auth_failed` (bad signature, or not sealed for `recipient`),
 * `vault_mismatch`, `recovery_key_mismatch`, `gid_salt_mismatch`, `generation_gap`, `bad_payload`.
 */
export function unwrapKeys(
  sodium: Sodium,
  wire: Uint8Array,
  recipient: DeviceIdentity | RecoveryIdentity,
  target: Keyring | { vaultId: string; recoveryPublicKey: RecoveryPublicKeys },
  trustedSigner: TrustedSigner,
): { ring: Keyring; senderDeviceId: string } {
  const vaultId = target.vaultId;
  assertVaultId(vaultId);
  if (wire.length < WRAP_HEADER_BYTES) throw new CryptoError("truncated");
  if (wire[0] !== WRAP_VERSION) throw new CryptoError("unsupported_version");
  const senderId = wire.subarray(1, 1 + DEVICE_ID_BYTES);
  const signature = wire.subarray(1 + DEVICE_ID_BYTES, WRAP_HEADER_BYTES);
  const sealed = wire.subarray(WRAP_HEADER_BYTES);
  const senderDeviceId = toHex(senderId);
  if (!isDeviceId(senderDeviceId) && senderDeviceId !== RECOVERY_SIGNER_ID) {
    throw new CryptoError("untrusted_sender");
  }
  const signPublicKey = trustedSigner(senderDeviceId);
  if (!signPublicKey) throw new CryptoError("untrusted_sender");
  const message = signedMessage(vaultId, senderId, recipient.recipient, sealed);
  if (!verifySignature(signature, message, signPublicKey)) throw new CryptoError("auth_failed");

  const payload = openSealed(sodium, sealed, recipient);
  let incoming: Keyring;
  try {
    incoming = decodeKeyPayload(sodium, payload);
  } finally {
    payload.fill(0);
  }
  try {
    if (incoming.vaultId !== vaultId) throw new CryptoError("vault_mismatch");
    if ("recoveryPublicKey" in target) {
      if (!samePublicKeys(incoming.recovery, target.recoveryPublicKey)) {
        throw new CryptoError("recovery_key_mismatch");
      }
      const ring = emptyLike(incoming);
      ring.merge(incoming);
      return { ring, senderDeviceId };
    }
    target.merge(incoming);
    return { ring: target, senderDeviceId };
  } finally {
    incoming.wipe();
  }
}

function samePublicKeys(a: RecoveryPublicKeys, b: RecoveryPublicKeys): boolean {
  const eq = (x: Uint8Array, y: Uint8Array) =>
    x.length === y.length && x.every((v, i) => v === y[i]);
  return eq(a.boxPublicKey, b.boxPublicKey) && eq(a.signPublicKey, b.signPublicKey);
}

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
  recipient: DeviceIdentity,
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
