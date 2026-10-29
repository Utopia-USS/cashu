// Research data hooks and actions: runs + summary + candidates for the strip, notes per instrument for the
// drawer, polling every 30 s while a run is `running` (implementation-plan item 37), and the actions with a
// server-side undo (dismiss / restore a note, Obserwuj a candidate) shown as toasts with `Cofnij`.
// One small shared store: reads are cached for a few seconds per profile (the drawer's slots, the strip and
// the review block read the same runs / summary), and every action bumps a version so all of them re-read.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useAsync } from "../../../../hooks";
import { dedupe } from "../../../../swr";
import { useToast } from "../../../../ui";
import { errorText } from "../../../../core/messages";
import { isMissingRoute } from "../../../../core/api";
import { makeUndo, type Undo, undoMessage, undoSettled } from "../../undo";
import { deleteWatch, dropInv, invKey, postWatch } from "../api";
import { acceptCandidate, dismissNote, getResearch, getResearchRuns, getMacro, getResearchSummary, getSegments, getWorkspace, restoreNote, unacceptCandidate } from "./api";
import { isRestorable, latestRun, noteSubject } from "./logic";
import type { ResearchNote, ResearchRun, SegmentWindow } from "./types";
import { C } from "../../../../common.strings.ts";
import { S } from "./data.strings.ts";

export const POLL_MS = 30000;

// ---- shared read cache + change version -------------------------------------------------------------------
let version = 0;
const subs = new Set<() => void>();
// 4 s request dedupe; it also resets with every cache clear / invalidate (F7 FIX2 B4).
const cache = dedupe();
/** After a research change (dismiss, restore, accept): drop the cache and let every reader re-read; with the
 * profile also the cached investments views (signals and the watchlist change too, F7 PX4). */
export function bumpResearch(slug?: string) { version++; cache.clear(); if (slug) dropInv(slug); subs.forEach((f) => f()); }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useResearchVersion = () => useSyncExternalStore(subscribe, () => version);
const cached = <T,>(key: string, load: () => Promise<T>): Promise<T> => cache.get(key, load);
// The loaders reject on a failure (an older server without research already reads as empty / null in api.ts): a
// failed refresh keeps the cached data (F7 FIX2 B3); a failed first load reads as empty at the hook's output.
const runsOf = (slug: string) => cached(`runs:${slug}`, () => getResearchRuns(slug));
const summaryOf = (slug: string) => cached(`sum:${slug}`, () => getResearchSummary(slug));
/** A list that never loaded reads as empty (the old fallback); while loading null. */
const listOr = <T,>(q: { data: T[] | null; error: string | null }): T[] | null => q.data ?? (q.error ? [] : null);

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
  // Keyed (F7 PX4) above the 4 s dedupe: a revisit shows the last runs / summary / candidates at once.
  const runsQ = useAsync(() => runsOf(slug), [slug, nonce, v], { key: invKey(slug, "research", "runs") });
  const tick = useRunPoll(runsQ.data);
  const [tickSeen, setTickSeen] = useState(0);
  // A poll tick re-reads the runs too (so `done` is noticed).
  useEffect(() => { if (tick !== tickSeen) { setTickSeen(tick); cache.clear(); runsQ.reload(); } }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const ran = (runsQ.data?.length ?? 0) > 0;
  const finishedKey = runsQ.data ? runsQ.data.map((r) => `${r.id}:${r.status}`).join(",") : "";
  const summaryQ = useAsync(() => (ran ? summaryOf(slug) : Promise.resolve(null)), [slug, nonce, ran, finishedKey, tick, v],
    { key: ran ? invKey(slug, "research", "summary") : undefined });
  const candQ = useAsync(() => (ran ? cached(`cand:${slug}`, () => getResearch(slug, { kind: "candidate", include_dismissed: true })) : Promise.resolve([] as ResearchNote[])), [slug, nonce, ran, tick, v],
    { key: ran ? invKey(slug, "research", "candidates") : undefined });
  return { runs: listOr(runsQ), summary: summaryQ.data, candidates: listOr(candQ), loading: runsQ.loading, reloadRuns: runsQ.reload };
}

/** P5 market segments of one window (home column, page widget, run strip fact): keyed per window, re-read by
 * `bumpResearch` and the run poll like the summary. `failed` = the request failed or the server has no endpoint
 * (nothing cached to show). */
