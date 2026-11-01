// The lease fold (lease.ts has the overview, the belief and the steps): a pure function of the set of
// lease events, the same on every device holding the same set. A compare-and-set chain built from the
// `prev` links: every lease event names `prev`, the eid of the last valid lease event its writer saw.
// The chain starts at the creator's recovery-signed pin (`prev = null`; nothing else may root it) and
// follows the valid children of the current head. When several children are valid, an owner pin wins
// over the others, then the first by (hlc, eid) (only the deterministic tie-break: the chain follows
// causality, so an event stamped with a wrong clock never falls out of it).
//
// Modes (S29c R4, lead decision D3). The owner's `lease.pinned` sets the mode:
// - `pinned` (the default from the creator's pin on): exactly one designated fetch leader. Claims and
//   renewals are ignored (`pinned_mode`). A re-pin to another device leaves `pendingFrom` = the leader
//   that was allowed to act before it, unless `force`, unless that leader wrote the pin itself, and
//   unless it is no longer trusted; the new leader may act only after `pendingFrom` acknowledged with
//   a `lease.released` on the chain (the hand-over ack). Rule 6 needs no propagation bound here: the
//   old leader acknowledges only after it saw the pin, and from then on it never acts.
// - `auto` (owner opt-in): claims, renewals and releases as before (terms, settle period); the belief
//   uses it only over a transport declaring bounded propagation. The leader in charge before the
//   opt-in acknowledges first, like a re-pin.
// The leader reports each completed fetch with `lease.fetched` (liveness, the 36 h warning). Durations
// are bounded (`until - at <= MAX_LEASE_TTL_MS`) and every `at` must agree with its event's HLC wall
// (`LEASE_CLOCK_TOLERANCE_MS`). No local clock enters the fold.

import { RECOVERY_SIGNER_ID } from "../crypto/index.js";
import { DEFAULT_MAX_DRIFT_MS, parseHlc } from "../hlc.js";
import { accepted, type KeySource } from "./acceptance.js";
import { canonicalJson, fromHex, isCanonicalValue } from "./bytes.js";
import { CatchUpFold, type DroppedWatermarkEntry, type RefusedWaiver } from "./catchUp.js";
import {
  decodeLeaseClaim,
  decodeLeaseFetched,
  decodeLeasePin,
  decodeLeaseRelease,
  decodeLeaseRenewal,
  LEASE_CLAIMED,
  LEASE_FETCHED,
  LEASE_PINNED,
  LEASE_RELEASED,
  LEASE_RENEWED,
  type LeaseClaimData,
  type LeaseFetchedData,
  type LeasePinnedData,
  type LeaseReleaseData,
  type LeaseRenewData,
  type LogEvent,
  pinConfirmationText,
  statementBody,
  type Watermark,
} from "./events.js";
import { comparePositions } from "./positions.js";
import type { Registry } from "./registry.js";
import { type StatementVerifier, verifyStatement } from "./statements.js";
import { cmp, push } from "./util.js";

/**
 * The longest term one claim or renewal may hold: 24 hours. PSD2 fetching runs about once a day
 * (CLAUDE.md rule 6), so a longer term buys nothing, and this bounds how long a holder that dies (or
 * whose clock is wrong) can keep everyone else from fetching: at most one term plus the skew margin.
 */
export const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
/** A lease event's `at` must lie within this of its own HLC wall (events.md 3.3: 5 minutes). */
export const LEASE_CLOCK_TOLERANCE_MS = DEFAULT_MAX_DRIFT_MS;

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
  | "not_holder"
  /** A device-signed pin without the owner's typed confirmation. */
  | "unconfirmed"
  /** A `prev = null` event other than a recovery-signed pin (only the creator's pin roots the chain). */
  | "not_root"
  /** A claim or renewal while the owner pinned a leader. */
  | "pinned_mode"
  /** A claim or renewal while the previous leader has not handed over yet. */
  | "pending_handover";

