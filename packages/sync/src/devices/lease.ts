// The fetch lease (CLAUDE.md data-safety rule 6: one PSD2 fetcher per vault; events.md LEADER and
// 8.3 M6). Two parts:
//
// 1. A pure fold over the signed lease events (leaseFold.ts): the compare-and-set chain, its mode
//    and its leader, the same on every device holding the same set.
// 2. A per-device belief and step function (this file). Rule 6 rests on exactly one of (S29c R4,
//    lead decision D3):
//    a) mode `pinned` (the default on EVERY backend, pinned to the vault's creator at creation):
//       exactly one designated device acts, changed only by an explicit owner action (a device-signed
//       pin after the owner typed the confirmation, or a recovery-signed one), and the new leader
//       acts only after the old one acknowledged (`pendingFrom`). This needs no propagation bound, so
//       it is safe over a synced folder. Only an owner-confirmed `force` re-pin skips the
//       acknowledgement (D4): then the old leader, if it is still alive and has not seen the pin, may
//       act once more.
//    b) mode `auto` (an owner opt-in): terms with claims, renewals and a settle period, used ONLY
//       over a transport that declares bounded propagation (carrier.ts `Transport.consistency`,
//       proven by the propagation conformance check) and whose bound the config covers:
//       settle >= skew + publish deadline + propagation bound. A holder acts only while its claim
//       was published within the publish deadline and a pull at least the settle period later still
//       showed its term, it pulled within the publish deadline BEFORE this action (so a pre-emption
//       published at least a settle period earlier is visible to that pull), its own clock is not
//       suspect, and `now < until - maxSkew`. Clocks only decide liveness: others claim at
//       `min(until, firstSeen + (until - at)) + maxSkew`, so a holder whose clock runs days ahead
//       cannot block fetching for longer than one term. Over an eventual transport nobody holds in
//       auto mode (`unsupported_transport`).
//
// The catch-up watermark (M6): lease events carry, per writer device, the cursor up to which their
// writer had applied that device's stream. A leader runs newest-day imports only after it applied,
// for every device, the HIGHEST valid cursor any lease event in the chain names (cumulative;
// catchUp.ts: registered devices only, capped at a revoked device's cut, conflicted devices dropped,
// minus owner waivers). Imports a leader made after its last lease event are not covered (a leader
// must not import while it cannot publish); the hand-over ack carries the old leader's watermark.

import type { LeaseTransport, SegmentCursor, UnstampedEvent } from "../carrier.js";
import { type DeviceIdentity, isDeviceId, type RecoveryIdentity } from "../crypto/core.js";
import { DEFAULT_MAX_DRIFT_MS } from "../hlc.js";
import { behindNeed } from "./catchUp.js";
import {
  buildLeaseClaim,
  buildLeaseFetched,
  buildLeasePin,
  buildLeaseRelease,
  buildLeaseRenewal,
  type PinRequest,
  type WaiveRequest,
  type Watermark,
} from "./events.js";
import { type LeaseView, MAX_LEASE_TTL_MS } from "./leaseFold.js";
import { cmp } from "./util.js";

export {
  foldLease,
  isLeaseEvent,
  LEASE_CLOCK_TOLERANCE_MS,
  type LeaseIgnoredReason,
  type LeaseTermEntry,
  type LeaseView,
  MAX_LEASE_TTL_MS,
} from "./leaseFold.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export interface LeaseConfig {
  /** How long a claim or renewal holds (writer's clock); at most MAX_LEASE_TTL_MS. */
  readonly ttlMs: number;
  /** The holder renews once less than this is left. */
  readonly renewBeforeMs: number;
  /** Largest pairwise clock skew the timing tolerates (events.md 3.3: 5 minutes). */
  readonly maxSkewMs: number;
  /**
   * A lease event counts for its writer only if it was pushed to a remote within this time, and a
   * holder acts only within this time after its last pull.
   */
  readonly publishDeadlineMs: number;
  /**
   * Mode auto: the largest propagation bound of a transport this config covers (the relay's
   * declared bound). A device whose transport declares more is `unsupported_transport`.
   */
  readonly propagationMs: number;
  /** After publishing a claim, a pull at least this much later must still show it as head. */
  readonly settleMs: number;
}

export const DEFAULT_LEASE_CONFIG: LeaseConfig = leaseConfig({});

