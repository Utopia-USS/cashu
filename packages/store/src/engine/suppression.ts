// Causal suppression and FWW losers (events.md 6.6), as a function of the held event SET:
// - among the terminal transitions of one row (types with rule FWW) the lowest `(hlc, eid)` wins;
//   the others are losers;
// - an event with `cause` = E is applied only if E is held, applied and not a loser, and E is not
//   revoked: no held revoker (catalog `revokes`) with E's gid that names E's eid sorts after E.
// An arriving event can flip earlier decisions either way; the caller re-folds what flipped.
import type { Revocation } from "../events/v1/catalog.js";
import type { EventLog, EventState } from "./log.js";
import { compareOrd, type FoldEvent, ord } from "./types.js";

/** The catalog's suppression inputs (registry `suppressionRules()`). */
export interface SuppressionRules {
  /** Types whose terminal transitions are first-writer-wins. */
  readonly fww: ReadonlySet<string>;
  /** Revoker type -> the cause type it revokes and the payload field naming the cause's eid. */
  readonly revokers: ReadonlyMap<string, Revocation>;
}

/** Revoked (cause) type -> its revoker types with their field. */
function revokersOf(rules: SuppressionRules): Map<string, { type: string; field: string }[]> {
  const out = new Map<string, { type: string; field: string }[]>();
  for (const [type, r] of rules.revokers) {
    out.set(r.cause, [...(out.get(r.cause) ?? []), { type, field: r.field }]);
  }
  return out;
}

/** Whether `r` (a revoker of `field`) revokes the cause `c`: same gid, names c's eid, sorts after. */
function revokes(
  r: { gid: string; hlc: string; eid: string; data: Readonly<Record<string, unknown>> },
  field: string,
  c: { gid: string; hlc: string; eid: string },
): boolean {
  return r.gid === c.gid && r.data[field] === c.eid && ord(r) > ord(c);
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
      const revoked = rules.revokers.get(e.type)?.cause;
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

  // Revocation: a held revoker with the cause's gid, naming the cause's eid, sorting after it.
  const revokedMemo = new Map<string, boolean>();
  const revoked = (c: { type: string; gid: string; hlc: string; eid: string }): boolean => {
    const kinds = revokerTypes.get(c.type);
    if (kinds === undefined) return false;
    const known = revokedMemo.get(c.eid);
    if (known !== undefined) return known;
    const out = kinds.some((k) =>
      log.terminalsOf([k.type], [c.gid]).some((r) => revokes(r, k.field, c)),
    );
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
  // Every held revoker, by (cause type, gid, named cause eid) (they are few: proposal failures).
  const revokerList = [...rules.revokers.entries()].flatMap(([type, r]) =>
    log.heldOfTypes([type]).map((e) => ({ e, r })),
  );
  const byCause = new Map<string, string[]>();
  for (const { e, r } of revokerList) {
    const named = e.data[r.field];
    if (typeof named !== "string") continue;
    const key = `${r.cause}|${e.gid}|${named}`;
    byCause.set(key, [...(byCause.get(key) ?? []), ord(e)]);
  }
  const causes = new Map<string, { type: string; gid: string; hlc: string; eid: string }>();
  const decided = new Map<string, EventState>();
  const groupWinner = new Map<string, string>();
  for (const e of held) {
    causes.set(e.eid, e);
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
    const c = e.cause === null ? undefined : causes.get(e.cause);
    if (to === "applied" && c !== undefined) {
      const at = ord(c);
      if ((byCause.get(`${c.type}|${c.gid}|${c.eid}`) ?? []).some((r) => r > at)) to = "suppressed";
    }
    decided.set(e.eid, to);
    if (e.state !== to) log.setState(e.eid, to);
  }
}
