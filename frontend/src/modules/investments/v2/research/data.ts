// Research data hooks and actions: runs + summary + candidates for the strip, notes per instrument for the
// drawer, polling every 30 s while a run is `running` (implementation-plan item 37), and the actions with a
// server-side undo (dismiss / restore a note, Obserwuj a candidate) shown as toasts with `Cofnij`.
// One small shared store: reads are cached for a few seconds per profile (the drawer's slots, the strip and
// the review block read the same runs / summary), and every action bumps a version so all of them re-read.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useAsync } from "../../../../hooks";
import { useToast } from "../../../../ui";
import { errorText } from "../../../../core/messages";
import { makeUndo, type Undo, undoMessage, undoSettled } from "../../undo";
import { deleteWatch, postWatch } from "../api";
import { acceptCandidate, dismissNote, getResearch, getResearchRuns, getResearchSummary, getWorkspace, restoreNote, unacceptCandidate } from "./api";
import { isRestorable, latestRun, noteSubject } from "./logic";
import type { ResearchNote, ResearchRun } from "./types";

export const POLL_MS = 30000;

// ---- shared read cache + change version -------------------------------------------------------------------
let version = 0;
const subs = new Set<() => void>();
const cache = new Map<string, { at: number; p: Promise<unknown> }>();
/** After a research change (dismiss, restore, accept): drop the cache and let every reader re-read. */
export function bumpResearch() { version++; cache.clear(); subs.forEach((f) => f()); }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useResearchVersion = () => useSyncExternalStore(subscribe, () => version);
function cached<T>(key: string, load: () => Promise<T>, ms = 4000): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.p as Promise<T>;
  const p = load();
  cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}
const runsOf = (slug: string) => cached(`runs:${slug}`, () => getResearchRuns(slug).catch(() => [] as ResearchRun[]));
const summaryOf = (slug: string) => cached(`sum:${slug}`, () => getResearchSummary(slug).catch(() => null));

/** A counter that ticks every 30 s while the latest run is running; `finish_research_run` flips the state
 * and the last tick refetches the summary once. */
export function useRunPoll(runs: ResearchRun[] | null | undefined): number {
  const running = latestRun(runs ?? [])?.status === "running";
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { if (!document.hidden) setTick((n) => n + 1); }, POLL_MS);
    return () => clearInterval(t);
  }, [running]);
  return tick;
}

