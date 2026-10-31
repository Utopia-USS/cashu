// The device registry: a pure fold over the signed `device.added` / `device.revoked` statements of a
// vault's log, rooted at the recovery signing key pinned in the keyring (never read from storage).
//
// - Trust comes ONLY from certificate chains (crypto `verifyCertificates`) over every certificate in
//   the set, with the revoked set: a revoked device and its certificate subtree are untrusted.
// - Revocations are resolved in log order (hlc, eid): one counts only if its signer is the recovery
//   identity, or a device trusted given the revocations before it, and it names at least one
//   registered device not yet revoked. Each counted event is one epoch step (crypto README: the
//   number of revocation events), so a device can claim at most `revocationCount` as a key epoch.
// - A revoked device keeps its statements written before its cut (its revocation point in its own
//   stream); everything it wrote at or after the cut is ignored, whatever HLC it claims.
// The result depends only on the SET of events: two devices holding the same set agree.

import type { SegmentCursor } from "../carrier.js";
import {
  RECOVERY_SIGNER_ID,
  type RecoveryPublicKeys,
  type Sodium,
  type TrustedDevice,
  type TrustedSigner,
  verifyCertificates,
} from "../crypto/index.js";
import { canonicalJson, equalBytes, fromHex, isCanonicalValue } from "./bytes.js";
import {
  byHlc,
  comparePositions,
  DEVICE_ADDED,
  DEVICE_REVOKED,
  type DeviceAddedData,
  type DeviceRevokedData,
  decodeDeviceAdded,
  decodeDeviceRevoked,
  type LogEvent,
  statementBody,
} from "./events.js";
import { type StatementVerifier, verifyStatement } from "./statements.js";

/** What the registry is rooted at: the vault id and the recovery keys pinned in the keyring. */
export interface TrustRoot {
  readonly vaultId: string;
  readonly recovery: RecoveryPublicKeys;
}

export interface Revocation {
  readonly device: string;
  readonly eid: string;
  readonly signer: string;
  /** First position of the device's own stream that is rejected. */
  readonly cut: SegmentCursor;
  /** 1-based count of the revocation event that revoked it (its epoch step). */
  readonly index: number;
  /** The device's certified signing key when it was revoked: verifies its statements before the cut. */
  readonly signPublicKey: Uint8Array | undefined;
}

export interface DeviceRecord {
  readonly deviceId: string;
  readonly name: string;
  readonly addedEid: string;
}

export type IgnoredReason =
  | "malformed"
  | "duplicate_eid"
  | "untrusted_signer"
  | "bad_signature"
  | "after_revocation"
  | "no_effect"
  | "key_mismatch";

export interface IgnoredStatement {
  readonly eid: string;
  readonly reason: IgnoredReason;
}

export interface RegistryOptions {
  /** Certificates known out of band: the vault creator's own, a paired device's own (pairing welcome). */
  readonly bootstrapCertificates?: readonly Uint8Array[];
  /** Signature check (default: `verifyStatement`); pass a `memoizedVerifier` when folding repeatedly. */
  readonly verify?: StatementVerifier;
}

const REGISTRY_TYPES = new Set<string>([DEVICE_ADDED, DEVICE_REVOKED]);

export function isRegistryEvent(event: LogEvent): boolean {
  return REGISTRY_TYPES.has(event.type);
}

export class Registry {
  readonly vaultId: string;
  readonly recovery: RecoveryPublicKeys;
  /** Certified, registered and not revoked (and not conflicted). */
  readonly trusted: ReadonlyMap<string, TrustedDevice>;
  /** Device ids certified with two key pairs: untrusted until re-certified (show them to the owner). */
  readonly conflicts: readonly string[];
  readonly revoked: ReadonlyMap<string, Revocation>;
  /** Counted revocation events: the highest key epoch any sender may claim. */
  readonly revocationCount: number;
  /** Display names of announced devices (trusted or revoked), from signed statements. */
  readonly devices: ReadonlyMap<string, DeviceRecord>;
  readonly ignored: readonly IgnoredStatement[];
  /** The well-formed registry events this registry was folded from (pairing welcomes carry them). */
  readonly events: readonly LogEvent[];
  readonly #sodium: Sodium;
  readonly #certificates: readonly Uint8Array[];
  readonly #registered: ReadonlySet<string>;

