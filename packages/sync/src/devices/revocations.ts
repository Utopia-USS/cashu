// How the registry decides revocations (S29b, review B1 / M1): by stream positions, as the grounded
// fixpoint of "a revocation counts when its signer is certified avoiding the revoked devices and is
// not revoked, or the revocation lies before the signer's cut" (registry.ts explains the rules).

import type { SegmentCursor } from "../carrier.js";
import type { CertificateIndex } from "../crypto/index.js";
import { canonicalJson, equalBytes, fromHex, isCanonicalValue } from "./bytes.js";
import { DecisionKeys } from "./decisionKeys.js";
import {
  decodeLeaseClaim,
  decodeLeaseRelease,
  decodeLeaseRenewal,
  LEASE_CLAIMED,
  LEASE_RELEASED,
  LEASE_RENEWED,
  type LogEvent,
  statementBody,
} from "./events.js";
import { beforeCut, comparePositions, maxPosition, minPosition } from "./positions.js";
import {
  type IgnoredStatement,
  MAX_REVOCATIONS_PER_SIGNER,
  type Revocation,
  type TrustRoot,
} from "./registryTypes.js";
import type { StatementVerifier } from "./statements.js";
import { cmp, push } from "./util.js";

const LEASE_TYPES = new Set<string>([LEASE_CLAIMED, LEASE_RENEWED, LEASE_RELEASED]);

/** A revocation statement whose signature verified. */
export interface Rev {
  readonly id: number;
  readonly event: LogEvent;
  readonly signer: string;
  readonly recovery: boolean;
  /** The certified key the statement verified with (device revocations). */
  readonly key: Uint8Array | undefined;
  /** Registered targets with their STATED cut (each fold step raises it with its decision keys). */
  targets: { readonly device: string; readonly cut: SegmentCursor }[];
}

export interface RevocationInput {
  readonly root: TrustRoot;
  /** Every event of the fold (lease statements are read as attested knowledge). */
  readonly events: readonly LogEvent[];
  /** Verified, deduplicated revocation statements. */
  readonly verified: readonly Rev[];
  readonly registered: ReadonlySet<string>;
  readonly index: CertificateIndex;
  readonly verify: StatementVerifier;
  /** Receives the statements that do not count (capped, no effect, defeated). */
  readonly ignored: IgnoredStatement[];
}

export interface RevocationResult {
  /** Counted revocation events (IN and UNDEC): each is one epoch step. */
  readonly counted: readonly Rev[];
  /** All revocations with an effect, in id order (authentic: pairing welcomes carry them). */
  readonly effective: readonly Rev[];
  readonly revoked: ReadonlyMap<string, Revocation>;
  readonly revokedIds: ReadonlySet<string>;
  /** The decision keys under the final revocations (Registry.statementKeys). */
  readonly keys: DecisionKeys;
}

