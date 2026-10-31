// The fetch lease (CLAUDE.md data-safety rule 6: one PSD2 fetcher per vault; events.md LEADER and
// 8.3 M6). Two parts:
//
// 1. A pure fold over the signed lease events, the same on every device holding the same set:
//    a compare-and-set chain. Every lease event names `prev`, the eid of the last valid lease event
//    its writer saw; it is valid only if `prev` equals the current head. Concurrent events with the
//    same `prev` are ordered by (hlc, eid) and only the first is valid, which is the deterministic
//    tie-break. `lease.claimed` starts a term (any trusted device), `lease.renewed` extends the
//    holder's term, `lease.released` ends it. No clock enters the fold, so clock skew can never fork
//    it: after convergence every device computes the same holder.
// 2. A per-device belief and step function that adds time conservatively. A holder believes it holds
//    only while `now < until - maxSkew`, only once its claim was published within the publish
//    deadline and a later pull (after the settle period) still showed it as head; others claim only
//    once `now >= until + maxSkew`. With pairwise skew under `maxSkew` (pairing refuses more,
//    events.md 3.3) the holder's belief ends before anyone else may claim, and a concurrent claim
//    that sorts first is visible before the settle period ends, so two beliefs never overlap while
//    the remote is linearizable. Beyond that bound beliefs can overlap until the next pull, never
//    after convergence.
//
// The catch-up watermark (M6): claims and renewals carry, per writer device, the highest HLC the
// holder had applied. A new holder runs newest-day imports only after it applied every device's
// stream up to the previous holder's last watermark (revoked devices excepted: their streams end at
// their cut).

import type { UnstampedEvent } from "../carrier.js";
import { type DeviceIdentity, isDeviceId } from "../crypto/index.js";
import { DEFAULT_MAX_DRIFT_MS, type Hlc } from "../hlc.js";
import { fromHex } from "./bytes.js";
import {
  buildLeaseClaim,
  buildLeaseRelease,
  buildLeaseRenewal,
  decodeLeaseClaim,
  decodeLeaseRelease,
  decodeLeaseRenewal,
  LEASE_CLAIMED,
  LEASE_RELEASED,
  LEASE_RENEWED,
  type LogEvent,
  statementBody,
  type Watermark,
} from "./events.js";
import { dedupe, type Registry } from "./registry.js";
import { type StatementVerifier, verifyStatement } from "./statements.js";

export interface LeaseConfig {
  /** How long a claim or renewal holds (writer's clock). */
  readonly ttlMs: number;
  /** The holder renews once less than this is left. */
  readonly renewBeforeMs: number;
  /** Largest pairwise clock skew the timing tolerates (events.md 3.3: 5 minutes). */
  readonly maxSkewMs: number;
  /** A lease event counts for its writer only if it was pushed to a remote within this time. */
  readonly publishDeadlineMs: number;
  /** After publishing a claim, a pull at least this much later must still show it as head. */
  readonly settleMs: number;
}

const HOUR = 60 * 60 * 1000;

export const DEFAULT_LEASE_CONFIG: LeaseConfig = leaseConfig({});

/** Validated config; the settle period must cover the skew plus the publish deadline. */
export function leaseConfig(overrides: Partial<LeaseConfig>): LeaseConfig {
  const maxSkewMs = overrides.maxSkewMs ?? DEFAULT_MAX_DRIFT_MS;
  const publishDeadlineMs = overrides.publishDeadlineMs ?? 60_000;
  const config: LeaseConfig = {
    ttlMs: overrides.ttlMs ?? 24 * HOUR,
    renewBeforeMs: overrides.renewBeforeMs ?? 12 * HOUR,
    maxSkewMs,
    publishDeadlineMs,
    settleMs: overrides.settleMs ?? maxSkewMs + publishDeadlineMs + 60_000,
  };
  const ok =
    Object.values(config).every((v) => Number.isSafeInteger(v) && v >= 0) &&
    config.settleMs >= config.maxSkewMs + config.publishDeadlineMs &&
    config.renewBeforeMs > 0 &&
    config.ttlMs > config.renewBeforeMs + 2 * config.maxSkewMs + config.settleMs;
  if (!ok)
    throw new RangeError("lease config: settle >= skew + deadline, ttl > renew + 2 skew + settle");
  return config;
}

export interface LeaseTermEntry {
  readonly eid: string;
  readonly kind: "claimed" | "renewed";
  readonly until: number;
}

export type LeaseIgnoredReason =
  | "malformed"
  | "duplicate_eid"
  | "writer_mismatch"
  | "untrusted_writer"
  | "bad_signature"
  | "stale_prev"
  | "not_holder";