  /** Not public API: use `foldRegistry`. */
  constructor(parts: {
    sodium: Sodium;
    root: TrustRoot;
    trusted: ReadonlyMap<string, TrustedDevice>;
    conflicts: readonly string[];
    revoked: ReadonlyMap<string, Revocation>;
    revocationCount: number;
    devices: ReadonlyMap<string, DeviceRecord>;
    ignored: readonly IgnoredStatement[];
    events: readonly LogEvent[];
    certificates: readonly Uint8Array[];
    registered: ReadonlySet<string>;
  }) {
    this.#sodium = parts.sodium;
    this.vaultId = parts.root.vaultId;
    this.recovery = parts.root.recovery;
    this.trusted = parts.trusted;
    this.conflicts = parts.conflicts;
    this.revoked = parts.revoked;
    this.revocationCount = parts.revocationCount;
    this.devices = parts.devices;
    this.ignored = parts.ignored;
    this.events = parts.events;
    this.#certificates = parts.certificates;
    this.#registered = parts.registered;
  }

  isTrusted(deviceId: string): boolean {
    return this.trusted.has(deviceId);
  }

  /** A device that some certificate or statement registered (trusted, revoked or conflicted). */
  isRegistered(deviceId: string): boolean {
    return this.#registered.has(deviceId);
  }

  /**
   * For crypto `unwrapKeys`: the signing key of a sender that is certified, registered and not
   * revoked, or the pinned recovery signing key for `RECOVERY_SIGNER_ID`.
   */
  readonly trustedSigner: TrustedSigner = (deviceId) =>
    deviceId === RECOVERY_SIGNER_ID
      ? this.recovery.signPublicKey.slice()
      : this.trusted.get(deviceId)?.signPublicKey;

  /**
   * The key a statement written by `device` at `position` (cursor after its batch) verifies with:
   * the trusted key, or for a revoked device its key at revocation when the statement is before
   * the cut. Undefined otherwise (untrusted, or a revoked device's statement at or after its cut).
   */
  statementKey(device: string, position: SegmentCursor): Uint8Array | undefined {
    const trusted = this.trusted.get(device);
    if (trusted) return trusted.signPublicKey;
    const revocation = this.revoked.get(device);
    if (revocation && comparePositions(position, revocation.cut) <= 0) {
      return revocation.signPublicKey?.slice();
    }
    return undefined;
  }

