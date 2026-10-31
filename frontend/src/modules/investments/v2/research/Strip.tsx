// Research strip on the Inwestycje home (research.md 1, implementation-plan item 30; P7 strip-design.md 2; P9 briefs):
// span 3, two columns `Makro` (1/3: five regime rows with the brief "for dummies", the explanation on hover / focus) |
// `Tematy` (2/3, fully expanded: the owner's topics with their tickers, the contribution of held topics and up to 3
// research briefs; watched-only topics muted after the held ones; a name opens the topic drawer). Kandydaci live in the home rail
// (`CandidatesRail`). Rendered only after the first run (density rule).
// Header tag = the latest run (its title: the next run); a week without a run collapses the strip to the not-run
// line. Home v3 (Q10 / Q13 / Q14): no footer, the strip is the last cell of the home; the unread count sits at the
// `wszystkie` entry point, rows carry the quiet page marker for new notes.
import { type CSSProperties, type ReactNode, useState } from "react";
import { useAsync } from "../../../../hooks";
import { Skeleton } from "../../../../ui";
import { Mark, UnreadChip, Widget } from "../../../../widgets";
import { dm, pct, wdm } from "../../labels";
import { useResearchActions, useSegments } from "./data";
import { getResearch } from "./api";
import { invKey } from "../api";
import {
  countsText, healthOf, isLive, lastDone, latestRun, nextSaturday, nNotes,
  researchCommand, runNotes, runTag, workspacePath, acceptedAt, watchItemId, latestTitle, candidateCriteria, criterionText, noteSubject,
} from "./logic";
import { RailRow } from "../HomeRail";
import { type CandidateState, CopyCommand, HealthPill, ScheduleHow, SentimentBars, TopicRow } from "./primitives";
import {
  barTitle, contribBars, type DisplayRow, homeTopics, staleSymbols, type SymOf, tone, topicColumns, topicKind, topicSymbols, windowTitle,
} from "./segments";
import type { InstrumentSummary, ResearchNote, ResearchRun, ResearchSummary, SegmentAttribution, Workspace } from "./types";
import { InstLabel, type InstLike } from "../InstLabel";
import { MacroColumn } from "./MacroWidgets";
import { S as L } from "./logic.strings.ts";
import { S as P } from "./primitives.strings.ts";
import { S } from "./Strip.strings.ts";

export interface StripCtx {
  slug: string;
  today: string;
  /** Held instruments: id -> display name, symbol, weight, the instrument (identity label). */
  held: Map<number, { name: string; symbol: string | null; weight: number | null; inst?: InstLike }>;
  /** Watched instruments: instrument id or symbol -> since / agent (candidate cards show `obserwowany od`). */
  watched: (n: ResearchNote) => CandidateState | undefined;
  strategyVersion: number | null;
  workspace: Workspace | null | undefined;
  onOpenAsset: (id: number, noteId?: number) => void;
  onOpenResearch: (query?: string) => void;
  /** P9: the topic / macro regime drawer (`topics/<key>` over the home; a macro note key opens the regime). */
  onOpenTopic: (key: string) => void;
  onChanged: () => void;
  /** Ustawienia › Agent AI (workspace and the routine). */
  onSettings?: () => void;
  /** Home reload counter: the Tematy / Makro columns re-read with the other home views. */
  nonce?: number;
  /** Symbol of an instrument id (segment rows list instrument ids). */
  symOf: (id: number) => string | null;
  /** P7: topic key -> watched (not held) symbols, from the watchlist's `instrument.segment`. */
  watchedTopics: Map<string, string[]>;
  /** Display name of a held or watched instrument (the calendar's companies). */
  nameOf?: (id: number) => string | null;
}

