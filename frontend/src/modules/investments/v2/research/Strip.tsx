// Research strip on the Inwestycje home (research.md 1, implementation-plan item 30; P7 strip-design.md 2): span 3,
// two columns `Makro` (1/3: five regime rows with a one-sentence summary, the explanation on hover / focus) |
// `Tematy` (2/3: the owner's topics, the week's topic trend regardless of weight, the contribution of held topics,
// the latest topic note; watched-only topics muted after the held ones). Kandydaci live in the home rail
// (`CandidatesRail`). Rendered only after the first run (density rule).
// Header tag = the latest run (its title: the next run); a week without a run collapses the strip to the not-run
// line. Home v3 (Q10 / Q13 / Q14): no footer, the strip is the last cell of the home; the unread count sits at the
// `wszystkie` entry point, rows carry the quiet page marker for new notes.
import { type CSSProperties, type ReactNode, useState } from "react";
import { useAsync } from "../../../../hooks";
import { Skeleton } from "../../../../ui";
import { Mark, UnreadChip, Widget } from "../../../../widgets";
import { dm, pct, plural, wdm } from "../../labels";
import { canRestore, useResearchActions, useSegments } from "./data";
import { getResearch } from "./api";
import { invKey } from "../api";
import {
  BOUNDARY, countsText, healthOf, isLive, lastDone, latestRun, nextSaturday, nNotes,
  researchCommand, runNotes, runTag, workspacePath, acceptedAt, watchItemId, latestTitle,
} from "./logic";
import { CandidateCard, type CandidateState, CopyCommand, HealthPill, ScheduleHow, SentimentBars, TopicRow } from "./primitives";
import {
  barTitle, contribBars, type DisplayRow, homeTopics, staleSymbols, type SymOf, tone, topicColumns, topicKind, topicSymbols, windowTitle,
} from "./segments";
import type { InstrumentSummary, ResearchNote, ResearchRun, ResearchSummary, SegmentAttribution, Workspace } from "./types";
import { InstLabel, type InstLike } from "../InstLabel";
import { MacroColumn } from "./MacroWidgets";

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
  onChanged: () => void;
  /** Ustawienia › Agent AI (workspace and the routine). */
  onSettings?: () => void;
  /** Home reload counter: the Tematy / Makro columns re-read with the other home views. */
  nonce?: number;
  /** Symbol of an instrument id (segment rows list instrument ids). */
  symOf: (id: number) => string | null;
  /** P7: topic key -> watched (not held) symbols, from the watchlist's `instrument.segment`. */
  watchedTopics: Map<string, string[]>;
}

export function ResearchStrip({ ctx, runs, summary }: {
  ctx: StripCtx; runs: ResearchRun[]; summary: ResearchSummary | null | undefined;
}) {
  const tag = runTag(runs, ctx.today);
  const last = latestRun(runs);
  const cmd = researchCommand(ctx.workspace?.path, ctx.slug);
  if (tag.state === "stale") {
    return (
      <Widget title="Research" className="rsch" tags={<span className={`tag ${tag.tone}`}>{tag.text}</span>}
        controls={<button className="lnk" onClick={() => ctx.onOpenResearch()}>otwórz notatki</button>} body="tight"
        footer={<><span>rutyna: <b>sobota 07:00</b> · Claude Code</span><span className="spacer" /><span>{BOUNDARY}</span></>}>
        <MacroColumn ctx={ctx} />
        <NotRun ctx={ctx} runs={runs} cmd={cmd} />
      </Widget>
    );
  }
  return (
    <Widget title="Research" className="rsch" id="inv-research"
      tags={<span className={`tag ${tag.tone}`} title={last?.status === "running" ? "przebieg trwa…" : `następny ${wdm(nextSaturday(ctx.today))} · rutyna Claude Code`}>{tag.text}</span>}
      controls={<>
        {tag.state === "failed" && <CopyCommand cmd={cmd} label="Uruchom ponownie" primary={false} showCmd={false} />}
        <UnreadChip n={summary?.totals?.notes_unread ?? 0} />
        <button className="lnk" onClick={() => ctx.onOpenResearch()}>wszystkie</button>
      </>}
      body="tight">
      <div className="rsch2">
        <MacroColumn ctx={ctx} />
        <TopicsColumn ctx={ctx} />
      </div>
    </Widget>
  );
}

/** Home rail widget under Alerty (P7 design 3): up to two compact candidate cards with Obserwuj / Odrzuć, the new
 * count as the tag, `wszyscy (N)` to the research page. The hook returns no item before the first run. */
export function CandidatesRail({ ctx, candidates }: { ctx: StripCtx; candidates: ResearchNote[] | null | undefined }) {
  const actions = useResearchActions(ctx.slug, ctx.onChanged);
  const open = (candidates ?? []).filter((n) => !n.dismissed_at);
  const fresh = open.filter((n) => !ctx.watched(n) && !acceptedAt(n) && watchItemId(n) == null);
  return (
    <Widget title="Kandydaci" id="inv-candidates" body="tight"
      count={fresh.length ? <span title={`nowi wg strategii${ctx.strategyVersion != null ? ` v${ctx.strategyVersion}` : ""}`}>{fresh.length}</span> : undefined}
      controls={open.length > 2 ? <button className="lnk" onClick={() => ctx.onOpenResearch("scope=candidates")}>wszyscy ({open.length})</button> : undefined}>
      {candidates === undefined ? <Skeleton h={96} r={8} />
        : open.length ? <div className="cands">{open.slice(0, 2).map((n) => (
            <CandidateCard key={n.id} note={n} compact today={ctx.today} state={ctx.watched(n)} busy={actions.busy === n.id}
              onWatch={actions.watch} onDismiss={actions.dismiss} onRestore={actions.restore} canRestore={canRestore(n)} />
          ))}</div>
        : <div className="empty">Brak nowych kandydatów.</div>}
    </Widget>
  );
}

