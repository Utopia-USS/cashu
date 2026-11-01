// The device registry: a pure fold over the signed `device.added` / `device.revoked` /
// `device.recoveryChanged` statements of a vault's log, rooted at the recovery signing key pinned in
// the keyring (never read from storage). The result depends only on the SET of events: every device
// that holds the same set computes the same registry, whatever the delivery order (S29b, review B1).
//
// Trust comes ONLY from certificate chains (crypto `CertificateIndex`): a revoked device and its
// certificate subtree are untrusted, a device id certified with two key pairs is conflicted.
//
// Revocations are decided by STREAM POSITIONS, never by a writer-chosen HLC:
// - A revocation statement r by device S sits at position p(r) of S's own stream. It is eligible
//   when S's key (the one r verifies with) is certified through a chain avoiding the revoked devices,
//   and S is not revoked or r lies before S's cut (positions.ts `beforeCut`). A revocation signed
//   with the recovery key always counts.
// - Eligibility depends on which revocations count, so the fold computes the grounded fixpoint of
//   that rule (alternating fixpoint: L grows, U shrinks, both start from nothing / everything):
//   IN = L (counts in every consistent reading), UNDEC = U \ L (counts in some), OUT = the rest.
//   Fail closed: IN and UNDEC revocations both revoke their targets. So X revoking Y while Y revokes
//   X, each after the other's cut, revokes both devices; a revoked signer's revocations never
//   un-count because of the order in which they arrived.
// - Mutual revocations where the revoker attests it had applied the other's revocation (q by X of Y
//   with cut(Y) at or after the position of Y's revocation of X) are the signature of a rewritten
//   stream (an honest X that applied a revocation of itself cannot revoke anyone): Y's revocation
//   then cannot defeat q, so both count and both devices are revoked (review A1b).
// - The cut (review M1): a device revocation's cut of S is raised to what its signer attested it had
//   applied of S's stream in its own earlier statements (lease watermarks, lease `prev` links into
//   S's stream, earlier revocations of S), so it cannot erase history the revoker had accepted. The
//   effective cut of S is the highest recovery-signed cut naming S when there is one (the owner sets
//   or raises it with the recovery words), else the lowest counted device cut (fail closed).
// - Each counted revocation event is one epoch step (`revocationCount`, the key-epoch cap).
//
// Caps (review M4, S29c R2): certificates count only when carried by their issuer's own stream (or,
// recovery-issued, announced by their subject or in a recovery-signed statement); per writer stream
// at most CERT_CHECK_BUDGET are checked and MAX_CERTS_PER_ISSUER count, so junk can crowd only the
// stream it sits in (certificates.ts). At most MAX_DEVICES device ids are admitted (breadth first),
// at most MAX_REVOCATIONS_PER_SIGNER revocation events count per device signer (its first, by its own
// stream order). Unsigned or forged events never count toward any quota. The certificates a revoked
// writer logged after its cut are dropped in a second pass (trust.ts). Cost: one breadth-first
// certificate closure (linear) per fixpoint step after an O(n log n) sort; every signature is checked
// once per fold and remembered across folds (`certificateCache`, the memoized statement verifier).

import type { SegmentCursor } from "../carrier.js";
import {
  CertificateCache,
  type CertificateClosure,
  type CertificateIndex,
  RECOVERY_SIGNER_ID,
  type RecoveryPublicKeys,
  type Sodium,
  type TrustedDevice,
  type TrustedSigner,
} from "../crypto/index.js";
import { acceptedKey, type KeySource } from "./acceptance.js";
import { canonicalJson, equalBytes, fromHex, isCanonicalValue } from "./bytes.js";
import { unconsentedTargets } from "./consent.js";
import { DecisionKeys } from "./decisionKeys.js";
import {
  byHlc,
  DEVICE_ADDED,
  DEVICE_REVOKED,
  type DeviceAddedData,
  type DeviceRevokedData,
  decodeDeviceAdded,
  decodeDeviceRevoked,
  decodeRecoveryChanged,
  type LogEvent,
  RECOVERY_CHANGED,
  type RecoveryChangedData,
  statementBody,
} from "./events.js";
import { beforeCut } from "./positions.js";
import {
  type Decoded,
  type IgnoredStatement,
  MAX_CERTS_PER_ISSUER,
  type PreviousRecoveryKey,
  type Revocation,
  type TrustRoot,
} from "./registryTypes.js";
import { type StatementVerifier, verifyStatement } from "./statements.js";
import { certificateTrust, decideRevocations, type TrustContext } from "./trust.js";
import { cmp } from "./util.js";

