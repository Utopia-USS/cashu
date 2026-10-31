// Key wrapping: the key payload (keys.ts) sealed for one recipient.
//
// Signed wrap (`wrapKeys` / `unwrapKeys`), for every hop after pairing:
//   wire = 0x03 | sender device id (16) | Ed25519 signature (64) | recipients | sealed
//   recipients = u16 count | device ids (16 each) the rotation was wrapped for
//   sealed = crypto_box_seal(key payload v3, recipient box public key)
//   signature over "cashu/wrap/v3" | lp(vault id) | sender id | recipient id | recipient box pk |
//                  recipients | sealed
// The recipient verifies the signature against the sender's signing key BEFORE opening, and only
// for senders the caller trusts (registered and not revoked, S29), so storage or a relay cannot
// plant keys.
//
// Pairing hop (`sealForPairing` / `openPairingWrap`): a plain X25519 sealed box. It authenticates
// the content but NOT the sender, so it is only for the first hop to a new device, and only when the
// exchange is authenticated out of band (QR scanned in person, or a short authentication string).

import { TrustedDevice } from "./cert.js";
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
  type KeyEntry,
  type Keyring,
} from "./keys.js";
import { PUBLIC_KEY_BYTES, SEAL_OVERHEAD, type Sodium } from "./sodium.js";

export const WRAP_VERSION = 3;
const WRAP_CONTEXT = utf8("cashu/wrap/v3");
const WRAP_HEADER_BYTES = 1 + DEVICE_ID_BYTES + SIGNATURE_BYTES;
/** Most recipients one rotation can list (devices + recovery). */
export const MAX_WRAP_RECIPIENTS = 1024;

/**
 * Returns the Ed25519 public key of a sender this device trusts (certified, registered and not
 * revoked; for `RECOVERY_SIGNER_ID`, the vault's recovery signing key), else undefined.
 */
export type TrustedSigner = (deviceId: string) => Uint8Array | undefined;

export interface UnwrapOptions {
  /**
   * Checks each new key's claimed epoch against what the caller knows about its sender (S29: the
   * signed registry's revocation count). Returning false refuses the whole wrap (`untrusted_sender`).
   */
  acceptEpoch?: (senderDeviceId: string, entry: KeyEntry) => boolean;
}

export interface Unwrapped {
  ring: Keyring;
  senderDeviceId: string;
  /** Every device (and `RECOVERY_SIGNER_ID`) the sender wrapped these keys for in this rotation; signed. */
  recipients: string[];
}

/** Where wraps for the vault's recovery key are sealed to. */
export function recoveryRecipient(ring: Keyring): RecoveryRecipient {
  return new RecoveryRecipient(INTERNAL, ring.recovery.boxPublicKey);
}

const INTERNAL = Symbol("recovery-recipient");

/** The vault's recovery key as a wrap recipient; its box key is the one pinned in the keyring. */
export class RecoveryRecipient {
  // ES private field: makes the type nominal and backs the runtime check in `is`.
  readonly #brand = true;
  readonly deviceId = RECOVERY_SIGNER_ID;
  readonly boxPublicKey: Uint8Array;

  /** Not public API: use `recoveryRecipient(ring)`. */
  constructor(token: typeof INTERNAL, boxPublicKey: Uint8Array) {
    if (token !== INTERNAL) throw new TypeError("use recoveryRecipient");
    this.boxPublicKey = boxPublicKey.slice();
  }

  /** True only for objects made by `recoveryRecipient` (survives no copy or spread). */
  static is(value: unknown): value is RecoveryRecipient {
    return typeof value === "object" && value !== null && #brand in value;
  }
}

function isRecipientId(id: string): boolean {
  return isDeviceId(id) || id === RECOVERY_SIGNER_ID;
}

function encodeRecipients(ids: readonly string[]): Uint8Array {
  const count = new Uint8Array(2);
  new DataView(count.buffer).setUint16(0, ids.length);
  return concat(count, ...ids.map(fromHex));
}

function signedMessage(
  vaultId: string,
  senderId: Uint8Array,
  recipient: WrapRecipient,
  recipients: Uint8Array,
  sealed: Uint8Array,
): Uint8Array {
  // Without the context: `sign` prepends it, verification below prepends WRAP_CONTEXT.
  return concat(
    lengthPrefixed(utf8(vaultId)),
    senderId,
    fromHex(recipient.deviceId),
    recipient.boxPublicKey,
    recipients,
    sealed,
  );
}

function checkRecipient(recipient: WrapRecipient): void {
  if (!isRecipientId(recipient.deviceId)) throw new RangeError("recipient device id is invalid");
  if (recipient.boxPublicKey.length !== PUBLIC_KEY_BYTES) {
    throw new RangeError("public key must be 32 bytes");
  }
}

function checkRecipientList(recipient: WrapRecipient, recipients: readonly string[]): void {
  if (
    recipients.length === 0 ||
    recipients.length > MAX_WRAP_RECIPIENTS ||
    new Set(recipients).size !== recipients.length ||
    !recipients.every(isRecipientId) ||
    !recipients.includes(recipient.deviceId)
  ) {
    throw new RangeError("recipients must be distinct valid ids including the recipient");
  }
}

/**
 * Seals the ring's keys (all of them, or only `kids`, e.g. just the new generation after a
 * rotation) for one recipient and signs the result as `sender`. `recipients` lists every device
 * (and `RECOVERY_SIGNER_ID`) this rotation is wrapped for; it is signed, so S29 can tell whether a
 * key ever went to a device it has since revoked. Safe to put in a synced folder or a relay.
 * `recipient` is a `TrustedDevice` (its box key came from a verified certificate) or the ring's
 * `recoveryRecipient`: a box key read from storage can never be sealed for.
 */