export function ThesisRow({ s, health, name, symbol, inst, muted, sub, right, onOpen }: {
  s: InstrumentSummary; health: ReturnType<typeof healthOf>; name: string; symbol: string | null; muted?: boolean;
  /** The instrument (positions, watchlist): the identity label (compact) instead of name + symbol text. */
  inst?: InstLike;
  sub?: ReactNode; right?: ReactNode; onOpen?: () => void;
}) {
  const line = sub ?? latestTitle(s) ?? (s.last_researched_at ? `research ${dm(s.last_researched_at)}` : "bez notatek");
  return (
    <div className="rrow">
      {inst ? (
        <div style={{ minWidth: 0 }}>
          <InstLabel density="compact" inst={inst} text={name} onOpen={onOpen ? () => onOpen() : undefined} sub={<span title={latestTitle(s) ?? undefined}>{line}</span>}
            badges={(s.unread ?? 0) > 0 && <Mark kind="notes" title={plural(s.unread!, "nowa notatka", "nowe notatki", "nowych notatek")} />} />
        </div>
      ) : (
        <div style={{ minWidth: 0 }}>
          <div className="nm">{onOpen ? <button className="nm" onClick={onOpen}>{name}</button> : name}{symbol && symbol !== name && <span className="sym">{symbol}</span>}
            {(s.unread ?? 0) > 0 && <> <Mark kind="notes" title={plural(s.unread!, "nowa notatka", "nowe notatki", "nowych notatek")} /></>}</div>
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

/** Home column `Tematy` (P7 design 2.3): the week's move by topic, held topics (contribution bar) then watched-only
 * topics (muted, trend only), two sub-columns from 6 rows, `pozostałe N` when topics were dropped. Instruments without
 * a topic are not shown (owner P7: no unassigned bucket anywhere). */
function TopicsColumn({ ctx }: { ctx: StripCtx }) {
  const seg = useSegments(ctx.slug, "1w", ctx.nonce ?? 0);
  const d = seg.data;
  const head = <TopicsHead d={d} />;
  if (!d) return <div className="tcol">{head}{seg.loading ? <Skeleton h={190} r={8} /> : <div className="empty-line">Brak danych tematów.</div>}</div>;
  const { rows, rest } = homeTopics(d);
  if (!rows.length) return <div className="tcol">{head}<div className="empty-line">Brak tematów.</div></div>;
  return (
    <div className="tcol">
      {head}
      <TopicRows rows={rows} stale={d.stale} symOf={ctx.symOf} watched={ctx.watchedTopics} onOpen={(key) => ctx.onOpenResearch(`segment=${key}`)} />
      {rest > 0 && <div className="rsec"><button className="lnk" onClick={() => ctx.onOpenResearch("scope=segments")}>pozostałe {rest}</button></div>}
    </div>
  );
}

/** `Tematy · tydzień -1,2 %` (home and review header); `extra` is appended to the count. */
export function TopicsHead({ d, extra }: { d: (Pick<SegmentAttribution, "start" | "end" | "portfolio_return"> & Partial<Pick<SegmentAttribution, "residual">>) | null | undefined; extra?: string | null }) {
  return (
    <div className="rsec">Tematy <span className="cnt" title={d ? windowTitle(d) : undefined}>· tydzień{d && d.portfolio_return != null && <> <span className={tone(d.portfolio_return)}>{pct(d.portfolio_return, true)}</span></>}{extra ? ` · ${extra}` : ""}</span></div>
  );
}

/** Rows on one shared bar scale (held rows only feed the scale); `compact` = one column always (review). */
export function TopicRows({ rows, stale, symOf, watched, onOpen, compact }: {
  rows: DisplayRow[]; stale: number[]; symOf: SymOf; watched: Map<string, string[]>; onOpen: (key: string) => void; compact?: boolean;
}) {
  const { max, bars } = contribBars(rows.map((r) => (topicKind(r) === "held" ? r.contribution : 0)));
  const { cols, rows: perCol } = compact ? { cols: 1 as const, rows: rows.length } : topicColumns(rows.length);
  const firstWatched = rows.findIndex((r) => topicKind(r) === "watched");
  return (
    <div className={`topics c${cols}`} style={{ "--rows": perCol } as CSSProperties}>
      {rows.map((r, i) => (
        <TopicRow key={r.key} r={r} kind={topicKind(r)} bar={{ ...bars[i], title: barTitle(r.contribution, max) }} syms={topicSymbols(r, symOf, watched)}
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
        <b>Rutyna nie uruchomiła się.</b>
        {at && (
          <div className="d">
            ostatni research {wdm(at)}{n != null ? ` · ${nNotes(n)}` : ""}{notesQ.data ? ` · ważnych ${live.length}${lastExpiry ? ` do ${dm(lastExpiry)}` : ""}` : ""}
          </div>
        )}
      </div>
      <CopyCommand cmd={cmd} />
      <button className="btn" onClick={() => setHow((v) => !v)} aria-expanded={how}>Zaplanuj w Claude Code</button>
      {how && <ScheduleHow path={workspacePath(ctx.workspace?.path, ctx.slug)} onSettings={ctx.onSettings} />}
    </div>
  );
}
