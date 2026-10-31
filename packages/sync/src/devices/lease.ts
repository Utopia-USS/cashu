// The fetch lease (CLAUDE.md data-safety rule 6: one PSD2 fetcher per vault; events.md LEADER and
// 8.3 M6). Two parts:
//
// 1. A pure fold over the signed lease events, the same on every device holding the same set: a
//    compare-and-set chain built from the `prev` links. Every lease event names `prev`, the eid of
//    the last valid lease event its writer saw. Starting from `prev = null`, the chain follows the
//    valid children of the current head; when several children are valid (concurrent events with
//    the same `prev`), the first by (hlc, eid) wins, which is only the deterministic tie-break: the
//    chain itself follows causality (`prev`), so an event stamped with a wrong clock never falls out
//    of it. `lease.claimed` starts a term (any trusted device), `lease.renewed` extends the holder's
//    term, `lease.released` ends it. Durations are bounded: `until - at <= MAX_LEASE_TTL_MS`, and the
//    writer's `at` must agree with the HLC its own engine stamped on the event (`LEASE_CLOCK_
//    TOLERANCE_MS`, the emit guard of events.md 3.3 re-checked at every lease event). No local clock
//    enters the fold, so after convergence every device computes the same holder.
// 2. A per-device belief and step function. A holder acts as leader (LEADER events, PSD2 fetches)
//    only while: its claim was published within the publish deadline and a pull at least the settle
//    period later still showed its term; it pulled within the publish deadline BEFORE this action
//    (so a pre-emption published at least a settle period earlier is always seen); its own clock is
//    not suspect (HLC warnings); and `now < until - maxSkew`. Rule 6 then holds whatever the clocks
//    say: a device that pre-empts (or claims concurrently) acts only a settle period after
//    publishing, and every holder pulls within the publish deadline before each action, so the
//    earlier holder sees the newer term and stops first (as long as the remote shows a published
//    event to every later pull, and one leader action completes within settle - deadline).
//    Clocks only decide liveness: others claim at `min(until, firstSeen + (until - at)) + maxSkew`,
//    so a holder whose clock runs days ahead cannot block fetching for longer than one term.
//
// The catch-up watermark (M6): lease events carry, per writer device, the cursor up to which their
// writer had applied that device's stream. A holder runs newest-day imports only after it applied,
// for every device, the HIGHEST valid cursor any lease event in the chain names (cumulative, not
// only the previous holder's; catchUp.ts: registered devices only, capped at a revoked device's cut,
// conflicted devices dropped, minus owner waivers). Imports a holder made after its last lease event
// are not covered (a holder must not import while it cannot publish).

import type { SegmentCursor, UnstampedEvent } from "../carrier.js";
import { type DeviceIdentity, isDeviceId } from "../crypto/index.js";
import { DEFAULT_MAX_DRIFT_MS, parseHlc } from "../hlc.js";
import { accepted } from "./acceptance.js";
import { canonicalJson, fromHex, isCanonicalValue } from "./bytes.js";
import {
  behindNeed,
  CatchUpFold,
  type DroppedWatermarkEntry,
  type RefusedWaiver,
} from "./catchUp.js";
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
  type LeaseClaimData,
  type LeaseReleaseData,
  type LeaseRenewData,
  type LogEvent,
  statementBody,
  type WaiveRequest,
  type Watermark,
} from "./events.js";
import { comparePositions } from "./positions.js";
import type { Registry } from "./registry.js";
import { type StatementVerifier, verifyStatement } from "./statements.js";
import { cmp, push } from "./util.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * The longest term one claim or renewal may hold: 24 hours. PSD2 fetching runs about once a day
 * (CLAUDE.md rule 6), so a longer term buys nothing, and this bounds how long a holder that dies (or
 * whose clock is wrong) can keep everyone else from fetching: at most one term plus the skew margin.
 */
export const MAX_LEASE_TTL_MS = 24 * HOUR;
/** A lease event's `at` must lie within this of its own HLC wall (events.md 3.3: 5 minutes). */
export const LEASE_CLOCK_TOLERANCE_MS = DEFAULT_MAX_DRIFT_MS;

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
  /** After publishing a claim, a pull at least this much later must still show it as head. */
  readonly settleMs: number;
}

