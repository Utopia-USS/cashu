// One device's view of one vault's devices: it folds the registry and lease events it is given,
// applies the key wraps addressed to it (retrying those that are not acceptable yet), applies
// recovery-key changes, owns the frame guard and answers "must I rotate before writing?". Pure
// protocol state: the frame gate (gate.ts) feeds it the events of every frame whose signed head
// verified (data-rejected frames included, see guard.ts) and the fork freezes it derives from signed
// heads; the caller writes the events it prepares. Statements a frozen writer made after its agreed
// prefix never enter a fold (heads.ts).

import type { SegmentCursor } from "../carrier.js";
import {
  CertificateCache,
  type DeviceIdentity,
  type Keyring,
  type RecoveryIdentity,
  type Sodium,
  wrapSenderId,
} from "../crypto/index.js";
import { canonicalJson, fromHex, isCanonicalValue } from "./bytes.js";
import {
  byHlc,
  consentToRevocation,
  decodeKeysRotated,
  KEYS_ROTATED,
  type LogEvent,
  type RevokedEntry,
} from "./events.js";
import { FrameGuard, type FrameRejection } from "./guard.js";
import { foldLease, isLeaseEvent, type LeaseView } from "./lease.js";
import { comparePositions, positionKey } from "./positions.js";
import type { ProvenanceStore } from "./provenance.js";
import {
  authorizedByOldKeys,
  baseWrapValid,
  buildRecoveryChange,
  type RecoveryHistory,
  recoveryHistory,
  recoveryKeysOf,
  sameRecoveryKeys,
} from "./recoveryChange.js";
import { foldRegistry, isRegistryEvent, type Registry } from "./registry.js";
import {
  applyWrap,
  type KeyContext,
  type PrepareResult,
  prepareRevocation,
  prepareRotation,
  type RateLimit,
  type RotationReason,
  rotationReason,
  type WrapOutcome,
} from "./rotation.js";
import { memoizedVerifier, type StatementVerifier } from "./statements.js";

/** Pending (not yet acceptable) wraps kept per claimed sender, and in all (review M4). */
export const MAX_PENDING_WRAPS_PER_SENDER = 32;
export const MAX_PENDING_WRAPS = 1024;

export interface VaultDevicesOptions {
  readonly sodium: Sodium;
  readonly identity: DeviceIdentity;
  readonly ring: Keyring;
  readonly provenance: ProvenanceStore;
  /** Local clock, ms. */
  readonly clock: () => number;
  /** Certificates known out of band (vault creation, this device's pairing certificate). */
  readonly bootstrapCertificates?: readonly Uint8Array[];
  readonly rateLimit?: RateLimit;
  /** Restored from the recovery words and not rotated yet (n3). */
  readonly recovering?: { readonly highestRecoveryEpoch: number };
  /** Shared with the pairing joiner (JoinerOptions) so the welcome's registry is verified once. */
  readonly verify?: StatementVerifier;
  readonly certificateCache?: CertificateCache;
}

export interface IngestReport {
  /** Wraps for this device that reached a final outcome in this pass. */
  readonly wraps: readonly { readonly eid: string; readonly outcome: WrapOutcome }[];
  /** Wraps kept for a later pass (sender or revocation not known yet, gap, rate limit). */
  readonly pending: readonly { readonly eid: string; readonly outcome: WrapOutcome }[];
  /** Set when this device must rotate before it writes any frame. */
  readonly rotation: RotationReason | undefined;
  /**
   * Accepted data the current registry no longer accepts (guard `recheck`): drop each device's data
   * ending after `after` and re-apply from there. Sorted by device; the same on every device.
   */
  readonly rejectedFrames: readonly FrameRejection[];
  /** Recovery-key changes applied in this pass (eids), and changes refused as conflicting. */
  readonly recovery: { readonly applied: readonly string[]; readonly conflicts: readonly string[] };
  /** The registry was folded again (new registry or lease statements, or a freeze changed). */
  readonly registryChanged: boolean;
}

interface PendingWrap {
  readonly key: string;
  readonly event: LogEvent;
  readonly sender: string;
  readonly wire: Uint8Array;
  outcome: WrapOutcome | undefined;
}

/** Pending wraps are retried on every change, and otherwise at most this often (rate-limit windows). */
const IDLE_RETRY_MS = 60_000;