export function ResearchStrip({ ctx, runs, summary }: {
  ctx: StripCtx; runs: ResearchRun[]; summary: ResearchSummary | null | undefined;
}) {
  const tag = runTag(runs, ctx.today);
  const last = latestRun(runs);
  const cmd = researchCommand(ctx.workspace?.path, ctx.slug);
  if (tag.state === "stale") {
    return (
      <Widget title={S.research} className="rsch" tags={<span className={`tag ${tag.tone}`}>{tag.text}</span>}
        controls={<button className="lnk" onClick={() => ctx.onOpenResearch()}>{S.openNotes}</button>} body="tight"
        footer={<><span>{S.routine} <b>{S.saturday}</b> · Claude Code</span><span className="spacer" /><span>{L.boundary}</span></>}>
        <MacroColumn ctx={ctx} />
        <NotRun ctx={ctx} runs={runs} cmd={cmd} />
      </Widget>
    );
  }
  return (
    <Widget title={S.research} className="rsch" id="inv-research"
      tags={<span className={`tag ${tag.tone}`} title={last?.status === "running" ? S.running : S.next(wdm(nextSaturday(ctx.today)))}>{tag.text}</span>}
      controls={<>
        {tag.state === "failed" && <CopyCommand cmd={cmd} label={S.runAgain} primary={false} showCmd={false} />}
        <UnreadChip n={summary?.totals?.notes_unread ?? 0} />
        <button className="lnk" onClick={() => ctx.onOpenResearch()}>{S.all}</button>
      </>}
      body="tight">
      <div className="rsch2">
        <MacroColumn ctx={ctx} />
        <TopicsColumn ctx={ctx} />
      </div>
    </Widget>
  );
}

/** Home rail widget under Alerty: one row per open candidate (ticker tile, name, the note's plain sentence), the
 * actions as icons at the right (Dlaczego pasuje opens the criteria under the row, Obserwuj, Odrzuć); no date, the
 * research agent dismisses a candidate that is no longer current. `wszyscy (N)` to the research page. The hook
 * returns no item before the first run. */