export interface LeaseView {
  /** Eid of the last valid lease event (what the next event must name as `prev`). */
  readonly head: string | null;
  /** `pinned` (one designated leader; also before any pin, then leaderless) or `auto`. */
  readonly mode: "pinned" | "auto";
  /** Mode pinned: the designated leader (null: none yet). Mode auto: null. */
  readonly pinned: string | null;
  /**
   * The leader allowed to act before the last pin, which must acknowledge (`lease.released`) before
   * anyone else acts; null when none (forced, self-written, untrusted, or acknowledged).
   */
  readonly pendingFrom: string | null;
  /** Mode pinned: the pinned leader. Mode auto: the device of the current term. */
  readonly holder: string | null;
  readonly released: boolean;
  /**
   * Nobody may act as leader through this view: mode pinned with no trusted leader, or mode auto with
   * no term, a released one, or an untrusted holder (then anyone may claim).
   */
  readonly free: boolean;
  /** Latest `until` of the current term (0 when there is none; always 0 in mode pinned). */
  readonly until: number;
  /** The current term: its claim, then its renewals (empty in mode pinned). */
  readonly term: readonly LeaseTermEntry[];
  /** Mode pinned: the pin that made `pinned` the leader (its `at` starts the liveness clock). */
  readonly pin: { readonly eid: string; readonly at: number; readonly force: boolean } | null;
  /** The leader's last fetch report since it became leader (`lease.fetched`). */
  readonly lastFetch: { readonly eid: string; readonly at: number } | null;
  /** Eids of the recovery-signed pins on the chain (a recovery change ratifies them). */
  readonly recoveryPins: readonly string[];
  /** The latest chain event's watermark. */
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

const LEASE_TYPES = new Set<string>([
  LEASE_CLAIMED,
  LEASE_RENEWED,
  LEASE_RELEASED,
  LEASE_PINNED,
  LEASE_FETCHED,
]);

export function isLeaseEvent(event: LogEvent): boolean {
  return LEASE_TYPES.has(event.type);
}

type DecodedLease =
  | ({ readonly kind: "claimed" } & LeaseClaimData)
  | ({ readonly kind: "renewed" } & LeaseRenewData)
  | ({ readonly kind: "released" } & LeaseReleaseData)
  | ({ readonly kind: "fetched" } & LeaseFetchedData)
  | ({ readonly kind: "pinned" } & LeasePinnedData);

function decodeLease(event: LogEvent): DecodedLease | undefined {
  if (event.v !== 1) return undefined;
  switch (event.type) {
    case LEASE_CLAIMED: {
      const d = decodeLeaseClaim(event.data);
      return d && { kind: "claimed", ...d };
    }
    case LEASE_RENEWED: {
      const d = decodeLeaseRenewal(event.data);
      return d && { kind: "renewed", ...d };
    }
    case LEASE_RELEASED: {
      const d = decodeLeaseRelease(event.data);
      return d && { kind: "released", ...d };
    }
    case LEASE_FETCHED: {
      const d = decodeLeaseFetched(event.data);
      return d && { kind: "fetched", ...d };
    }
    default: {
      const d = decodeLeasePin(event.data);
      return d && { kind: "pinned", ...d };
    }
  }
}

interface Candidate {
  readonly event: LogEvent;
  readonly d: DecodedLease;
}

/** Field checks that need no signature; the reason an event can never count, or undefined. */
function shapeProblem(event: LogEvent, d: DecodedLease): LeaseIgnoredReason | undefined {
  if (d.kind === "pinned") {
    if (d.signer !== RECOVERY_SIGNER_ID && d.signer !== event.writer) return "writer_mismatch";
    if (
      d.signer !== RECOVERY_SIGNER_ID &&
      d.text !== pinConfirmationText(d.mode, d.leader, d.force)
    )
      return "unconfirmed";
  } else if (d.device !== event.writer) {
    return "writer_mismatch";
  }
  if (Math.abs(d.at - parseHlc(event.hlc).wall) > LEASE_CLOCK_TOLERANCE_MS) return "clock_mismatch";
  if (
    (d.kind === "claimed" || d.kind === "renewed") &&
    !(d.until > d.at && d.until - d.at <= MAX_LEASE_TTL_MS)
  ) {
    return "term_too_long";
  }
  if (d.prev === null && !(d.kind === "pinned" && d.signer === RECOVERY_SIGNER_ID)) {
    return "not_root";
  }
  return undefined;
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
    const problem = d ? shapeProblem(event, d) : "malformed";
    if (problem || !d) {
      reasons.set(event.eid, problem ?? "malformed");
      continue;
    }
    push(byEid, event.eid, { event, d });
  }