export class VaultDevices {
  readonly guard: FrameGuard;
  readonly #o: VaultDevicesOptions;
  readonly #registryEvents: LogEvent[] = [];
  readonly #leaseEvents: LogEvent[] = [];
  readonly #seenEvents = new Set<string>();
  readonly #firstSeen = new Map<string, number>();
  readonly #pending = new Map<string, PendingWrap>();
  readonly #verify: StatementVerifier;
  readonly #certificateCache: CertificateCache;
  #history: RecoveryHistory = { previous: [], certificates: [] };
  #registry: Registry;
  #lease: LeaseView;
  #recovering: { readonly highestRecoveryEpoch: number } | undefined;
  /** Kids held when the recovery key last changed here: the active key must not be one of them. */
  #keysAtPin: ReadonlySet<string> | undefined;
  #recoveryConflicts: string[] = [];
  #lastRetryAt = Number.NEGATIVE_INFINITY;
  /** Writers frozen at an agreed prefix (proven forks, heads.ts): later statements are ignored. */
  #frozen: ReadonlyMap<string, SegmentCursor> = new Map();

  constructor(options: VaultDevicesOptions) {
    this.#o = options;
    this.#verify = options.verify ?? memoizedVerifier();
    this.#certificateCache = options.certificateCache ?? new CertificateCache();
    this.#recovering = options.recovering;
    this.#registry = this.#foldRegistry();
    this.#lease = foldLease(this.#registry, this.#leaseEvents, this.#verify);
    this.guard = new FrameGuard(
      () => this.#registry,
      () => this.#frozen,
    );
  }

  /** Writers frozen at an agreed prefix (set by the gate from signed heads). */
  get frozen(): ReadonlyMap<string, SegmentCursor> {
    return this.#frozen;
  }

  /**
   * Replaces the fork freezes (gate.ts, from signed heads). When they change, the folds run again
   * without the frozen writers' later statements, and the guard reports data no longer accepted.
   */
  freeze(frozen: ReadonlyMap<string, SegmentCursor>): IngestReport | undefined {
    const same =
      frozen.size === this.#frozen.size &&
      [...frozen].every(([d, at]) => {
        const known = this.#frozen.get(d);
        return known !== undefined && comparePositions(known, at) === 0;
      });
    if (same) return undefined;
    this.#frozen = new Map(frozen);
    return this.#refold();
  }

  /** Events a fold may use: everything, minus frozen writers' statements after their prefix. */
  #unfrozen(events: readonly LogEvent[]): LogEvent[] {
    if (this.#frozen.size === 0) return [...events];
    return events.filter((e) => {
      const limit = this.#frozen.get(e.writer);
      return !limit || comparePositions(e.position, limit) <= 0;
    });
  }

