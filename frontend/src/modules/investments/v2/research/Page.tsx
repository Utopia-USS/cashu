// Research view `#/{slug}/investments.portfolio/research` (research.md 1 + 7), as a story (Story.tsx): the page
// head with `Uruchom teraz` (copies the command), one summary sentence with the week's thesis moves and the tabs
// Tematy, Twoje spółki, Notatki (headline first, figures and sources on a click, dismiss with undo), Kalendarz,
// Kandydaci and Przebiegi (runs, scope and rules). Topics and macro regimes open their drawer. Before the first run:
// the empty state with the three steps (skill, first run, schedule).
import { useEffect, useState } from "react";
import { useAsync } from "../../../../hooks";
import { SetupSteps, type SetupStepItem, Skeleton, Tag } from "../../../../ui";
import { Grid, type GridItem, Widget } from "../../../../widgets";
import { dm, hm } from "../../labels";
import { getResearch } from "./api";
import { invKey } from "../api";
import type { InstLike } from "../InstLabel";
import { canRestore, useResearchActions, useResearchOverview, useSegments, useWorkspace } from "./data";
import { researchCommand, ROUTINE_PROMPT, runMinutes, runNotes, workspacePath } from "./logic";
import { CandidateCard, type CandidateState, CopyCommand, ScheduleHow } from "./primitives";
import { CalendarTab, MineTab, NotesTab, StoryHead, type StoryTab, STORY_TABS, TopicsTab, useWeek } from "./Story";
import { canonKey, hashWithSegment, isSegment } from "./segments";
import type { ResearchNote, ResearchRun, Workspace } from "./types";
import { isMacroKey } from "./macro";
import { localDay } from "../../../../time";
import { PRIVACY_SHORT as PRIVACY_SHORT_C, S } from "./Page.strings.ts";


export interface ResearchPageProps {
  slug: string;
  today: string;
  privacy: string;
  held: Map<number, { name: string; symbol: string | null; weight: number | null; inst?: InstLike }>;
  watchedIds: Map<number, { name: string; symbol: string | null; inst?: InstLike }>;
  watched: (n: ResearchNote) => CandidateState | undefined;
  symOf: (id: number) => string | null;
  /** P7: topic key -> watched (not held) symbols. */
  watchedTopics: Map<string, string[]>;
  strategyVersion: number | null;
  initial: URLSearchParams;
  onBack: () => void;
  onOpenAsset: (id: number, noteId?: number) => void;
  /** P9: a topic note's name opens the topic drawer over the home. */
  onOpenTopic: (key: string) => void;
  onSettings: () => void;
  onChanged: () => void;
}

const PRIVACY_SHORT: Record<string, string> = PRIVACY_SHORT_C;

