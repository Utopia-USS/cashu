// Device certificates: the trust root a recovering device (or any device) can check without trusting
// storage. The recovery identity certifies the creating device at vault creation, while the words are
// on screen; every later device is certified by an already trusted device when it is paired. A
// device is trusted only through a chain of valid certificates rooted at the vault's recovery signing
// key, so a registry file in storage cannot add a "device" of its own.
//
//   cert   = 0x01 | signer id (16) | subject id (16) | subject sign pk (32) | subject box pk (32) | sig (64)
//   signed = "cashu/cert/v1" | lp(vault id) | signer id | subject id | subject sign pk | subject box pk
//
// Conflicting certificates (one device id, two key pairs) fail closed: the id is untrusted and
// reported, never resolved by order. Revoking a certified device is S29's signed registry; until it
// lands, a revoked device's certificate still validates here (known gap, see README).

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

const CERT_VERSION = 1;
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
  // lp(vault id) | body without the version byte; `sign` / verification prepend CERT_CONTEXT.
  return concat(lengthPrefixed(utf8(vaultId)), body.subarray(1));
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
  return concat(body, signer.sign("cashu/cert/v1", signedBody(vaultId, body)));
}

const INTERNAL = Symbol("trusted-device");

/**
 * A device whose id, signing key and box key were verified through a certificate chain. Only
 * `verifyCertificates` creates these, so wraps (`wrapKeys`) can only be sealed for box keys that came
 * from verified certificates, never from a registry file in storage.
 */
export class TrustedDevice {
  // ES private field: makes the type nominal and backs the runtime check in `is`.
  readonly #brand = true;
  readonly deviceId: string;
  readonly signPublicKey: Uint8Array;
  readonly boxPublicKey: Uint8Array;

  /** Not public API: use `verifyCertificates`. */
  constructor(
    token: typeof INTERNAL,
    deviceId: string,
    signPublicKey: Uint8Array,
    boxPublicKey: Uint8Array,
  ) {
    if (token !== INTERNAL) throw new TypeError("use verifyCertificates");
    this.deviceId = deviceId;
    this.signPublicKey = signPublicKey.slice();
    this.boxPublicKey = boxPublicKey.slice();
  }

  /** True only for objects made by `verifyCertificates` (survives no copy or spread). */
  static is(value: unknown): value is TrustedDevice {
    return typeof value === "object" && value !== null && #brand in value;
  }
}

export interface CertificateCheck {
  /** Devices trusted through a chain rooted at the recovery key, with exactly one key pair each. */
  devices: Map<string, TrustedDevice>;
  /**
   * Device ids that valid chains certify with two or more different key pairs. Fail closed: they
   * are not trusted (nor anything trusted only through them), and the app must show them so the
   * owner can re-certify.
   */
  conflicts: string[];
}

interface ParsedCert {
  bytes: Uint8Array;
  signerId: string;
  subjectId: string;
  signPublicKey: Uint8Array;
  boxPublicKey: Uint8Array;
}

interface Node {
  id: string;
  signPublicKey: Uint8Array;
  boxPublicKey?: Uint8Array;
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
    boxPublicKey: cert.slice(at + PUBLIC_KEY_BYTES, at + 2 * PUBLIC_KEY_BYTES),
  };
}

const nodeKey = (n: Node) =>
  `${n.id}:${toHex(n.signPublicKey)}:${n.boxPublicKey ? toHex(n.boxPublicKey) : ""}`;

/**
 * Verifies device certificates for a vault. Every (device id, sign key, box key) reachable from the
 * recovery signing key through valid certificates is a candidate. A device id with more than one
 * candidate is CONFLICTED: it is excluded, trust does not flow through it, and the closure is
 * recomputed until no new conflict appears. The result depends only on the SET of certificates,
 * never on their order, chain depth or id order. Malformed certificates, unknown signers, bad
 * signatures and cycles never make a device trusted; the same key pair certified twice is no conflict.
 */
export function verifyCertificates(
  _sodium: Sodium,
  vaultId: string,
  recoverySignPublicKey: Uint8Array,
  certs: readonly Uint8Array[],
): CertificateCheck {
  assertVaultId(vaultId);
  if (recoverySignPublicKey.length !== PUBLIC_KEY_BYTES) throw new CryptoError("bad_payload");
  const parsed = certs.map(parse).filter((c): c is ParsedCert => c !== undefined);
  const root: Node = { id: RECOVERY_SIGNER_ID, signPublicKey: recoverySignPublicKey };
  const verified = new Map<string, boolean>();
  const valid = (index: number, c: ParsedCert, signer: Node): boolean => {
    const cacheKey = `${index}:${toHex(signer.signPublicKey)}`;
    let ok = verified.get(cacheKey);
    if (ok === undefined) {
      const message = concat(CERT_CONTEXT, signedBody(vaultId, c.bytes.subarray(0, BODY_BYTES)));
      ok = verifySignature(c.bytes.subarray(BODY_BYTES), message, signer.signPublicKey);
      verified.set(cacheKey, ok);
    }
    return ok;
  };

  const closure = (excluded: Set<string>): Map<string, Node> => {
    const reached = new Map<string, Node>([[nodeKey(root), root]]);
    let changed = true;
    while (changed) {
      changed = false;
      parsed.forEach((c, index) => {
        if (excluded.has(c.subjectId) || excluded.has(c.signerId)) return;
        const subject: Node = {
          id: c.subjectId,
          signPublicKey: c.signPublicKey,
          boxPublicKey: c.boxPublicKey,
        };
        if (reached.has(nodeKey(subject))) return;
        for (const signer of reached.values()) {
          if (signer.id === c.signerId && valid(index, c, signer)) {
            reached.set(nodeKey(subject), subject);
            changed = true;
            return;
          }
        }
      });
    }
    return reached;
  };

  const excluded = new Set<string>();
  for (;;) {
    const byId = new Map<string, Node[]>();
    for (const n of closure(excluded).values()) {
      if (n.id === RECOVERY_SIGNER_ID) continue;
      byId.set(n.id, [...(byId.get(n.id) ?? []), n]);
    }
    const fresh = [...byId].filter(([id, nodes]) => nodes.length > 1 && !excluded.has(id));
    if (fresh.length === 0) {
      const devices = new Map<string, TrustedDevice>();
      for (const [id, [n]] of byId) {
        if (n?.boxPublicKey)
          devices.set(id, new TrustedDevice(INTERNAL, id, n.signPublicKey, n.boxPublicKey));
      }
      return { devices, conflicts: [...excluded].sort() };
    }
    for (const [id] of fresh) excluded.add(id);
  }
}