/** Runs, summary and open candidates (home strip, review block, research view header). */
export function useResearchOverview(slug: string, nonce: number) {
  const v = useResearchVersion();
  const runsQ = useAsync(() => runsOf(slug), [slug, nonce, v]);
  const tick = useRunPoll(runsQ.data);
  const [tickSeen, setTickSeen] = useState(0);
  // A poll tick re-reads the runs too (so `done` is noticed).
  useEffect(() => { if (tick !== tickSeen) { setTickSeen(tick); cache.clear(); runsQ.reload(); } }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const ran = (runsQ.data?.length ?? 0) > 0;
  const finishedKey = runsQ.data ? runsQ.data.map((r) => `${r.id}:${r.status}`).join(",") : "";
  const summaryQ = useAsync(() => (ran ? summaryOf(slug) : Promise.resolve(null)), [slug, nonce, ran, finishedKey, tick, v]);
  const candQ = useAsync(() => (ran ? cached(`cand:${slug}`, () => getResearch(slug, { kind: "candidate", include_dismissed: true }).catch(() => [] as ResearchNote[])) : Promise.resolve([] as ResearchNote[])), [slug, nonce, ran, tick, v]);
  return { runs: runsQ.data, summary: summaryQ.data, candidates: candQ.data, loading: runsQ.loading, reloadRuns: runsQ.reload };
}

export function useWorkspace(slug: string) {
  return useAsync(() => getWorkspace(slug).catch(() => null), [slug]);
}

/** Notes of one instrument (incl. dismissed, for restore within the window); polled while a run is live. */
export function useInstrumentNotes(slug: string, instrumentId: number, nonce = 0) {
  const v = useResearchVersion();
  const runsQ = useAsync(() => runsOf(slug), [slug, nonce, v]);
  const tick = useRunPoll(runsQ.data);
  useEffect(() => { if (tick) cache.clear(); }, [tick]);
  const notesQ = useAsync(() => cached(`inst:${slug}:${instrumentId}`, () => getResearch(slug, { instrument: instrumentId, include_dismissed: true, include_expired: true }).catch(() => [] as ResearchNote[])), [slug, instrumentId, nonce, tick, v]);
  const summaryQ = useAsync(() => summaryOf(slug), [slug, nonce, tick, v]);
  const row = useMemo(() => summaryQ.data?.instruments.find((x) => x.instrument_id === instrumentId) ?? null, [summaryQ.data, instrumentId]);
  return { runs: runsQ.data, notes: notesQ.data, summary: summaryQ.data, row, loading: notesQ.loading };
}

/** Dismissed within the server's restore window (15 minutes). */
export const canRestore = (n: Pick<ResearchNote, "dismissed_at" | "restorable_until">, now = Date.now()) => isRestorable(n, now);

const noteUndos = new Map<string, Undo>();

/** FastAPI's own 404 / 405 for a route the server does not have (no error code, the generic detail). */
function isMissingRoute(e: unknown): boolean {
  const x = (typeof e === "object" && e !== null ? e : {}) as { status?: number; message?: string; code?: string | null };
  return (x.status === 404 || x.status === 405) && !x.code && /^(not found|method not allowed)$/i.test(x.message ?? "");
}

/** Actions with undo. `onChanged` refreshes the caller (and the page: signals change on dismiss). */
export function useResearchActions(slug: string, onChanged: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);

  const offer = (key: string, text: string, savedAt: number, run: () => Promise<unknown>, what: string) => {
    const u = noteUndos.get(key) ?? makeUndo(savedAt, run);
    noteUndos.set(key, u);
    const retry = () => {
      void u.undo().then((res) => {
        if (undoSettled(res)) { noteUndos.delete(key); bumpResearch(); onChanged(); }
        const msg = undoMessage(res, what);
        if (msg) toast(msg, res === "failed" ? 8000 : 3000, res === "failed" ? { label: "Cofnij", onClick: retry } : undefined);
      });
    };
    toast(text, 10000, { label: "Cofnij", onClick: retry });
  };

  const dismiss = async (n: ResearchNote) => {
    setBusy(n.id);
    try {
      await dismissNote(slug, n.id);
      bumpResearch();
      onChanged();
      const cand = n.kind === "candidate";
      offer(`d:${n.id}:${Date.now()}`, cand ? `Odrzucono kandydata: ${noteSubject(n).name}` : "Notatka odrzucona", Date.now(), () => restoreNote(slug, n.id), cand ? "odrzucenie kandydata" : "odrzucenie notatki");
    } catch (e) { toast(`Nie odrzucono: ${errorText(e)}`, 5000); } finally { setBusy(null); }
  };

  const restore = async (n: ResearchNote) => {
    setBusy(n.id);
    try { await restoreNote(slug, n.id); bumpResearch(); onChanged(); toast(n.kind === "candidate" ? "Przywrócono kandydata" : "Przywrócono notatkę", 2500); }
    catch (e) { toast(`Nie przywrócono: ${errorText(e)}`, 5000); } finally { setBusy(null); }
  };

  /** `Obserwuj`: watchlist row + draft thesis in one call; servers without it get a plain watchlist row. */
  const watch = async (n: ResearchNote) => {
    setBusy(n.id);
    const name = noteSubject(n).name;
    try {
      let undo: () => Promise<unknown>;
      try {
        await acceptCandidate(slug, n.id);
        undo = () => unacceptCandidate(slug, n.id);
      } catch (e) {
        if (!isMissingRoute(e)) throw e;
        const w = await postWatch(slug, { ...(n.instrument_id != null ? { instrument_id: n.instrument_id } : { symbol_or_isin: n.candidate?.symbol ?? n.instrument?.symbol ?? "" }), note: `kandydat: ${n.title}` });
        undo = () => deleteWatch(slug, w.id);
      }
      bumpResearch();
      onChanged();
      offer(`w:${n.id}:${Date.now()}`, `Dodano do obserwowanych: ${name}`, Date.now(), undo, "obserwowanie");
    } catch (e) { toast(`Nie dodano do obserwowanych: ${errorText(e)}`, 5000); } finally { setBusy(null); }
  };

  return { dismiss, restore, watch, busy };
}
