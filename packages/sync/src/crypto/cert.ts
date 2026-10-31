// Device certificates: the trust root a recovering device (or any device) can check without trusting
// storage. The recovery identity certifies the creating device at vault creation, while the words are
// on screen; every later device is certified by an already trusted device when it is paired. A
// device is trusted only through a chain of valid certificates rooted at the vault's recovery signing
// key, so a registry file in storage cannot add a "device" of its own.
//
//   cert   = 0x01 | signer id (16) | subject id (16) | subject sign pk (32) | subject box pk (32) | sig (64)
//   signed = "cashu/cert/v1" | lp(vault id) | signer id | subject id | subject sign pk | subject box pk
//
// Revoking a certified device is S29's signed registry; until it lands, a revoked device's
// certificate still validates here (known gap, see README).

import { concat, fromHex, lengthPrefixed, toHex, utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import {
  DEVICE_ID_BYTES,
  type DeviceIdentity,
  isDeviceId,
  RECOVERY_SIGNER_ID,
  type RecoveryIdentity,
  SIGNATURE_BYTES,
  verifySignature,
} from "./identity.js";
import { assertVaultId } from "./keys.js";
import { PUBLIC_KEY_BYTES, type Sodium } from "./sodium.js";

export const CERT_VERSION = 1;
const CERT_CONTEXT = utf8("cashu/cert/v1");
const BODY_BYTES = 1 + 2 * DEVICE_ID_BYTES + 2 * PUBLIC_KEY_BYTES;
export const CERT_BYTES = BODY_BYTES + SIGNATURE_BYTES;

/** What a certificate vouches for: a device id and its two public keys. */
export interface CertSubject {
  deviceId: string;
  signPublicKey: Uint8Array;
  boxPublicKey: Uint8Array;
}

function signedBody(vaultId: string, body: Uint8Array): Uint8Array {
  // body without the version byte: signer id | subject id | sign pk | box pk
  return concat(CERT_CONTEXT, lengthPrefixed(utf8(vaultId)), body.subarray(1));
}

/** `signer` (the recovery identity or a trusted device) vouches for `subject` in this vault. */
export function certifyDevice(
  _sodium: Sodium,
  signer: DeviceIdentity | RecoveryIdentity,
  subject: CertSubject,
  vaultId: string,
): Uint8Array {
  assertVaultId(vaultId);
  if (!isDeviceId(subject.deviceId)) throw new RangeError("subject must be a device id");
  if (
    subject.signPublicKey.length !== PUBLIC_KEY_BYTES ||
    subject.boxPublicKey.length !== PUBLIC_KEY_BYTES
  ) {
    throw new RangeError("public keys must be 32 bytes");
  }
  const body = concat(
    Uint8Array.of(CERT_VERSION),
    fromHex(signer.deviceId),
    fromHex(subject.deviceId),
    subject.signPublicKey,
    subject.boxPublicKey,
  );
  return concat(body, signer.sign(signedBody(vaultId, body)));
}

interface ParsedCert {
  bytes: Uint8Array;
  signerId: string;
  subjectId: string;
  signPublicKey: Uint8Array;
}

function parse(cert: Uint8Array): ParsedCert | undefined {
  if (cert.length !== CERT_BYTES || cert[0] !== CERT_VERSION) return undefined;
  const signerId = toHex(cert.subarray(1, 1 + DEVICE_ID_BYTES));
  const subjectId = toHex(cert.subarray(1 + DEVICE_ID_BYTES, 1 + 2 * DEVICE_ID_BYTES));
  if (!(isDeviceId(signerId) || signerId === RECOVERY_SIGNER_ID) || !isDeviceId(subjectId)) {
    return undefined;
  }
  const at = 1 + 2 * DEVICE_ID_BYTES;
  return {
    bytes: cert,
    signerId,
    subjectId,
    signPublicKey: cert.slice(at, at + PUBLIC_KEY_BYTES),
  };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/**
 * The devices trusted through a chain of valid certificates rooted at `recoverySignPublicKey`, as
 * device id -> signing public key. Order independent (certificates are processed in a canonical
 * order until nothing changes); malformed certificates, unknown signers, bad signatures and cycles
 * never make a device trusted. The first trusted key for a device id wins; a later certificate
 * naming another key for that id is ignored. The recovery signer itself is not in the map.
 */
export function verifyCertificates(
  _sodium: Sodium,
  vaultId: string,
  recoverySignPublicKey: Uint8Array,
  certs: readonly Uint8Array[],
): Map<string, Uint8Array> {
  assertVaultId(vaultId);
  if (recoverySignPublicKey.length !== PUBLIC_KEY_BYTES) {
    throw new CryptoError("bad_payload");
  }
  const pending = certs
    .map(parse)
    .filter((c): c is ParsedCert => c !== undefined)
    .sort((a, b) => compareBytes(a.bytes, b.bytes));
  const trusted = new Map<string, Uint8Array>();
  const signerKey = (id: string) =>
    id === RECOVERY_SIGNER_ID ? recoverySignPublicKey : trusted.get(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i] as ParsedCert;
      if (trusted.has(c.subjectId)) {
        pending.splice(i--, 1);
        continue;
      }
      const key = signerKey(c.signerId);
      if (!key) continue;
      pending.splice(i--, 1);
      const body = c.bytes.subarray(0, BODY_BYTES);
      const signature = c.bytes.subarray(BODY_BYTES);
      if (verifySignature(signature, signedBody(vaultId, body), key)) {
        trusted.set(c.subjectId, c.signPublicKey);
        changed = true;
      }
    }
  }
  return trusted;
}
