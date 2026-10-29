// Research layer entry for the Inwestycje home (one hook, a few lines in Home.tsx): the strip as a grid item
// (after Sygnały + Alerty, deferred after the Alerty + Alokacja pair at two columns), the review block and
// the `Research` row of Co się zmieniło, the hero meta line, the decision form's research line, the research
// view route, the topic drawer (P9) and the context the strip / view / block share. Nothing shows before the first run.
import { type ReactNode, useCallback, useMemo } from "react";
import type { GridItem } from "../../../../widgets";
import type { WatchItem } from "../api";
import { instName } from "../logic";
import { useMacro, useResearchOverview, useWorkspace } from "./data";
import { acceptedAt, latestRun, showStrip, watchItemId } from "./logic";
import { canonKey } from "./segments";
import { ResearchPage } from "./Page";
import { ReviewResearch, researchChanges, researchEffectLine } from "./ReviewBlock";
import { CandidatesRail, ResearchStrip, type StripCtx } from "./Strip";
import { MacroChangesWidget, MacroStrip } from "./MacroWidgets";
import { normMacroChanges } from "./macro";
import { TopicDetail, topicCrumb } from "./TopicDrawer";
import type { DigestResearch, ResearchNote } from "./types";
import { localDay } from "../../../../time";

export { AssetResearch, ThesisHealth, useResearchShown } from "./AssetResearch";

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
  /** Navigate inside the investments tab (`research`, `assets/{id}?note=…`). */
  go: (sub?: string) => void;
  openAsset: (id: number, noteId?: number) => void;
  /** P9: the topic / macro regime drawer (`topics/<key>`). */
  openTopic: (key: string) => void;
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
  // P7: topic key -> watched (not held) symbols; the BE's `members` is the count, the FE lists the symbols.
  const watchedTopics = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const w of o.watch) {
      const k = canonKey(w.instrument?.segment);
      const s = w.instrument?.symbol;
      if (k && s && !w.held) m.set(k, [...(m.get(k) ?? []), s]);
    }
    return m;
  }, [o.watch]);
  const ctx: StripCtx = {
    slug: o.slug, today: o.today, nonce: o.nonce, held, watched, symOf, watchedTopics, strategyVersion: o.strategyVersion, workspace: ws.data,
    onOpenAsset: o.openAsset, onOpenResearch: (q) => o.go(q ? `research?${q}` : "research"), onOpenTopic: o.openTopic, onChanged: o.onChanged, onSettings: o.onSettings,
  };
  const instOf = useCallback((id: number) => held.get(id) ?? watchedIds.get(id) ?? null, [held, watchedIds]);
  const ran = showStrip(runs);
  const last = latestRun(runs ?? []);
  // P6: the macro regimes come from the daily check, not from research runs: shown before the first run too.
  const macro = useMacro(o.slug, o.nonce);
  const macroChanges = normMacroChanges(o.digestResearch?.macro_changes);

  /** Grid item of the strip; the last cell of the home (Q13). Before the first run only the macro line (P6), when
   * there are regimes. */
  const strip: GridItem | null = ran && runs ? { id: "research", span: 3, node: <ResearchStrip ctx={ctx} runs={runs} summary={summary} /> }
    : macro.data?.regimes.length ? { id: "research", span: 3, node: <MacroStrip ctx={ctx} /> } : null;

  /** P7: the Kandydaci widget of the home rail (under Alerty); null before the first run. */
  const candidatesItem: GridItem | null = ran && runs ? { id: "candidates", span: 1, node: <CandidatesRail ctx={ctx} candidates={candidates} /> } : null;

  /** Review block (span 3) between Co się zmieniło and Sygnały; before the first run only the changed macro
   * regimes (P6), when any changed. */
  const review = (since: string | null): GridItem | null => ran && runs && since
    ? { id: "review-research", span: 3, node: <ReviewResearch ctx={ctx} runs={runs} summary={summary} candidates={candidates} digest={o.digestResearch} since={since} onSettings={o.onSettings} /> }
    : since && macroChanges.length ? { id: "review-research", span: 3, node: <MacroChangesWidget changes={macroChanges} onOpen={o.openTopic} /> } : null;

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
    <ResearchPage slug={o.slug} today={o.today} privacy={o.privacy} held={held} watchedIds={watchedIds} watched={watched} symOf={symOf} watchedTopics={watchedTopics} strategyVersion={o.strategyVersion}
      initial={params} onBack={onBack} onOpenAsset={o.openAsset} onOpenTopic={o.openTopic} onSettings={o.onSettings} onChanged={o.onChanged} />
  );

  /** P9: the topic drawer's content (route `topics/<key>`) and its title. */
  const topic = (key: string) => (
    <TopicDetail key={key} slug={o.slug} topic={key} today={o.today} symOf={symOf} instOf={instOf} watchedTopics={watchedTopics}
      onOpenAsset={(id) => o.openAsset(id)} onChanged={o.onChanged} />
  );

  return { ran, runs, summary, strip, candidates: candidatesItem, review, changesRow, ranInPeriod, effect, page, topic, topicCrumb };
}