export {
  CERT_CHECK_BUDGET,
  type IgnoredReason,
  type IgnoredStatement,
  MAX_CERTS_PER_ISSUER,
  MAX_REVOCATIONS_PER_SIGNER,
  type PreviousRecoveryKey,
  type Revocation,
  type TrustRoot,
} from "./registryTypes.js";

export interface DeviceRecord {
  readonly deviceId: string;
  readonly name: string;
  readonly addedEid: string;
  /** Who announced it (the writer of its first accepted `device.added`: who paired it). */
  readonly pairedBy: string;
  /** When: that event's position in the writer's stream and its HLC stamp. */
  readonly pairedAt: { readonly position: SegmentCursor; readonly hlc: string };
}

/** A `device.recoveryChanged` statement whose signer was trusted under this registry's root. */
export interface RecoveryChange {
  readonly event: LogEvent;
  readonly data: RecoveryChangedData;
}

export interface RegistryOptions {
  /** Certificates known out of band: vault creation, a paired device's own, recovery changes. */
  readonly bootstrapCertificates?: readonly Uint8Array[];
  /** Signature check (default: `verifyStatement`); pass a `memoizedVerifier` when folding repeatedly. */
  readonly verify?: StatementVerifier;
  /** Certificate signature cache shared across folds. */
  readonly certificateCache?: CertificateCache;
}

