// Research layer entry for the Inwestycje home (one hook, a few lines in Home.tsx): the strip as a grid item
// (after Sygnały + Alerty, deferred after the Alerty + Alokacja pair at two columns), the review block and
// the `Research` row of Co się zmieniło, the hero meta line, the decision form's research line, the research
// view route and the context the strip / view / block share. Nothing shows before the first run.
import { type ReactNode, useCallback, useMemo } from "react";
import type { GridItem } from "../../../../widgets";
import type { WatchItem } from "../api";
import { instName } from "../logic";
import { useResearchOverview, useWorkspace } from "./data";
import { acceptedAt, latestRun, showStrip, watchItemId } from "./logic";
import { ResearchPage } from "./Page";
import { ReviewResearch, researchChanges, researchEffectLine } from "./ReviewBlock";
import { ResearchStrip, type StripCtx } from "./Strip";
import type { DigestResearch, ResearchNote } from "./types";
import { localDay } from "../../../../time";

export { AssetResearch, ResearchHeaderNote, ThesisFieldChip, ThesisHealth, useResearchTimeline } from "./AssetResearch";

interface PositionLike { instrument: { id: number | string; name?: string | null; label: string; symbol?: string | null }; weight?: number | null }

export interface ResearchHomeInput {
  slug: string;
  nonce: number;
  today: string;
  privacy: string;
  positions: PositionLike[];
  watch: WatchItem[];
  strategyVersion: number | null;
  /** The review digest (its `since` and the `research` block, RS CONTRACT). */
  digest: { since?: string | null; research?: unknown } | null | undefined;
  /** Navigate inside the investments tab (`research`, `research?theme=…`, `assets/{id}?note=…`). */
  go: (sub?: string) => void;
  openAsset: (id: number, noteId?: number) => void;
  onSettings: () => void;
  onChanged: () => void;
}

export function useResearchHome(input: ResearchHomeInput) {
  const o = { ...input, since: input.digest?.since ?? null, digestResearch: (input.digest?.research ?? null) as DigestResearch | null };
  const { runs, summary, candidates } = useResearchOverview(o.slug, o.nonce);
  const ws = useWorkspace(o.slug);
  const held = useMemo(() => new Map(o.positions.map((p) => [Number(p.instrument.id), { name: instName(p.instrument), symbol: p.instrument.symbol ?? null, weight: p.weight ?? null, inst: p.instrument }])), [o.positions]);
  const watchedIds = useMemo(() => new Map(o.watch.filter((w) => w.instrument).map((w) => [w.instrument_id, { name: instName(w.instrument!), symbol: w.instrument!.symbol ?? null, inst: w.instrument! }])), [o.watch]);
  const watched = useCallback((n: ResearchNote) => {
    const sym = (n.candidate?.symbol ?? n.instrument?.symbol)?.toUpperCase();
    const wid = watchItemId(n);
    const w = o.watch.find((x) => (wid != null && x.id === wid) || (n.instrument_id != null && x.instrument_id === n.instrument_id) || (sym && x.instrument?.symbol?.toUpperCase() === sym));
    if (!w) return acceptedAt(n) ? { watchedSince: acceptedAt(n) } : undefined;
    // An instrument the agent put on the watchlist itself (add_to_watchlist) shows `dodany przez agenta`.
    return { watchedSince: acceptedAt(n) ?? w.added_at, agent: w.source === "agent" && !acceptedAt(n) };
  }, [o.watch]);
  const symOf = useCallback((id: number) => held.get(id)?.symbol ?? watchedIds.get(id)?.symbol
    ?? summary?.instruments.find((s) => s.instrument_id === id)?.instrument?.symbol ?? null, [held, watchedIds, summary]);
  const ctx: StripCtx = {
    slug: o.slug, today: o.today, held, watched, symOf, strategyVersion: o.strategyVersion, workspace: ws.data,
    onOpenAsset: o.openAsset, onOpenResearch: (q) => o.go(q ? `research?${q}` : "research"), onChanged: o.onChanged, onSettings: o.onSettings,
  };
  const ran = showStrip(runs);
  const last = latestRun(runs ?? []);

  /** Grid item of the strip (null before the first run); the last cell of the home (Q13). */
  const strip: GridItem | null = ran && runs ? { id: "research", span: 3, node: <ResearchStrip ctx={ctx} runs={runs} summary={summary} candidates={candidates} /> } : null;

  /** Review block (span 3) between Co się zmieniło and Sygnały; null before the first run. */
  const review = (since: string | null): GridItem | null => ran && runs && since
    ? { id: "review-research", span: 3, node: <ReviewResearch ctx={ctx} runs={runs} summary={summary} candidates={candidates} digest={o.digestResearch} since={since} onSettings={o.onSettings} /> }
    : null;

  /** `Research` row of Co się zmieniło (null when no run in the period). */
  const changesRow = researchChanges({ digest: o.digestResearch, held, onJump: () => document.getElementById("inv-review-research")?.scrollIntoView({ behavior: "smooth", block: "start" }) });

  /** Review step 1 label `✓ Zmiany i research` when a run happened in the period. */
  const ranInPeriod = o.digestResearch?.ran_in_period ?? (!!last && !!o.since && last.status !== "running" && (localDay(last.started_at) ?? "") >= o.since);

  /** Decision form line for an instrument with research since the last review. */
  const effect = (instrumentId: number): ReactNode => {
    const l = researchEffectLine({ instrumentId, digest: o.digestResearch, summary, runs, today: o.today });
    if (!l) return null;
    return <>{l.text} · <button className="lnk" onClick={() => o.openAsset(instrumentId)}>otwórz notatki</button></>;
  };

  /** The research view (route `research`). */
  const page = (params: URLSearchParams, onBack: () => void) => (
    <ResearchPage slug={o.slug} today={o.today} privacy={o.privacy} held={held} watchedIds={watchedIds} watched={watched} symOf={symOf} strategyVersion={o.strategyVersion}
      initial={params} onBack={onBack} onOpenAsset={o.openAsset} onSettings={o.onSettings} onChanged={o.onChanged} />
  );

  return { ran, runs, summary, strip, review, changesRow, ranInPeriod, effect, page };
}
