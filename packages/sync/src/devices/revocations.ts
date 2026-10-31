// How the registry decides revocations (S29b, review B1 / M1): by stream positions, as the grounded
// fixpoint of "a revocation counts when its signer is certified avoiding the revoked devices and is
// not revoked, or the revocation lies before the signer's cut" (registry.ts explains the rules).

import type { SegmentCursor } from "../carrier.js";
import type { CertificateClosure, CertificateIndex } from "../crypto/index.js";
import { canonicalJson, equalBytes, fromHex, isCanonicalValue } from "./bytes.js";
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
  /** Registered targets with their stated cut (raised to the signer's attested knowledge later). */
  targets: { readonly device: string; cut: SegmentCursor }[];
}

export interface RevocationInput {
  readonly root: TrustRoot;
  /** Every event of the fold (lease statements are read as attested knowledge). */
  readonly events: readonly LogEvent[];
  /** Verified, deduplicated revocation statements. */
  readonly verified: readonly Rev[];
  readonly registered: ReadonlySet<string>;
  readonly index: CertificateIndex;
  /** The certificate closure ignoring revocations. */
  readonly all: CertificateClosure;
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
}

/** Caps, cut validation, mutual exemptions, the grounded fixpoint and the fail-closed result. */
export function resolveRevocations(input: RevocationInput): RevocationResult {
  const { root, events, registered, index, all, verify, ignored } = input;
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

  // --- M1: raise each device revocation's cut to what its signer had attested of the target.
  const knowledge = attestedKnowledge(root, events, revs, all, verify);
  for (const r of revs) {
    if (r.recovery) continue;
    for (const t of r.targets) {
      const known = knowledge(r, t.device);
      if (known) t.cut = maxPosition(t.cut, known);
    }
  }

  // --- A1b: q (X revokes Y) attests it applied Y's stream past y (Y revokes X): y cannot defeat q.
  const naming = new Map<string, Rev[]>();
  for (const r of revs) for (const t of r.targets) push(naming, t.device, r);
  const exempt = new Map<number, Set<number>>();
  for (const q of revs) {
    if (q.recovery) continue;
    for (const t of q.targets) {
      for (const y of naming.get(q.signer) ?? []) {
        if (!y.recovery && y.signer === t.device && beforeCut(y.event.position, t.cut)) {
          const set = exempt.get(q.id) ?? new Set<number>();
          set.add(y.id);
          exempt.set(q.id, set);
        }
      }
    }
  }

  // --- The grounded fixpoint.
  const recoveryIds = new Set(revs.filter((r) => r.recovery).map((r) => r.id));
  // A revoked device's statements before its cut verify with its certified key: the one key pair
  // ever certified for it, or when it was certified with several (conflict), only those a signer
  // that is not revoked vouches for.
  const revokedKeys = (device: string, closure: CertificateClosure) => {
    const ever = all.keysOf(device);
    return ever.length === 1 ? ever : closure.certifiedKeysOf(device);
  };
  const cutOf = (device: string, counted: readonly Rev[]): SegmentCursor | undefined => {
    let rec: SegmentCursor | undefined;
    let dev: SegmentCursor | undefined;
    for (const r of counted) {
      const t = r.targets.find((x) => x.device === device);
      if (!t) continue;
      if (r.recovery) rec = rec ? maxPosition(rec, t.cut) : t.cut;
      else dev = dev ? minPosition(dev, t.cut) : t.cut;
    }
    return rec ?? dev;
  };
  const gamma = (assumed: ReadonlySet<number>): Set<number> => {
    const counted = revs.filter((r) => assumed.has(r.id) || recoveryIds.has(r.id));
    const revokedIds = new Set<string>();
    const countedNaming = new Map<string, Rev[]>();
    for (const r of counted) {
      for (const t of r.targets) {
        revokedIds.add(t.device);
        push(countedNaming, t.device, r);
      }
    }
    const closure = index.closure(revokedIds);
    const out = new Set(recoveryIds);
    for (const r of revs) {
      if (r.recovery) continue;
      const key = r.key as Uint8Array;
      const keys = revokedIds.has(r.signer)
        ? revokedKeys(r.signer, closure)
        : closure.keysOf(r.signer);
      if (!keys.some((k) => equalBytes(k.signPublicKey, key))) continue;
      const skip = exempt.get(r.id);
      const relevant = (countedNaming.get(r.signer) ?? []).filter((y) => !skip?.has(y.id));
      const cut = relevant.length === 0 ? undefined : cutOf(r.signer, relevant);
      if (cut === undefined || beforeCut(r.event.position, cut)) out.add(r.id);
    }
    return out;
  };
  let lower = new Set<number>();
  let upper = gamma(lower);
  for (let step = 0; step <= 2 * revs.length + 2; step++) {
    const nextLower = gamma(upper);
    const nextUpper = gamma(nextLower);
    if (sameSet(nextLower, lower) && sameSet(nextUpper, upper)) break;
    lower = nextLower;
    upper = nextUpper;
  }

  // --- Result: IN and UNDEC revoke (fail closed).
  const counted = revs.filter((r) => upper.has(r.id));
  const revokedIds = new Set<string>(counted.flatMap((r) => r.targets.map((t) => t.device)));
  const finalClosure = index.closure(revokedIds);
  const revoked = new Map<string, Revocation>();
  for (const device of [...revokedIds].sort()) {
    const naming = counted.filter((r) => r.targets.some((t) => t.device === device));
    revoked.set(device, {
      device,
      cut: cutOf(device, naming) as SegmentCursor,
      eids: naming.map((r) => r.event.eid).sort(),
      signers: [...new Set(naming.map((r) => r.signer))].sort(),
      contested: naming.some((r) => !lower.has(r.id)),
      signPublicKeys: revokedKeys(device, finalClosure).map((k) => k.signPublicKey),
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
  return { counted, effective: revs, revoked, revokedIds };
}

/**
 * What a revoker had attested it applied of a target's stream, in its own statements at or before
 * the revocation's position: lease watermarks, lease `prev` links to the target's lease events, and
 * the cuts of its own earlier revocations of the target. Only statements whose signature verifies
 * with one of the revoker's certified keys count.
 */
function attestedKnowledge(
  root: TrustRoot,
  events: readonly LogEvent[],
  revs: readonly Rev[],
  all: CertificateClosure,
  verify: StatementVerifier,
): (r: Rev, target: string) => SegmentCursor | undefined {
  const revokers = new Set(revs.filter((r) => !r.recovery).map((r) => r.signer));
  const leaseByEid = new Map<string, LogEvent>();
  const leaseByWriter = new Map<string, LogEvent[]>();
  for (const e of events) {
    if (!LEASE_TYPES.has(e.type)) continue;
    if (!leaseByEid.has(e.eid)) leaseByEid.set(e.eid, e);
    if (revokers.has(e.writer)) push(leaseByWriter, e.writer, e);
  }
  const cache = new Map<string, Map<string, SegmentCursor>[]>();
  const attestations = (writer: string) => {
    let list = cache.get(writer);
    if (list) return list;
    list = [];
    const keys = all.keysOf(writer).map((k) => k.signPublicKey);
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
      const body = statementBody(root.vaultId, e.type, e.eid, e.data);
      if (!keys.some((k) => verify("cashu/lease/v1", body, fromHex(d.sig), k))) continue;
      const seen = new Map<string, SegmentCursor>(Object.entries(d.watermark));
      const prev = d.prev === null ? undefined : leaseByEid.get(d.prev);
      if (prev) {
        const before = seen.get(prev.writer);
        seen.set(prev.writer, before ? maxPosition(before, prev.position) : prev.position);
      }
      seen.set("@position", e.position);
      list.push(seen);
    }
    cache.set(writer, list);
    return list;
  };
  return (r, target) => {
    let best: SegmentCursor | undefined;
    for (const seen of attestations(r.signer)) {
      const at = seen.get("@position") as SegmentCursor;
      const c = seen.get(target);
      if (c && comparePositions(at, r.event.position) <= 0) best = best ? maxPosition(best, c) : c;
    }
    for (const other of revs) {
      if (other === r || other.recovery || other.signer !== r.signer) continue;
      if (comparePositions(other.event.position, r.event.position) >= 0) continue;
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
