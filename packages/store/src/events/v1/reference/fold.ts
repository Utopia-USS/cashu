// Executable reference semantics for the convergence-critical rules of events.md v1.2:
// deterministic gid check (7.10, invalid-gid), identity resolution (6.4), row-keyed folds over
// resolved keys (6.4), signal episodes (8.7), FWW + causal suppression (6.6), CREATE (6.2), SOFT
// re-creation, GUARDed wake. It is a pure function of the SET of events (sorted by (hlc, eid),
// duplicates by eid ignored), so any delivery order or duplication gives the same view. The store's
// materializers MUST produce the same results on the shared scenarios (reference/testing/scenarios.ts,
// run by reference/convergence.test.ts and the store's convergence acceptance); they may be
// incremental, this one is not.
//
// Scope: the profile, its modules (enabled register + enabled_at), accounts (key parking), balances
// (row key under account merges), loans (visible with terms), asset notes, transactions (imported,
// cash legs, cash expenses + TOMB), watchlist, instrument overrides (segment GUARD), manual
// valuations, signals + decisions, proposals + caused events, connector bindings. Other tables follow
// the same patterns (plain LWW-F / CREATE per gid) and are not modelled here.

import { detPartsOf } from "../det-parts.js";
import { claimAllowed } from "../identity.js";
import type { GidTable } from "../namespaces.js";

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

// --------------------------------------------------------------------------------------------- //
// Deterministic gids (events.md 7.10): an event whose gid is DET over parts its payload carries MUST
// carry exactly DET(table)[parts]; otherwise it is parked (`invalid-gid`): held, never folded, never
// a valid cause. DET is a parameter (the store computes the keyed HMAC, the scenarios bind synthetic
// names), so this module stays free of salts and crypto.
// --------------------------------------------------------------------------------------------- //

/** `DET(table)[parts]` (gid.md 3). */
export type RefDet = (table: GidTable, parts: readonly string[]) => string;

function gidValid(e: RefEvent, det: RefDet): boolean {
  const p = detPartsOf(e.type, e.data);
  return p === undefined || det(p.table, p.parts) === e.gid;
}