/** Caps, cut validation, mutual exemptions, the grounded fixpoint and the fail-closed result. */
export function resolveRevocations(input: RevocationInput): RevocationResult {
  const { root, events, registered, index, verify, ignored } = input;
  const deduped = input.verified;
  // --- Caps and effect.
  const bySigner = new Map<string, Rev[]>();
  for (const r of deduped) if (!r.recovery) push(bySigner, r.signer, r);
  const capped = new Set<Rev>();
  for (const list of bySigner.values()) {
    list.sort(
      (a, b) =>
        comparePositions(a.event.position, b.event.position) || cmp(a.event.eid, b.event.eid),
    );
    for (const r of list.slice(MAX_REVOCATIONS_PER_SIGNER)) capped.add(r);
  }
  const revs: Rev[] = [];
  for (const r of deduped) {
    if (capped.has(r)) {
      ignored.push({ eid: r.event.eid, reason: "capped" });
      continue;
    }
    r.targets = r.targets.filter((t) => registered.has(t.device));
    if (r.targets.length === 0) {
      ignored.push({ eid: r.event.eid, reason: "no_effect" });
      continue;
    }
    revs.push({ ...r, id: revs.length });
  }

  // --- The grounded fixpoint. Everything a step decides from keys (who may revoke, a revoked
  // signer's key, M1 attestations that raise cuts, the A1b exemption built on those cuts) uses the
  // DECISION KEYS under that step's assumed revocations (decisionKeys.ts): a key certified through a
  // revoked or conflicted device never contributes.
  const recoveryIds = new Set(revs.filter((r) => r.recovery).map((r) => r.id));
  const knowledge = attestedKnowledge(root, events, revs, verify);
  const step = (assumed: ReadonlySet<number>) => {
    const counted = revs.filter((r) => assumed.has(r.id) || recoveryIds.has(r.id));
    const revokedIds = new Set<string>();
    for (const r of counted) for (const t of r.targets) revokedIds.add(t.device);
    const keys = new DecisionKeys(index, revokedIds);
    const cuts = raisedCuts(revs, keys, knowledge);
    return { counted, revokedIds, keys, cuts };
  };
  const gamma = (assumed: ReadonlySet<number>): Set<number> => {
    const { counted, revokedIds, keys, cuts } = step(assumed);
    const exempt = exemptions(revs, cuts);
    const countedNaming = new Map<string, Rev[]>();
    for (const r of counted) for (const t of r.targets) push(countedNaming, t.device, r);
    const out = new Set(recoveryIds);
    for (const r of revs) {
      if (r.recovery) continue;
      const key = r.key as Uint8Array;
      if (!keys.signKeysOf(r.signer).some((k) => equalBytes(k, key))) continue;
      if (revokedIds.has(r.signer)) {
        const skip = exempt.get(r.id);
        const relevant = (countedNaming.get(r.signer) ?? []).filter((y) => !skip?.has(y.id));
        const cut = relevant.length === 0 ? undefined : cutOf(r.signer, relevant, cuts);
        if (cut !== undefined && !beforeCut(r.event.position, cut)) continue;
      }
      out.add(r.id);
    }
    return out;
  };
  let lower = new Set<number>();
  let upper = gamma(lower);
  for (let i = 0; i <= 2 * revs.length + 2; i++) {
    const nextLower = gamma(upper);
    const nextUpper = gamma(nextLower);
    if (sameSet(nextLower, lower) && sameSet(nextUpper, upper)) break;
    lower = nextLower;
    upper = nextUpper;
  }

  // --- Result: IN and UNDEC revoke (fail closed).
  const { counted, revokedIds, keys, cuts } = step(upper);
  // R1: a counted device revocation answered by a counted device revocation of its own signer is
  // contested whatever the exemption decided (retaliation and rewrite look alike by positions).
  const mutual = new Set<number>();
  for (const r of counted) {
    if (r.recovery) continue;
    const answered = counted.some(
      (y) =>
        !y.recovery &&
        r.targets.some((t) => t.device === y.signer) &&
        y.targets.some((t) => t.device === r.signer),
    );
    if (answered) mutual.add(r.id);
  }
  const revoked = new Map<string, Revocation>();
  for (const device of [...revokedIds].sort()) {
    const naming = counted.filter((r) => r.targets.some((t) => t.device === device));
    revoked.set(device, {
      device,
      cut: cutOf(device, naming, cuts) as SegmentCursor,
      eids: naming.map((r) => r.event.eid).sort(),
      signers: [...new Set(naming.map((r) => r.signer))].sort(),
      contested: naming.some((r) => !lower.has(r.id) || mutual.has(r.id)),
      signPublicKeys: keys.signKeysOf(device),
    });
  }
  for (const r of revs) {
    if (upper.has(r.id)) continue;
    const signerRevocation = revoked.get(r.signer);
    ignored.push({
      eid: r.event.eid,
      reason:
        signerRevocation && !beforeCut(r.event.position, signerRevocation.cut)
          ? "after_revocation"
          : "untrusted_signer",
    });
  }
  return { counted, effective: revs, revoked, revokedIds, keys };
}

/** Per revocation and target: the effective cut (a device cut raised to its signer's attestations). */
type Cuts = (r: Rev, device: string) => SegmentCursor;

function raisedCuts(revs: readonly Rev[], keys: DecisionKeys, knowledge: Knowledge): Cuts {
  const raised = new Map<number, Map<string, SegmentCursor>>();
  for (const r of revs) {
    const map = new Map<string, SegmentCursor>();
    for (const t of r.targets) {
      const known = r.recovery ? undefined : knowledge(r, t.device, keys);
      map.set(t.device, known ? maxPosition(t.cut, known) : t.cut);
    }
    raised.set(r.id, map);
  }
  return (r, device) => raised.get(r.id)?.get(device) as SegmentCursor;
}

/** The effective cut of `device` among `counted`: the highest recovery cut, else the lowest device cut. */
function cutOf(device: string, counted: readonly Rev[], cuts: Cuts): SegmentCursor | undefined {
  let rec: SegmentCursor | undefined;
  let dev: SegmentCursor | undefined;
  for (const r of counted) {
    if (!r.targets.some((x) => x.device === device)) continue;
    const cut = cuts(r, device);
    if (r.recovery) rec = rec ? maxPosition(rec, cut) : cut;
    else dev = dev ? minPosition(dev, cut) : cut;
  }
  return rec ?? dev;
}

/** A1b: q (X revokes Y) attests it applied Y's stream past y (Y revokes X): y cannot defeat q. */
function exemptions(revs: readonly Rev[], cuts: Cuts): Map<number, Set<number>> {
  const naming = new Map<string, Rev[]>();
  for (const r of revs) for (const t of r.targets) push(naming, t.device, r);
  const exempt = new Map<number, Set<number>>();
  for (const q of revs) {
    if (q.recovery) continue;
    for (const t of q.targets) {
      for (const y of naming.get(q.signer) ?? []) {
        if (
          !y.recovery &&
          y.signer === t.device &&
          beforeCut(y.event.position, cuts(q, t.device))
        ) {
          const set = exempt.get(q.id) ?? new Set<number>();
          set.add(y.id);
          exempt.set(q.id, set);
        }
      }
    }
  }
  return exempt;
}