/** Validated config; the settle period must cover the skew, the publish deadline and propagation. */
export function leaseConfig(overrides: Partial<LeaseConfig>): LeaseConfig {
  const maxSkewMs = overrides.maxSkewMs ?? DEFAULT_MAX_DRIFT_MS;
  const publishDeadlineMs = overrides.publishDeadlineMs ?? 60_000;
  const propagationMs = overrides.propagationMs ?? 0;
  const config: LeaseConfig = {
    ttlMs: overrides.ttlMs ?? MAX_LEASE_TTL_MS,
    renewBeforeMs: overrides.renewBeforeMs ?? 12 * HOUR,
    maxSkewMs,
    publishDeadlineMs,
    propagationMs,
    settleMs: overrides.settleMs ?? maxSkewMs + publishDeadlineMs + propagationMs + 60_000,
  };
  const ok =
    Object.values(config).every((v) => Number.isSafeInteger(v) && v >= 0) &&
    config.ttlMs <= MAX_LEASE_TTL_MS &&
    config.settleMs >= config.maxSkewMs + config.publishDeadlineMs + config.propagationMs &&
    config.renewBeforeMs > 0 &&
    config.ttlMs > config.renewBeforeMs + 2 * config.maxSkewMs + config.settleMs;
  if (!ok) {
    throw new RangeError(
      "lease config: ttl <= 24 h, settle >= skew + deadline + propagation, ttl > renew + 2 skew + settle",
    );
  }
  return config;
}

// ---------------------------------------------------------------------------------------------
// Belief and steps (per device, with its own clock)

/** Device-local record of one of this device's own lease events (kept with leader-local state). */
export interface OwnLeaseRecord {
  /** Local clock when the event was written. */
  readonly writtenAt: number;
  /**
   * Local clock when a sync pass pushed it (mode auto: through the bounded remotes, the engine's
   * `leaseTransport().lastPushAt` of that pass); undefined while unpublished.
   */
  readonly publishedAt?: number;
}

export interface LeaseLocal {
  readonly me: string;
  readonly now: number;
  /** Local clock when the last pass that pulled from a remote finished (undefined: never). */
  readonly lastPullAt: number | undefined;
  /**
   * D6: the passes since `lastPullAt` reached every remote they could and missed only unreachable
   * ones (the engine's `PullStatus` `offline`; carrier.ts). `reachedAt` = start of the latest such
   * pass. Mode pinned accepts it in place of `lastPullAt`: leadership there moves only by an owner's
   * explicit action, so the worst case of acting on the last known state is one extra fetch per Mac
   * until they see each other. Mode auto ignores it (its safety rests on timing). Absent: no such pass.
   * Bounded (G2, `offlinePullAt`): while the registry holds another device that could be pinned
   * (`peerCanLead`), only for OFFLINE_LEAD_MAX_MS after the last complete pull (`lastCompleteAt`,
   * persisted by the host; unknown = no grace). Without such a device nobody else can lead, so no bound.
   */
  readonly offlinePull?: {
    readonly since: number;
    readonly reachedAt: number;
    readonly lastCompleteAt?: number;
    readonly peerCanLead: boolean;
  };
  /**
   * The engine's report of the last pass (`SyncEngine.leaseTransport()`): mode auto runs only while
   * it is `bounded`, and then uses its pull time.
   */
  readonly transport: LeaseTransport;
  readonly own: (eid: string) => OwnLeaseRecord | undefined;
  /**
   * Local clock when this device first ingested a lease event (undefined: unknown, for example
   * after a restart without the record; then the current time is used, which only waits longer).
   */
  readonly firstSeen: (eid: string) => number | undefined;
  /**
   * False while this device's clock disagrees with its peers by more than the skew bound: its HLC
   * refused to stamp (clock behind its own last stamp) or it received events stamped more than
   * the skew ahead of it. Such a device neither claims nor holds.
   */
  readonly clockOk: boolean;
}

/** Mode auto is usable here: the last pass reached every bounded remote, within the config's bound. */
export function supportsAutoHandover(
  local: Pick<LeaseLocal, "transport">,
  config: LeaseConfig,
): boolean {
  return (
    local.transport.kind === "bounded" && local.transport.propagationMs <= config.propagationMs
  );
}

/** In mode auto, only pulls through the bounded remotes count. */
function autoPullAt(local: LeaseLocal): number | undefined {
  return local.transport.kind === "bounded" ? local.transport.lastPullAt : undefined;
}

