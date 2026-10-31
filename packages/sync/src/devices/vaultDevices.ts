// One device's view of one vault's devices: it folds the registry and lease events it is given,
// applies the key wraps addressed to it (retrying those that are not acceptable yet), owns the frame
// guard and answers "must I rotate before writing?". Pure protocol state: the store feeds it the
// applied events (`logEventsFromBatch`) and writes the events it prepares.

import type { DeviceIdentity, Keyring, RecoveryIdentity, Sodium } from "../crypto/index.js";
import { fromHex } from "./bytes.js";
import {
  byHlc,
  decodeKeysRotated,
  KEYS_ROTATED,
  type LogEvent,
  type RevokedEntry,
} from "./events.js";
import { FrameGuard } from "./guard.js";
import { foldLease, isLeaseEvent, type LeaseView } from "./lease.js";
import type { ProvenanceStore } from "./provenance.js";
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
import { memoizedVerifier } from "./statements.js";

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
}

export interface IngestReport {
  /** Wraps for this device that reached a final outcome in this pass. */
  readonly wraps: readonly { readonly eid: string; readonly outcome: WrapOutcome }[];
  /** Wraps kept for a later pass (sender or revocation not known yet, gap, rate limit). */
  readonly pending: readonly { readonly eid: string; readonly outcome: WrapOutcome }[];
  /** Set when this device must rotate before it writes any frame. */
  readonly rotation: RotationReason | undefined;
}

interface PendingWrap {
  readonly event: LogEvent;
  readonly wire: Uint8Array;
}

export class VaultDevices {
  readonly guard: FrameGuard;
  readonly #o: VaultDevicesOptions;
  readonly #registryEvents: LogEvent[] = [];
  readonly #leaseEvents: LogEvent[] = [];
  readonly #pending = new Map<string, PendingWrap>();
  readonly #seenWraps = new Set<string>();
  readonly #verify = memoizedVerifier();
  #registry: Registry;
  #lease: LeaseView;
  #recovering: { readonly highestRecoveryEpoch: number } | undefined;

  constructor(options: VaultDevicesOptions) {
    this.#o = options;
    this.#recovering = options.recovering;
    this.#registry = this.#foldRegistry();
    this.#lease = foldLease(this.#registry, this.#leaseEvents, this.#verify);
    this.guard = new FrameGuard(() => this.#registry);
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

  #foldRegistry(): Registry {
    const ring = this.#o.ring;
    return foldRegistry(
      this.#o.sodium,
      { vaultId: ring.vaultId, recovery: ring.recovery },
      this.#registryEvents,
      { bootstrapCertificates: this.#o.bootstrapCertificates ?? [], verify: this.#verify },
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
    };
  }

  /** Applies events from the log (any types; others are skipped). Idempotent by eid. */
  ingest(events: readonly LogEvent[]): IngestReport {
    let registryChanged = false;
    let leaseChanged = false;
    const me = this.#o.identity.deviceId;
    for (const e of events) {
      if (isRegistryEvent(e)) {
        this.#registryEvents.push(e);
        registryChanged = true;
      } else if (isLeaseEvent(e)) {
        this.#leaseEvents.push(e);
        leaseChanged = true;
      } else if (e.type === KEYS_ROTATED && e.v === 1 && !this.#seenWraps.has(e.eid)) {
        const data = decodeKeysRotated(e.data);
        const wire = data?.wraps[me];
        if (wire !== undefined) {
          this.#seenWraps.add(e.eid);
          this.#pending.set(e.eid, { event: e, wire: fromHex(wire) });
        }
      }
    }
    if (registryChanged) this.#registry = this.#foldRegistry();
    if (registryChanged || leaseChanged) {
      this.#lease = foldLease(this.#registry, this.#leaseEvents, this.#verify);
    }

    const wraps: { eid: string; outcome: WrapOutcome }[] = [];
    const pending = new Map<string, WrapOutcome>();
    for (let progress = true; progress; ) {
      progress = false;
      const ordered = [...this.#pending.values()].sort((a, b) => byHlc(a.event, b.event));
      for (const p of ordered) {
        const outcome = applyWrap(this.keyContext(), p.wire);
        if (outcome.status === "retry") {
          pending.set(p.event.eid, outcome);
          continue;
        }
        this.#pending.delete(p.event.eid);
        pending.delete(p.event.eid);
        wraps.push({ eid: p.event.eid, outcome });
        if (outcome.status === "applied") progress = true;
      }
    }
    return {
      wraps,
      pending: [...pending].map(([eid, outcome]) => ({ eid, outcome })),
      rotation: this.rotationNeeded(),
    };
  }

  /** Why this device must rotate before writing any frame, or undefined. */
  rotationNeeded(): RotationReason | undefined {
    if (this.#recovering) return "recovered";
    return rotationReason(
      this.#o.ring,
      this.#registry,
      this.#o.provenance,
      this.#o.identity.deviceId,
    );
  }

  prepareRotation(eid: string): PrepareResult {
    return this.#clearRecoveryOnCommit(prepareRotation(this.keyContext(), eid));
  }

  prepareRevocation(
    targets: readonly RevokedEntry[],
    eids: { readonly revoke: string; readonly rotate: string },
    recovery?: RecoveryIdentity,
  ): PrepareResult {
    return this.#clearRecoveryOnCommit(
      prepareRevocation(this.keyContext(), targets, eids, recovery),
    );
  }

  #clearRecoveryOnCommit(result: PrepareResult): PrepareResult {
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