/** Sort by (hlc, eid) and drop re-delivered duplicates (same eid). */
function ordered(events: readonly RefEvent[]): RefEvent[] {
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

function appliedEvents(evs: readonly RefEvent[]): RefEvent[] {
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

class Identity {
  private parent = new Map<string, string>();
  private keyOwner = new Map<string, string>();
  /** root -> its exclusive key (accounts: the one `iban:` key a component may hold, review N2). */
  private exclusiveOf = new Map<string, string>();
  /** Claims / unions refused by the exclusive-key guard, in fold order (shown as conflicts). */
  readonly conflicts: string[] = [];

  constructor(private readonly exclusivePrefix: string | null = null) {}

  find(g: string): string {
    let r = g;
    for (let p = this.parent.get(r); p !== undefined && p !== r; p = this.parent.get(r)) r = p;
    return r;
  }

  exclusiveKey(g: string): string | undefined {
    return this.exclusiveOf.get(this.find(g));
  }

  /** Fold `from`'s root into `into`'s root unless both hold different exclusive keys. */
  private union(from: string, into: string, why: string): boolean {
    const a = this.find(from);
    const b = this.find(into);
    if (a === b) return true;
    const ka = this.exclusiveOf.get(a);
    const kb = this.exclusiveOf.get(b);
    if (ka !== undefined && kb !== undefined && ka !== kb) {
      this.conflicts.push(why);
      return false;
    }
    this.parent.set(a, b);
    if (kb === undefined && ka !== undefined) this.exclusiveOf.set(b, ka);
    return true;
  }

  /** Claim `key` for `g`; true when the key now belongs to g's component. */
  claim(g: string, key: string): boolean {
    const exclusive = this.exclusivePrefix !== null && key.startsWith(this.exclusivePrefix);
    if (exclusive) {
      const held = this.exclusiveOf.get(this.find(g));
      if (held !== undefined && held !== key) {
        this.conflicts.push(`${g} ${key}`);
        return false;
      }
    }
    const owner = this.keyOwner.get(key);
    if (owner === undefined) {
      this.keyOwner.set(key, g);
      if (exclusive) this.exclusiveOf.set(this.find(g), key);
      return true;
    }
    return this.union(g, owner, `${g} ${key}`);
  }

  merge(source: string, target: string): void {
    this.union(source, target, `${source}->${target}`);
  }
}

function resolveIdentities(evs: readonly RefEvent[]) {
  const accounts = new Identity("iban:");
  const instruments = new Identity();
  /** The raw IBAN of each event whose `iban:` claim was accepted, by eid. */
  const acceptedIban = new Map<string, string>();
  for (const e of evs) {
    if (e.type === "account.opened" || e.type === "account.identified") {
      for (const k of (e.data.keys as string[] | undefined) ?? []) {
        if (!claimAllowed(k, e.data.iban)) continue; // N2: no checksum, no claim
        const ok = accounts.claim(e.gid, k);
        if (ok && k.startsWith("iban:") && !acceptedIban.has(e.eid)) {
          acceptedIban.set(e.eid, String(e.data.iban));
        }
      }
    } else if (e.type === "instrument.aliasAdded") {
      const inst = str(e.data.instrument);
      if (inst) instruments.claim(inst, `${str(e.data.namespace)}:${str(e.data.value)}`);
    } else if (e.type === "instrument.merged") {
      instruments.merge(String(e.data.source), String(e.data.target));
    }
  }
  return { accounts, instruments, acceptedIban };
}

/** A dedup key with its `i:` / `a:` gid parts resolved to their roots (gid.md section 6). */
function resolveDedupKey(key: string, ids: ReturnType<typeof resolveIdentities>): string {
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

interface AccountRow {
  /** The identity root: always one of `members` (events.md 6.4, N1). */
  gid: string;
  /** The raw IBAN as claimed: the first accepted claim's, else the first non-null `iban` (6.4). */
  iban: string | null;
  /** The component's `iban:` key without the prefix (checksum-valid only, N2), else null. */
  ibanKey: string | null;
  externalId: string | null;
  name: string | null;
  members: string[];
}
interface TxnRow {
  /** The anchor: the first applied member (N1); writers may address any member. */
  gid: string;
  members: string[];
  claim: string | null;
  /** The derived cash mirror leg, present while the effective claim is cash_withdrawal. */
  leg: { gid: string; claim: string | null } | null;
}
interface LoanRow {
  /** The anchor: the termsSet that made the row visible. */
  gid: string;
  principal: string;
  paymentIban: string | null;
  paymentText: string | null;
}
interface NoteRow {
  /** The anchor: the first set with a note (S24 D-24.9). */
  gid: string;
  note: string | null;
}
interface CashExpenseRow {
  claim: string | null;
  claimBy: string;
}
interface WatchRow {
  gid: string;
  members: string[];
  live: boolean;
  note: string | null;
  tags: string[];
  addedAt: string | null;
  source: string | null;
}
interface SignalEpisode {
  gid: string;
  key: string;
  status: "active" | "acknowledged" | "resolved" | "expired";
  closedReason: string | null;
  snoozedUntil: string | null;
  message: string | null;
  aliases: string[];
  decisions: string[];
}
interface BindingRow {
  live: boolean;
  params: unknown;
  cursor: string | null;
}

interface ProfileRow {
  name: string;
  baseCurrency: string;
  mcpPrivacy: string;
}
interface ModuleRow {
  enabled: boolean;
  /** Time of the enable that flipped the register to enabled (S24 D-24.4). */
  enabledAt: string;
}
interface BalanceRow {
  /** The anchor: the first applied member (N1). */
  gid: string;
  amount: string;
  /** The first applied record's currency (S24 D-24.5). */
  currency: string;
  /** Time of the latest record (LWW with the amount). */
  at: string;
}

export interface RefView {
  profile: ProfileRow | null;
  modules: Record<string, ModuleRow>;
  balances: Record<string, BalanceRow>;
  accounts: Record<string, AccountRow>;
  /** Loans by resolved account: visible once terms exist (m7). */
  loans: Record<string, LoanRow>;
  /** Asset notes by resolved account: no row before a non-null note (D-24.9). */
  notes: Record<string, NoteRow>;
  /** Live cash expenses (TOMB on delete) with their claim register. */
  cashExpenses: Record<string, CashExpenseRow>;
  transactions: Record<string, TxnRow>;
  accountConflicts: string[];
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

export function materialize(input: readonly RefEvent[], det: RefDet): RefView {
  const evs = appliedEvents(ordered(input).filter((e) => gidValid(e, det)));
  const ids = resolveIdentities(evs);
  const acc = (g: string) => ids.accounts.find(g);
  const inst = (g: string) => ids.instruments.find(g);

  // Row keys of member gids, learned from the events that name their subject.
  const watchInstrument = new Map<string, string>();
  const txnRowOf = new Map<string, string>();
  const bindingRowOf = new Map<string, string>();

  let profile: (ProfileRow & { created: boolean }) | null = null;
  const moduleRegs = new Map<string, { enabled: boolean; enabledAt: string | null }>();
  const balances = new Map<string, BalanceRow>();
  const accounts = new Map<string, AccountRow>();
  /** root -> the first non-null raw `iban` of its opens / identifications (shown without a key). */
  const rawIban = new Map<string, string>();
  const openedRoots = new Set<string>(); // roots with an applied account.opened of any member
  interface TxnState {
    gid: string;
    members: string[];
    /** Resolved account and currency of the first applied import (CREATE). */
    account: string;
    currency: string;
    claim: string | null;
    claimBy: string;
    legClaim: string | null;
    legClaimBy: string;
  }
  const transactions = new Map<string, TxnState>();
  const ownName = new Map<string, string>(); // account gid -> its own first opened name
  const bankOf = new Map<string, { bank: string; type: string; firstOrd: number }>(); // root -> first open
  const typeSet = new Map<string, string>(); // account root -> latest account.typeSet
  const expenses = new Map<string, CashExpenseRow>(); // cash expense gid -> live row
  const loanRegs = new Map<
    string,
    Partial<LoanRow> & { payment?: [string | null, string | null] }
  >();
  const notes = new Map<string, NoteRow>();
  const deletedExpenses = new Set<string>(); // TOMB
  const removed = new Map<string, boolean>(); // account root -> SOFT register
  const renamed = new Map<string, string>(); // account root -> latest explicit rename
  const memberLive = new Map<string, boolean>(); // watchlist member gid -> its own SOFT register
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
      row = { gid: root, iban: null, ibanKey: null, externalId: null, name: null, members: [] };
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
      case "profile.created":
      case "profile.renamed":
      case "profile.settingsChanged": {
        const p: ProfileRow & { created: boolean } = profile ?? {
          created: false,
          name: "",
          baseCurrency: "",
          mcpPrivacy: "",
        };
        if (e.type === "profile.created") {
          if (p.created) break; // CREATE: the first applied create stands
          p.created = true;
          p.name = String(d.name);
          p.baseCurrency = String(d.baseCurrency);
          p.mcpPrivacy = String(d.mcpPrivacy);
        } else if (e.type === "profile.renamed") {
          p.name = String(d.name);
        } else {
          if ("baseCurrency" in d) p.baseCurrency = String(d.baseCurrency);
          if ("mcpPrivacy" in d) p.mcpPrivacy = String(d.mcpPrivacy);
        }
        profile = p;
        break;
      }
      case "module.enabled":
      case "module.disabled": {
        const id = String(d.moduleId);
        const reg = moduleRegs.get(id) ?? { enabled: false, enabledAt: null };
        if (e.type === "module.enabled" && !reg.enabled) reg.enabledAt = e.at;
        reg.enabled = e.type === "module.enabled";
        moduleRegs.set(id, reg);
        break;
      }
      case "balance.recorded": {
        const key = `${acc(String(d.account))}|${String(d.date)}|${String(d.source)}`;
        const row = balances.get(key);
        if (row === undefined) {
          balances.set(key, {
            gid: e.gid,
            amount: String(d.amount),
            currency: String(d.currency),
            at: e.at,
          });
        } else {
          row.amount = String(d.amount);
          row.at = e.at;
        }
        break;
      }
      case "account.opened":
      case "account.identified": {
        const row = accountRow(acc(e.gid));
        if (!row.members.includes(e.gid)) row.members.push(e.gid);
        // N2: only an accepted `iban:` claim sets the identity IBAN (one per component, checksum
        // valid); without one the first raw `iban` is shown (no data loss), never as a key.
        const accepted = ids.acceptedIban.get(e.eid);
        if (row.iban === null && accepted !== undefined) row.iban = accepted;
        const raw = str(d.iban);
        if (raw && !rawIban.has(acc(e.gid))) rawIban.set(acc(e.gid), raw);
        if (row.externalId === null && str(d.externalId))
          row.externalId = str(d.externalId) ?? null;
        if (e.type === "account.opened") {
          openedRoots.add(acc(e.gid));
          if (!bankOf.has(acc(e.gid))) {
            bankOf.set(acc(e.gid), {
              bank: String(d.bank),
              type: String(d.type),
              firstOrd: evs.indexOf(e),
            });
          }
          if (!ownName.has(e.gid)) ownName.set(e.gid, str(d.name) ?? "");
          if (row.name === null) row.name = str(d.name) ?? null;
        }
        break;
      }
      case "account.renamed":
        renamed.set(acc(e.gid), str(d.name) ?? "");
        break;
      case "account.typeSet":
        typeSet.set(acc(e.gid), String(d.type));
        break;
      case "loan.termsSet":
      case "loan.paymentMatchingSet": {
        const key = acc(String(d.account));
        const reg = loanRegs.get(key) ?? {};
        if (e.type === "loan.termsSet") {
          reg.gid ??= e.gid;
          reg.principal = String(d.principal);
        } else {
          reg.payment = [
            (d.paymentIban as string | null) ?? null,
            (d.paymentText as string | null) ?? null,
          ];
        }
        loanRegs.set(key, reg);
        break;
      }
      case "assetDetails.noteSet": {
        const key = acc(String(d.account));
        const note = (d.note as string | null) ?? null;
        const row = notes.get(key);
        if (row !== undefined) row.note = note;
        else if (note !== null) notes.set(key, { gid: e.gid, note });
        break;
      }
      case "txn.cashExpenseAdded":
        // CREATE once per gid; never again after its TOMB.
        if (!expenses.has(e.gid) && !deletedExpenses.has(e.gid)) {
          expenses.set(e.gid, { claim: String(d.category), claimBy: "manual_txn" });
        }
        break;
      case "txn.deleted":
        if (expenses.delete(e.gid)) deletedExpenses.add(e.gid); // a delete of anything else: no-op
        break;
      case "account.removed":
      case "account.restored":
        removed.set(acc(e.gid), e.type === "account.removed");
        break;

      case "txn.imported": {
        const row = `${acc(String(d.account))}|${String(d.dedupHash)}|${String(d.occurrence)}`;
        txnRowOf.set(e.gid, row);
        const t = transactions.get(row) ?? {
          gid: e.gid, // the anchor: first applied member
          members: [],
          account: acc(String(d.account)),
          currency: String(d.currency),
          claim: null,
          claimBy: "",
          legClaim: null,
          legClaimBy: "",
        };
        if (!t.members.includes(e.gid)) t.members.push(e.gid);
        transactions.set(row, t);
        break;
      }
      case "txn.categorySet":
      case "txn.categoryCleared": {
        // The subject is a member gid, or the leg gid of a member: `cashleg:<member>` stands in for
        // DET(transactions)["cashleg", member] (gid.md 4.4). Any member's leg gid reaches the leg.
        const expense = expenses.get(e.gid);
        if (expense !== undefined) {
          const source = e.type === "txn.categoryCleared" ? "" : String(d.source);
          if (source.startsWith("llm") && expense.claimBy === "manual_txn") break; // GUARD
          expense.claim = e.type === "txn.categoryCleared" ? null : String(d.category);
          expense.claimBy = source;
          break;
        }
        const isLeg = e.gid.startsWith("cashleg:");
        const member = isLeg ? e.gid.slice("cashleg:".length) : e.gid;
        const t = transactions.get(txnRowOf.get(member) ?? "");
        if (!t) break; // parked: its import is not held
        const source = e.type === "txn.categoryCleared" ? "" : String(d.source);
        const by = isLeg ? t.legClaimBy : t.claimBy;
        if (source.startsWith("llm") && by === "manual_txn") break; // GUARD
        const category = e.type === "txn.categoryCleared" ? null : String(d.category);
        if (isLeg) {
          t.legClaim = category;
          t.legClaimBy = source;
        } else {
          t.claim = category;
          t.claimBy = source;
        }
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
          gid: e.gid, // the anchor: first applied member
          members: [],
          live: false,
          note: null,
          tags: [],
          addedAt: null,
          source: null,
        };
        if (!row.members.includes(e.gid)) row.members.push(e.gid);
        if (e.type === "watchlist.added") {
          memberLive.set(e.gid, true); // M2: re-add restores
          row.addedAt = e.at;
          row.source = str(d.source) ?? null;
        }
        if (e.type === "watchlist.removed") memberLive.set(e.gid, false);
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
        if (episodeOf.has(e.gid)) break; // CREATE: a signal gid is opened once
        const key = resolveDedupKey(String(d.dedupKey), ids);
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
        if (!proposals.has(e.gid)) proposals.set(e.gid, "pending"); // CREATE: the first create stands
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

  // An account row exists once an open of any member is applied (its bank, currency and name come
  // from the first applied open); a component known only through `account.identified` has no row.
  for (const root of [...accounts.keys()]) if (!openedRoots.has(root)) accounts.delete(root);
  // N4: an explicit rename wins, else the identity root's own opened name.
  for (const [root, row] of accounts) {
    row.name = renamed.get(root) ?? ownName.get(root) ?? row.name;
    row.ibanKey = ids.accounts.exclusiveKey(root)?.slice("iban:".length) ?? null;
    row.iban ??= rawIban.get(root) ?? null;
  }
  // Key parking (S24 D-24.7): per (bank, external id) group the live rows hold the key, else the one
  // whose first open sorts last; every other member shows `<key>~<gid>`.
  const groups = new Map<string, AccountRow[]>();
  for (const [root, row] of accounts) {
    if (row.externalId === null) continue;
    const k = `${bankOf.get(root)?.bank}\u0000${row.externalId}`;
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  for (const rows of groups.values()) {
    const live = rows.filter((r) => removed.get(r.gid) !== true);
    const latest = [...rows].sort(
      (a, b) => (bankOf.get(b.gid)?.firstOrd ?? 0) - (bankOf.get(a.gid)?.firstOrd ?? 0),
    )[0];
    const holders = new Set(live.length > 0 ? live : latest ? [latest] : []);
    for (const r of rows) if (!holders.has(r)) r.externalId = `${r.externalId}~${r.gid}`;
  }
  // N3: presence of a merged watchlist row = any member's own SOFT register is live.
  for (const row of watchlist.values()) {
    row.live = row.members.some((m) => memberLive.get(m) === true);
  }
  // A cash leg needs the manual claim (D-24.3), a row not on a cash account, and the cash pool
  // account of its currency open (scenario name `pool:<CUR>` stands in for DET(accounts)["ext",
  // "manual", "cash:<CUR>"]).
  const accountType = (root: string) => typeSet.get(root) ?? bankOf.get(root)?.type;
  const txnRows = new Map<string, TxnRow>();
  for (const [k, t] of transactions) {
    const leg =
      t.claim === "cash_withdrawal" &&
      t.claimBy === "manual_txn" &&
      accountType(t.account) !== "cash" &&
      openedRoots.has(acc(`pool:${t.currency}`))
        ? { gid: `cashleg:${t.gid}`, claim: t.legClaim }
        : null;
    txnRows.set(k, { gid: t.gid, members: [...t.members].sort(), claim: t.claim, leg });
  }

  const loans = new Map<string, LoanRow>();
  for (const [key, reg] of loanRegs) {
    if (reg.gid === undefined || reg.principal === undefined) continue; // no terms: no row
    loans.set(key, {
      gid: reg.gid,
      principal: reg.principal,
      paymentIban: reg.payment?.[0] ?? null,
      paymentText: reg.payment?.[1] ?? null,
    });
  }
  const modules = new Map<string, ModuleRow>();
  for (const [id, reg] of moduleRegs) {
    if (reg.enabledAt !== null) modules.set(id, { enabled: reg.enabled, enabledAt: reg.enabledAt });
  }

  return {
    profile:
      profile === null || !profile.created
        ? null
        : {
            name: profile.name,
            baseCurrency: profile.baseCurrency,
            mcpPrivacy: profile.mcpPrivacy,
          },
    modules: sortRecord(modules),
    balances: sortRecord(balances),
    accounts: sortRecord(accounts),
    loans: sortRecord(loans),
    notes: sortRecord(notes),
    cashExpenses: sortRecord(expenses),
    accountConflicts: [...ids.accounts.conflicts],
    transactions: sortRecord(txnRows),
    watchlist: sortRecord(watchlist),
    overrides: sortRecord(overrides),
    valuations: sortRecord(valuations),
    signals: sortRecord(episodes),
    proposals: sortRecord(proposals),
    bindings: sortRecord(bindings),
  };
}
