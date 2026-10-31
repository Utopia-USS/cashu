// Executable reference semantics for the convergence-critical rules of events.md v1.1:
// identity resolution (6.4), row-keyed folds over resolved keys (6.5), signal episodes (8.7),
// FWW + causal suppression (6.6), SOFT re-creation, GUARDed wake. It is a pure function of the SET
// of events (sorted by (hlc, eid), duplicates by eid ignored), so any delivery order or duplication
// gives the same view. S23 / S25 materializers MUST produce the same results on the same scenarios
// (reference/convergence.test.ts); they may be incremental, this one is not.
//
// Scope: accounts, transactions (imported), watchlist, instrument overrides (segment GUARD), manual
// valuations, signals + decisions, proposals + caused events, connector bindings. Other tables follow
// the same patterns (plain LWW-F / CREATE per gid) and are not modelled here.

export interface RefEvent {
  eid: string;
  hlc: string;
  at: string;
  type: string;
  gid: string;
  data: Record<string, unknown>;
  cause?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Sort by (hlc, eid) and drop re-delivered duplicates (same eid). */
export function ordered(events: readonly RefEvent[]): RefEvent[] {
  const byEid = new Map<string, RefEvent>();
  for (const e of events) if (!byEid.has(e.eid)) byEid.set(e.eid, e);
  return [...byEid.values()].sort((a, b) =>
    a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.eid < b.eid ? -1 : a.eid > b.eid ? 1 : 0,
  );
}

// --------------------------------------------------------------------------------------------- //
// Causal suppression (events.md 6.6): FWW terminal transitions of proposals; caused events follow.
// --------------------------------------------------------------------------------------------- //

const PROPOSAL_TERMINALS = new Set(["proposal.approved", "proposal.rejected", "proposal.failed"]);

export function appliedEvents(evs: readonly RefEvent[]): RefEvent[] {
  const present = new Map(evs.map((e) => [e.eid, e]));
  const losers = new Set<string>();
  const decided = new Set<string>();
  for (const e of evs) {
    if (!PROPOSAL_TERMINALS.has(e.type)) continue;
    if (decided.has(e.gid)) losers.add(e.eid);
    else decided.add(e.gid);
  }
  const memo = new Map<string, boolean>();
  const applied = (e: RefEvent): boolean => {
    const known = memo.get(e.eid);
    if (known !== undefined) return known;
    let ok = !losers.has(e.eid);
    if (ok && e.cause !== undefined) {
      const c = present.get(e.cause);
      ok = c !== undefined && applied(c); // a cause not (yet) held parks the event
    }
    memo.set(e.eid, ok);
    return ok;
  };
  return evs.filter(applied);
}

// --------------------------------------------------------------------------------------------- //
// Identity resolution (events.md 6.4): union-find over key / alias claims and owner merges, processed
// in (hlc, eid) order. A later claim of a held key folds the claimer into the holder's root; a merge
// folds the source's root into the target's root.
// --------------------------------------------------------------------------------------------- //

export class Identity {
  private parent = new Map<string, string>();
  private keyOwner = new Map<string, string>();

  find(g: string): string {
    let r = g;
    for (let p = this.parent.get(r); p !== undefined && p !== r; p = this.parent.get(r)) r = p;
    return r;
  }

  private union(from: string, into: string): void {
    const a = this.find(from);
    const b = this.find(into);
    if (a !== b) this.parent.set(a, b);
  }

  claim(g: string, key: string): void {
    const owner = this.keyOwner.get(key);
    if (owner === undefined) this.keyOwner.set(key, g);
    else this.union(g, owner);
  }