export function CandidatesRail({ ctx, candidates }: { ctx: StripCtx; candidates: ResearchNote[] | null | undefined }) {
  const actions = useResearchActions(ctx.slug, ctx.onChanged);
  const [why, setWhy] = useState<number | null>(null);
  // An expired candidate is gone: the agent gives each one 30 days and writes a fresh note when it still fits.
  const open = (candidates ?? []).filter((n) => !n.dismissed_at && !n.expired && (!n.expires_at || Date.parse(n.expires_at) > Date.now()));
  const fresh = open.filter((n) => !ctx.watched(n) && !acceptedAt(n) && watchItemId(n) == null);
  const shown = (fresh.length ? fresh : open).slice(0, 3);
  return (
    <Widget title={S.candidates} id="inv-candidates" body="tight" className="hrail"
      controls={open.length > 3 ? <button className="lnk" onClick={() => ctx.onOpenResearch("scope=candidates")}>{S.allCandidates(open.length)}</button> : undefined}>
      {candidates === undefined ? <Skeleton h={96} r={8} />
        : shown.length ? (
          <>
            {fresh.length > 0 && <p className="hlead">{S.candidatesLead(fresh.length)}</p>}
            {shown.map((n) => {
              const { name } = noteSubject(n);
              const watched = !!ctx.watched(n) || !!acceptedAt(n) || watchItemId(n) != null;
              const text = noteSentence(n);
              const crit = candidateCriteria(n);
              const context = typeof n.details?.context === "string" ? n.details.context : null;
              const busy = actions.busy === n.id;
              return (
                <div key={n.id} data-note={n.id}>
                  <RailRow inst={{ id: n.instrument?.id ?? `c:${n.id}`, label: name, name, symbol: n.instrument?.symbol ?? n.candidate?.symbol ?? null }}
                    title={name} text={text} right={(
                      <>
                        <button className={`hr-ic${why === n.id ? " hr-on" : ""}`} title={S.whyFits} aria-label={S.whyFitsAria(name)} aria-expanded={why === n.id}
                          onClick={() => setWhy(why === n.id ? null : n.id)}>{ICON_WHY}</button>
                        <button className={`hr-ic hr-ok${watched ? " hr-on" : ""}`} title={watched ? S.watching : P.watch} aria-label={`${P.watch}: ${name}`}
                          disabled={busy || watched} onClick={() => actions.watch(n)}>{ICON_WATCH}</button>
                        <button className="hr-ic hr-no" title={S.dismissTitle} aria-label={`${S.dismissTitle}: ${name}`} disabled={busy}
                          onClick={() => actions.dismiss(n)}>{ICON_DISMISS}</button>
                      </>
                    )} />
                  {why === n.id && (
                    <div className="hr-why">
                      {crit.items.map((c, k) => <span key={k}>{c.met ? "✓" : "·"} {criterionText(c)}</span>)}
                      {context && <span>{context}</span>}
                      {!crit.total && !context && <span>{n.title}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )
        : <div className="empty">{S.noCandidates}</div>}
    </Widget>
  );
}

/** The candidate note's plain sentence: the agent's headline (or its brief's), else the context, else the met
 * criteria, else the title (older notes; it often just repeats the name). */
function noteSentence(n: ResearchNote): string {
  const d = n.details as Record<string, unknown> | null | undefined;
  const brief = d && typeof d.brief === "object" && d.brief ? (d.brief as Record<string, unknown>).headline : null;
  const head = typeof d?.headline === "string" ? d.headline : typeof brief === "string" ? brief : null;
  if (head?.trim()) return head.trim();
  if (typeof d?.context === "string" && d.context.trim()) return d.context.trim();
  const met = candidateCriteria(n).items.filter((c) => c.met).slice(0, 2).map(criterionText);
  return met.length ? met.join(" · ") : n.title;
}

const ICON_WHY = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 0 1 4.8 1c0 1.7-2.3 2.2-2.3 3.5" /><path d="M12 17h.01" />
  </svg>
);
const ICON_WATCH = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
  </svg>
);
const ICON_DISMISS = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
);

export function ThesisRow({ s, health, name, symbol, inst, muted, sub, right, onOpen }: {
  s: InstrumentSummary; health: ReturnType<typeof healthOf>; name: string; symbol: string | null; muted?: boolean;
  /** The instrument (positions, watchlist): the identity label (compact) instead of name + symbol text. */
  inst?: InstLike;
  sub?: ReactNode; right?: ReactNode; onOpen?: () => void;
}) {
  const line = sub ?? latestTitle(s) ?? (s.last_researched_at ? S.researchOn(dm(s.last_researched_at)) : S.noNotes);
  return (
    <div className="rrow">
      {inst ? (
        <div style={{ minWidth: 0 }}>
          <InstLabel density="compact" inst={inst} text={name} onOpen={onOpen ? () => onOpen() : undefined} sub={<span title={latestTitle(s) ?? undefined}>{line}</span>}
            badges={(s.unread ?? 0) > 0 && <Mark kind="notes" title={P.nNewNotes(s.unread!)} />} />
        </div>
      ) : (
        <div style={{ minWidth: 0 }}>
          <div className="nm">{onOpen ? <button className="nm" onClick={onOpen}>{name}</button> : name}{symbol && symbol !== name && <span className="sym">{symbol}</span>}
            {(s.unread ?? 0) > 0 && <> <Mark kind="notes" title={P.nNewNotes(s.unread!)} /></>}</div>
          <div className="sub" title={latestTitle(s) ?? undefined}>{line}</div>
        </div>
      )}
      <SentimentBars values={s.sentiment_8w} />
      <div className="r">
        <HealthPill state={health} muted={muted} />
        <span className="cnt">{right ?? countsText(health, s.counts, { notes: s.notes, latestPolarity: s.latest_polarity })}</span>
      </div>
    </div>
  );
}

/** Home column `Tematy` (P9): every topic (no cap, the strip is the last widget and expands), held topics (contribution
 * bar) then watched-only topics (muted), two sub-columns from 6 rows. Instruments without a topic are not shown. */
function TopicsColumn({ ctx }: { ctx: StripCtx }) {
  const seg = useSegments(ctx.slug, "1w", ctx.nonce ?? 0);
  const d = seg.data;
  const head = <TopicsHead d={d} />;
  if (!d) return <div className="tcol">{head}{seg.loading ? <Skeleton h={190} r={8} /> : <div className="empty-line">{S.noTopicData}</div>}</div>;
  const rows = homeTopics(d);
  if (!rows.length) return <div className="tcol">{head}<div className="empty-line">{S.noTopics}</div></div>;
  return (
    <div className="tcol">
      {head}
      <TopicRows rows={rows} stale={d.stale} symOf={ctx.symOf} watched={ctx.watchedTopics} onOpen={ctx.onOpenTopic} />
    </div>
  );
}

/** `Tematy · tydzień -1,2 %` (home and review header); `extra` is appended to the count. */
export function TopicsHead({ d, extra }: { d: (Pick<SegmentAttribution, "start" | "end" | "portfolio_return"> & Partial<Pick<SegmentAttribution, "residual">>) | null | undefined; extra?: string | null }) {
  return (
    <div className="rsec">{S.topics} <span className="cnt" title={d ? windowTitle(d) : undefined}>{S.week}{d && d.portfolio_return != null && <> <span className={tone(d.portfolio_return)}>{pct(d.portfolio_return, true)}</span></>}{extra ? ` · ${extra}` : ""}</span></div>
  );
}

/** Rows on one shared bar scale (held rows only feed the scale); `compact` = one column always (review). */
export function TopicRows({ rows, stale, symOf, watched, onOpen, compact }: {
  rows: DisplayRow[]; stale: number[]; symOf: SymOf; watched: Map<string, string[]>; onOpen: (key: string) => void; compact?: boolean;
}) {
  const { max, bars } = contribBars(rows.map((r) => (topicKind(r) === "held" ? r.contribution : 0)));
  const { cols, rows: perCol } = compact ? { cols: 1 as const, rows: rows.length } : topicColumns(rows.length);
  // The dashed rule above the first row without exposure-or-member: watched-only, else brief-only.
  const firstWatched = rows.findIndex((r) => topicKind(r) === "watched" || topicKind(r) === "none");
  return (
    <div className={`topics c${cols}`} style={{ "--rows": perCol } as CSSProperties}>
      {rows.map((r, i) => (
        <TopicRow key={r.key} r={r} kind={topicKind(r)} bar={{ ...bars[i], title: barTitle(r.contribution, max) }} syms={topicKind(r) === "none" ? [] : topicSymbols(r, symOf, watched)}
          stale={staleSymbols(r, stale, symOf)} first={i === firstWatched && i > 0} right={cols === 2 && i >= perCol} last={cols === 2 && i === perCol - 1} onOpen={() => onOpen(r.key)} />
      ))}
    </div>
  );
}

/** "Research not run this week" (research.md 7): one line with what is still valid, the command,
 * `Kopiuj polecenie`, `Zaplanuj w Claude Code` (the local routine steps, never `/schedule`: a cloud routine
 * cannot reach the local MCP server). */
export function NotRun({ ctx, runs, cmd }: { ctx: Pick<StripCtx, "slug" | "today" | "workspace" | "onSettings">; runs: ResearchRun[]; cmd: string }) {
  const [how, setHow] = useState(false);
  const done = lastDone(runs);
  const notesQ = useAsync(() => getResearch(ctx.slug, {}), [ctx.slug], { key: invKey(ctx.slug, "research", "notes", "default") });
  const live = (notesQ.data ?? []).filter((n) => isLive(n, ctx.today));
  const lastExpiry = live.map((n) => n.expires_at ?? "").sort().slice(-1)[0];
  const at = done ? done.finished_at ?? done.started_at : null;
  const n = done ? runNotes(done) : null;
  return (
    <div className="norun">
      <div className="grow">
        <b>{S.routineNotRun}</b>
        {at && (
          <div className="d">
            {S.lastResearch(wdm(at))}{n != null ? ` · ${nNotes(n)}` : ""}{notesQ.data ? S.valid(live.length, lastExpiry ? dm(lastExpiry) : null) : ""}
          </div>
        )}
      </div>
      <CopyCommand cmd={cmd} />
      <button className="btn" onClick={() => setHow((v) => !v)} aria-expanded={how}>{S.scheduleIn}</button>
      {how && <ScheduleHow path={workspacePath(ctx.workspace?.path, ctx.slug)} onSettings={ctx.onSettings} />}
    </div>
  );
}