export function ResearchPage(p: ResearchPageProps) {
  const [nonce, setNonce] = useState(0);
  const refresh = () => { setNonce((n) => n + 1); p.onChanged(); };
  const { runs, summary, candidates, loading } = useResearchOverview(p.slug, nonce);
  const ws = useWorkspace(p.slug);
  const seg = useSegments(p.slug, "1w", nonce);
  // An old `?segment=` / `?theme=` link opens the plain page (P9); the stale param leaves the URL. `?tab=` opens a tab.
  const [tab, setTab] = useState<StoryTab>(() => {
    const t = p.initial.get("tab") as StoryTab | null;
    return t && STORY_TABS.includes(t) ? t : p.initial.get("scope") === "candidates" ? "candidates" : "topics";
  });
  // Every live note (the Tematy cards' lines, Twoje spółki, Notatki); dismissed ones stay out.
  const notesQ = useAsync(() => getResearch(p.slug, {}), [p.slug, nonce], { key: invKey(p.slug, "research", "notes", "live") });
  const { cal } = useWeek(p.slug, p.today);
  const openNote = (n: ResearchNote) => (n.instrument_id != null ? p.onOpenAsset(n.instrument_id, n.id)
    : n.segment && (isMacroKey(n.segment) || isSegment(n.segment)) ? p.onOpenTopic(isMacroKey(n.segment) ? n.segment : canonKey(n.segment)!) : setTab("notes"));
  useEffect(() => {
    const next = hashWithSegment(location.hash, null);
    if (next !== location.hash) { try { history.replaceState(history.state, "", next); } catch { /* ignore */ } }
  }, []);
  const cmd = researchCommand(ws.data?.path, p.slug);
  const head = (
    <>
      <nav className="crumb" aria-label={S.crumb}><button onClick={p.onBack}>{S.investments}</button> › <span>{S.research}</span></nav>
      <div className="pagehead">
        <h2 className="ph">{S.research}</h2>
        <span className="spacer" />
        {ws.data?.exists !== false && <CopyCommand cmd={cmd} label={S.runNow} primary={false} showCmd={false} />}
      </div>
    </>
  );
  if (loading && !runs) return <>{head}<Skeleton h={160} r={12} /></>;
  if (!runs?.length) return <>{head}<Grid items={[
    { id: "empty", span: 3, node: <EmptyResearch cmd={cmd} path={workspacePath(ws.data?.path, p.slug)} ws={ws.data} onSettings={p.onSettings} /> },
  ]} /></>;

  // Research as a story: the summary sentence and the tabs, then one tab's widgets.
  const notes = notesQ.data ?? [];
  const live = (candidates ?? []).filter((n) => !n.dismissed_at && !n.candidate?.accepted_at).length;
  const items: GridItem[] = [
    { id: "story", span: 3, node: <StoryHead today={p.today} runs={runs} summary={summary} segments={seg.data} candidates={live} tab={tab} onTab={setTab} /> },
    ...(tab === "topics" ? [{ id: "st-topics", span: 3 as const, node: <TopicsTab segments={seg.data} notes={notes} symOf={p.symOf} today={p.today} onOpenTopic={p.onOpenTopic} onOpenNote={openNote} /> }]
      : tab === "mine" ? [{ id: "st-mine", span: 3 as const, node: <MineTab summary={summary} notes={notes} today={p.today} cal={cal?.events ?? []} names={p.held} onOpenAsset={p.onOpenAsset} /> }]
      : tab === "notes" ? [{ id: "notes", span: 3 as const, node: <NotesTab slug={p.slug} notes={notes} today={p.today} held={p.held} watchedIds={p.watchedIds} onOpenAsset={p.onOpenAsset} onOpenTopic={p.onOpenTopic} onChanged={refresh} /> }]
      : tab === "calendar" ? [{ id: "st-cal", span: 3 as const, node: <CalendarTab slug={p.slug} today={p.today} names={(id) => p.held.get(id)?.name ?? p.watchedIds.get(id)?.name ?? null} /> }]
      : tab === "candidates" ? [{ id: "cands", span: 3 as const, node: <CandidatesWidget slug={p.slug} today={p.today} notes={candidates ?? []} watched={p.watched} strategyVersion={p.strategyVersion} onChanged={refresh} /> }]
      : [
        { id: "runs", span: 3 as const, node: <RunsTable runs={runs} symOf={p.symOf} /> },
        { id: "scope", span: 3 as const, node: <ScopeWidget held={p.held.size} watched={p.watchedIds.size} strategyVersion={p.strategyVersion} privacy={p.privacy} path={ws.data?.path ?? `~/Documents/cashU/${p.slug}`} /> },
      ]),
  ];
  return <>{head}<Grid items={items} /></>;
}

function CandidatesWidget({ slug, today, notes, watched, strategyVersion, onChanged }: {
  slug: string; today: string; notes: ResearchNote[]; watched: (n: ResearchNote) => CandidateState | undefined; strategyVersion: number | null; onChanged: () => void;
}) {
  const actions = useResearchActions(slug, onChanged);
  const list = [...notes].sort((a, b) => (a.dismissed_at ? 1 : 0) - (b.dismissed_at ? 1 : 0) || b.observed_at.localeCompare(a.observed_at));
  return (
    <Widget title={S.candidates} count={list.filter((n) => !n.dismissed_at).length || undefined} controls={<span className="muted" style={{ fontSize: 12 }}>{S.byStrategy(strategyVersion)}</span>}
      body="tight">
      {!list.length ? <div className="muted" style={{ fontSize: 13 }}>{S.noCandidates}</div>
        : list.map((n) => <CandidateCard key={n.id} note={n} today={today} state={watched(n)} busy={actions.busy === n.id} onWatch={actions.watch} onDismiss={actions.dismiss}
          onRestore={actions.restore} canRestore={canRestore(n)} />)}
    </Widget>
  );
}

// ---- notes ----------------------------------------------------------------------------------------------

// ---- runs and scope ---------------------------------------------------------------------------------------

/** Run scope in words (RS CONTRACT: held, watchlist, candidates, segments [keys, P5], instrument_ids [explicit]). */
function scopeText(s: ResearchRun["scope"], symOf: (id: number) => string | null): string {
  if (!s || Array.isArray(s)) return Array.isArray(s) && s.length ? s.join(", ") : "-";
  const o = s as { held?: boolean; watchlist?: boolean; candidates?: boolean; segments?: string[]; instrument_ids?: number[] };
  const ids = (o.instrument_ids ?? []).map((id) => symOf(id) ?? `#${id}`);
  const parts = [o.held && S.scopePositions, o.watchlist && S.scopeWatched, o.candidates && S.scopeCandidates, o.segments?.length ? S.scopeTopics : null, ids.length ? ids.join(", ") : null].filter(Boolean);
  return parts.join(", ") || "-";
}