  /** Trusted devices and the revocation count once `devices` are revoked too (before writing it). */
  previewRevocation(devices: readonly string[]): {
    trusted: ReadonlyMap<string, TrustedDevice>;
    revocationCount: number;
  } {
    const fresh = devices.filter((d) => this.#registered.has(d) && !this.revoked.has(d));
    if (fresh.length === 0) return { trusted: this.trusted, revocationCount: this.revocationCount };
    const revokedIds = new Set([...this.revoked.keys(), ...fresh]);
    const check = verifyCertificates(
      this.#sodium,
      this.vaultId,
      this.recovery.signPublicKey,
      this.#certificates,
      revokedIds,
    );
    return { trusted: check.devices, revocationCount: this.revocationCount + 1 };
  }
}

interface Decoded<T> {
  readonly event: LogEvent;
  readonly data: T;
}

/**
 * Folds the registry events of a vault (other event types are skipped). Never throws on log
 * content: malformed, forged or late statements are ignored and listed in `ignored`.
 */
export function foldRegistry(
  sodium: Sodium,
  root: TrustRoot,
  events: readonly LogEvent[],
  options: RegistryOptions = {},
): Registry {
  const verify = options.verify ?? verifyStatement;
  const ignored: IgnoredStatement[] = [];
  const { unique, duplicates } = dedupe(events.filter(isRegistryEvent));
  for (const eid of duplicates) ignored.push({ eid, reason: "duplicate_eid" });

  const added: Decoded<DeviceAddedData>[] = [];
  const revocations: Decoded<DeviceRevokedData>[] = [];
  for (const event of unique) {
    const data =
      event.v !== 1
        ? undefined
        : event.type === DEVICE_ADDED
          ? decodeDeviceAdded(event.data)
          : decodeDeviceRevoked(event.data);
    if (!data) {
      ignored.push({ eid: event.eid, reason: "malformed" });
    } else if ("certificate" in data) {
      added.push({ event, data });
    } else {
      revocations.push({ event, data });
    }
  }

  const certificates = [
    ...(options.bootstrapCertificates ?? []).map((c) => c.slice()),
    ...added.map((a) => fromHex(a.data.certificate)),
  ];
  const trustWith = (revoked: ReadonlySet<string>) =>
    verifyCertificates(sodium, root.vaultId, root.recovery.signPublicKey, certificates, revoked);
  const unrevoked = trustWith(new Set());
  // Registered = certified through a valid chain at some point (revocations ignored). A bare
  // `device.added` naming an uncertified id registers nothing, so revoking such an id never counts.
  const registered = new Set<string>([...unrevoked.devices.keys(), ...unrevoked.conflicts]);

  const revoked = new Map<string, Revocation>();
  let count = 0;
  let trust = unrevoked;
  const afterCut = (event: LogEvent) => {
    const r = revoked.get(event.writer);
    return r !== undefined && comparePositions(event.position, r.cut) > 0;
  };
  for (const { event, data } of revocations) {
    if (afterCut(event)) {
      ignored.push({ eid: event.eid, reason: "after_revocation" });
      continue;
    }
    const key = signerKey(
      root,
      data.signer,
      event.writer,
      (id) => trust.devices.get(id)?.signPublicKey,
    );
    if (!key) {
      ignored.push({ eid: event.eid, reason: "untrusted_signer" });
      continue;
    }
    const body = statementBody(root.vaultId, event.type, event.eid, event.data);
    if (!verify("cashu/registry/v1", body, fromHex(data.sig), key)) {
      ignored.push({ eid: event.eid, reason: "bad_signature" });
      continue;
    }
    const targets = data.devices.filter((d) => registered.has(d.device) && !revoked.has(d.device));
    if (targets.length === 0) {
      ignored.push({ eid: event.eid, reason: "no_effect" });
      continue;
    }
    count += 1;
    for (const t of targets) {
      revoked.set(t.device, {
        device: t.device,
        eid: event.eid,
        signer: data.signer,
        cut: t.cut,
        index: count,
        signPublicKey: trust.devices.get(t.device)?.signPublicKey,
      });
    }
    trust = trustWith(new Set(revoked.keys()));
  }

  const devices = new Map<string, DeviceRecord>();
  for (const { event, data } of added) {
    if (afterCut(event)) {
      ignored.push({ eid: event.eid, reason: "after_revocation" });
      continue;
    }
    const key = signerKey(root, data.signer, event.writer, (id) => {
      const t = trust.devices.get(id);
      if (t) return t.signPublicKey;
      const r = revoked.get(id);
      return r && comparePositions(event.position, r.cut) <= 0 ? r.signPublicKey : undefined;
    });
    if (!key) {
      ignored.push({ eid: event.eid, reason: "untrusted_signer" });
      continue;
    }
    const body = statementBody(root.vaultId, event.type, event.eid, event.data);
    if (!verify("cashu/registry/v1", body, fromHex(data.sig), key)) {
      ignored.push({ eid: event.eid, reason: "bad_signature" });
      continue;
    }
    // Names are kept for revoked and subtree-cut devices too (the owner must recognise them), so
    // the declared keys are checked against the certified keys ignoring revocations.
    const known = trust.devices.get(data.device) ?? unrevoked.devices.get(data.device);
    const keysMatch =
      known !== undefined &&
      equalBytes(known.signPublicKey, fromHex(data.signPublicKey)) &&
      equalBytes(known.boxPublicKey, fromHex(data.boxPublicKey));
    if (!keysMatch) {
      ignored.push({ eid: event.eid, reason: "key_mismatch" });
      continue;
    }
    if (!devices.has(data.device)) {
      devices.set(data.device, { deviceId: data.device, name: data.name, addedEid: event.eid });
    }
  }

  return new Registry({
    sodium,
    root,
    trusted: trust.devices,
    conflicts: trust.conflicts,
    revoked,
    revocationCount: count,
    devices,
    ignored,
    events: [...added, ...revocations].map((d) => d.event).sort(byHlc),
    certificates,
    registered,
  });
}

/** Statements are signed by their writer, or by the recovery identity (vault creation, restore). */
function signerKey(
  root: TrustRoot,
  signer: string,
  writer: string,
  deviceKey: (id: string) => Uint8Array | undefined,
): Uint8Array | undefined {
  if (signer === RECOVERY_SIGNER_ID) return root.recovery.signPublicKey;
  if (signer !== writer) return undefined;
  return deviceKey(signer);
}

/**
 * Sorts by (hlc, eid) and keeps the first event of each eid; a second event with the same eid and a
 * different body is corruption (events.md 2), reported and ignored.
 */
export function dedupe(events: readonly LogEvent[]): { unique: LogEvent[]; duplicates: string[] } {
  const sorted = [...events].sort(byHlc);
  const seen = new Map<string, string>();
  const unique: LogEvent[] = [];
  const duplicates: string[] = [];
  for (const e of sorted) {
    const fingerprint = fingerprintOf(e);
    const first = seen.get(e.eid);
    if (first === undefined) {
      seen.set(e.eid, fingerprint);
      unique.push(e);
    } else if (first !== fingerprint) {
      duplicates.push(e.eid);
    }
  }
  return { unique, duplicates };
}

function fingerprintOf(e: LogEvent): string {
  const head = JSON.stringify([e.type, e.v, e.hlc, e.writer, e.position.seg, e.position.offset]);
  // Canonical when possible, so the same event read back with another key order is no conflict.
  if (isCanonicalValue(e.data)) return head + canonicalJson(e.data);
  return `${head}#${e.eid}:unserializable`;
}
