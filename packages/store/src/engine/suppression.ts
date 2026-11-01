// Causal suppression and FWW losers (events.md 6.6), as a function of the held event SET:
// - among the terminal transitions of one row (types with rule FWW) the lowest `(hlc, eid)` wins;
//   the others are losers;
// - an event with `cause` = E is applied only if E is held, applied and not a loser, and E is not
//   revoked: no held revoker of E's type (catalog `revokesCausesOf`) with E's gid sorts after E.
// An arriving event can flip earlier decisions either way; the caller re-folds what flipped.
import type { EventLog, EventState } from "./log.js";
import { compareOrd, type FoldEvent, ord } from "./types.js";

/** The catalog's suppression inputs (registry `suppressionRules()`). */
export interface SuppressionRules {
  /** Types whose terminal transitions are first-writer-wins. */
  readonly fww: ReadonlySet<string>;
  /** Revoker type -> the type whose caused events it revokes (same gid, sorting after it). */
  readonly revokers: ReadonlyMap<string, string>;
}

/** Revoked type -> its revoker types. */
function revokersOf(rules: SuppressionRules): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [revoker, revoked] of rules.revokers) {
    out.set(revoked, [...(out.get(revoked) ?? []), revoker]);
  }
  return out;
}

export interface StateFlip {
  readonly event: FoldEvent;
  /** `new` for an event inserted in this apply. */
  readonly from: EventState | "new";
  readonly to: EventState;
}

type Held = FoldEvent & { state: EventState | "new" };

/**
 * Decide the state of the newly inserted known events and of every held event whose state they can
 * change. Writes the states and returns the flips (new events always appear, with `from: "new"`).
 */
export function updateSuppression(
  log: EventLog,
  fresh: readonly FoldEvent[],
  rules: SuppressionRules,
): StateFlip[] {
  const fww = rules.fww;
  const fwwTypes = [...fww];
  const revokerTypes = revokersOf(rules);
  const pending = new Map<string, Held>();
  for (const e of fresh) pending.set(e.eid, { ...e, state: "new" });

  // Candidates: the fresh events, every terminal of an FWW group a candidate belongs to, and the
  // closure over `cause` (anything caused by a candidate may flip with it). Iterate to a fixpoint.
  const loadedGroups = new Set<string>();
  const loadedRevoked = new Set<string>();
  let queue = [...pending.values()];
  while (queue.length > 0) {
    const next: Held[] = [];
    for (const c of log.causedBy(queue.map((e) => e.eid))) {
      if (!pending.has(c.eid)) {
        pending.set(c.eid, c);
        next.push(c);
      }
    }
    const groups = [...pending.values()]
      .filter((e) => fww.has(e.type) && !loadedGroups.has(e.gid))
      .map((e) => e.gid);
    for (const g of groups) loadedGroups.add(g);
    if (groups.length > 0) {
      for (const t of log.terminalsOf(fwwTypes, [...new Set(groups)])) {
        if (!pending.has(t.eid)) {
          pending.set(t.eid, t);
          next.push(t);
        }
      }
    }
    // A revoker re-decides the events its revoked event caused: load that event (its caused events
    // follow through `causedBy` on the next round).
    for (const e of [...pending.values()]) {
      const revoked = rules.revokers.get(e.type);
      const key = `${revoked}|${e.gid}`;
      if (revoked === undefined || loadedRevoked.has(key)) continue;
      loadedRevoked.add(key);
      for (const t of log.terminalsOf([revoked], [e.gid])) {
        if (!pending.has(t.eid)) {
          pending.set(t.eid, t);
          next.push(t);
        }
      }
    }
    queue = next;
  }

  // Revocation: a held revoker of the cause's type and gid that sorts after the cause.
  const revokedMemo = new Map<string, boolean>();
  const revoked = (c: { type: string; gid: string; hlc: string; eid: string }): boolean => {
    const types = revokerTypes.get(c.type);
    if (types === undefined) return false;
    const known = revokedMemo.get(c.eid);
    if (known !== undefined) return known;
    const at = ord(c);
    const out = log.terminalsOf(types, [c.gid]).some((r) => ord(r) > at);
    revokedMemo.set(c.eid, out);
    return out;
  };

  // FWW: per group the lowest (hlc, eid) among its held terminals wins (whatever their causes).
  const winners = new Map<string, Held>();
  for (const e of pending.values()) {
    if (!fww.has(e.type)) continue;
    const w = winners.get(e.gid);
    if (w === undefined || ord(e) < ord(w)) winners.set(e.gid, e);
  }

  const decided = new Map<string, EventState>();
  const causeApplied = (e: Held): boolean => {
    if (e.cause === undefined) return true;
    const p = pending.get(e.cause);
    if (p) return ord(p) < ord(e) && decided.get(p.eid) === "applied" && !revoked(p);
    const row = log.get(e.cause);
    return (
      row !== undefined && row.hlc + row.eid < ord(e) && row.state === "applied" && !revoked(row)
    );
  };

  const flips: StateFlip[] = [];
  for (const e of [...pending.values()].sort(compareOrd)) {
    let to: EventState = "applied";
    if (fww.has(e.type) && winners.get(e.gid)?.eid !== e.eid) to = "suppressed";
    if (to === "applied" && !causeApplied(e)) to = "suppressed";
    decided.set(e.eid, to);
    if (e.state === "new") {
      if (to !== "applied") log.setState(e.eid, to); // inserted as applied
      flips.push({ event: e, from: "new", to });
    } else if (e.state !== to) {
      log.setState(e.eid, to);
      flips.push({ event: e, from: e.state, to });
    }
  }
  return flips;
}

/** Full pass over every held event (rebuild): recompute every state from scratch. */
export function recomputeAllSuppression(log: EventLog, rules: SuppressionRules): void {
  const fww = rules.fww;
  const held = log.allHeldStates();
  // Positions in fold order: the last held revoker per (revoked type, gid).
  const lastRevoker = new Map<string, number>();
  held.forEach((e, i) => {
    const revoked = rules.revokers.get(e.type);
    if (revoked !== undefined) lastRevoker.set(`${revoked}|${e.gid}`, i);
  });
  const position = new Map<string, number>();
  const kind = new Map<string, string>();
  const decided = new Map<string, EventState>();
  const groupWinner = new Map<string, string>();
  for (const [i, e] of held.entries()) {
    position.set(e.eid, i);
    kind.set(e.eid, `${e.type}|${e.gid}`);
    let to: EventState = "applied";
    if (fww.has(e.type)) {
      const w = groupWinner.get(e.gid);
      if (w === undefined) groupWinner.set(e.gid, e.eid);
      else to = "suppressed";
    }
    // The cause must be held, applied and sort before its effect (events.md 5: same batch, earlier).
    if (to === "applied" && e.cause !== null && decided.get(e.cause) !== "applied") {
      to = "suppressed";
    }
    if (to === "applied" && e.cause !== null) {
      const revoker = lastRevoker.get(kind.get(e.cause) ?? "");
      if (revoker !== undefined && revoker > (position.get(e.cause) ?? Infinity)) to = "suppressed";
    }
    decided.set(e.eid, to);
    if (e.state !== to) log.setState(e.eid, to);
  }
}