export const DEFAULT_LEASE_CONFIG: LeaseConfig = leaseConfig({});

/** Validated config; the settle period must cover the skew plus the publish deadline. */
export function leaseConfig(overrides: Partial<LeaseConfig>): LeaseConfig {
  const maxSkewMs = overrides.maxSkewMs ?? DEFAULT_MAX_DRIFT_MS;
  const publishDeadlineMs = overrides.publishDeadlineMs ?? 60_000;
  const config: LeaseConfig = {
    ttlMs: overrides.ttlMs ?? MAX_LEASE_TTL_MS,
    renewBeforeMs: overrides.renewBeforeMs ?? 12 * HOUR,
    maxSkewMs,
    publishDeadlineMs,
    settleMs: overrides.settleMs ?? maxSkewMs + publishDeadlineMs + 60_000,
  };
  const ok =
    Object.values(config).every((v) => Number.isSafeInteger(v) && v >= 0) &&
    config.ttlMs <= MAX_LEASE_TTL_MS &&
    config.settleMs >= config.maxSkewMs + config.publishDeadlineMs &&
    config.renewBeforeMs > 0 &&
    config.ttlMs > config.renewBeforeMs + 2 * config.maxSkewMs + config.settleMs;
  if (!ok) {
    throw new RangeError(
      "lease config: ttl <= 24 h, settle >= skew + deadline, ttl > renew + 2 skew + settle",
    );
  }
  return config;
}

export interface LeaseTermEntry {
  readonly eid: string;
  readonly kind: "claimed" | "renewed";
  /** The writer's clock when it wrote the event. */
  readonly at: number;
  readonly until: number;
}

export type LeaseIgnoredReason =
  | "malformed"
  | "duplicate_eid"
  | "writer_mismatch"
  | "untrusted_writer"
  | "bad_signature"
  | "clock_mismatch"
  | "term_too_long"
  | "stale_prev"
  | "not_holder";

export interface LeaseView {
  /** Eid of the last valid lease event (what the next event must name as `prev`). */
  readonly head: string | null;
  readonly holder: string | null;
  readonly released: boolean;
  /** No holder, released, or the holder is no longer trusted (revoked, conflicted): anyone may claim. */
  readonly free: boolean;
  /** Latest `until` of the current term (0 when there is none). */
  readonly until: number;
  /** The current term: its claim, then its renewals. */
  readonly term: readonly LeaseTermEntry[];
  /** The holder's latest watermark. */
  readonly watermark: Watermark;
  /**
   * Pointwise highest VALID cursor named by the lease events of the chain (catchUp.ts): apply up to
   * it before newest-day imports.
   */
  readonly catchUp: Watermark;
  /** Per device in `catchUp`: the eid of the lease event that set it (UI: who requires it). */
  readonly catchUpSources: ReadonlyMap<string, string>;
  /** Watermark entries that never count (unknown or untrusted device). */
  readonly catchUpDropped: readonly DroppedWatermarkEntry[];
  /** Waivers without the owner's confirmation (refused; the events still count otherwise). */
  readonly waiversRefused: readonly RefusedWaiver[];
  readonly ignored: readonly { readonly eid: string; readonly reason: LeaseIgnoredReason }[];
}

const LEASE_TYPES = new Set<string>([LEASE_CLAIMED, LEASE_RENEWED, LEASE_RELEASED]);

export function isLeaseEvent(event: LogEvent): boolean {
  return LEASE_TYPES.has(event.type);
}

type DecodedLease =
  | ({ readonly kind: "claimed" } & LeaseClaimData)
  | ({ readonly kind: "renewed" } & LeaseRenewData)
  | ({ readonly kind: "released" } & LeaseReleaseData);

function decodeLease(event: LogEvent): DecodedLease | undefined {
  if (event.v !== 1) return undefined;
  if (event.type === LEASE_CLAIMED) {
    const d = decodeLeaseClaim(event.data);
    return d && { kind: "claimed", ...d };
  }
  if (event.type === LEASE_RENEWED) {
    const d = decodeLeaseRenewal(event.data);
    return d && { kind: "renewed", ...d };
  }
  const d = decodeLeaseRelease(event.data);
  return d && { kind: "released", ...d };
}