function RunsTable({ runs, symOf }: { runs: ResearchRun[]; symOf: (id: number) => string | null }) {
  const list = [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 12);
  return (
    <Widget title={S.runs} count={S.lastN(list.length)} body="flush tight"
      footer={<><span className="spacer" /><span>{S.routine} <b>{S.saturday}</b> · Claude Code</span></>}>
      <table>
        <thead><tr><th style={{ paddingLeft: 16 }}>{S.colDate}</th><th>{S.colStatus}</th><th>{S.colScope}</th><th className="num">{S.colNotes}</th><th className="num" title={S.colSignalsTitle}>{S.colSignals}</th><th className="num">{S.colTime}</th><th style={{ paddingRight: 16 }}>{S.colStartedBy}</th></tr></thead>
        <tbody>
          {list.map((r) => {
            const m = runMinutes(r);
            const st = r.status === "done" ? [S.finished, "pos"] : r.status === "running" ? [S.running, "info"] : [S.interrupted, "neg"];
            return (
              <tr key={r.id}>
                <td className="tnum" style={{ paddingLeft: 16 }}>{localDay(r.started_at)} {hm(r.started_at)}</td>
                <td><span className="polt" style={{ color: "var(--text)" }}><i className={`pd ${st[1] === "info" ? "" : st[1]}`} style={st[1] === "info" ? { background: "var(--info)" } : undefined} aria-hidden /> {st[0]}</span></td>
                <td>{scopeText(r.scope, symOf)}{r.scheduled === false && r.scope && !Array.isArray(r.scope) && !(r.scope as { held?: boolean }).held ? S.onDemandSuffix : ""}</td>
                <td className="num">{runNotes(r) ?? "-"}</td>
                <td className="num">{r.counts?.signals ?? "-"}</td>
                <td className="num">{m != null ? `${m} min` : "-"}</td>
                <td style={{ paddingRight: 16 }}>{r.scheduled === false || r.created_by === "user" ? S.you : S.routineBy(r.status === "failed" ? (r.reason === "interrupted" || r.interrupted ? S.interrupted : r.reason ?? S.interrupted) : "Claude Code")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Widget>
  );
}

function ScopeWidget({ held, watched, strategyVersion, privacy, path }: { held: number; watched: number; strategyVersion: number | null; privacy: string; path: string }) {
  return (
    <Widget title={S.scopeRules} body="tight">
      <div className="kvl">
        <span className="k">{S.scope}</span><span><b>{S.scopeLine(held, watched)}</b>{S.scopeRest(strategyVersion != null ? ` v${strategyVersion}` : "")}</span>
        <span className="k">{S.sources}</span><span>{S.sourcesList}</span>
        <span className="k">{S.not}</span><span>{S.notList}</span>
        <span className="k">{S.privacy}</span><span>{S.privacyLine(PRIVACY_SHORT[privacy] ?? privacy, privacy === "amounts")}</span>
        <span className="k">{S.workspace}</span><span><code className="cmd wrap">{path}</code>{S.mcpOnly}</span>
        <span className="k">{S.validity}</span><span>{S.validityLine}</span>
      </div>
    </Widget>
  );
}

// ---- never ran (research.md 7) ----------------------------------------------------------------------------

function EmptyResearch({ cmd, path, ws, onSettings }: { cmd: string; path: string; ws: Workspace | null | undefined; onSettings: () => void }) {
  const [how, setHow] = useState(false);
  const noWs = ws?.exists === false;
  const skill = ws?.skill_installed ?? null;
  const steps: SetupStepItem[] = [
    noWs ? {
      key: "ws", status: "on", title: <span>{S.createWorkspace}</span>,
      actions: <button className="btn primary" onClick={onSettings}>{S.settings}</button>,
    } : {
      key: "skill", status: skill === true ? "done" : "on",
      title: <span>{S.skill} <b>market-research</b> {skill === true ? S.installed : skill === false ? S.toInstall : S.inWorkspace}</span>,
      hint: skill === true ? <>{S.inWorkspaceAt} <code>{path}</code></> : <>{S.updateWorkspace} <code>cashu workspace update</code>)</>,
      tag: ws?.skill_installed_at ? <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{dm(ws.skill_installed_at)}</span> : undefined,
      actions: skill === true ? undefined : <button className="btn" onClick={onSettings}>{S.settings}</button>,
    },
    {
      key: "run", status: noWs ? "todo" : "on", title: S.firstRun,
      hint: S.about30,
      actions: noWs ? undefined : <CopyCommand cmd={cmd} label={S.copy} />,
    },
    {
      key: "schedule", status: "todo", title: S.scheduleSaturdays,
      hint: how ? undefined : <>{S.saturday} · <code>{ROUTINE_PROMPT}</code></>,
      actions: <button className="btn" onClick={() => setHow((v) => !v)} aria-expanded={how}>{S.howToSchedule}</button>,
      body: how ? <div style={{ margin: "6px 0" }}><ScheduleHow path={path} onSettings={onSettings} /></div> : undefined,
    },
  ];
  return (
    <Widget title={S.research} tags={<Tag>{S.neverRan}</Tag>} body="tight" className="rsch-empty">
      <div className="lead">{S.lead}</div>
      <div className="d">{S.noRecommendations}</div>
      <SetupSteps steps={steps} />
    </Widget>
  );
}
