// Change notification by table: the store reports the public tables each apply touched, and
// `useQuery` (built on useSyncExternalStore) re-reads snapshots whose read tables intersect them.
// Listeners run after the transaction commits, so they always read committed state.

export type TablesListener = (touched: ReadonlySet<string>) => void;

export class ChangeHub {
  readonly #listeners = new Map<string, Set<TablesListener>>();
  readonly #versions = new Map<string, number>();

  subscribe(tables: Iterable<string>, listener: TablesListener): () => void {
    const names = [...new Set(tables)];
    for (const t of names) {
      let set = this.#listeners.get(t);
      if (!set) {
        set = new Set();
        this.#listeners.set(t, set);
      }
      set.add(listener);
    }
    return () => {
      for (const t of names) this.#listeners.get(t)?.delete(listener);
    };
  }

  /** Sum of the per-table change counters: changes iff one of the tables changed. */
  version(tables: Iterable<string>): number {
    let v = 0;
    for (const t of new Set(tables)) v += this.#versions.get(t) ?? 0;
    return v;
  }

  notify(touched: ReadonlySet<string>): void {
    if (touched.size === 0) return;
    for (const t of touched) this.#versions.set(t, (this.#versions.get(t) ?? 0) + 1);
    const due = new Set<TablesListener>();
    for (const t of touched) for (const l of this.#listeners.get(t) ?? []) due.add(l);
    const errors: unknown[] = [];
    for (const l of due) {
      try {
        l(touched);
      } catch (error) {
        errors.push(error);
      }
    }
    // Every listener ran; a failing one is a bug and surfaces to the caller's error boundary.
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "store listeners failed");
  }
}
