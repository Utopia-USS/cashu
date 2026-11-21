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
// reported, never resolved by order. Revoking a certified device is S29's signed registry, which
// passes the revoked ids in (`verify(revoked)`): a revoked id and its certificate subtree lose trust.
// `CertificateIndex` parses a vault's certificates once and caches signature checks across calls, so
// the registry can recompute trust after every change in linear time (S29b, review M4).

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
  // ES private fields: the type is nominal (backs `is`) and the key bytes cannot be changed in place.
  readonly #brand = true;
  readonly #signPublicKey: Uint8Array;
  readonly #boxPublicKey: Uint8Array;
  readonly #issuers: readonly string[];
  readonly deviceId: string;
  /** The vault whose certificates vouched for this device; `wrapKeys` refuses any other vault. */
  readonly vaultId: string;

  /** Not public API: use `verifyCertificates`. */
  constructor(
    token: typeof INTERNAL,
    vaultId: string,
    deviceId: string,
    keys: { signPublicKey: Uint8Array; boxPublicKey: Uint8Array },
    issuers: readonly string[],
  ) {
    if (token !== INTERNAL) throw new TypeError("use verifyCertificates");
    this.vaultId = vaultId;
    this.deviceId = deviceId;
    this.#signPublicKey = keys.signPublicKey.slice();
    this.#boxPublicKey = keys.boxPublicKey.slice();
    this.#issuers = [...issuers];
  }

  /** A copy of the certified Ed25519 key. */
  get signPublicKey(): Uint8Array {
    return this.#signPublicKey.slice();
  }

  /** A copy of the certified X25519 key: the only box key wraps are sealed for. */
  get boxPublicKey(): Uint8Array {
    return this.#boxPublicKey.slice();
  }

  /** Signer ids (devices, or `RECOVERY_SIGNER_ID`) of the valid certificates that vouch for it. */
  get issuers(): string[] {
    return [...this.#issuers];
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

/** The fields of a well-formed certificate (its signature is NOT checked here). */
export interface ParsedCertificate {
  readonly signerId: string;
  readonly subjectId: string;
  readonly signPublicKey: Uint8Array;
  readonly boxPublicKey: Uint8Array;
}

interface ParsedCert extends ParsedCertificate {
  readonly bytes: Uint8Array;
  readonly hex: string;
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
    hex: toHex(cert),
    signerId,
    subjectId,
    signPublicKey: cert.slice(at, at + PUBLIC_KEY_BYTES),
    boxPublicKey: cert.slice(at + PUBLIC_KEY_BYTES, at + 2 * PUBLIC_KEY_BYTES),
  };
}

/** Reads a certificate's signer, subject and keys without verifying it (undefined if malformed). */
export function parseCertificate(cert: Uint8Array): ParsedCertificate | undefined {
  const c = parse(cert);
  return (
    c && {
      signerId: c.signerId,
      subjectId: c.subjectId,
      signPublicKey: c.signPublicKey.slice(),
      boxPublicKey: c.boxPublicKey.slice(),
    }
  );
}

/**
 * Remembers certificate signature checks across calls (by certificate bytes and signer key), so a
 * registry that re-folds on every change verifies each certificate signature once. Bounded: the
 * oldest entries are dropped first, never the whole cache at once.
 */
export class CertificateCache {
  readonly #results = new Map<string, boolean>();
  readonly #max: number;

  constructor(maxEntries = 100_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries");
    this.#max = maxEntries;
  }

  /** Not public API. */
  check(key: string, verify: () => boolean): boolean {
    const hit = this.#results.get(key);
    if (hit !== undefined) return hit;
    const ok = verify();
    if (this.#results.size >= this.#max) {
      const oldest = this.#results.keys().next();
      if (!oldest.done) this.#results.delete(oldest.value);
    }
    this.#results.set(key, ok);
    return ok;
  }
}

/** One certified key pair of a device, with the signer ids whose valid certificates vouch for it. */
export interface CandidateKey {
  readonly deviceId: string;
  readonly signPublicKey: Uint8Array;
  readonly boxPublicKey: Uint8Array;
  readonly issuers: readonly string[];
}

interface Node {
  readonly id: string;
  readonly key: string;
  readonly signPublicKey: Uint8Array;
  readonly boxPublicKey?: Uint8Array;
  readonly issuers: Set<string>;
}

const nodeKey = (id: string, sign: Uint8Array, box: Uint8Array | undefined) =>
  `${id}:${toHex(sign)}:${box ? toHex(box) : ""}`;

/**
 * Every key pair reachable from the recovery key through valid certificates while avoiding a set of
 * excluded ids (neither certified nor certifying). Conflicts are NOT resolved here: an id may have
 * several candidate key pairs (`CertificateIndex.verify` resolves them, failing closed).
 */
export class CertificateClosure {
  readonly #index: CertificateIndex;
  readonly #byId: Map<string, Node[]>;

  /** Not public API: use `CertificateIndex.closure`. */
  constructor(index: CertificateIndex, byId: Map<string, Node[]>) {
    this.#index = index;
    this.#byId = byId;
  }

  /** Device ids with at least one reachable key pair. */
  ids(): string[] {
    return [...this.#byId.keys()].filter((id) => id !== RECOVERY_SIGNER_ID).sort();
  }

  /** The reachable key pairs of a device (empty when it is excluded or unreachable). */
  keysOf(deviceId: string): CandidateKey[] {
    return (this.#byId.get(deviceId) ?? []).flatMap((n) => (n.boxPublicKey ? [candidate(n)] : []));
  }

  /**
   * The key pairs of `deviceId` that a reachable signer certified, even when `deviceId` itself was
   * excluded: what a revoked device's key was before it was cut (its own certificates are ignored).
   */
  certifiedKeysOf(deviceId: string): CandidateKey[] {
    const found = new Map<string, Node>();
    for (const c of this.#index.certsAbout(deviceId)) {
      for (const signer of this.#byId.get(c.signerId) ?? []) {
        if (!this.#index.valid(c, signer.signPublicKey)) continue;
        const key = nodeKey(c.subjectId, c.signPublicKey, c.boxPublicKey);
        const node = found.get(key) ?? {
          id: c.subjectId,
          key,
          signPublicKey: c.signPublicKey,
          boxPublicKey: c.boxPublicKey,
          issuers: new Set<string>(),
        };
        node.issuers.add(c.signerId);
        found.set(key, node);
      }
    }
    return [...found.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map(candidate);
  }
}

function candidate(n: Node): CandidateKey {
  return {
    deviceId: n.id,
    signPublicKey: n.signPublicKey.slice(),
    boxPublicKey: (n.boxPublicKey as Uint8Array).slice(),
    issuers: [...n.issuers].sort(),
  };
}

export interface CertificateIndexOptions {
  /** Shared signature-check cache (pass the same one to every index of a vault). */
  readonly cache?: CertificateCache;
  /**
   * At most this many distinct device ids are admitted, breadth first from the recovery key, and
   * within one depth in (device id, keys) order; the rest are unreachable. Default: no limit.
   */
  readonly maxDevices?: number;
}

/**
 * The certificates of one vault, parsed and indexed once. `closure(excluded)` is a breadth-first
 * search (each certificate is visited once per reachable signer key, each signature checked once
 * per index and remembered in the cache), so a registry can recompute trust after every change in
 * time linear in the number of certificates.
 */
export class CertificateIndex {
  readonly vaultId: string;
  readonly #root: Node;
  readonly #bySigner = new Map<string, ParsedCert[]>();
  readonly #bySubject = new Map<string, ParsedCert[]>();
  readonly #cache: CertificateCache;
  readonly #maxDevices: number;

  constructor(
    _sodium: Sodium,
    vaultId: string,
    recoverySignPublicKey: Uint8Array,
    certs: readonly Uint8Array[],
    options: CertificateIndexOptions = {},
  ) {
    assertVaultId(vaultId);
    if (recoverySignPublicKey.length !== PUBLIC_KEY_BYTES) throw new CryptoError("bad_payload");
    this.vaultId = vaultId;
    this.#cache = options.cache ?? new CertificateCache();
    this.#maxDevices = options.maxDevices ?? Number.POSITIVE_INFINITY;
    this.#root = {
      id: RECOVERY_SIGNER_ID,
      key: nodeKey(RECOVERY_SIGNER_ID, recoverySignPublicKey, undefined),
      signPublicKey: recoverySignPublicKey.slice(),
      issuers: new Set(),
    };
    const seen = new Set<string>();
    for (const bytes of certs) {
      const c = parse(bytes);
      if (!c || seen.has(c.hex)) continue;
      seen.add(c.hex);
      push(this.#bySigner, c.signerId, c);
      push(this.#bySubject, c.subjectId, c);
    }
  }

  /** Not public API. */
  certsAbout(subjectId: string): readonly ParsedCert[] {
    return this.#bySubject.get(subjectId) ?? [];
  }

  /** Is `cert` well formed and signed by `signPublicKey` for this vault (cached)? */
  isSignedBy(cert: Uint8Array, signPublicKey: Uint8Array): boolean {
    const c = parse(cert);
    return c !== undefined && this.valid(c, signPublicKey);
  }

  /** Not public API: is `c` validly signed by `signPublicKey` for this vault (cached)? */
  valid(c: ParsedCert, signPublicKey: Uint8Array): boolean {
    return this.#cache.check(`${this.vaultId}|${c.hex}|${toHex(signPublicKey)}`, () => {
      const message = concat(
        CERT_CONTEXT,
        signedBody(this.vaultId, c.bytes.subarray(0, BODY_BYTES)),
      );
      return verifySignature(c.bytes.subarray(BODY_BYTES), message, signPublicKey);
    });
  }

  /** Every key pair reachable from the recovery key avoiding `excluded` (breadth first). */
  closure(excluded: ReadonlySet<string>): CertificateClosure {
    const reached = new Map<string, Node>([[this.#root.key, this.#root]]);
    const byId = new Map<string, Node[]>([[RECOVERY_SIGNER_ID, [this.#root]]]);
    let frontier: Node[] = [this.#root];
    while (frontier.length > 0) {
      const level = new Map<string, Node>();
      for (const signer of frontier) {
        for (const c of this.#bySigner.get(signer.id) ?? []) {
          if (excluded.has(c.subjectId) || excluded.has(c.signerId)) continue;
          if (!this.valid(c, signer.signPublicKey)) continue;
          const key = nodeKey(c.subjectId, c.signPublicKey, c.boxPublicKey);
          const node = reached.get(key) ?? level.get(key);
          if (node) {
            node.issuers.add(c.signerId);
            continue;
          }
          level.set(key, {
            id: c.subjectId,
            key,
            signPublicKey: c.signPublicKey,
            boxPublicKey: c.boxPublicKey,
            issuers: new Set([c.signerId]),
          });
        }
      }
      frontier = [];
      for (const key of [...level.keys()].sort()) {
        const node = level.get(key) as Node;
        if (!byId.has(node.id) && byId.size - 1 >= this.#maxDevices) continue;
        reached.set(key, node);
        push(byId, node.id, node);
        frontier.push(node);
      }
    }
    return new CertificateClosure(this, byId);
  }

  /**
   * Trust with conflicts resolved, failing closed: a device id with two candidate key pairs is
   * excluded (and passes no trust on), and the closure is recomputed until no new conflict appears.
   * Revoked devices are cut from the start, so their certificate subtree loses trust unless another
   * trusted path vouches for a device.
   */
  verify(revoked: ReadonlySet<string>): CertificateCheck {
    const excluded = new Set<string>(revoked);
    for (;;) {
      const closure = this.closure(excluded);
      const fresh = closure.ids().filter((id) => closure.keysOf(id).length > 1);
      if (fresh.length === 0) {
        const devices = new Map<string, TrustedDevice>();
        for (const id of closure.ids()) {
          const [k] = closure.keysOf(id);
          if (k) devices.set(id, new TrustedDevice(INTERNAL, this.vaultId, id, k, k.issuers));
        }
        const conflicts = [...excluded].filter((id) => !revoked.has(id)).sort();
        return { devices, conflicts };
      }
      for (const id of fresh) excluded.add(id);
    }
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Verifies device certificates for a vault. Every (device id, sign key, box key) reachable from the
 * recovery signing key through valid certificates is a candidate. A device id with more than one
 * candidate is CONFLICTED: it is excluded, trust does not flow through it, and the closure is
 * recomputed until no new conflict appears. The result depends only on the SET of certificates,
 * never on their order, chain depth or id order. Malformed certificates, unknown signers, bad
 * signatures and cycles never make a device trusted; the same key pair certified twice is no conflict.
 */
export function verifyCertificates(
  sodium: Sodium,
  vaultId: string,
  recoverySignPublicKey: Uint8Array,
  certs: readonly Uint8Array[],
  revoked: ReadonlySet<string>,
  options: CertificateIndexOptions = {},
): CertificateCheck {
  return new CertificateIndex(sodium, vaultId, recoverySignPublicKey, certs, options).verify(
    revoked,
  );
}