type Knowledge = (r: Rev, target: string, keys: DecisionKeys) => SegmentCursor | undefined;

/**
 * What a revoker had attested it applied of a target's stream, in its own statements at or before
 * the revocation's position: lease watermarks, lease `prev` links to the target's lease events, and
 * the stated cuts of its own earlier revocations of the target. Only statements that verify with the
 * revoker's DECISION key count (decisionKeys.ts).
 */
function attestedKnowledge(
  root: TrustRoot,
  events: readonly LogEvent[],
  revs: readonly Rev[],
  verify: StatementVerifier,
): Knowledge {
  const revokers = new Set(revs.filter((r) => !r.recovery).map((r) => r.signer));
  const leaseByEid = new Map<string, LogEvent>();
  const leaseByWriter = new Map<string, LogEvent[]>();
  for (const e of events) {
    if (!LEASE_TYPES.has(e.type)) continue;
    if (!leaseByEid.has(e.eid)) leaseByEid.set(e.eid, e);
    if (revokers.has(e.writer)) push(leaseByWriter, e.writer, e);
  }
  // Decoded once; verified per decision key (the memoized verifier makes repeats cheap).
  const decoded = new Map<
    string,
    { e: LogEvent; sig: Uint8Array; body: Uint8Array; seen: Map<string, SegmentCursor> }[]
  >();
  const statementsOf = (writer: string) => {
    let list = decoded.get(writer);
    if (list) return list;
    list = [];
    for (const e of leaseByWriter.get(writer) ?? []) {
      const d =
        e.v !== 1
          ? undefined
          : e.type === LEASE_CLAIMED
            ? decodeLeaseClaim(e.data)
            : e.type === LEASE_RENEWED
              ? decodeLeaseRenewal(e.data)
              : decodeLeaseRelease(e.data);
      if (!d || d.device !== writer) continue;
      const seen = new Map<string, SegmentCursor>(Object.entries(d.watermark));
      const prev = d.prev === null ? undefined : leaseByEid.get(d.prev);
      if (prev) {
        const before = seen.get(prev.writer);
        seen.set(prev.writer, before ? maxPosition(before, prev.position) : prev.position);
      }
      const body = statementBody(root.vaultId, e.type, e.eid, e.data);
      list.push({ e, sig: fromHex(d.sig), body, seen });
    }
    decoded.set(writer, list);
    return list;
  };
  return (r, target, keys) => {
    const signKeys = keys.signKeysOf(r.signer);
    if (signKeys.length === 0) return undefined;
    let best: SegmentCursor | undefined;
    for (const { e, sig, body, seen } of statementsOf(r.signer)) {
      const c = seen.get(target);
      if (!c || comparePositions(e.position, r.event.position) > 0) continue;
      if (!signKeys.some((k) => verify("cashu/lease/v1", body, sig, k))) continue;
      best = best ? maxPosition(best, c) : c;
    }
    for (const other of revs) {
      if (other === r || other.recovery || other.signer !== r.signer) continue;
      if (comparePositions(other.event.position, r.event.position) >= 0) continue;
      if (!signKeys.some((k) => equalBytes(k, other.key as Uint8Array))) continue;
      const t = other.targets.find((x) => x.device === target);
      if (t) best = best ? maxPosition(best, t.cut) : t.cut;
    }
    return best;
  };
}

/**
 * Among verified revocations with the same eid: identical content keeps the copy earliest in its
 * writer's stream (a replay can only sit later than the genuine one); different content (only the
 * signer itself can sign two) keeps the copy with the smallest content and reports the eid.
 */
export function dedupeVerified(revs: readonly Rev[], ignored: IgnoredStatement[]): Rev[] {
  const byEid = new Map<string, Rev[]>();
  for (const r of revs) push(byEid, r.event.eid, r);
  const out: Rev[] = [];
  for (const [eid, list] of byEid) {
    const contents = new Set(list.map((r) => contentOf(r.event)));
    const sorted = [...list].sort(
      (a, b) =>
        cmp(contentOf(a.event), contentOf(b.event)) ||
        cmp(a.event.writer, b.event.writer) ||
        comparePositions(a.event.position, b.event.position),
    );
    out.push(sorted[0] as Rev);
    if (contents.size > 1) ignored.push({ eid, reason: "duplicate_eid" });
  }
  return out.sort((a, b) => cmp(a.event.eid, b.event.eid));
}

function contentOf(e: LogEvent): string {
  return isCanonicalValue(e.data) ? `${e.type}|${e.v}|${canonicalJson(e.data)}` : `${e.eid}:?`;
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