  // Signature check (cached per candidate) through the gate: the recovery key for a recovery-signed
  // pin (a replaced key only for statements its change ratified), else the writer's trusted key, or
  // its key before its cut (a revoked device's later events never count).
  const checked = new Map<Candidate, boolean>();
  const authentic = (c: Candidate): boolean => {
    let ok = checked.get(c);
    if (ok === undefined) {
      const byRecovery = c.d.kind === "pinned" && c.d.signer === RECOVERY_SIGNER_ID;
      const source: KeySource = byRecovery
        ? { kind: "recovery", signKeys: registry.recoverySignKeysFor(c.event.eid) }
        : {
            kind: "statement",
            keys: registry.decisionKeys,
            device: c.event.writer,
            position: c.event.position,
            revoked: registry.revoked,
          };
      const body = statementBody(registry.vaultId, c.event.type, c.event.eid, c.event.data);
      ok = accepted(verify, "cashu/lease/v1", body, fromHex(c.d.sig), source);
      checked.set(c, ok);
      if (!ok) {
        const keyless =
          !byRecovery && registry.statementKeys(c.event.writer, c.event.position).length === 0;
        reasons.set(c.event.eid, keyless ? "untrusted_writer" : "bad_signature");
      }
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
  // Tie-break between concurrent children: owner pins first, then the lowest HLC any copy carries,
  // then the eid (a fetch report or renewal racing the owner's pin never undoes the owner's action).
  const tie = new Map<string, string>();
  const pinEids = new Set<string>();
  for (const [eid, copies] of byEid) {
    tie.set(eid, copies.map((c) => c.event.hlc).sort()[0] as string);
    if (copies.some((c) => c.d.kind === "pinned")) pinEids.add(eid);
  }
  const order = (a: string, b: string) =>
    Number(pinEids.has(b)) - Number(pinEids.has(a)) ||
    cmp(tie.get(a) as string, tie.get(b) as string) ||
    cmp(a, b);

  const trusted = (d: string | null): d is string => d !== null && registry.isTrusted(d);
  let head: string | null = null;
  let mode: "pinned" | "auto" = "pinned";
  let pinned: string | null = null;
  let pendingFrom: string | null = null;
  let pin: LeaseView["pin"] = null;
  let lastFetch: LeaseView["lastFetch"] = null;
  let holder: string | null = null;
  let released = false;
  let until = 0;
  let term: LeaseTermEntry[] = [];
  let watermark: Watermark = {};
  const catchUp = new CatchUpFold(registry, verify);
  const onChain = new Set<string>();
  const recoveryPins: string[] = [];

  /** Who could still act as leader right now (the one a new pin must hear from). */
  const activeLeader = (): string | null => {
    if (trusted(pendingFrom)) return pendingFrom;
    if (mode === "pinned") return trusted(pinned) ? pinned : null;
    return !released && trusted(holder) ? holder : null;
  };
  /** Why `d` cannot extend the chain now, or undefined. */
  const refusal = (d: DecodedLease): LeaseIgnoredReason | undefined => {
    const pending = trusted(pendingFrom);
    switch (d.kind) {
      case "pinned":
        return undefined;
      case "claimed":
      case "renewed":
        if (mode === "pinned") return "pinned_mode";
        if (pending) return "pending_handover";
        return d.kind === "claimed" || (d.device === holder && !released)
          ? undefined
          : "not_holder";
      case "released":
        if (pending) return d.device === pendingFrom ? undefined : "not_holder";
        return mode === "auto" && d.device === holder && !released ? undefined : "not_holder";
      case "fetched": {
        if (pending) return "not_holder";
        const leader = mode === "pinned" ? pinned : released ? null : holder;
        return d.device === leader ? undefined : "not_holder";
      }
    }
  };

  for (;;) {
    let next: Candidate | undefined;
    for (const eid of (children.get(head) ?? []).sort(order)) {
      if (onChain.has(eid)) continue;
      const c = resolve(eid);
      if (!c || c.d.prev !== head) continue;
      const why = refusal(c.d);
      if (why) {
        reasons.set(eid, why);
        continue;
      }
      next = c;
      break;
    }
    if (!next) break;
    const { event, d } = next;
    if (d.kind === "pinned") {
      const active = activeLeader();
      const handsOver =
        active !== null &&
        !d.force &&
        active !== event.writer &&
        !(d.mode === "pinned" && active === d.leader);
      pendingFrom = handsOver ? active : null;
      if (d.signer === RECOVERY_SIGNER_ID) recoveryPins.push(event.eid);
      mode = d.mode;
      pinned = d.mode === "pinned" ? d.leader : null;
      pin = d.mode === "pinned" ? { eid: event.eid, at: d.at, force: d.force } : null;
      lastFetch = null;
      holder = null;
      released = false;
      until = 0;
      term = [];
    } else if (d.kind === "claimed") {
      holder = d.device;
      released = false;
      until = d.until;
      term = [{ eid: event.eid, kind: "claimed", at: d.at, until: d.until }];
      lastFetch = null;
    } else if (d.kind === "renewed") {
      until = d.until;
      term = [...term, { eid: event.eid, kind: "renewed", at: d.at, until: d.until }];
    } else if (d.kind === "released") {
      if (trusted(pendingFrom) && d.device === pendingFrom) pendingFrom = null;
      if (mode === "auto" && d.device === holder) released = true;
    } else {
      lastFetch = { eid: event.eid, at: d.at };
    }
    watermark = d.watermark;
    const waive = d.kind === "claimed" || d.kind === "renewed" ? d.waive : undefined;
    catchUp.add(event.eid, event.writer, d.watermark, waive);
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

  if (mode === "pinned") holder = pinned;
  const free =
    mode === "pinned" ? !trusted(pinned) : holder === null || released || !trusted(holder);
  const required = catchUp.result();
  return {
    head,
    mode,
    pinned,
    pendingFrom: trusted(pendingFrom) ? pendingFrom : null,
    holder,
    released,
    free,
    until,
    term,
    pin,
    lastFetch,
    recoveryPins,
    watermark,
    catchUp: required.need,
    catchUpSources: required.sources,
    catchUpDropped: required.dropped,
    waiversRefused: required.waiversRefused,
    ignored,
  };
}

function contentOf(e: LogEvent): string {
  return isCanonicalValue(e.data) ? canonicalJson(e.data) : `${e.eid}:?`;
}