function timely(record: OwnLeaseRecord | undefined, config: LeaseConfig): boolean {
  return (
    record?.publishedAt !== undefined &&
    record.publishedAt >= record.writtenAt &&
    record.publishedAt - record.writtenAt <= config.publishDeadlineMs
  );
}

function myTerm(view: LeaseView, local: LeaseLocal): boolean {
  return view.mode === "auto" && !view.free && view.holder === local.me && view.term.length > 0;
}

/** The `until` this device may rely on: its term events that were published in time. */
function effectiveUntil(view: LeaseView, local: LeaseLocal, config: LeaseConfig): number {
  let best = 0;
  for (const e of view.term) {
    if (timely(local.own(e.eid), config)) best = Math.max(best, e.until);
  }
  return best;
}

function settled(view: LeaseView, local: LeaseLocal, config: LeaseConfig): boolean {
  const claim = view.term[0];
  const record = claim && local.own(claim.eid);
  const pullAt = autoPullAt(local);
  return (
    record !== undefined &&
    timely(record, config) &&
    pullAt !== undefined &&
    record.publishedAt !== undefined &&
    pullAt >= record.publishedAt + config.settleMs
  );
}

function pulledRecently(pullAt: number | undefined, now: number, config: LeaseConfig): boolean {
  return pullAt !== undefined && pullAt <= now && now - pullAt <= config.publishDeadlineMs;
}

/**
 * G2: how long after its last complete pull a pinned leader may go on acting on offline evidence
 * while another device could have been pinned meanwhile (a second Mac). Covers a provider outage, a
 * quota day and a holiday; after it the leader stops until a pass reaches every remote again (or the
 * owner turns sync off for the vault, which removes the unreachable remote).
 */
export const OFFLINE_LEAD_MAX_MS = 7 * 24 * 60 * 60_000;

/**
 * The time the offline evidence vouches for (`offlinePull.reachedAt`), or undefined when there is
 * none or its bound ran out (`LeaseLocal.offlinePull`). Pure; the caller still checks recency.
 */
export function offlinePullAt(offline: LeaseLocal["offlinePull"], now: number): number | undefined {
  if (offline === undefined) return undefined;
  if (!offline.peerCanLead) return offline.reachedAt;
  const last = offline.lastCompleteAt;
  return last !== undefined && last <= now && now - last <= OFFLINE_LEAD_MAX_MS
    ? offline.reachedAt
    : undefined;
}

/** Mode pinned: this device is the designated leader and nobody has to hand over first. */
function pinnedLeader(view: LeaseView, local: LeaseLocal): boolean {
  return (
    view.mode === "pinned" && !view.free && view.pinned === local.me && view.pendingFrom === null
  );
}

/**
 * True while this device may act as the fetch leader. Check it right before EVERY leader action
 * (LEADER event, PSD2 fetch): it requires a pull within the publish deadline. In mode pinned a pass
 * that reached every reachable remote and missed only unreachable ones counts as that pull
 * (`LeaseLocal.offlinePull`, D6): a relay outage pauses sync, never the leader's local work (bounded
 * by OFFLINE_LEAD_MAX_MS while another device could lead, G2).
 */
export function holdsLease(
  view: LeaseView,
  local: LeaseLocal,
  config: LeaseConfig = DEFAULT_LEASE_CONFIG,
): boolean {
  if (!local.clockOk) return false;
  if (view.mode === "pinned") {
    return (
      pinnedLeader(view, local) &&
      (pulledRecently(local.lastPullAt, local.now, config) ||
        pulledRecently(offlinePullAt(local.offlinePull, local.now), local.now, config))
    );
  }
  return (
    supportsAutoHandover(local, config) &&
    view.pendingFrom === null &&
    myTerm(view, local) &&
    settled(view, local, config) &&
    pulledRecently(autoPullAt(local), local.now, config) &&
    local.now < effectiveUntil(view, local, config) - config.maxSkewMs
  );
}

/**
 * When the current term ends as far as THIS device is concerned: the latest term event's `until`,
 * but never later than the time this device first saw that event plus the event's own duration (a
 * holder whose clock runs ahead cannot stretch its term on other devices).
 */
export function termEndFor(view: LeaseView, local: LeaseLocal): number {
  const last = view.term[view.term.length - 1];
  if (!last) return 0;
  const seen = local.firstSeen(last.eid) ?? local.now;
  return Math.min(last.until, seen + (last.until - last.at));
}

