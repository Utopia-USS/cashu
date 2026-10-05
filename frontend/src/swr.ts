// Stale-while-revalidate cache behind `useAsync(fn, deps, { key })` (F7 PX2): a revisited tab shows its last
// data at once and refreshes it in the background; a loader only on a true first load. Pure (no React, no DOM):
// hooks.ts wires it into the hooks, tests/swr.test.mjs checks it.
//
// Profile isolation (hard rule): keys are built with `ck(slug, ...)`, so the profile slug is the first segment
// of every key (its scope). The cache serves and stores only keys of the active scope; the shell calls
// `swr.setScope(slug)` on render, which clears everything when the profile changes. `clear()` also runs on a
// 401 (core/api.ts handle401) and on the shell's refresh after writes. A fetch started before a clear (or an
// invalidate) never stores its older answer after it.

/** Most entries kept; the least recently used goes first. */
export const SWR_MAX = 200;

type Part = string | number | boolean | null | undefined;

/** Cache key of profile data: the slug (scope), the area, its parameters; "/"-joined, each part URI-encoded,
 * null / undefined as "". Two call sites share a key only when they fetch AND shape the data the same way. */
export function ck(slug: string, area: string, ...parts: Part[]): string {
  return [slug, area, ...parts].map((p) => encodeURIComponent(p == null ? "" : String(p))).join("/");
}

/** The scope of a key: its encoded profile slug. */
export const scopeOf = (key: string): string => key.split("/", 1)[0];

/** Taken when a fetch starts; its answer is stored only if no clear happened since and no newer fetch of the
 * same key stored first. */
export interface Ticket { readonly epoch: number; readonly seq: number }

export interface SwrCache {
  readonly size: number;
  /** Bumped by every clear and invalidate: what was started before belongs to the old data. */
  readonly epoch: number;
  /** The cached data of a key without touching the LRU order (render). */
  peek<T>(key: string): { data: T } | undefined;
  /** The cached data of a key, marked as recently used. */
  get<T>(key: string): { data: T } | undefined;
  begin(): Ticket;
  /** Store a fetch's answer; false when refused (stale ticket, other profile, null / undefined data). */
  put(key: string, data: unknown, ticket: Ticket): boolean;
  clear(): void;
  /** The active profile; a different slug clears the whole cache first. */
  setScope(slug: string): void;
  /** Drop `prefix` and every key under it (`ck(slug, "budget")` drops `ck(slug, "budget", ...)`). */
  invalidate(prefix: string): number;
}

export function createCache(max = SWR_MAX): SwrCache {
  const map = new Map<string, { data: unknown; seq: number }>();
  let scope: string | null = null;
  let epoch = 0;
  let seq = 0;
  const inScope = (key: string) => scope === null || scopeOf(key) === scope;
  const cache: SwrCache = {
    get size() { return map.size; },
    get epoch() { return epoch; },
    peek<T>(key: string) {
      const e = inScope(key) ? map.get(key) : undefined;
      return e ? { data: e.data as T } : undefined;
    },
    get<T>(key: string) {
      const e = inScope(key) ? map.get(key) : undefined;
      if (!e) return undefined;
      map.delete(key);
      map.set(key, e);
      return { data: e.data as T };
    },
    begin() { seq += 1; return { epoch, seq }; },
    put(key, data, ticket) {
      if (ticket.epoch !== epoch || !inScope(key) || data == null) return false;
      const cur = map.get(key);
      if (cur && cur.seq > ticket.seq) return false;
      map.delete(key);
      map.set(key, { data, seq: ticket.seq });
      while (map.size > max) map.delete(map.keys().next().value as string);
      return true;
    },
    clear() { map.clear(); epoch += 1; },
    setScope(slug) {
      const s = encodeURIComponent(slug);
      if (s !== scope) { cache.clear(); scope = s; }
    },
    invalidate(prefix) {
      let n = 0;
      for (const k of [...map.keys()]) if (k === prefix || k.startsWith(`${prefix}/`)) { map.delete(k); n += 1; }
      epoch += 1; // a fetch in flight may hold the data from before the write
      return n;
    },
  };
  return cache;
}

