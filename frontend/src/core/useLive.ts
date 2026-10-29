// Live data (P10): one change stream per window (SSE over fetch, so the token goes in the header, never the URL),
// reconnecting with backoff, plus a fallback poll every 60 s while the window is visible. Events are applied in
// bursts of 500 ms: list rows patch the cached lists in place (no request), derived views re-read only their keys,
// a reset re-reads the profile. Nothing remounts: open drawers and form input stay. Mounted once by the shell.
import { useEffect } from "react";
import { patchCache, revalidate } from "../swr";
import { authHeaders, getChanges, handle401, isMissingRoute, isMock, pp } from "./api";
import {
  createBatcher, fresh, invalidations, LIVE_POLL_MS, listPatches, type LiveEvent, parseSse, profileScope, reconnectDelay,
} from "./live";

type Listener = (slug: string, events: LiveEvent[]) => void;
const listeners = new Set<Listener>();
/** Every applied burst of a profile's events (the investments run state listens). */
export function onLiveEvents(f: Listener): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

// Invalidations asked for by other parts of the app (the price refresh) join the next burst.
const extra = new Map<string, Set<string>>();
let kick: ((slug: string) => void) | null = null;
/** Re-read these cache prefixes with the next burst (coalesced with pushed events). */
export function liveInvalidate(slug: string, prefixes: string[]): void {
  const set = extra.get(slug) ?? new Set<string>();
  prefixes.forEach((p) => set.add(p));
  extra.set(slug, set);
  if (kick) kick(slug);
  else { extra.delete(slug); prefixes.forEach((p) => revalidate(p)); }
}

function apply(slug: string, events: LiveEvent[], reset: boolean): void {
  const prefixes = new Set<string>(extra.get(slug) ?? []);
  extra.delete(slug);
  if (reset) prefixes.add(profileScope(slug));
  for (const e of events) {
    for (const p of listPatches(slug, e)) patchCache(p.match, p.apply);
    for (const p of invalidations(slug, e)) prefixes.add(p);
  }
  // a prefix under another one in the set is redundant
  const all = [...prefixes];
  for (const p of all) if (!all.some((q) => q !== p && p.startsWith(`${q}/`))) revalidate(p);
  if (events.length) listeners.forEach((f) => f(slug, events));
}

export function useLive(slug: string): void {
  useEffect(() => {
    if (isMock()) return;
    let lastId: number | null = null;
    let stopped = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;
    let streamOk = true;
    let pendingReset = false;
    const batch = createBatcher<LiveEvent>((evs) => { const r = pendingReset; pendingReset = false; apply(slug, fresh(evs, null), r); });
    kick = (s) => { if (s === slug) batch.push(); };
    const take = (evs: LiveEvent[]) => {
      const add = fresh(evs, lastId);
      if (add.length) { lastId = add[add.length - 1].id; batch.push(...add); }
    };

    const connect = async () => {
      if (stopped) return;
      abort = new AbortController();
      try {
        const r = await fetch(pp(slug, `/changes/stream${lastId == null ? "" : `?after=${lastId}`}`), {
          headers: { ...(await authHeaders()), Accept: "text/event-stream" }, signal: abort.signal,
        });
        if (r.status === 401) { handle401(); return; }
        if (r.status === 404 || r.status === 405) { streamOk = false; return; } // an older server: the poll only
        if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const parsed = parseSse(buf + value);
          buf = parsed.rest;
          for (const f of parsed.frames) {
            const data = JSON.parse(f.data);
            if (f.event === "hello") { failures = 0; if (lastId == null) lastId = data.last_id; }
            else if (f.event === "change") take([data as LiveEvent]);
            else if (f.event === "reset") { pendingReset = true; lastId = data.last_id; batch.push(); }
          }
        }
      } catch {
        if (stopped) return;
        failures += 1;
      }
      if (!stopped && streamOk) retry = setTimeout(connect, failures ? reconnectDelay(failures) : 0);
    };

    const poll = async () => {
      if (stopped || document.hidden) return;
      try {
        const r = await getChanges(slug, lastId);
        if (lastId == null) lastId = r.last_id;
        else {
          if (r.reset) pendingReset = true;
          take(r.events);
          if (r.reset) { lastId = r.last_id; batch.push(); }
        }
      } catch (e) {
        if (isMissingRoute(e)) stopped = true;
      }
    };

    void connect();
    const t = setInterval(() => { void poll(); }, LIVE_POLL_MS);
    const onVisible = () => { if (!document.hidden) void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      kick = null;
      batch.flushNow();
      clearInterval(t);
      if (retry) clearTimeout(retry);
      abort?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [slug]);
}
