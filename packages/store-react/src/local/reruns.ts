// Live-query re-runs off the write path (the phone): the store notifies its listeners synchronously
// after each committed apply, so without this every mounted live query re-runs inside the command
// (or the sync part) that wrote. A scheduler wraps each query source: a notification only marks the
// query's re-run as due, and the due re-runs run together on a later macrotask, each once however many
// applies woke it meanwhile (one re-run per query per burst). Which queries wake stays the store's
// table-based answer (`watchQuery` listens to the tables each run read). The due re-runs run cheapest
// first (by each query's last re-run time), in slices of about one frame with a yield between, so a
// cheap query (the row the owner just filed) shows its change before an expensive one (a whole-month
// figure) has re-run. `hold` defers every re-run until the last hold is released (a first sync, an
// import, a replay), which runs them once.
import type { QuerySource } from "@cashu/store/query";

type Listener = (touched: ReadonlySet<string>) => void;

export interface RerunScheduler {
  /** `source` with its change notifications deferred to this scheduler. */
  wrap(source: QuerySource): QuerySource;
  /** Defer every re-run until the returned release (called once; later calls do nothing). */
  hold(): () => void;
  /** Run the due re-runs now (unless held). */
  flush(): void;
  /** Re-runs due (for tests and diagnostics). */
  readonly pending: number;
}

export interface RerunSchedulerOptions {
  /** How a flush is scheduled (default: a macrotask, after the writer's await resolved). */
  readonly schedule?: (run: () => void) => void;
  /** A flush yields (schedules the rest) once a slice ran this long (ms; default 8). */
  readonly sliceMs?: number;
  readonly now?: () => number;
}

const macrotask = (run: () => void): void => {
  setTimeout(run, 0);
};

export function createRerunScheduler(options: RerunSchedulerOptions = {}): RerunScheduler {
  const schedule = options.schedule ?? macrotask;
  const sliceMs = options.sliceMs ?? 8;
  const now = options.now ?? (() => performance.now());
  /** Each listener's last re-run time (ms): the cheapest due re-runs go first. */
  const cost = new WeakMap<Listener, number>();
  /** Due re-runs with the union of the tables that woke each. */
  const due = new Map<Listener, Set<string>>();
  let holds = 0;
  let scheduled = false;

  const request = (): void => {
    if (scheduled || holds > 0 || due.size === 0) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      flush();
    });
  };

  function flush(): void {
    if (holds > 0) return;
    const batch = [...due].sort(([a], [b]) => (cost.get(a) ?? 0) - (cost.get(b) ?? 0));
    const start = now();
    const errors: unknown[] = [];
    for (const [listener, touched] of batch) {
      if (!due.has(listener)) continue; // stopped by an earlier re-run of this slice
      if (now() - start >= sliceMs) break;
      due.delete(listener);
      const t0 = now();
      try {
        listener(touched);
      } catch (error) {
        errors.push(error);
      }
      cost.set(listener, now() - t0);
    }
    // The rest after a yield (a new apply meanwhile joins them, each still once).
    request();
    // As the store's own notification: every re-run ran; a failing listener is a bug and surfaces.
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "live query re-runs failed");
  }

  return {
    wrap(source) {
      return {
        read: (sql, ...params) => source.read(sql, ...params),
        tablesRead: (sql) => source.tablesRead(sql),
        subscribe(tables, listener) {
          const stop = source.subscribe(tables, (touched) => {
            const seen = due.get(listener);
            if (seen === undefined) due.set(listener, new Set(touched));
            else for (const t of touched) seen.add(t);
            request();
          });
          return () => {
            stop();
            due.delete(listener);
          };
        },
      };
    },
    hold() {
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        request();
      };
    },
    flush,
    get pending() {
      return due.size;
    },
  };
}
