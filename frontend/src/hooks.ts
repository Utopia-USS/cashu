import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "./core/messages";
import { type InFlight, singleFlight } from "./inflight";
import { swr, swrDone, swrFail, swrInit, swrStart, type SwrState, swrView } from "./swr";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  /** Unkeyed: a run is in flight. Keyed: a run is in flight and there is no data to show (a true first load). */
  loading: boolean;
  /** A run is in flight while data is shown (background refresh); never shown as text. */
  refreshing: boolean;
  reload: () => void;
}

export interface AsyncOpts {
  /** Stale-while-revalidate (F7 PX2, src/swr.ts): `ck(slug, area, ...params)`. A mount with cached data
   * starts with it and `loading = false`, refreshes in the background and swaps the answer in; a failed
   * refresh keeps the data and sets `error`; `reload()` keeps the data visible. Undefined: no cache. */
  key?: string;
  /** Keyed only: on a key change without a cache entry, keep showing the previous key's data (same profile)
   * until the answer instead of a loader. Opt-in, only where the old data while loading is visibly marked or
   * harmless; default off (old numbers under the new label are wrong numbers, F7 PX2b). */
  keepPrevious?: boolean;
}

/** One fetch of a hook: the answer goes to the cache (keyed) and, while the run is current, to the state. */
function runOnce<T>(fn: () => Promise<T>, key: string | undefined, keep: boolean, alive: () => boolean, set: (f: (s: SwrState<T>) => SwrState<T>) => void) {
  const ticket = key === undefined ? null : swr.begin();
  fn().then(
    (d) => {
      if (ticket) swr.put(key!, d, ticket);
      if (alive()) set(() => swrDone(key, d));
    },
    (e: unknown) => { if (alive()) set((s) => swrFail(swr, s, key, errorText(e), keep)); },
  );
}

/** Run an async fetcher on mount and whenever `deps` (or the key) change; expose reload(). With `opts.key`
 * the last data per key is cached (see AsyncOpts). */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = [], opts?: AsyncOpts): AsyncState<T> {
  const key = opts?.key;
  const keep = !!opts?.keepPrevious;
  const [st, setSt] = useState<SwrState<T>>(() => swrInit<T>(swr, key));
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setSt((s) => swrStart(swr, s, key, keep)); // an error belongs to the run that failed, not to the next deps
    runOnce(fnRef.current, key, keep, () => alive, setSt);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, key, nonce]);

  return { ...swrView(swr, st, key, keep), reload };
}

/** Measure an element's content width, updating on resize. Uses a callback ref so
 * it re-attaches correctly when the target mounts/unmounts (e.g. hidden behind a
 * loading skeleton and rendered later). `node` exposes the current element. */
export function useWidth<T extends HTMLElement>() {
  const [width, setWidth] = useState(0);
  const node = useRef<T | null>(null);
  const obs = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    obs.current?.disconnect();
    node.current = el;
    if (el) {
      const ro = new ResizeObserver(() => setWidth(el.clientWidth));
      ro.observe(el);
      setWidth(el.clientWidth);
      obs.current = ro;
    }
  }, []);
  return { ref, width, node };
}

/** Like useAsync, but re-fetches every `ms` while the tab is visible and on window
 * focus, keeping the last good data on screen between refreshes (no skeleton flash). `opts.key` as in
 * useAsync (the first run of a mount or deps change starts from the cached data). */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = [], opts?: AsyncOpts): AsyncState<T> {
  const key = opts?.key;
  const keep = !!opts?.keepPrevious;
  const [st, setSt] = useState<SwrState<T>>(() => swrInit<T>(swr, key));
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setSt((s) => swrStart(swr, s, key, keep));
    const run = (force = false) => {
      if (document.hidden && !force) return;
      runOnce(fnRef.current, key, keep, () => alive, setSt);
    };
    const onFocus = () => run();
    run(true);
    const t = setInterval(run, ms);
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ms, key, nonce]);

  return { ...swrView(swr, st, key, keep), reload };
}

/** In-flight guard of a submit button (F7 FE2): `busy` disables it, `run` skips a second click while the
 * first request runs (see inflight.ts). */
export function useInFlight(): { busy: boolean; run: InFlight["run"] } {
  const [busy, setBusy] = useState(false);
  const guard = useRef<InFlight | null>(null);
  guard.current ??= singleFlight(setBusy);
  return { busy, run: guard.current.run.bind(guard.current) };
}