export interface LeaseView {
  /** Eid of the last valid lease event (what the next event must name as `prev`). */
  readonly head: string | null;
  readonly holder: string | null;
  readonly released: boolean;
  /** No holder, released, or the holder is no longer trusted (revoked): anyone may claim now. */
  readonly free: boolean;
  /** Latest `until` of the current term (0 when there is none). */
  readonly until: number;
  /** The current term: its claim, then its renewals. */
  readonly term: readonly LeaseTermEntry[];
  /** The holder's latest watermark. */
  readonly watermark: Watermark;
  /** The previous holder's last watermark: apply up to it before newest-day imports. */
  readonly catchUp: Watermark;
  readonly ignored: readonly { readonly eid: string; readonly reason: LeaseIgnoredReason }[];
}

const LEASE_TYPES = new Set<string>([LEASE_CLAIMED, LEASE_RENEWED, LEASE_RELEASED]);

export function isLeaseEvent(event: LogEvent): boolean {
  return LEASE_TYPES.has(event.type);
}

function decodeLease(event: LogEvent) {
  if (event.v !== 1) return undefined;
  if (event.type === LEASE_CLAIMED) {
    const d = decodeLeaseClaim(event.data);
    return d && ({ kind: "claimed", ...d } as const);
  }
  if (event.type === LEASE_RENEWED) {
    const d = decodeLeaseRenewal(event.data);
    return d && ({ kind: "renewed", ...d } as const);
  }
  const d = decodeLeaseRelease(event.data);
  return d && ({ kind: "released", ...d } as const);
}

/** Folds the lease events of a vault (other types are skipped). Never throws on log content. */
export function foldLease(
  registry: Registry,
  events: readonly LogEvent[],
  verify: StatementVerifier = verifyStatement,
): LeaseView {
  const ignored: { eid: string; reason: LeaseIgnoredReason }[] = [];
  const { unique, duplicates } = dedupe(events.filter(isLeaseEvent));
  for (const eid of duplicates) ignored.push({ eid, reason: "duplicate_eid" });

  let head: string | null = null;
  let holder: string | null = null;
  let released = false;
  let until = 0;
  let term: LeaseTermEntry[] = [];
  let watermark: Watermark = {};
  let catchUp: Watermark = {};

  for (const event of unique) {
    const d = decodeLease(event);
    if (!d) {
      ignored.push({ eid: event.eid, reason: "malformed" });
      continue;
    }
    if (d.device !== event.writer) {
      ignored.push({ eid: event.eid, reason: "writer_mismatch" });
      continue;
    }
    const key = registry.statementKey(event.writer, event.position);
    if (!key) {
      ignored.push({ eid: event.eid, reason: "untrusted_writer" });
      continue;
    }
    const body = statementBody(registry.vaultId, event.type, event.eid, event.data);
    if (!verify("cashu/lease/v1", body, fromHex(d.sig), key)) {
      ignored.push({ eid: event.eid, reason: "bad_signature" });
      continue;
    }
    if (d.prev !== head) {
      ignored.push({ eid: event.eid, reason: "stale_prev" });
      continue;
    }
    if (d.kind === "claimed") {
      catchUp = holder === null ? {} : watermark;
      holder = d.device;
      released = false;
      until = d.until;
      term = [{ eid: event.eid, kind: "claimed", until: d.until }];
      watermark = d.watermark;
    } else if (d.device !== holder || released) {
      ignored.push({ eid: event.eid, reason: "not_holder" });
      continue;
    } else if (d.kind === "renewed") {
      until = d.until;
      term = [...term, { eid: event.eid, kind: "renewed", until: d.until }];
      watermark = d.watermark;
    } else {
      released = true;
      watermark = d.watermark;
    }
    head = event.eid;
  }

  const free = holder === null || released || !registry.isTrusted(holder);
  return { head, holder, released, free, until, term, watermark, catchUp, ignored };
}

// ---------------------------------------------------------------------------------------------
// Belief and steps (per device, with its own clock)

/** Device-local record of one of this device's own lease events (kept with leader-local state). */
export interface OwnLeaseRecord {
  /** Local clock when the event was written. */
  readonly writtenAt: number;
  /** Local clock when a sync pass pushed it to a remote; undefined while unpublished. */
  readonly publishedAt?: number;
}

export interface LeaseLocal {
  readonly me: string;
  readonly now: number;
  /** Local clock when the last pass that pulled from a remote finished (undefined: never). */
  readonly lastPullAt: number | undefined;
  readonly own: (eid: string) => OwnLeaseRecord | undefined;
}

function timely(record: OwnLeaseRecord | undefined, config: LeaseConfig): boolean {
  return (
    record?.publishedAt !== undefined &&
    record.publishedAt >= record.writtenAt &&
    record.publishedAt - record.writtenAt <= config.publishDeadlineMs
  );
}