export function useSegments(slug: string, window: SegmentWindow, nonce = 0) {
  const v = useResearchVersion();
  const runsQ = useAsync(() => runsOf(slug), [slug, nonce, v], { key: invKey(slug, "research", "runs") });
  const tick = useRunPoll(runsQ.data);
  // A poll tick re-reads the runs too, so the poll stops once the run is done (as useResearchOverview).
  useEffect(() => { if (tick) { cache.clear(); runsQ.reload(); } }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const finishedKey = runsQ.data ? runsQ.data.map((r) => `${r.id}:${r.status}`).join(",") : "";
  const q = useAsync(() => cached(`seg:${slug}:${window}`, () => getSegments(slug, window)), [slug, window, nonce, v, tick, finishedKey],
    { key: invKey(slug, "research", "segments", window) });
  return { data: q.data, loading: q.loading, failed: !q.loading && !q.data };
}

/** P6 macro regimes (home line, page widget): re-read by `bumpResearch` (a macro note read / dismissed changes
 * `unread` / `note`), the run poll (a run writes macro notes) and the home `nonce`. `failed` = the request failed or
 * the server has no endpoint. */
export function useMacro(slug: string, nonce = 0) {
  const v = useResearchVersion();
  const runsQ = useAsync(() => runsOf(slug), [slug, nonce, v], { key: invKey(slug, "research", "runs") });
  const tick = useRunPoll(runsQ.data);
  useEffect(() => { if (tick) { cache.clear(); runsQ.reload(); } }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const finishedKey = runsQ.data ? runsQ.data.map((r) => `${r.id}:${r.status}`).join(",") : "";
  const q = useAsync(() => cached(`macro:${slug}`, () => getMacro(slug)), [slug, nonce, v, tick, finishedKey], { key: invKey(slug, "research", "macro") });
  return { data: q.data, loading: q.loading, failed: !q.loading && !q.data };
}

export function useWorkspace(slug: string) {
  return useAsync(() => getWorkspace(slug), [slug], { key: invKey(slug, "research", "workspace") });
}

/** Notes of one instrument (incl. dismissed, for restore within the window); polled while a run is live. */
export function useInstrumentNotes(slug: string, instrumentId: number, nonce = 0) {
  const v = useResearchVersion();
  const runsQ = useAsync(() => runsOf(slug), [slug, nonce, v], { key: invKey(slug, "research", "runs") });
  const tick = useRunPoll(runsQ.data);
  useEffect(() => { if (tick) { cache.clear(); runsQ.reload(); } }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const notesQ = useAsync(() => cached(`inst:${slug}:${instrumentId}`, () => getResearch(slug, { instrument: instrumentId, include_dismissed: true, include_expired: true })), [slug, instrumentId, nonce, tick, v],
    { key: invKey(slug, "research", "instrument", instrumentId) });
  const summaryQ = useAsync(() => summaryOf(slug), [slug, nonce, tick, v], { key: invKey(slug, "research", "summary") });
  const row = useMemo(() => summaryQ.data?.instruments.find((x) => x.instrument_id === instrumentId) ?? null, [summaryQ.data, instrumentId]);
  return { runs: listOr(runsQ), notes: listOr(notesQ), summary: summaryQ.data, row, loading: notesQ.loading };
}

/** Dismissed within the server's restore window (15 minutes). */
export const canRestore = (n: Pick<ResearchNote, "dismissed_at" | "restorable_until">, now = Date.now()) => isRestorable(n, now);

const noteUndos = new Map<string, Undo>();

export { isMissingRoute };

/** Actions with undo. `onChanged` refreshes the caller (and the page: signals change on dismiss). */
export function useResearchActions(slug: string, onChanged: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);

  const offer = (key: string, text: string, savedAt: number, run: () => Promise<unknown>, what: string) => {
    const u = noteUndos.get(key) ?? makeUndo(savedAt, run);
    noteUndos.set(key, u);
    const retry = () => {
      void u.undo().then((res) => {
        if (undoSettled(res)) { noteUndos.delete(key); bumpResearch(slug); onChanged(); }
        const msg = undoMessage(res, what);
        if (msg) toast(msg, res === "failed" ? 8000 : 3000, res === "failed" ? { label: C.undo, onClick: retry } : undefined);
      });
    };
    toast(text, 10000, { label: C.undo, onClick: retry });
  };

  const dismiss = async (n: ResearchNote) => {
    setBusy(n.id);
    try {
      await dismissNote(slug, n.id);
      bumpResearch(slug);
      onChanged();
      const cand = n.kind === "candidate";
      offer(`d:${n.id}:${Date.now()}`, cand ? S.candidateDismissed(noteSubject(n).name) : S.noteDismissed, Date.now(), () => restoreNote(slug, n.id), cand ? S.whatCandidateDismiss : S.whatNoteDismiss);
    } catch (e) { toast(S.notDismissed(errorText(e)), 5000); } finally { setBusy(null); }
  };

  const restore = async (n: ResearchNote) => {
    setBusy(n.id);
    try { await restoreNote(slug, n.id); bumpResearch(slug); onChanged(); toast(n.kind === "candidate" ? S.candidateRestored : S.noteRestored, 2500); }
    catch (e) { toast(S.notRestored(errorText(e)), 5000); } finally { setBusy(null); }
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
        const w = await postWatch(slug, { ...(n.instrument_id != null ? { instrument_id: n.instrument_id } : { symbol_or_isin: n.candidate?.symbol ?? n.instrument?.symbol ?? "" }), note: S.candidateNote(n.title) });
        undo = () => deleteWatch(slug, w.id);
      }
      bumpResearch(slug);
      onChanged();
      offer(`w:${n.id}:${Date.now()}`, S.watched(name), Date.now(), undo, S.whatWatch);
    } catch (e) { toast(S.notWatched(errorText(e)), 5000); } finally { setBusy(null); }
  };

  return { dismiss, restore, watch, busy };
}