interface Candidate {
  readonly event: LogEvent;
  readonly d: DecodedLease;
}

/** Folds the lease events of a vault (other types are skipped). Never throws on log content. */
export function foldLease(
  registry: Registry,
  events: readonly LogEvent[],
  verify: StatementVerifier = verifyStatement,
): LeaseView {
  const ignored: { eid: string; reason: LeaseIgnoredReason }[] = [];
  const reasons = new Map<string, LeaseIgnoredReason>();

  // Well-formed events whose own fields are consistent; signatures are checked lazily on the walk.
  const byEid = new Map<string, Candidate[]>();
  for (const event of events) {
    if (!isLeaseEvent(event)) continue;
    const d = decodeLease(event);
    if (!d) {
      reasons.set(event.eid, "malformed");
      continue;
    }
    if (d.device !== event.writer) {
      reasons.set(event.eid, "writer_mismatch");
      continue;
    }
    if (Math.abs(d.at - parseHlc(event.hlc).wall) > LEASE_CLOCK_TOLERANCE_MS) {
      reasons.set(event.eid, "clock_mismatch");
      continue;
    }
    if (d.kind !== "released" && !(d.until > d.at && d.until - d.at <= MAX_LEASE_TTL_MS)) {
      reasons.set(event.eid, "term_too_long");
      continue;
    }
    push(byEid, event.eid, { event, d });
  }

  // Signature check (cached per candidate): the writer's trusted key, or its key before its cut.
  const checked = new Map<Candidate, boolean>();
  const authentic = (c: Candidate): boolean => {
    let ok = checked.get(c);
    if (ok === undefined) {
      const keys = registry.statementKeys(c.event.writer, c.event.position);
      const body = statementBody(registry.vaultId, c.event.type, c.event.eid, c.event.data);
      ok = accepted(verify, "cashu/lease/v1", body, fromHex(c.d.sig), {
        kind: "statement",
        keys: registry.decisionKeys,
        device: c.event.writer,
        position: c.event.position,
        revoked: registry.revoked,
      });
      checked.set(c, ok);
      if (!ok) reasons.set(c.event.eid, keys.length === 0 ? "untrusted_writer" : "bad_signature");
    }
    return ok;
  };

  // One copy per eid: the authentic copy earliest in its writer's stream (a replay sits later).
  const unique = new Map<string, Candidate | undefined>();
  const duplicates = new Set<string>();
  const resolve = (eid: string): Candidate | undefined => {
    if (unique.has(eid)) return unique.get(eid);
    const copies = (byEid.get(eid) ?? []).filter(authentic);
    const contents = new Set(copies.map((c) => contentOf(c.event)));
    if (contents.size > 1) {
      duplicates.add(eid);
      ignored.push({ eid, reason: "duplicate_eid" });
    }
    const best = copies.sort(
      (a, b) =>
        cmp(contentOf(a.event), contentOf(b.event)) ||
        comparePositions(a.event.position, b.event.position),
    )[0];
    unique.set(eid, best);
    return best;
  };

  const children = new Map<string | null, string[]>();
  for (const [eid, copies] of byEid) {
    for (const prev of new Set(copies.map((c) => c.d.prev))) push(children, prev, eid);
  }
  // Tie-break between concurrent children: the lowest HLC any copy carries, then the eid.
  const tie = new Map<string, string>();
  for (const [eid, copies] of byEid) {
    tie.set(eid, copies.map((c) => c.event.hlc).sort()[0] as string);
  }
  const order = (a: string, b: string) =>
    cmp(tie.get(a) as string, tie.get(b) as string) || cmp(a, b);

  let head: string | null = null;
  let holder: string | null = null;
  let released = false;
  let until = 0;
  let term: LeaseTermEntry[] = [];
  let watermark: Watermark = {};
  const catchUp = new CatchUpFold(registry, verify);
  const onChain = new Set<string>();

  for (;;) {
    let next: Candidate | undefined;
    for (const eid of (children.get(head) ?? []).sort(order)) {
      if (onChain.has(eid)) continue;
      const c = resolve(eid);
      if (!c || c.d.prev !== head) continue;
      if (c.d.kind !== "claimed" && (c.d.device !== holder || released)) {
        reasons.set(eid, "not_holder");
        continue;
      }
      next = c;
      break;
    }
    if (!next) break;
    const { event, d } = next;
    if (d.kind === "claimed") {
      holder = d.device;
      released = false;
      until = d.until;
      term = [{ eid: event.eid, kind: "claimed", at: d.at, until: d.until }];
    } else if (d.kind === "renewed") {
      until = d.until;
      term = [...term, { eid: event.eid, kind: "renewed", at: d.at, until: d.until }];
    } else {
      released = true;
    }
    watermark = d.watermark;
    catchUp.add(event.eid, event.writer, d.watermark, d.kind === "released" ? undefined : d.waive);
    head = event.eid;
    onChain.add(event.eid);
  }

  for (const eid of byEid.keys()) {
    if (!onChain.has(eid) && !duplicates.has(eid)) {
      reasons.set(eid, reasons.get(eid) ?? "stale_prev");
    }
  }
  for (const [eid, reason] of [...reasons].sort(([a], [b]) => cmp(a, b))) {
    if (!onChain.has(eid)) ignored.push({ eid, reason });
  }

  const free = holder === null || released || !registry.isTrusted(holder);
  const required = catchUp.result();
  return {
    head,
    holder,
    released,
    free,
    until,
    term,
    watermark,
    catchUp: required.need,
    catchUpSources: required.sources,
    catchUpDropped: required.dropped,
    waiversRefused: required.waiversRefused,
    ignored,
  };
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

function pulledRecently(local: LeaseLocal, config: LeaseConfig): boolean {
  return (
    local.lastPullAt !== undefined &&
    local.lastPullAt <= local.now &&
    local.now - local.lastPullAt <= config.publishDeadlineMs
  );
}

/**
 * True while this device may act as the fetch leader. Check it right before EVERY leader action
 * (LEADER event, PSD2 fetch): it requires a pull within the publish deadline.
 */
export function holdsLease(
  view: LeaseView,
  local: LeaseLocal,
  config: LeaseConfig = DEFAULT_LEASE_CONFIG,
): boolean {
  return (
    local.clockOk &&
    myTerm(view, local) &&
    settled(view, local, config) &&
    pulledRecently(local, config) &&
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
  /** This device holds the lease; renew at `renewAt`. */
  | { readonly kind: "hold"; readonly until: number; readonly renewAt: number }
  | { readonly kind: "renew" }
  | { readonly kind: "claim" }
  /** An own lease event is not pushed yet: run a sync pass. */
  | { readonly kind: "publish" }
  /** The own claim is pushed; pull again at or after `until` before acting. */
  | { readonly kind: "settle"; readonly until: number }
  /** The own term cannot be relied on (published too late, record lost, not eligible, bad clock). */
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
    if (!eligible || !local.clockOk) return view.released ? { kind: "idle" } : { kind: "release" };
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
  if (!eligible || !local.clockOk) return { kind: "idle" };
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
      at: write.now,
      until: write.now + config.ttlMs,
      watermark,
      prev: view.head,
      ...(write.waive ? { waive: write.waive } : {}),
    });
  }
  if (view.head === null || view.holder !== write.identity.deviceId) {
    throw new RangeError("only the holder renews or releases");
  }
  if (step === "renew") {
    return buildLeaseRenewal(write.identity, write.vaultId, write.eid, {
      at: write.now,
      until: write.now + config.ttlMs,
      watermark,
      prev: view.head,
      ...(write.waive ? { waive: write.waive } : {}),
    });
  }
  return buildLeaseRelease(write.identity, write.vaultId, write.eid, {
    at: write.now,
    watermark,
    prev: view.head,
  });
}

function contentOf(e: LogEvent): string {
  return isCanonicalValue(e.data) ? canonicalJson(e.data) : `${e.eid}:?`;
}