function myTerm(view: LeaseView, local: LeaseLocal): boolean {
  return !view.free && view.holder === local.me && view.term.length > 0;
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
  return (
    record !== undefined &&
    timely(record, config) &&
    local.lastPullAt !== undefined &&
    record.publishedAt !== undefined &&
    local.lastPullAt >= record.publishedAt + config.settleMs
  );
}

/** True while this device may act as the fetch leader (LEADER events, PSD2 fetches). */
export function holdsLease(
  view: LeaseView,
  local: LeaseLocal,
  config: LeaseConfig = DEFAULT_LEASE_CONFIG,
): boolean {
  return (
    myTerm(view, local) &&
    settled(view, local, config) &&
    local.now < effectiveUntil(view, local, config) - config.maxSkewMs
  );
}

export type LeaseStep =
  /** This device holds the lease; renew at `renewAt`. */
  | { readonly kind: "hold"; readonly until: number; readonly renewAt: number }
  | { readonly kind: "renew" }
  | { readonly kind: "claim" }
  /** An own lease event is not pushed yet: run a sync pass. */
  | { readonly kind: "publish" }
  /** The own claim is pushed; pull again at or after `until` before acting. */
  | { readonly kind: "settle"; readonly until: number }
  /** The own term cannot be relied on (published too late, local record lost, or not eligible). */
  | { readonly kind: "release" }
  /** Another device holds the lease; it may be claimed at `until`. */
  | { readonly kind: "wait"; readonly until: number }
  | { readonly kind: "idle" };

/**
 * What this device should do next. `eligible` = this device is configured to fetch (rule 6: the
 * owner picks fetchers; a phone may opt out).
 */
export function nextLeaseStep(
  view: LeaseView,
  local: LeaseLocal,
  eligible: boolean,
  config: LeaseConfig = DEFAULT_LEASE_CONFIG,
): LeaseStep {
  if (myTerm(view, local)) {
    if (!eligible) return { kind: "release" };
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
    // term settles like any claim, and no other device may claim before this term's until + skew.
    return { kind: "claim" };
  }
  if (!eligible) return { kind: "idle" };
  if (view.free) return { kind: "claim" };
  const claimAt = view.until + config.maxSkewMs;
  return local.now >= claimAt ? { kind: "claim" } : { kind: "wait", until: claimAt };
}

/** Writer devices whose streams are not yet applied up to the previous holder's watermark. */
export function catchUpMissing(
  view: LeaseView,
  applied: ReadonlyMap<string, Hlc>,
  registry: Registry,
): string[] {
  const missing: string[] = [];
  for (const [device, hlc] of Object.entries(view.catchUp)) {
    if (registry.revoked.has(device)) continue;
    const have = applied.get(device);
    if (have === undefined || have < hlc) missing.push(device);
  }
  return missing.sort();
}

/**
 * The gate for newest-day-rule imports (events.md 8.3): hold the lease AND have applied the log up
 * to the previous holder's watermark.
 */
export function mayRunNewestDayImports(
  view: LeaseView,
  local: LeaseLocal,
  applied: ReadonlyMap<string, Hlc>,
  registry: Registry,
  config: LeaseConfig = DEFAULT_LEASE_CONFIG,
): boolean {
  return holdsLease(view, local, config) && catchUpMissing(view, applied, registry).length === 0;
}

/** The watermark of a lease event: per writer device, the highest applied HLC. */
export function watermarkOf(applied: ReadonlyMap<string, Hlc>): Watermark {
  const out: Record<string, Hlc> = {};
  for (const [device, hlc] of [...applied].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (isDeviceId(device)) out[device] = hlc;
  }
  return out;
}

export interface LeaseWrite {
  readonly identity: DeviceIdentity;
  readonly vaultId: string;
  readonly eid: string;
  readonly now: number;
  readonly applied: ReadonlyMap<string, Hlc>;
}

/** The event for a `claim` / `renew` / `release` step; record it as an own lease event when written. */
export function leaseEventFor(
  step: "claim" | "renew" | "release",
  view: LeaseView,
  write: LeaseWrite,
  config: LeaseConfig = DEFAULT_LEASE_CONFIG,
): UnstampedEvent {
  const watermark = watermarkOf(write.applied);
  if (step === "claim") {
    return buildLeaseClaim(write.identity, write.vaultId, write.eid, {
      until: write.now + config.ttlMs,
      watermark,
      prev: view.head,
    });
  }
  if (view.head === null || view.holder !== write.identity.deviceId) {
    throw new RangeError("only the holder renews or releases");
  }
  if (step === "renew") {
    return buildLeaseRenewal(write.identity, write.vaultId, write.eid, {
      until: write.now + config.ttlMs,
      watermark,
      prev: view.head,
    });
  }
  return buildLeaseRelease(write.identity, write.vaultId, write.eid, {
    watermark,
    prev: view.head,
  });
}
