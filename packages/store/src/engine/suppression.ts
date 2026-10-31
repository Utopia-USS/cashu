// Causal suppression and FWW losers (events.md 6.6), as a function of the held event SET:
// - among the terminal transitions of one row (types with rule FWW) the lowest `(hlc, eid)` wins;
//   the others are losers;
// - an event with `cause` = E is applied only if E is held, applied and not a loser.
// An arriving event can flip earlier decisions either way; the caller re-folds what flipped.
import type { EventLog, EventState } from "./log.js";
import { compareOrd, type FoldEvent, ord } from "./types.js";

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
  fww: ReadonlySet<string>,
): StateFlip[] {
  const fwwTypes = [...fww];
  const pending = new Map<string, Held>();
  for (const e of fresh) pending.set(e.eid, { ...e, state: "new" });

  // Candidates: the fresh events, every terminal of an FWW group a candidate belongs to, and the
  // closure over `cause` (anything caused by a candidate may flip with it). Iterate to a fixpoint.
  const loadedGroups = new Set<string>();
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
    queue = next;
  }

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
    if (p) return ord(p) < ord(e) && decided.get(p.eid) === "applied";
    const row = log.get(e.cause);
    return row !== undefined && row.hlc + row.eid < ord(e) && row.state === "applied";
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
export function recomputeAllSuppression(log: EventLog, fww: ReadonlySet<string>): void {
  const decided = new Map<string, EventState>();
  const groupWinner = new Map<string, string>();
  for (const e of log.allHeldStates()) {
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
    decided.set(e.eid, to);
    if (e.state !== to) log.setState(e.eid, to);
  }
}