const REGISTRY_TYPES = new Set<string>([DEVICE_ADDED, DEVICE_REVOKED, RECOVERY_CHANGED]);

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
  /** The authentic registry statements (verified signatures), in log order: pairing welcomes carry them. */
  readonly events: readonly LogEvent[];
  /** Recovery-key changes signed by a device trusted (or before its cut) under this root. */
  readonly recoveryChanges: readonly RecoveryChange[];
  readonly #index: CertificateIndex;
  readonly #registered: ReadonlySet<string>;
  readonly #issued: ReadonlyMap<string, number>;
  readonly #keys: DecisionKeys;
  readonly #windows: ReadonlyMap<string, number>;
  readonly #retired: ReadonlySet<string>;
  readonly #previousRecovery: readonly PreviousRecoveryKey[];
  #all: CertificateClosure | undefined;

  /** Not public API: use `foldRegistry`. */
  constructor(parts: {
    root: TrustRoot;
    index: CertificateIndex;
    trusted: ReadonlyMap<string, TrustedDevice>;
    conflicts: readonly string[];
    revoked: ReadonlyMap<string, Revocation>;
    revocationCount: number;
    devices: ReadonlyMap<string, DeviceRecord>;
    ignored: readonly IgnoredStatement[];
    events: readonly LogEvent[];
    recoveryChanges: readonly RecoveryChange[];
    registered: ReadonlySet<string>;
    issued: ReadonlyMap<string, number>;
    keys: DecisionKeys;
    windows: ReadonlyMap<string, number>;
    retired: ReadonlySet<string>;
  }) {
    this.vaultId = parts.root.vaultId;
    this.recovery = parts.root.recovery;
    this.#previousRecovery = parts.root.previous ?? [];
    this.#index = parts.index;
    this.trusted = parts.trusted;
    this.conflicts = parts.conflicts;
    this.revoked = parts.revoked;
    this.revocationCount = parts.revocationCount;
    this.devices = parts.devices;
    this.ignored = parts.ignored;
    this.events = parts.events;
    this.recoveryChanges = parts.recoveryChanges;
    this.#registered = parts.registered;
    this.#issued = parts.issued;
    this.#keys = parts.keys;
    this.#windows = parts.windows;
    this.#retired = parts.retired;
  }

  /**
   * The recovery signing keys a recovery-signed statement `eid` may verify with: the pinned key,
   * plus a replaced one when its change ratified `eid` (a leaked old phrase signs nothing new).
   */
  recoverySignKeysFor(eid: string): readonly Uint8Array[] {
    return [
      this.recovery.signPublicKey,
      ...this.#previousRecovery.filter((p) => p.ratified.has(eid)).map((p) => p.keys.signPublicKey),
    ];
  }

  isTrusted(deviceId: string): boolean {
    return this.trusted.has(deviceId);
  }

  /** A device that some certificate chain registered (trusted, revoked or conflicted). */
  isRegistered(deviceId: string): boolean {
    return this.#registered.has(deviceId);
  }

  /**
   * How many more certificates of `issuer` (a device, or RECOVERY_SIGNER_ID) `writer`'s stream can
   * carry and still have them count (its per-writer window, certificates.ts).
   */
  certificateRoom(writer: string, issuer: string): number {
    return Math.max(0, MAX_CERTS_PER_ISSUER - (this.#windows.get(`${writer}|${issuer}`) ?? 0));
  }

  /** Certificates by `issuer` that count (pairing refuses once it reaches MAX_CERTS_PER_ISSUER). */
  certificatesIssuedBy(issuer: string): number {
    return this.#issued.get(issuer) ?? 0;
  }

  /**
   * For crypto `unwrapKeys`: the signing key of a sender that is certified, registered and not
   * revoked, or the pinned recovery signing key for `RECOVERY_SIGNER_ID`.
   */
  readonly trustedSigner: TrustedSigner = (deviceId) =>
    deviceId === RECOVERY_SIGNER_ID
      ? this.recovery.signPublicKey.slice()
      : this.#keys.trustedKeyOf(deviceId);

  /** The decision keys under the final revocations (acceptance.ts sources). */
  get decisionKeys(): DecisionKeys {
    return this.#keys;
  }

  /**
   * Whether `consent` (per target other than `signer`) makes a device-signed revocation by
   * `signer` count (H2, H5', H5''): each signature verifies with a decision key of its target
   * avoiding the signer, everything it certified, and every retired device (consent.ts).
   */
  consentAccepted(
    eid: string,
    entries: readonly { readonly device: string; readonly cut: SegmentCursor }[],
    signer: string,
    consent: Readonly<Record<string, string>>,
    verify: StatementVerifier = verifyStatement,
  ): readonly string[] {
    return unconsentedTargets(
      verify,
      new DecisionKeys(this.#index, this.#retired),
      this.vaultId,
      eid,
      entries,
      signer,
      consent,
    );
  }

  /**
   * The keys a statement written by `device` at `position` (cursor after its batch) may verify
   * with: its decision key (decisionKeys.ts), for a revoked device only when the statement lies
   * before its cut. Empty otherwise (untrusted, conflicted, or a revoked device after its cut).
   * Every consumer that accepts a statement as evidence (lease events, watermarks, names, recovery
   * changes) goes through it.
   */
  statementKeys(device: string, position: SegmentCursor): readonly Uint8Array[] {
    return this.#keys.statementKeys(device, position, this.revoked);
  }

  /**
   * The keys that may have SIGNED frames of `device` (its stream heads): every key certified for it
   * through a chain from the recovery key, revocations ignored (acceptance.ts `author` source). A
   * frame signature only says who wrote the frame; whether its data or statements count is decided
   * by cuts and decision keys, as for every statement.
   */
  authorKeys(device: string): readonly Uint8Array[] {
    this.#all ??= this.#index.closure(new Set());
    return this.#all.keysOf(device).map((k) => k.signPublicKey.slice());
  }

  /** Trusted devices and the revocation count once `devices` are revoked too (before writing it). */
  previewRevocation(devices: readonly string[]): {
    trusted: ReadonlyMap<string, TrustedDevice>;
    revocationCount: number;
  } {
    const fresh = devices.filter((d) => this.#registered.has(d) && !this.revoked.has(d));
    if (fresh.length === 0) return { trusted: this.trusted, revocationCount: this.revocationCount };
    const check = this.#index.verify(new Set([...this.revoked.keys(), ...fresh]));
    return { trusted: check.devices, revocationCount: this.revocationCount + 1 };
  }
}

/**
 * Folds the registry events of a vault (other event types are skipped; lease events are read only
 * as the revokers' attested knowledge). Never throws on log content: malformed, forged, capped or
 * late statements are ignored and listed in `ignored`.
 */
export function foldRegistry(
  sodium: Sodium,
  root: TrustRoot,
  events: readonly LogEvent[],
  options: RegistryOptions = {},
): Registry {
  const verify = options.verify ?? verifyStatement;
  const ignored: IgnoredStatement[] = [];
  const unique = exactUnique(events.filter((e) => REGISTRY_TYPES.has(e.type)));

  const added: Decoded<DeviceAddedData>[] = [];
  const revocations: Decoded<DeviceRevokedData>[] = [];
  const changes: Decoded<RecoveryChangedData>[] = [];
  for (const event of unique) {
    if (event.v !== 1) {
      ignored.push({ eid: event.eid, reason: "malformed" });
    } else if (event.type === DEVICE_ADDED) {
      const data = decodeDeviceAdded(event.data);
      if (data) added.push({ event, data });
      else ignored.push({ eid: event.eid, reason: "malformed" });
    } else if (event.type === DEVICE_REVOKED) {
      const data = decodeDeviceRevoked(event.data);
      if (data) revocations.push({ event, data });
      else ignored.push({ eid: event.eid, reason: "malformed" });
    } else {
      const data = decodeRecoveryChanged(event.data);
      if (data) changes.push({ event, data });
      else ignored.push({ eid: event.eid, reason: "malformed" });
    }
  }

  const cache = options.certificateCache ?? new CertificateCache();
  const recoveryKeyFor = (eid: string): Uint8Array[] => [
    root.recovery.signPublicKey,
    ...(root.previous ?? []).filter((p) => p.ratified.has(eid)).map((p) => p.keys.signPublicKey),
  ];
  const verifies = (event: LogEvent, sig: string, source: KeySource) =>
    acceptedKey(
      verify,
      "cashu/registry/v1",
      statementBody(root.vaultId, event.type, event.eid, event.data),
      fromHex(sig),
      source,
    );
  const context: TrustContext = {
    sodium,
    root,
    cache,
    verify,
    bootstrap: options.bootstrapCertificates ?? [],
    events,
    revocations,
    heldAdds: new Set(
      added.map(
        ({ event }) =>
          `${event.writer}|${event.position.seg}:${event.position.offset}|${event.eid}`,
      ),
    ),
    recoveryKeyFor,
    acceptStatement: verifies,
  };

  // --- Certificates and revocations (decided once, over every logged certificate), then (R2) the
  // certificates again without those revoked writers logged after their cut: they never register a
  // device, count toward a quota or take an admission slot (trust.ts explains the single decision).
  const first = certificateTrust(context, added);
  const decided = decideRevocations(context, first);
  const { counted, effective, revoked } = decided.result;
  ignored.push(...decided.ignored);
  const late = new Set(
    added.filter((a) => {
      // A recovery-signed statement does not rest on its carrier: a device retiring itself with
      // the words writes the re-certifications of its orphans in its own (now cut) stream.
      if (a.data.signer === RECOVERY_SIGNER_ID) return false;
      const r = revoked.get(a.event.writer);
      return r !== undefined && !beforeCut(a.event.position, r.cut);
    }),
  );
  const final =
    late.size === 0
      ? first
      : certificateTrust(
          context,
          added.filter((a) => !late.has(a)),
        );
  const { index, all, selection } = final;
  const registered = new Set([...final.registered, ...revoked.keys()]);
  const rejected = new Map(selection.rejected);
  for (const a of late) rejected.set(a, "after_revocation");
  const trust = index.verify(decided.result.revokedIds);

  // Keys a statement of `device` at `position` may verify with (decisionKeys.ts, the one rule).
  const statementKeys = (device: string, position: SegmentCursor): Uint8Array[] =>
    decided.result.keys.statementKeys(device, position, revoked);

  // --- Names (cosmetic): any authentic `device.added` whose declared keys match a certified pair.
  const devices = new Map<string, DeviceRecord>();
  const acceptedAdds: LogEvent[] = [];
  for (const a of [...added].sort((x, y) => cmp(x.event.eid, y.event.eid))) {
    const { event, data } = a;
    const certificateReason = rejected.get(a);
    if (certificateReason) {
      ignored.push({ eid: event.eid, reason: certificateReason });
      continue;
    }
    const keys =
      data.signer === RECOVERY_SIGNER_ID
        ? recoveryKeyFor(event.eid)
        : data.signer === event.writer
          ? statementKeys(event.writer, event.position)
          : [];
    if (keys.length === 0) {
      const r = revoked.get(event.writer);
      ignored.push({
        eid: event.eid,
        reason: r && data.signer === event.writer ? "after_revocation" : "untrusted_signer",
      });
      continue;
    }
    const declaredSign = fromHex(data.signPublicKey);
    const declaredBox = fromHex(data.boxPublicKey);
    const keysMatch = all
      .keysOf(data.device)
      .some(
        (k) => equalBytes(k.signPublicKey, declaredSign) && equalBytes(k.boxPublicKey, declaredBox),
      );
    if (!keysMatch) {
      ignored.push({ eid: event.eid, reason: "key_mismatch" });
      continue;
    }
    const source: KeySource =
      data.signer === RECOVERY_SIGNER_ID
        ? { kind: "recovery", signKeys: keys }
        : {
            kind: "statement",
            keys: decided.result.keys,
            device: event.writer,
            position: event.position,
            revoked,
          };
    if (!verifies(event, data.sig, source)) {
      ignored.push({ eid: event.eid, reason: "bad_signature" });
      continue;
    }
    acceptedAdds.push(event);
    if (!devices.has(data.device)) {
      devices.set(data.device, {
        deviceId: data.device,
        name: data.name,
        addedEid: event.eid,
        pairedBy: data.signer === RECOVERY_SIGNER_ID ? RECOVERY_SIGNER_ID : event.writer,
        pairedAt: { position: event.position, hlc: event.hlc },
      });
    }
  }

  // --- Recovery-key changes signed under this root (VaultDevices decides which one to pin).
  const recoveryChanges: RecoveryChange[] = [];
  for (const { event, data } of changes) {
    const keys = data.signer === event.writer ? statementKeys(event.writer, event.position) : [];
    const source: KeySource = {
      kind: "statement",
      keys: decided.result.keys,
      device: event.writer,
      position: event.position,
      revoked,
    };
    if (keys.length === 0 || !verifies(event, data.sig, source)) {
      ignored.push({
        eid: event.eid,
        reason: keys.length === 0 ? "untrusted_signer" : "bad_signature",
      });
      continue;
    }
    recoveryChanges.push({ event, data });
  }

  return new Registry({
    root,
    index,
    trusted: trust.devices,
    conflicts: trust.conflicts,
    revoked,
    revocationCount: counted.length,
    devices,
    ignored,
    events: [
      ...acceptedAdds,
      ...effective.map((r) => r.event),
      ...recoveryChanges.map((c) => c.event),
    ].sort(byHlc),
    recoveryChanges: recoveryChanges.sort((a, b) => cmp(a.event.eid, b.event.eid)),
    registered,
    issued: selection.issued,
    keys: decided.result.keys,
    windows: selection.windows,
    retired: decided.retired,
  });
}

/** Drops exact re-deliveries (same eid, writer, position and content). */
function exactUnique(events: readonly LogEvent[]): LogEvent[] {
  const seen = new Set<string>();
  const out: LogEvent[] = [];
  for (const e of events) {
    const key = `${e.eid}|${e.writer}|${e.position.seg}:${e.position.offset}|${fingerprintOf(e)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function fingerprintOf(e: LogEvent): string {
  const head = JSON.stringify([e.type, e.v, e.hlc, e.writer, e.position.seg, e.position.offset]);
  // Canonical when possible, so the same event read back with another key order is no conflict.
  if (isCanonicalValue(e.data)) return head + canonicalJson(e.data);
  return `${head}#${e.eid}:unserializable`;
}
