// Identity resolution (events.md 6.4): per kind a union-find over claims and merges, processed in
// `(hlc, eid)` order over the applied events. A claim of an unheld key makes the claimer its holder; a
// claim of a held key folds the claimer's root into the holder's root (the earlier holder survives);
// a merge folds `find(source)` into `find(target)`. With an exclusive prefix (accounts: `iban:`) a
// component holds at most one such key; refused claims / unions are recorded as conflicts.
//
// The resolution is recomputed from the log whenever identity events arrive (they are few: one per
// account / alias, not per transaction) and persisted, so `resolve` is a map lookup during folds.
import type { SqlDriver, SqlStatement } from "../sql/driver.js";
import type { EventLog } from "./log.js";
import type { IdentityConflict, IdentityKind, ViewSql } from "./types.js";

class UnionFind {
  readonly parent = new Map<string, string>();
  readonly keyOwner = new Map<string, string>();
  readonly exclusiveOf = new Map<string, string>();
  readonly conflicts: IdentityConflict[] = [];

  constructor(private readonly exclusivePrefix: string | undefined) {}

  find(g: string): string {
    let r = g;
    for (let p = this.parent.get(r); p !== undefined && p !== r; p = this.parent.get(r)) r = p;
    // path compression keeps long merge chains cheap
    let x = g;
    while (x !== r) {
      const next = this.parent.get(x) as string;
      this.parent.set(x, r);
      x = next;
    }
    return r;
  }

  touch(g: string): void {
    if (!this.parent.has(g)) this.parent.set(g, g);
  }

  #union(from: string, into: string, conflict: Omit<IdentityConflict, "reason">): boolean {
    const a = this.find(from);
    const b = this.find(into);
    if (a === b) return true;
    const ka = this.exclusiveOf.get(a);
    const kb = this.exclusiveOf.get(b);
    if (ka !== undefined && kb !== undefined && ka !== kb) {
      this.conflicts.push({ ...conflict, reason: "union-refused" });
      return false;
    }
    this.parent.set(a, b);
    if (kb === undefined && ka !== undefined) this.exclusiveOf.set(b, ka);
    return true;
  }

  claim(g: string, key: string, at: { eid: string; hlc: string }): boolean {
    this.touch(g);
    const exclusive = this.exclusivePrefix !== undefined && key.startsWith(this.exclusivePrefix);
    if (exclusive) {
      const held = this.exclusiveOf.get(this.find(g));
      if (held !== undefined && held !== key) {
        this.conflicts.push({ ...at, gid: g, key, reason: "second-exclusive-key" });
        return false;
      }
    }
    const owner = this.keyOwner.get(key);
    if (owner === undefined) {
      this.keyOwner.set(key, g);
      if (exclusive) this.exclusiveOf.set(this.find(g), key);
      return true;
    }
    return this.#union(g, owner, { ...at, gid: g, key });
  }

  merge(source: string, target: string, at: { eid: string; hlc: string }): void {
    this.touch(source);
    this.touch(target);
    this.#union(source, target, { ...at, gid: source, key: null });
  }
}

interface KindState {
  /** gid -> root, only for gids whose root differs from themselves. */
  roots: Map<string, string>;
  /** root -> members (root included), only for non-trivial components. */
  members: Map<string, string[]>;
  accepted: Map<string, string>;
  conflicts: string;
}

export interface IdentityChange {
  /** Kinds whose `resolve` changed for at least one gid. */
  readonly roots: ReadonlySet<string>;
  /** Kinds whose accepted claim values changed. */
  readonly accepted: ReadonlySet<string>;
  /** Public tables rewritten (conflict lists). */
  readonly tables: ReadonlySet<string>;
}

export class IdentityService {
  readonly #kinds: readonly IdentityKind[];
  readonly #state = new Map<string, KindState>();
  readonly #db: SqlDriver;
  readonly #byType = new Map<string, IdentityKind>();
  readonly #loadRoots: SqlStatement;
  readonly #loadAccepted: SqlStatement;