export type LeaseStep =
  /** Mode pinned: this device is the designated leader; fetch when due, then write `fetched`. */
  | { readonly kind: "lead" }
  /** Mode auto: this device holds the lease; renew at `renewAt`. */
  | { readonly kind: "hold"; readonly until: number; readonly renewAt: number }
  | { readonly kind: "renew" }
  | { readonly kind: "claim" }
  /** An own lease event is not pushed yet: run a sync pass. */
  | { readonly kind: "publish" }
  /** The own claim is pushed; pull again at or after `until` before acting. */
  | { readonly kind: "settle"; readonly until: number }
  /**
   * Write a `lease.released`: the own term cannot be relied on (published too late, record lost,
   * not eligible, bad clock), or the owner moved the leadership and this device must hand over.
   */
  | { readonly kind: "release" }
  /** The owner moved the leadership; `from` has to acknowledge before anyone acts (or a force re-pin). */
  | { readonly kind: "handover_wait"; readonly from: string }
  /** Mode auto, but this device's transport declares no (covered) propagation bound: pin a leader. */
  | { readonly kind: "unsupported_transport" }
  /** Another device holds the lease; it may be claimed at `until`. */
  | { readonly kind: "wait"; readonly until: number }
  | { readonly kind: "idle" };

/**
 * What this device should do next. `eligible` = this device is configured to fetch (mode auto: the
 * owner picks fetchers; a phone may opt out). In mode pinned the pin alone decides.
 */
export function nextLeaseStep(
  view: LeaseView,
  local: LeaseLocal,
  eligible: boolean,
  config: LeaseConfig = DEFAULT_LEASE_CONFIG,
): LeaseStep {
  if (view.pendingFrom === local.me) return { kind: "release" }; // the hand-over ack
  if (view.mode === "pinned") {
    if (view.free || view.pinned !== local.me) return { kind: "idle" };
    if (view.pendingFrom !== null) return { kind: "handover_wait", from: view.pendingFrom };
    return local.clockOk ? { kind: "lead" } : { kind: "idle" };
  }
  if (myTerm(view, local) && (!eligible || !local.clockOk)) {
    return view.released ? { kind: "idle" } : { kind: "release" };
  }
  if (!eligible || !local.clockOk) return { kind: "idle" };
  if (!supportsAutoHandover(local, config)) return { kind: "unsupported_transport" };
  if (view.pendingFrom !== null) return { kind: "handover_wait", from: view.pendingFrom };
  if (myTerm(view, local)) {
    const claim = view.term[0];
    const record = claim && local.own(claim.eid);
    if (!record) return { kind: "release" };
    if (record.publishedAt === undefined) {
      return local.now - record.writtenAt > config.publishDeadlineMs
        ? { kind: "release" }
        : { kind: "publish" };
    }
    if (!timely(record, config)) return { kind: "release" };
    if (!settled(view, local, config)) {
      return { kind: "settle", until: record.publishedAt + config.settleMs };
    }
    const until = effectiveUntil(view, local, config);
    if (local.now < until - config.maxSkewMs) {
      const head = view.head === null ? undefined : local.own(view.head);
      if (head && head.publishedAt === undefined) return { kind: "publish" };
      const renewAt = until - config.renewBeforeMs;
      return local.now >= renewAt ? { kind: "renew" } : { kind: "hold", until, renewAt };
    }
    // Lapsed: never renew a lapsed term (a renewal skips the settle period). Claim afresh: the new
    // term settles like any claim, and no other device may claim before this term's end + skew.
    return { kind: "claim" };
  }
  if (view.free) return { kind: "claim" };
  const claimAt = termEndFor(view, local) + config.maxSkewMs;
  return local.now >= claimAt ? { kind: "claim" } : { kind: "wait", until: claimAt };
}

/**
 * Writer devices whose streams are not yet applied up to the catch-up requirement, with the cursor
 * needed (already validated and capped by the fold; `catchUpSources` names who requires it).
 */
export function catchUpMissing(
  view: LeaseView,
  applied: ReadonlyMap<string, SegmentCursor>,
): { readonly device: string; readonly need: SegmentCursor }[] {
  return behindNeed(view.catchUp, applied);
}

/**
 * The gate for newest-day-rule imports (events.md 8.3): hold the lease AND have applied the log up
 * to the catch-up requirement.
 */
export function mayRunNewestDayImports(
  view: LeaseView,
  local: LeaseLocal,
  applied: ReadonlyMap<string, SegmentCursor>,
  config: LeaseConfig = DEFAULT_LEASE_CONFIG,
): boolean {
  return holdsLease(view, local, config) && catchUpMissing(view, applied).length === 0;
}