  merge(source: string, target: string): void {
    this.union(source, target);
  }
}

export function resolveIdentities(evs: readonly RefEvent[]) {
  const accounts = new Identity();
  const instruments = new Identity();
  for (const e of evs) {
    if (e.type === "account.opened" || e.type === "account.identified") {
      for (const k of (e.data.keys as string[] | undefined) ?? []) accounts.claim(e.gid, k);
    } else if (e.type === "instrument.aliasAdded") {
      const inst = str(e.data.instrument);
      if (inst) instruments.claim(inst, `${str(e.data.namespace)}:${str(e.data.value)}`);
    } else if (e.type === "instrument.merged") {
      instruments.merge(String(e.data.source), String(e.data.target));
    }
  }
  return { accounts, instruments };
}

/** A dedup key with its `i:` / `a:` gid parts resolved to their roots (gid.md section 6). */
export function resolveDedupKey(key: string, ids: ReturnType<typeof resolveIdentities>): string {
  return key
    .split("|")
    .map((part) => {
      if (part.startsWith("i:")) return `i:${ids.instruments.find(part.slice(2))}`;
      if (part.startsWith("a:")) return `a:${ids.accounts.find(part.slice(2))}`;
      return part;
    })
    .join("|");
}

// --------------------------------------------------------------------------------------------- //
// The view
// --------------------------------------------------------------------------------------------- //

export interface AccountRow {
  gid: string;
  iban: string | null;
  externalId: string | null;
  name: string | null;
  members: string[];
}
export interface WatchRow {
  live: boolean;
  note: string | null;
  tags: string[];
  addedAt: string | null;
  source: string | null;
}
export interface SignalEpisode {
  gid: string;
  key: string;
  status: "active" | "acknowledged" | "resolved" | "expired";
  closedReason: string | null;
  snoozedUntil: string | null;
  message: string | null;
  aliases: string[];
  decisions: string[];
}
export interface BindingRow {
  live: boolean;
  params: unknown;
  cursor: string | null;
}

export interface RefView {
  accounts: Record<string, AccountRow>;
  transactions: Record<string, { gid: string; claim: string | null }>;
  watchlist: Record<string, WatchRow>;
  overrides: Record<string, { segment: string | null; segmentBy: string | null; tags: unknown }>;
  valuations: Record<string, string>;
  signals: Record<string, SignalEpisode>;
  proposals: Record<string, string>;
  bindings: Record<string, BindingRow>;
}

function sortRecord<T>(m: Map<string, T>): Record<string, T> {
  return Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function materialize(input: readonly RefEvent[]): RefView {
  const evs = appliedEvents(ordered(input));
  const ids = resolveIdentities(evs);
  const acc = (g: string) => ids.accounts.find(g);
  const inst = (g: string) => ids.instruments.find(g);

  // Row keys of member gids, learned from the events that name their subject.
  const watchInstrument = new Map<string, string>();
  const txnRowOf = new Map<string, string>();
  const bindingRowOf = new Map<string, string>();
  const signalKeyOf = new Map<string, string>();

  const accounts = new Map<string, AccountRow>();
  const transactions = new Map<string, { gid: string; claim: string | null; claimBy: string }>();
  const watchlist = new Map<string, WatchRow>();
  const overrides = new Map<
    string,
    { segment: string | null; segmentBy: string | null; tags: unknown }
  >();
  const valuations = new Map<string, string>();
  const proposals = new Map<string, string>();
  const bindings = new Map<string, BindingRow>();
  const episodes = new Map<string, SignalEpisode>(); // by episode gid
  const openByKey = new Map<string, string>(); // resolved key -> open episode gid
  const episodeOf = new Map<string, string>(); // signal gid -> episode gid
  const decisionLinks = new Map<string, string[]>(); // decision gid -> episode gids
  const undone = new Set<string>();

  const accountRow = (root: string): AccountRow => {
    let row = accounts.get(root);
    if (!row) {
      row = { gid: root, iban: null, externalId: null, name: null, members: [] };
      accounts.set(root, row);
    }
    return row;
  };
  const isOpen = (ep: SignalEpisode) => ep.status === "active" || ep.status === "acknowledged";
  const liveLinks = (ep: SignalEpisode) =>
    [...decisionLinks.entries()].some(([d, eps]) => !undone.has(d) && eps.includes(ep.gid));

  for (const e of evs) {
    const d = e.data;
    switch (e.type) {
      case "account.opened":
      case "account.identified": {
        const row = accountRow(acc(e.gid));
        if (!row.members.includes(e.gid)) row.members.push(e.gid);
        if (row.iban === null && str(d.iban)) row.iban = str(d.iban) ?? null; // first non-null wins
        if (row.externalId === null && str(d.externalId))
          row.externalId = str(d.externalId) ?? null;
        if (e.type === "account.opened" && row.name === null) row.name = str(d.name) ?? null;
        break;
      }
      case "account.renamed":
        accountRow(acc(e.gid)).name = str(d.name) ?? null;
        break;

      case "txn.imported": {
        const row = `${acc(String(d.account))}|${String(d.dedupHash)}|${String(d.occurrence)}`;
        txnRowOf.set(e.gid, row);
        if (!transactions.has(row)) transactions.set(row, { gid: e.gid, claim: null, claimBy: "" });
        break;
      }
      case "txn.categorySet": {
        const t = transactions.get(txnRowOf.get(e.gid) ?? "");
        if (!t) break; // parked: its import is not held
        const source = String(d.source);
        if (source !== "manual_txn" && t.claimBy === "manual_txn") break; // GUARD
        t.claim = String(d.category);
        t.claimBy = source;
        break;
      }

      case "watchlist.added":
      case "watchlist.updated":
      case "watchlist.removed": {
        if (e.type === "watchlist.added") watchInstrument.set(e.gid, String(d.instrument));
        const member = watchInstrument.get(e.gid);
        if (member === undefined) break; // parked
        const key = inst(member);
        const row = watchlist.get(key) ?? {
          live: false,
          note: null,
          tags: [],
          addedAt: null,
          source: null,
        };
        if (e.type === "watchlist.added") {
          row.live = true; // M2: re-add restores
          row.addedAt = e.at;
          row.source = str(d.source) ?? null;
        }
        if (e.type === "watchlist.removed") row.live = false;
        if ("note" in d) row.note = (d.note as string | null) ?? null;
        if ("tags" in d) row.tags = (d.tags as string[]) ?? [];
        watchlist.set(key, row);
        break;
      }

      case "instrumentOverride.set":
      case "instrumentOverride.segmentSet": {
        const key = inst(String(d.instrument));
        const row = overrides.get(key) ?? { segment: null, segmentBy: null, tags: null };
        if (e.type === "instrumentOverride.set" && "tags" in d) row.tags = d.tags;
        if (e.type === "instrumentOverride.segmentSet") {
          const by = String(d.by);
          if (by === "agent" && row.segment !== null && row.segmentBy === "owner") {
            overrides.set(key, row);
            break; // GUARD: the agent never changes the owner's segment
          }
          row.segment = (d.segment as string | null) ?? null;
          row.segmentBy = row.segment === null ? null : by;
        }
        overrides.set(key, row);
        break;
      }

      case "valuation.set":
        valuations.set(`${inst(String(d.instrument))}|${String(d.asOf)}`, String(d.unitValue));
        break;

      case "signal.opened": {
        const key = resolveDedupKey(String(d.dedupKey), ids);
        signalKeyOf.set(e.gid, key);
        const open = openByKey.get(key);
        if (open !== undefined) {
          const ep = episodes.get(open);
          if (ep) {
            ep.aliases.push(e.gid); // B2: a second open of an open key joins the open episode
            ep.message = str(d.message) ?? ep.message;
          }
          episodeOf.set(e.gid, open);
          break;
        }
        const ep: SignalEpisode = {
          gid: e.gid,
          key,
          status: "active",
          closedReason: null,
          snoozedUntil: null,
          message: str(d.message) ?? null,
          aliases: [],
          decisions: [],
        };
        episodes.set(e.gid, ep);
        episodeOf.set(e.gid, e.gid);
        openByKey.set(key, e.gid);
        break;
      }
      case "signal.refreshed":
      case "signal.escalated":
      case "signal.closed":
      case "signal.reopened":
      case "signal.snoozed":
      case "signal.woken": {
        const ep = episodes.get(episodeOf.get(e.gid) ?? "");
        if (!ep) break; // parked
        if (e.type === "signal.refreshed" || e.type === "signal.escalated") {
          if (!isOpen(ep)) break;
          ep.message = str(d.message) ?? ep.message;
          if (e.type === "signal.escalated" && d.reactivate === true) ep.status = "active";
        } else if (e.type === "signal.closed") {
          if (!isOpen(ep)) break;
          ep.status = d.status === "expired" ? "expired" : "resolved";
          ep.closedReason = str(d.reason) ?? null;
          if (openByKey.get(ep.key) === ep.gid) openByKey.delete(ep.key);
        } else if (e.type === "signal.reopened") {
          const fits =
            (d.reason === "alert_restored" && ep.status === "expired") ||
            (d.reason === "note_restored" && ep.status === "resolved");
          if (!fits || openByKey.has(ep.key)) break; // another episode of the key is open
          ep.status = liveLinks(ep) ? "acknowledged" : "active";
          ep.closedReason = null;
          openByKey.set(ep.key, ep.gid);
        } else if (e.type === "signal.snoozed") {
          ep.snoozedUntil = (d.until as string | null) ?? null;
        } else if (e.type === "signal.woken") {
          if (ep.snoozedUntil !== d.until) break; // M7 GUARD: a newer snooze stands
          ep.snoozedUntil = null;
          if (ep.status === "acknowledged") ep.status = "active";
        }
        break;
      }
      case "decision.recorded": {
        const eps: string[] = [];
        for (const s of (d.signals as string[]) ?? []) {
          const ep = episodes.get(episodeOf.get(s) ?? "");
          if (!ep) continue;
          eps.push(ep.gid);
          if (!ep.decisions.includes(e.gid)) ep.decisions.push(e.gid);
          if (ep.status === "active") ep.status = "acknowledged";
        }
        decisionLinks.set(e.gid, eps);
        break;
      }
      case "decision.undone": {
        undone.add(e.gid);
        for (const g of decisionLinks.get(e.gid) ?? []) {
          const ep = episodes.get(g);
          if (!ep) continue;
          ep.decisions = ep.decisions.filter((x) => x !== e.gid);
          if (ep.status === "acknowledged" && !liveLinks(ep)) ep.status = "active";
        }
        break;
      }

      case "proposal.created":
        proposals.set(e.gid, "pending");
        break;
      case "proposal.approved":
      case "proposal.rejected":
      case "proposal.failed":
        if (proposals.has(e.gid)) proposals.set(e.gid, e.type.slice("proposal.".length));
        break;

      case "connectorBinding.set": {
        const row = `${acc(String(d.account))}|${String(d.connectorId)}`;
        bindingRowOf.set(e.gid, row);
        const b = bindings.get(row) ?? { live: false, params: null, cursor: null };
        b.live = true; // M1: a set after a removal re-creates the binding
        b.params = d.params;
        bindings.set(row, b);
        break;
      }
      case "connectorBinding.removed":
      case "connectorBinding.cursorAdvanced": {
        const b = bindings.get(bindingRowOf.get(e.gid) ?? "");
        if (!b) break;
        if (e.type === "connectorBinding.removed") b.live = false;
        else b.cursor = (d.cursor as string | null) ?? null;
        break;
      }
    }
  }

  return {
    accounts: sortRecord(accounts),
    transactions: sortRecord(
      new Map([...transactions].map(([k, v]) => [k, { gid: v.gid, claim: v.claim }])),
    ),
    watchlist: sortRecord(watchlist),
    overrides: sortRecord(overrides),
    valuations: sortRecord(valuations),
    signals: sortRecord(episodes),
    proposals: sortRecord(proposals),
    bindings: sortRecord(bindings),
  };
}
