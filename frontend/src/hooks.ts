import { useCallback, useEffect, useRef, useState } from "react";

interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Run an async fetcher on mount and whenever `deps` change; expose reload(). */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fnRef.current()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload };
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
