// Sunday review: the `Co mówi research` block (research.md 1, implementation-plan item 33; span 3 between Co
// się zmieniło and Sygnały): theses whose health changed since the last review (`była aktualna`), the market
// changed macro regimes and the topics of the digest (P5 / P7 Tematy, new topic notes first, no Waluty / no unassigned), candidates since the last review with actions; the rest
// collapsed. A week without a run turns it into the not-run line with the copyable command. Also the
// `Research` row of Co się zmieniło and the decision form's `research z soboty: …` line.
import { type ReactNode, useState } from "react";
import { Widget } from "../../../../widgets";
import { dm, hm, wdm } from "../../labels";
import { canRestore, useResearchActions, useSegments } from "./data";
import {
  countsText, HEALTH_LABEL, healthOf, latestRun, latestTitle, normHealth, nNotes, researchCommand, runMinutes, runNotes, runTag,
} from "./logic";
import { CandidateCard } from "./primitives";
import { normDigestMarket, reviewTopics, withBriefs, withNewNote } from "./segments";
import { MacroChanges } from "./MacroWidgets";
import { normMacroChanges } from "./macro";
import { NotRun, type StripCtx, ThesisRow, TopicRows, TopicsHead } from "./Strip";
import type { DigestResearch, ResearchNote, ResearchRun, ResearchSummary } from "./types";
import { localDay } from "../../../../time";
import { S as L } from "./logic.strings.ts";
import { S } from "./ReviewBlock.strings.ts";