/** The watermark of a lease event: per writer device, the applied cursor of its stream. */
export function watermarkOf(applied: ReadonlyMap<string, SegmentCursor>): Watermark {
  const out: Record<string, SegmentCursor> = {};
  for (const [device, cursor] of [...applied].sort(([a], [b]) => cmp(a, b))) {
    if (isDeviceId(device)) out[device] = { seg: cursor.seg, offset: cursor.offset };
  }
  return out;
}

export interface LeaseWrite {
  readonly identity: DeviceIdentity;
  readonly vaultId: string;
  readonly eid: string;
  readonly now: number;
  /** Applied cursor per writer device (the store's view cursors). */
  readonly applied: ReadonlyMap<string, SegmentCursor>;
  /**
   * Devices whose catch-up requirement the OWNER waived after confirming that their data is lost or
   * withheld, with that confirmation (events.ts `WaiveRequest`; claims and renewals only; never
   * written automatically).
   */
  readonly waive?: WaiveRequest;
}

/**
 * The event for a `claim` / `renew` / `release` step, or the leader's `fetched` report after a
 * completed fetch; record it as an own lease event when written.
 */
export function leaseEventFor(
  step: "claim" | "renew" | "release" | "fetched",
  view: LeaseView,
  write: LeaseWrite,
  config: LeaseConfig = DEFAULT_LEASE_CONFIG,
): UnstampedEvent {
  const watermark = watermarkOf(write.applied);
  const me = write.identity.deviceId;
  if (step === "claim") {
    if (view.head === null)
      throw new RangeError("a vault's lease chain starts with the creator pin");
    return buildLeaseClaim(write.identity, write.vaultId, write.eid, {
      at: write.now,
      until: write.now + config.ttlMs,
      watermark,
      prev: view.head,
      ...(write.waive ? { waive: write.waive } : {}),
    });
  }
  const head = view.head;
  const acking = view.pendingFrom === me;
  const leading = view.holder === me && !view.free && view.pendingFrom === null;
  if (head === null || !(step === "release" ? acking || view.holder === me : leading)) {
    throw new RangeError("only the leader renews or reports; only it or a pending leader releases");
  }
  if (step === "renew") {
    return buildLeaseRenewal(write.identity, write.vaultId, write.eid, {
      at: write.now,
      until: write.now + config.ttlMs,
      watermark,
      prev: head,
      ...(write.waive ? { waive: write.waive } : {}),
    });
  }
  const fields = { at: write.now, watermark, prev: head };
  return step === "fetched"
    ? buildLeaseFetched(write.identity, write.vaultId, write.eid, fields)
    : buildLeaseRelease(write.identity, write.vaultId, write.eid, fields);
}

/**
 * The owner's pin (an explicit owner action only: the typed confirmation or the recovery words).
 * Opting into mode auto needs this device's transport to declare a bound the config covers (the UI
 * offers it only with a relay configured).
 */
export function pinEventFor(
  view: LeaseView,
  write: LeaseWrite,
  pin: PinRequest,
  local: Pick<LeaseLocal, "transport">,
  config: LeaseConfig = DEFAULT_LEASE_CONFIG,
): UnstampedEvent {
  if (view.mode === "auto" && pin.mode === "pinned" && !pin.force) {
    throw new RangeError("leaving automatic handover requires an owner-confirmed force pin");
  }
  if (pin.mode === "auto" && !supportsAutoHandover(local, config)) {
    throw new RangeError("automatic handover needs a relay declaring bounded propagation");
  }
  if (view.head === null) throw new RangeError("a vault's lease chain starts with the creator pin");
  return buildLeasePin(
    write.identity,
    write.vaultId,
    write.eid,
    { at: write.now, watermark: watermarkOf(write.applied), prev: view.head },
    pin,
  );
}

/**
 * The vault's first lease event, written at vault creation next to the creator's `device.added`:
 * the creator is the pinned fetch leader (D3), signed with the recovery words then on screen.
 */
export function creatorPin(
  creator: DeviceIdentity,
  recovery: RecoveryIdentity,
  vaultId: string,
  eid: string,
  now: number,
): UnstampedEvent {
  return buildLeasePin(
    creator,
    vaultId,
    eid,
    { at: now, watermark: {}, prev: null },
    {
      mode: "pinned",
      leader: creator.deviceId,
      force: false,
      confirmation: { kind: "recovery", recovery },
    },
  );
}