export function wrapKeys(
  sodium: Sodium,
  ring: Keyring,
  sender: DeviceIdentity | RecoveryIdentity,
  recipient: TrustedDevice | RecoveryRecipient,
  kids?: readonly string[],
  recipients: readonly string[] = [recipient.deviceId],
): Uint8Array {
  if (!(TrustedDevice.is(recipient) || RecoveryRecipient.is(recipient))) {
    throw new TypeError("wrap recipients come from verifyCertificates or recoveryRecipient");
  }
  checkRecipient(recipient);
  checkRecipientList(recipient, recipients);
  const payload = encodeKeyPayload(ring, kids);
  let sealed: Uint8Array;
  try {
    sealed = sodium.seal(payload, recipient.boxPublicKey);
  } finally {
    payload.fill(0);
  }
  const senderId = fromHex(sender.deviceId);
  const list = encodeRecipients(recipients);
  const signature = sender.sign(
    "cashu/wrap/v3",
    signedMessage(ring.vaultId, senderId, recipient, list, sealed),
  );
  return concat(Uint8Array.of(WRAP_VERSION), senderId, signature, list, sealed);
}

/**
 * Verifies and opens a signed wrap, then merges its keys under the acceptance policy:
 * - into `target` when it is a Keyring (mutated in place, all or nothing; a wrap may add at most
 *   one generation above the highest held, so one wrap cannot flood the ring), or
 * - into a new ring when `target` names the vault and its recovery public keys (a device with no
 *   keys yet, e.g. one recovering from the words).
 * Throws `truncated` / `unsupported_version` (malformed header), `untrusted_sender` (signer unknown
 * to `trustedSigner`, or an epoch refused by `acceptEpoch`), `auth_failed` (bad signature, or not
 * sealed for `recipient`), `vault_mismatch`, `recovery_key_mismatch`, `gid_salt_mismatch`,
 * `generation_gap`, `epoch_gap`, `bad_payload`.
 */
export function unwrapKeys(
  sodium: Sodium,
  wire: Uint8Array,
  recipient: DeviceIdentity | RecoveryIdentity,
  target: Keyring | { vaultId: string; recoveryPublicKey: RecoveryPublicKeys },
  trustedSigner: TrustedSigner,
  options: UnwrapOptions = {},
): Unwrapped {
  const vaultId = target.vaultId;
  assertVaultId(vaultId);
  if (wire.length < WRAP_HEADER_BYTES + 2) throw new CryptoError("truncated");
  if (wire[0] !== WRAP_VERSION) throw new CryptoError("unsupported_version");
  const senderId = wire.subarray(1, 1 + DEVICE_ID_BYTES);
  const signature = wire.subarray(1 + DEVICE_ID_BYTES, WRAP_HEADER_BYTES);
  const count = new DataView(wire.buffer, wire.byteOffset + WRAP_HEADER_BYTES, 2).getUint16(0);
  const listEnd = WRAP_HEADER_BYTES + 2 + count * DEVICE_ID_BYTES;
  if (wire.length < listEnd) throw new CryptoError("truncated");
  const list = wire.subarray(WRAP_HEADER_BYTES, listEnd);
  const sealed = wire.subarray(listEnd);
  const senderDeviceId = toHex(senderId);
  if (!isRecipientId(senderDeviceId)) throw new CryptoError("untrusted_sender");
  const signPublicKey = trustedSigner(senderDeviceId);
  if (!signPublicKey) throw new CryptoError("untrusted_sender");
  const message = concat(
    WRAP_CONTEXT,
    signedMessage(vaultId, senderId, recipient.recipient, list, sealed),
  );
  if (!verifySignature(signature, message, signPublicKey)) throw new CryptoError("auth_failed");

  // Signed by a trusted sender from here on; a list that does not name this recipient is malformed.
  const recipients: string[] = [];
  for (let i = 0; i < count; i++) {
    recipients.push(toHex(list.subarray(2 + i * DEVICE_ID_BYTES, 2 + (i + 1) * DEVICE_ID_BYTES)));
  }
  if (
    !recipients.every(isRecipientId) ||
    !recipients.includes(recipient.deviceId) ||
    new Set(recipients).size !== count
  ) {
    throw new CryptoError("bad_payload");
  }

  const payload = openSealed(sodium, sealed, recipient);
  let incoming: Keyring;
  try {
    incoming = decodeKeyPayload(sodium, payload);
  } finally {
    payload.fill(0);
  }
  try {
    if (incoming.vaultId !== vaultId) throw new CryptoError("vault_mismatch");
    const existing = "recoveryPublicKey" in target ? undefined : target;
    const fresh = incoming.entries().filter((e) => !existing?.get(e.kid));
    if (existing && fresh.some((e) => e.generation > existing.maxGeneration + 1)) {
      throw new CryptoError("generation_gap");
    }
    if (options.acceptEpoch && !fresh.every((e) => options.acceptEpoch?.(senderDeviceId, e))) {
      throw new CryptoError("untrusted_sender");
    }
    if (!existing) {
      const pinned = (target as { recoveryPublicKey: RecoveryPublicKeys }).recoveryPublicKey;
      if (!samePublicKeys(incoming.recovery, pinned)) {
        throw new CryptoError("recovery_key_mismatch");
      }
      const ring = emptyLike(incoming);
      ring.merge(incoming);
      return { ring, senderDeviceId, recipients };
    }
    existing.merge(incoming);
    return { ring: existing, senderDeviceId, recipients };
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
