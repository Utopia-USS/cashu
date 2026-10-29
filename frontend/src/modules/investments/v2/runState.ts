// The daily check's state for the investments head (P10): the app runs it on its own (server: at start when it
// has not run today, then after 07:30), the worker or the CLI may too. Read once per profile from
// `GET /investments/run/status`, then kept current by the pushed `run` events (core/useLive.ts); the views re-read
// through the same events when it ends.
import { useEffect, useSyncExternalStore } from "react";
import { runStateOf } from "../../../core/live";
import { onLiveEvents } from "../../../core/useLive";
import { getRunStatus } from "./api";

export interface RunState { running: boolean; lastStatus: string | null; loaded: boolean }
const INITIAL: RunState = { running: false, lastStatus: null, loaded: false };
const states = new Map<string, RunState>();
const subs = new Set<() => void>();
const get = (slug: string) => states.get(slug) ?? INITIAL;
function set(slug: string, patch: Partial<RunState>) {
  states.set(slug, { ...get(slug), ...patch });
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

onLiveEvents((slug, events) => {
  for (const e of events) {
    const st = runStateOf(e);
    if (st) set(slug, { running: st.running, ...(st.running ? {} : { lastStatus: st.status }) });
  }
});

export function useRunState(slug: string): RunState {
  useEffect(() => {
    if (get(slug).loaded) return;
    set(slug, { loaded: true });
    getRunStatus(slug).then((r) => set(slug, { running: r.running, lastStatus: r.last?.status ?? null }), () => { /* older server */ });
  }, [slug]);
  return useSyncExternalStore(subscribe, () => get(slug));
}