  #refold(): IngestReport {
    this.#registry = this.#foldRegistry();
    const applied = this.#applyRecoveryChanges();
    this.#lease = foldLease(this.#registry, this.#unfrozen(this.#leaseEvents), this.#verify);
    return {
      wraps: [],
      pending: [],
      rotation: this.rotationNeeded(),
      rejectedFrames: this.guard.recheck(),
      recovery: { applied, conflicts: [...this.#recoveryConflicts] },
      registryChanged: true,
    };
  }

  get registry(): Registry {
    return this.#registry;
  }

  get lease(): LeaseView {
    return this.#lease;
  }

  get ring(): Keyring {
    return this.#o.ring;
  }

  get deviceId(): string {
    return this.#o.identity.deviceId;
  }

  /** The position of the last lease event `device` wrote that this device holds (undefined: none). */
  lastLeaseEventOf(device: string): SegmentCursor | undefined {
    let last: SegmentCursor | undefined;
    for (const e of this.#leaseEvents) {
      if (e.writer === device && (!last || comparePositions(e.position, last) > 0))
        last = e.position;
    }
    return last;
  }

  /** Local clock when this device first ingested a lease event (for `LeaseLocal.firstSeen`). */
  firstSeen(eid: string): number | undefined {
    return this.#firstSeen.get(eid);
  }

  #foldRegistry(): Registry {
    const ring = this.#o.ring;
    this.#history = recoveryHistory(ring.vaultId, ring.recovery, this.#registryEvents);
    return foldRegistry(
      this.#o.sodium,
      { vaultId: ring.vaultId, recovery: ring.recovery, previous: this.#history.previous },
      this.#unfrozen([...this.#registryEvents, ...this.#leaseEvents]),
      {
        bootstrapCertificates: [
          ...(this.#o.bootstrapCertificates ?? []),
          ...this.#history.certificates,
        ],
        verify: this.#verify,
        certificateCache: this.#certificateCache,
      },
    );
  }

  keyContext(): KeyContext {
    const ctx: KeyContext = {
      sodium: this.#o.sodium,
      identity: this.#o.identity,
      ring: this.#o.ring,
      registry: this.#registry,
      provenance: this.#o.provenance,
      now: this.#o.clock(),
    };
    return {
      ...ctx,
      ...(this.#o.rateLimit ? { rateLimit: this.#o.rateLimit } : {}),
      ...(this.#recovering ? { recoveryEpochCap: this.#recovering.highestRecoveryEpoch + 1 } : {}),
      ...(this.#history.previous.length > 0
        ? { previousRecoveryKeys: this.#history.previous.map((p) => p.keys) }
        : {}),
    };
  }

  /**
   * Applies events from the log (any types; others are skipped). Idempotent: an event delivered
   * again (same eid, writer, position and content) is a no-op; copies that differ are all kept and
   * judged by the folds (a junk copy never hides the genuine one, review m2).
   */
  ingest(events: readonly LogEvent[]): IngestReport {
    let registryChanged = false;
    let leaseChanged = false;
    let wrapsArrived = false;
    const me = this.#o.identity.deviceId;
    const now = this.#o.clock();
    for (const e of events) {
      const key = copyKey(e);
      if (this.#seenEvents.has(key)) continue;
      if (isRegistryEvent(e)) {
        this.#seenEvents.add(key);
        this.#registryEvents.push(e);
        registryChanged = true;
      } else if (isLeaseEvent(e)) {
        this.#seenEvents.add(key);
        this.#leaseEvents.push(e);
        if (!this.#firstSeen.has(e.eid)) this.#firstSeen.set(e.eid, now);
        leaseChanged = true;
        registryChanged = true; // lease statements are revokers' attested knowledge (registry M1)
      } else if (e.type === KEYS_ROTATED && e.v === 1) {
        this.#seenEvents.add(key);
        const wire = decodeKeysRotated(e.data)?.wraps[me];
        if (wire !== undefined)
          wrapsArrived = this.#queueWrap(key, e, fromHex(wire)) || wrapsArrived;
      }
    }
    const applied: string[] = [];
    if (registryChanged) {
      this.#registry = this.#foldRegistry();
      applied.push(...this.#applyRecoveryChanges());
    }
    if (registryChanged || leaseChanged) {
      this.#lease = foldLease(this.#registry, this.#unfrozen(this.#leaseEvents), this.#verify);
    }
    if (registryChanged) {
      for (const [k, p] of this.#pending) {
        if (this.#registry.revoked.has(p.sender)) this.#pending.delete(k);
      }
    }

    const wraps: { eid: string; outcome: WrapOutcome }[] = [];
    const retry =
      registryChanged ||
      wrapsArrived ||
      (this.#pending.size > 0 && now - this.#lastRetryAt >= IDLE_RETRY_MS);
    if (retry) this.#lastRetryAt = now;
    for (let progress = retry; progress; ) {
      progress = false;
      const ordered = [...this.#pending.values()].sort(
        (a, b) => byHlc(a.event, b.event) || (a.key < b.key ? -1 : 1),
      );
      for (const p of ordered) {
        const outcome = applyWrap(this.keyContext(), p.wire);
        if (outcome.status === "retry") {
          p.outcome = outcome;
          continue;
        }
        this.#pending.delete(p.key);
        wraps.push({ eid: p.event.eid, outcome });
        if (outcome.status === "applied") progress = true;
      }
    }
    return {
      wraps,
      pending: [...this.#pending.values()].flatMap((p) =>
        p.outcome ? [{ eid: p.event.eid, outcome: p.outcome }] : [],
      ),
      rotation: this.rotationNeeded(),
      rejectedFrames: registryChanged ? this.guard.recheck() : [],
      recovery: { applied, conflicts: [...this.#recoveryConflicts] },
      registryChanged,
    };
  }

  /** Keeps a wrap for retries within the per-sender and total bounds; false when dropped. */
  #queueWrap(key: string, event: LogEvent, wire: Uint8Array): boolean {
    const sender = wrapSenderId(wire);
    if (sender === undefined || this.#registry.revoked.has(sender)) return false;
    let fromSender = 0;
    for (const p of this.#pending.values()) if (p.sender === sender) fromSender += 1;
    if (fromSender >= MAX_PENDING_WRAPS_PER_SENDER || this.#pending.size >= MAX_PENDING_WRAPS) {
      return false;
    }
    this.#pending.set(key, { key, event, sender, wire, outcome: undefined });
    return true;
  }

  /**
   * Pins the recovery keys of every change that starts from the current pin, is authorized by the
   * pinned recovery key, was signed by a device trusted under the current root when it wrote it (the
   * registry already dropped changes written after a cut) and carries a base wrap the new keys signed.
   * Two different changes from the same pin are not applied (fail closed) and reported.
   */
  #applyRecoveryChanges(): string[] {
    const applied: string[] = [];
    for (let guard = 0; guard < 64; guard++) {
      const ring = this.#o.ring;
      const candidates = this.#registry.recoveryChanges.filter(
        (c) =>
          sameRecoveryKeys(recoveryKeysOf(c.data.from), ring.recovery) &&
          !sameRecoveryKeys(recoveryKeysOf(c.data.to), ring.recovery) &&
          authorizedByOldKeys(ring.vaultId, c.event.eid, c.data) &&
          baseWrapValid(ring.vaultId, c.data),
      );
      const targets = new Set(candidates.map((c) => `${c.data.to.box}:${c.data.to.sign}`));
      if (targets.size === 0) break;
      if (targets.size > 1) {
        this.#recoveryConflicts = candidates.map((c) => c.event.eid).sort();
        break;
      }
      const change = candidates[0];
      if (!change) break;
      ring.replaceRecoveryKey(recoveryKeysOf(change.data.to));
      this.#keysAtPin = new Set(ring.entries().map((e) => e.kid));
      applied.push(change.event.eid);
      this.#registry = this.#foldRegistry();
    }
    return applied;
  }

  /** Why this device must rotate before writing any frame, or undefined. */
  rotationNeeded(): RotationReason | undefined {
    if (this.#recovering) return "recovered";
    const reason = rotationReason(
      this.#o.ring,
      this.#registry,
      this.#o.provenance,
      this.#o.identity.deviceId,
    );
    if (reason) return reason;
    if (this.#keysAtPin?.has(this.#o.ring.active.kid)) return "recovery_changed";
    return undefined;
  }

  /**
   * Consents (H2) to this device's retirement by `revoker` (the revocation `eid` of `entries`), then
   * WIPES this device's vault keys and identity: a retired device that is later sold or stolen can
   * neither read the vault nor mint consent keys (review H5''). The caller passes the consent to the
   * revoker and deletes the keys from its KeyStore too (S44 flow).
   */
  consentToRetirement(eid: string, entries: readonly RevokedEntry[], revoker: string): string {
    const consent = consentToRevocation(
      this.#o.identity,
      this.#o.ring.vaultId,
      eid,
      entries,
      revoker,
    );
    this.#o.ring.wipe();
    this.#o.identity.wipe();
    return consent;
  }

  prepareRotation(eid: string): PrepareResult {
    return this.#onCommit(prepareRotation(this.keyContext(), eid));
  }

  prepareRevocation(
    targets: readonly RevokedEntry[],
    eids: {
      readonly revoke: string;
      readonly rotate: string;
      readonly recertify?: () => string;
    },
    authority?: RecoveryIdentity | { readonly consent: Readonly<Record<string, string>> },
    selection: { readonly recertify?: readonly string[] } = {},
  ): PrepareResult {
    return this.#onCommit(
      prepareRevocation(this.keyContext(), targets, eids, authority, selection),
    );
  }

  /**
   * The `device.recoveryChanged` event for new recovery words (`next`) created on this device, with
   * the owner's current words (`current`) authorizing it (n1). Write it to this device's stream;
   * ingesting it pins the new keys here, and this device then rotates.
   */
  prepareRecoveryChange(current: RecoveryIdentity, next: RecoveryIdentity, eid: string) {
    return buildRecoveryChange(
      this.#o.sodium,
      this.#o.identity,
      this.#o.ring,
      this.#registry,
      current,
      next,
      eid,
      this.#lease.recoveryPins,
    );
  }

  #onCommit(result: PrepareResult): PrepareResult {
    if (!result.ok || !result.change.key) return result;
    const { change } = result;
    return {
      ok: true,
      change: {
        ...change,
        commit: () => {
          change.commit();
          this.#recovering = undefined;
        },
      },
    };
  }
}

function copyKey(e: LogEvent): string {
  const content = isCanonicalValue(e.data) ? canonicalJson(e.data) : `#${e.hlc}`;
  return `${e.eid}|${e.writer}|${positionKey(e.position)}|${e.type}|${e.v}|${e.hlc}|${content}`;
}