export function ReviewResearch({ ctx, runs, summary, candidates, digest, since, onSettings }: {
  ctx: StripCtx; runs: ResearchRun[]; summary: ResearchSummary | null | undefined; candidates: ResearchNote[] | null | undefined;
  digest: DigestResearch | null | undefined; since: string; onSettings: () => void;
}) {
  const [rest, setRest] = useState(false);
  const actions = useResearchActions(ctx.slug, ctx.onChanged);
  // P9: the digest rows may come without briefs / thesis: the live topic rows fill them in (same rows as the home).
  const live = useSegments(ctx.slug, "1w", ctx.nonce ?? 0);
  const tag = runTag(runs, ctx.today);
  const last = latestRun(runs);
  const ranInPeriod = digest?.ran_in_period ?? (!!last && (localDay(last.started_at) ?? "") >= since);
  if (!ranInPeriod) {
    const n = last ? runNotes(last) : null;
    return (
      <Widget title={S.title} className="rsch" tags={<span className={`tag ${tag.tone || "warn"}`}>{tag.state === "stale" ? tag.text : S.noneThisWeek(last ? dm(last.finished_at ?? last.started_at) : null)}</span>}
        controls={last ? <button className="lnk" onClick={() => ctx.onOpenResearch()}>{S.notesFrom(dm(last.started_at), n)}</button> : undefined} body="tight"
        footer={<><span>{S.routine} <b>{S.saturday}</b> · Claude Code · <button className="lnk" onClick={onSettings}>{S.settings}</button></span><span className="spacer" /><span>{L.boundary}</span></>}>
        <MacroChanges changes={normMacroChanges(digest?.macro_changes)} onOpen={ctx.onOpenTopic} />
        <NotRun ctx={ctx} runs={runs} cmd={researchCommand(ctx.workspace?.path, ctx.slug)} />
      </Widget>
    );
  }
  const changed = digest?.theses_changed ?? [];
  const rows = (summary?.instruments ?? []).filter((s) => ctx.held.has(s.instrument_id));
  const changedRows = changed.map((c) => ({ c, s: rows.find((s) => s.instrument_id === c.instrument_id) })).filter((x) => x.s);
  const others = rows.filter((s) => !changed.some((c) => c.instrument_id === s.instrument_id));
  const noThesis = others.filter((s) => healthOf(s, ctx.today) === "no_thesis");
  const noNotes = others.filter((s) => !s.notes && !s.counts.supports && !s.counts.weakens && !s.counts.invalidates && !s.counts.fulfills && !s.counts.neutral);
  // The digest's 1w attribution as of its end: the top rows + `market` (header move, stale).
  const { segments, market } = normDigestMarket(digest?.segments, digest?.market);
  const newSeg = withNewNote(segments);
  const topicRows = withBriefs(reviewTopics(segments), live.data?.segments ?? []);
  const candIds = new Set(digest?.candidates ?? []);
  const cands = (candidates ?? []).filter((n) => candIds.size ? candIds.has(n.id) : (localDay(n.observed_at) ?? "") >= since);
  const newC = cands.filter((n) => !n.dismissed_at).length, dismissedC = cands.filter((n) => n.dismissed_at).length;
  const run = digest?.run ?? last!;
  const mins = runMinutes(run);
  const name = (id: number, fallback?: string | null) => ctx.held.get(id)?.name ?? fallback ?? `#${id}`;
  const sym = (id: number, fallback?: string | null) => ctx.held.get(id)?.symbol ?? fallback ?? null;
  const inst = (id: number) => ctx.held.get(id)?.inst;
  return (
    <Widget title={S.title} className="rsch" id="inv-review-research"
      tags={<span className="tag">{wdm(run.started_at)} · {nNotes(digest?.notes_count ?? runNotes(run) ?? 0)} · {S.since(dm(since))}</span>}
      controls={<button className="lnk" onClick={() => ctx.onOpenResearch()}>{S.all}</button>} body="tight"
      footer={<>
        <span>{wdm(run.started_at)} {hm(run.started_at)}{mins ? ` · ${mins} min` : ""}</span>
        <span><b>{digest?.notes_count ?? runNotes(run) ?? 0}</b> {S.notes(digest?.notes_count ?? runNotes(run) ?? 0)}</span>
        {typeof run.counts?.sources_checked === "number" && <span><b>{run.counts.sources_checked}</b> {S.sources(run.counts.sources_checked)}</span>}
        {digest?.counts && <span><b>{digest.counts.community}</b> {S.community}</span>}
        {digest?.signals_count != null && <span><b>{digest.signals_count}</b> {S.signalsFromResearch(digest.signals_count)}</span>}
        <span className="spacer" /><span>{L.boundary}</span>
      </>}>
      <div className="rsch3">
        <div>
          <div className="rsec">{S.theses} <span className="cnt">· {changedRows.length ? S.nChanges(changedRows.length) : S.noChanges}</span></div>
          {changedRows.map(({ c, s }) => {
            const from = normHealth(c.from);
            const h = healthOf(s!, ctx.today);
            return (
              <ThesisRow key={c.instrument_id} s={s!} health={normHealth(c.to) ?? h} name={name(c.instrument_id, c.label ?? s!.label)} symbol={sym(c.instrument_id, c.symbol ?? s!.symbol)} inst={inst(c.instrument_id)}
                sub={<>{from ? S.was(HEALTH_LABEL[from]) : S.newAssessment}{latestTitle(s!) ? ` · ${latestTitle(s!)}` : ""}</>}
                right={countsText(normHealth(c.to) ?? h, c.counts ?? s!.counts, { notes: s!.notes, latestPolarity: s!.latest_polarity })}
                onOpen={() => ctx.onOpenAsset(c.instrument_id)} />
            );
          })}
          {rest && others.map((s) => <ThesisRow key={s.instrument_id} s={s} health={healthOf(s, ctx.today)} name={name(s.instrument_id, s.label)} symbol={sym(s.instrument_id, s.symbol)} inst={inst(s.instrument_id)} onOpen={() => ctx.onOpenAsset(s.instrument_id)} />)}
          {others.length > 0 && !rest && (
            <div className="rrow" style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
              <div><div className="nm">{S.otherPositions(others.length)}</div>
                <div className="sub">{[S.noChanges, noThesis.length ? S.noThesisFor(noThesis.map((s) => sym(s.instrument_id, s.symbol) ?? name(s.instrument_id)).slice(0, 3).join(S.and)) : null, noNotes.length ? S.nNoNotes(noNotes.length) : null].filter(Boolean).join(" · ")}</div></div>
              <button className="lnk" onClick={() => setRest(true)}>{S.show}</button>
            </div>
          )}
        </div>
        <div>
          <MacroChanges changes={normMacroChanges(digest?.macro_changes)} onOpen={ctx.onOpenTopic} />
          <TopicsHead d={market} extra={newSeg ? S.nNewNotes(newSeg) : S.noNewNotes} />
          {topicRows.length
            ? <TopicRows compact rows={topicRows} stale={market?.stale ?? []} symOf={ctx.symOf} watched={ctx.watchedTopics} onOpen={ctx.onOpenTopic} />
            : <div className="empty-line">{S.noTopicData}</div>}
        </div>
        <div>
          <div className="rsec">{S.candidates} <span className="cnt">· {[newC ? S.nNew(newC) : S.noneNew, dismissedC ? S.nDismissed(dismissedC) : null].filter(Boolean).join(" · ")}</span></div>
          {cands.filter((n) => !n.dismissed_at).slice(0, 3).map((n) => (
            <CandidateCard key={n.id} note={n} today={ctx.today} state={ctx.watched(n)} busy={actions.busy === n.id}
              onWatch={actions.watch} onDismiss={actions.dismiss} onRestore={actions.restore} canRestore={canRestore(n)} />
          ))}
          {!newC && <div className="empty-line">{S.noNewCandidates}</div>}
        </div>
      </div>
    </Widget>
  );
}