/** A request dedupe below the cache (F7 FIX2 B4): views on one page that read the same endpoint share one
 * promise for a few seconds. An entry belongs to the cache epoch it was started in, so after any clear
 * (refresh after a write, profile switch, 401) or invalidate a mount never gets a promise begun before it (its
 * answer would pass the new epoch's ticket and be stored as fresh). A failed promise is dropped at once. */
export interface Dedupe {
  get<T>(key: string, load: () => Promise<T>, ms?: number): Promise<T>;
  clear(): void;
}

export function createDedupe(cache: Pick<SwrCache, "epoch">, ttl = 4000, now: () => number = Date.now): Dedupe {
  const m = new Map<string, { at: number; epoch: number; p: Promise<unknown> }>();
  return {
    get<T>(key: string, load: () => Promise<T>, ms = ttl): Promise<T> {
      const hit = m.get(key);
      if (hit && hit.epoch === cache.epoch && now() - hit.at < ms) return hit.p as Promise<T>;
      const p = load();
      const entry = { at: now(), epoch: cache.epoch, p };
      m.set(key, entry);
      p.catch(() => { if (m.get(key) === entry) m.delete(key); });
      return p;
    },
    clear() { m.clear(); },
  };
}

/** The app's one cache (hooks.ts, core/api.ts on 401, the shell). */
export const swr = createCache();
/** Forget all cached data (401, refresh after writes). */
export const clearCache = (): void => swr.clear();
/** Forget the cached data under a key prefix, e.g. after a write that changes one area. */
export const invalidate = (prefix: string): number => swr.invalidate(prefix);
/** A request dedupe tied to the app's cache (reset by every clear / invalidate). */
export const dedupe = (ttl = 4000): Dedupe => createDedupe(swr, ttl);

// ---- hook state (pure reducers; hooks.ts keeps one SwrState per hook) ---------------------------

export interface SwrState<T> { key: string | undefined; data: T | null; error: string | null; running: boolean }
export interface SwrView<T> { data: T | null; error: string | null; loading: boolean; refreshing: boolean }

const sameScope = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && scopeOf(a) === scopeOf(b);

/** A hook's first state: the cached data of its key when there is some (then no loader). */
export function swrInit<T>(cache: SwrCache, key: string | undefined): SwrState<T> {
  return { key, data: key === undefined ? null : cache.peek<T>(key)?.data ?? null, error: null, running: true };
}

/** What a render shows for `key`. The state when it belongs to this key. Right after a key change (before the
 * effect runs) the cached data of the new key, else nothing (a loader): the previous key's numbers under the new
 * key's label would be wrong numbers (F7 PX2b). Only with `keepPrevious` (opt-in, for a view where the old data
 * while loading is marked or harmless) the previous data stays, and only within the same profile.
 * Unkeyed: `loading` is true while any run is in flight (the old behaviour); keyed: only without data. */
export function swrView<T>(cache: SwrCache, st: SwrState<T>, key: string | undefined, keepPrevious = false): SwrView<T> {
  const own = st.key === key;
  const cached = key === undefined ? undefined : cache.peek<T>(key);
  const data = own ? st.data : cached ? cached.data : keepPrevious && sameScope(st.key, key) ? st.data : null;
  const running = own ? st.running : true;
  return { data, error: own ? st.error : null, loading: running && (key === undefined || data == null), refreshing: running && data != null };
}

/** A run starts (mount, deps or key change, reload): the shown data stays, the previous run's error goes. */
export function swrStart<T>(cache: SwrCache, st: SwrState<T>, key: string | undefined, keepPrevious = false): SwrState<T> {
  const data = swrView(cache, st, key, keepPrevious).data;
  if (st.key === key && st.running && st.error === null && st.data === data) return st;
  return { key, data, error: null, running: true };
}

/** The run answered: its data replaces what was shown. */
export function swrDone<T>(key: string | undefined, data: T): SwrState<T> {
  return { key, data, error: null, running: false };
}

/** The run failed: the shown (cached) data stays, the error is set. */
export function swrFail<T>(cache: SwrCache, st: SwrState<T>, key: string | undefined, error: string, keepPrevious = false): SwrState<T> {
  return { key, data: swrView(cache, st, key, keepPrevious).data, error, running: false };
}