  constructor(db: SqlDriver, kinds: readonly IdentityKind[]) {
    this.#db = db;
    this.#kinds = kinds;
    for (const k of kinds) for (const t of k.handles) this.#byType.set(t, k);
    this.#loadRoots = db.prepare("SELECT gid, root FROM identity_roots WHERE kind = ?");
    this.#loadAccepted = db.prepare("SELECT eid, value FROM identity_accepted WHERE kind = ?");
    this.load();
  }

  /** Reload the persisted resolution (after open, rebuild or a snapshot import). */
  load(): void {
    for (const k of this.#kinds) {
      const roots = new Map<string, string>();
      for (const r of this.#loadRoots.all<{ gid: string; root: string }>(k.id)) {
        roots.set(r.gid, r.root);
      }
      const accepted = new Map<string, string>();
      for (const r of this.#loadAccepted.all<{ eid: string; value: string }>(k.id)) {
        accepted.set(r.eid, r.value);
      }
      this.#state.set(k.id, { roots, members: membersOf(roots), accepted, conflicts: "" });
    }
  }

  isIdentityType(type: string): boolean {
    return this.#byType.has(type);
  }

  resolve(kind: string, gid: string): string {
    return this.#state.get(kind)?.roots.get(gid) ?? gid;
  }

  members(kind: string, root: string): readonly string[] {
    return this.#state.get(kind)?.members.get(root) ?? [root];
  }

  accepted(kind: string, eid: string): string | undefined {
    return this.#state.get(kind)?.accepted.get(eid);
  }

  /** Recompute every kind from the applied events in the log; persist and report what changed. */
  recompute(log: EventLog, sql: ViewSql, force = false): IdentityChange {
    const roots = new Set<string>();
    const accepted = new Set<string>();
    const tables = new Set<string>();
    for (const kind of this.#kinds) {
      const uf = new UnionFind(kind.exclusivePrefix);
      const acc = new Map<string, string>();
      for (const e of log.appliedOfTypes(kind.handles)) {
        const at = { eid: e.eid, hlc: e.hlc };
        for (const c of kind.claims(e)) {
          const ok = uf.claim(c.gid, c.key, at);
          if (
            ok &&
            c.value !== undefined &&
            kind.exclusivePrefix !== undefined &&
            c.key.startsWith(kind.exclusivePrefix) &&
            !acc.has(e.eid)
          ) {
            acc.set(e.eid, c.value);
          }
        }
        for (const m of kind.merges(e)) uf.merge(m.source, m.target, at);
      }
      const next = new Map<string, string>();
      for (const g of uf.parent.keys()) {
        const r = uf.find(g);
        if (r !== g) next.set(g, r);
      }
      const prev = this.#state.get(kind.id);
      const conflicts = JSON.stringify(uf.conflicts);
      const rootsChanged = force || !prev || !sameMap(prev.roots, next);
      const acceptedChanged = force || !prev || !sameMap(prev.accepted, acc);
      if (rootsChanged) {
        roots.add(kind.id);
        this.#db.prepare("DELETE FROM identity_roots WHERE kind = ?").run(kind.id);
        const ins = this.#db.prepare(
          "INSERT INTO identity_roots (kind, gid, root) VALUES (?, ?, ?)",
        );
        for (const [g, r] of next) ins.run(kind.id, g, r);
      }
      if (acceptedChanged) {
        accepted.add(kind.id);
        this.#db.prepare("DELETE FROM identity_accepted WHERE kind = ?").run(kind.id);
        const ins = this.#db.prepare(
          "INSERT INTO identity_accepted (kind, eid, value) VALUES (?, ?, ?)",
        );
        for (const [eid, v] of acc) ins.run(kind.id, eid, v);
      }
      const conflictsChanged = force || !prev || prev.conflicts !== conflicts;
      if (conflictsChanged && kind.writeConflicts) {
        kind.writeConflicts(uf.conflicts, sql);
        for (const t of kind.tables ?? []) tables.add(t.name);
      }
      this.#state.set(kind.id, {
        roots: next,
        members: membersOf(next),
        accepted: acc,
        conflicts,
      });
    }
    return { roots, accepted, tables };
  }
}

function sameMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function membersOf(roots: ReadonlyMap<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [g, r] of roots) {
    const list = out.get(r) ?? [r];
    list.push(g);
    out.set(r, list);
  }
  for (const list of out.values()) list.sort();
  return out;
}
