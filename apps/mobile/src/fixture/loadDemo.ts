// Loads the synthetic demo log into a store and proves the view: apply in batches, then a full
// rebuild from the held log, both hashed (`viewHash`). Rebuild must equal the incremental apply; the
// hash itself is compared across runtimes by the S41 run (device vs `PRINT_DEMO_HASH=1 jest` on Node
// at the same commit), not pinned here, because the store's materializers still change the view.
// Runtime-free: the caller passes the opened store and a clock.
import { type Store, viewHash } from "@cashu/store/runtime";
import { demoLog } from "./demoLog";

const BATCH = 500;

interface TableCount {
  readonly table: string;
  readonly rows: number;
}

export interface DemoLoad {
  readonly events: number;
  readonly applied: number;
  readonly duplicates: number;
  readonly parked: number;
  readonly rejected: number;
  readonly generateMs: number;
  readonly applyMs: number;
  readonly rebuildMs: number;
  readonly hashAfterApply: string;
  readonly hashAfterRebuild: string;
  /** The view rebuilt from the log equals the incrementally applied one. */
  readonly rebuildMatches: boolean;
  readonly tables: readonly TableCount[];
}

export function loadDemo(store: Store, now: () => number): DemoLoad {
  const t0 = now();
  const log = demoLog();
  const t1 = now();
  let applied = 0;
  let duplicates = 0;
  let parked = 0;
  let rejected = 0;
  for (let i = 0; i < log.length; i += BATCH) {
    const r = store.applyEnvelopes(log.slice(i, i + BATCH));
    applied += r.applied;
    duplicates += r.duplicates;
    parked += r.parked;
    rejected += r.rejected.length;
  }
  const t2 = now();
  const afterApply = viewHash(store);
  const t3 = now();
  store.rebuild({ redecode: true, reindex: true });
  const t4 = now();
  const afterRebuild = viewHash(store);
  return {
    events: log.length,
    applied,
    duplicates,
    parked,
    rejected,
    generateMs: t1 - t0,
    applyMs: t2 - t1,
    rebuildMs: t4 - t3,
    hashAfterApply: afterApply.hash,
    hashAfterRebuild: afterRebuild.hash,
    rebuildMatches: afterApply.hash === afterRebuild.hash,
    tables: Object.entries(afterRebuild.tables)
      .filter(([, t]) => t.rows > 0)
      .map(([table, t]) => ({ table, rows: t.rows })),
  };
}
