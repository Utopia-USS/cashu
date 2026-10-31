// The performance service over a vault (Python `performance/service.py`): the full-history computation
// (daily series of every account, benchmark prices) runs once per change and is cached per vault; the
// views (`performance_view`, `attribution_view`, `mcp_summary`) cut ranges and account filters from
// the cached computation. No render-time heavy work: a view call with unchanged inputs only checks
// the fingerprint.
//
// Fingerprint (Python `_profile_key` + `_market_key`): the change counters of every view table the
// loader read (`Store.version` over the tables `Store.tablesRead` finds in its SQL, so nobody lists
// tables by hand), the end date, the strategy values and the price cache's write counter
// (`PriceCache.version`; prices are device-local caches, never view tables, so no materializer can
// maintain the series itself). A hit costs a few counter reads, no SQL over the history.
import { type market, performance as perf } from "@cashu/domain/investments";
import type { Store } from "../../materialize.js";
import type { SqlValue } from "../../sql/driver.js";
import { brokerageAccounts } from "../queries/transactions.js";
import { type InputsRequest, performanceInputs } from "./inputs.js";

/** Vaults whose computation is kept (Python `CACHE_SIZE`). */
export const CACHE_SIZE = 8;

interface Entry {
  readonly store: Store;
  readonly tables: ReadonlySet<string>;
  readonly storeKey: string;
  readonly prices: market.PriceCache;
  readonly order: InputsRequest["order"];
  readonly computed: perf.ComputedPerformance;
}

/** A strategy as a stable text (Maps as entry lists): equal values, equal keys. */
function strategyKey(strategy: perf.PerformanceStrategy): string {
  return JSON.stringify(strategy, (_k, v: unknown) =>
    v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v,
  );
}

/** A view request: the range and the brokerage accounts (gids) it is limited to (null = all). */
export interface ViewRequest extends InputsRequest {
  readonly range: string;
  readonly accounts?: readonly string[] | null;
}

/** Expected refusals of a view (the API answers 422 / 404). */
export type ViewResult<V> =
  | { readonly ok: true; readonly value: V }
  | { readonly ok: false; readonly reason: "unknown_range" | "unknown_account" };

/**
 * The performance service of one process: one cached computation per vault (LRU of `CACHE_SIZE`).
 * The app keeps one instance next to its open stores; tests make their own.
 */
export class PerformanceService {
  readonly #entries = new Map<string, Entry>();

  /** Drop every cached computation (Python `clear_cache`). */
  clear(): void {
    this.#entries.clear();
  }

  /** Python `compute`: the full-history computation of the vault up to `asOf`, cached. */
  computed(store: Store, request: InputsRequest): perf.ComputedPerformance {
    const key = (tables: ReadonlySet<string>) =>
      `${store.version(tables)}|${request.prices.version()}|${request.asOf}|${strategyKey(request.strategy)}`;
    const hit = this.#entries.get(store.vault);
    if (
      hit !== undefined &&
      hit.store === store &&
      hit.prices === request.prices &&
      hit.order === request.order &&
      hit.storeKey === key(hit.tables)
    ) {
      this.#entries.delete(store.vault);
      this.#entries.set(store.vault, hit);
      return hit.computed;
    }
    const tables = new Set<string>();
    const read = <R>(sql: string, ...params: SqlValue[]): R[] => {
      for (const t of store.tablesRead(sql)) tables.add(t);
      return store.read<R>(sql, ...params);
    };
    const computed = perf.computePerformance(performanceInputs(read, request), request.asOf);
    this.#entries.delete(store.vault);
    this.#entries.set(store.vault, {
      store,
      tables,
      storeKey: key(tables),
      prices: request.prices,
      order: request.order,
      computed,
    });
    while (this.#entries.size > CACHE_SIZE) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.delete(oldest);
    }
    return computed;
  }

  /** `GET /investments/performance`: `performance_view(range, accounts)`. */
  performanceView(store: Store, request: ViewRequest): ViewResult<perf.PerformanceView> {
    return this.#view(store, request, perf.performanceView);
  }

  /** `GET /investments/performance/attribution`: `attribution_view(range, accounts)`. */
  attributionView(store: Store, request: ViewRequest): ViewResult<perf.AttributionView> {
    return this.#view(store, request, perf.attributionView);
  }

  /** Python `mcp_summary`: whole history, every account; null without investments history. */
  historyMetrics(store: Store, request: InputsRequest): perf.HistoryMetrics | null {
    return perf.historyMetrics(this.computed(store, request));
  }

  #view<V>(
    store: Store,
    request: ViewRequest,
    view: (c: perf.ComputedPerformance, key: perf.RangeKey, scope: perf.AccountScope) => V,
  ): ViewResult<V> {
    if (!perf.isRangeKey(request.range)) return { ok: false, reason: "unknown_range" };
    const accounts = request.accounts ?? null;
    if (accounts !== null) {
      const known = new Set(brokerageAccounts(store.read.bind(store)).map((a) => a.gid));
      if (accounts.some((a) => !known.has(a))) return { ok: false, reason: "unknown_account" };
    }
    const scope = accounts === null ? null : (accounts as perf.AccountScope);
    return { ok: true, value: view(this.computed(store, request), request.range, scope) };
  }
}