/** `Research` row of Co się zmieniło: `14 notatek · 2 tezy osłabione (CDR, EIMI), 1 wzmocniona (KGH) · 2
 * kandydatów · niżej`. Null when no run happened in the period. */
export function researchChanges(o: { digest: DigestResearch | null | undefined; held: StripCtx["held"]; onJump: () => void }): ReactNode | null {
  const d = o.digest;
  if (!d || (!(d.ran_in_period ?? !!d.run) && !d.notes_count)) return null;
  const sym = (c: { instrument_id: number; symbol?: string | null; label?: string | null }) => o.held.get(c.instrument_id)?.symbol ?? c.symbol ?? c.label ?? `#${c.instrument_id}`;
  const weak = d.theses_changed.filter((c) => ["weak", "inv"].includes(normHealth(c.to) ?? ""));
  const ful = d.theses_changed.filter((c) => normHealth(c.to) === "ful");
  const sup = d.theses_changed.filter((c) => normHealth(c.to) === "sup");
  const parts = [
    weak.length ? `${S.nWeakened(weak.length)} (${weak.map(sym).join(", ")})` : null,
    ful.length ? `${S.nFulfilled(ful.length)} (${ful.map(sym).join(", ")})` : null,
    sup.length ? `${S.nStrengthened(sup.length)} (${sup.map(sym).join(", ")})` : null,
  ].filter(Boolean).join(", ");
  return (
    <>
      <b>{nNotes(d.notes_count)}</b>
      <span className="s">{parts ? ` · ${parts}` : ""}{d.candidates.length ? ` · ${S.nCandidates(d.candidates.length)}` : ""} · </span>
      <button className="lnk" onClick={o.onJump}>{S.below}</button>
    </>
  );
}

/** Decision form effect line: `research z soboty: 2 notatki osłabiają tezę (premiera 2028, Q3) · otwórz notatki`. */
export function researchEffectLine(o: {
  instrumentId: number; digest: DigestResearch | null | undefined; summary: ResearchSummary | null | undefined; runs: ResearchRun[] | null | undefined; today: string;
}): { text: string; weekday: string } | null {
  const row = o.summary?.instruments.find((s) => s.instrument_id === o.instrumentId);
  const last = latestRun(o.runs ?? []);
  if (!row || !last) return null;
  const changed = o.digest?.theses_changed.find((c) => c.instrument_id === o.instrumentId);
  const c = row.counts;
  const rel = c.invalidates ? S.relThesis("invalidates", c.invalidates)
    : c.weakens ? S.relThesis("weakens", c.weakens)
    : c.fulfills ? S.relThesis("fulfills", c.fulfills)
    : c.supports ? S.relThesis("supports", c.supports) : null;
  if (!rel && !changed) return null;
  const day = new Date(`${localDay(last.started_at)}T12:00:00`).getDay();
  const weekday = day === 6 ? S.fromSaturday : S.fromDate(dm(last.started_at));
  return { text: S.effect(weekday, rel, latestTitle(row)), weekday };
}
