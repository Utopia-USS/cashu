// The research page (ab24ab6 v2/research/Page.tsx ResearchPage + the Story.tsx page parts StoryHead, TopicsTab,
// MineTab, NotesTab, CalendarTab and the Page's CandidatesWidget, RunsTable, ScopeWidget, EmptyResearch): every
// string and list the pure ResearchPageView renders. The logic is ui-logic's verbatim port (research/logic,
// storyLogic, macro, segments); only the old components' formatting and derivations live here.
import { PRIVACY_SHORT, S } from "@cashu/i18n/investments/v2/research/Page.strings";
import { S as P } from "@cashu/i18n/investments/v2/research/primitives.strings";
import { MOOD, REL, S as T } from "@cashu/i18n/investments/v2/research/Story.strings";
import type { CandidateCardProps } from "@cashu/ui";
import { localDay } from "@cashu/ui-logic/core/time";
import { dm, hm, micName, pp, wdm } from "@cashu/ui-logic/investments/labels";
import { instMono } from "@cashu/ui-logic/investments/v2/logic";
import {
  acceptedAt,
  candidateCriteria,
  candidateReturn,
  criterionText,
  entryTypeLabel,
  HEALTH_LABEL,
  healthOf,
  isRestorable,
  KIND_LABEL,
  latestRun,
  nextSaturday,
  normRelation,
  noteSubject,
  ROUTINE_PROMPT,
  researchCommand,
  runMinutes,
  runNotes,
  safeUrl,
  watchItemId,
  workspacePath,
} from "@cashu/ui-logic/investments/v2/research/logic";
import { S as L } from "@cashu/ui-logic/investments/v2/research/logic.strings";
import { isMacroKey, macroLabel } from "@cashu/ui-logic/investments/v2/research/macro";
import {
  canonKey,
  isSegment,
  segmentLabel,
} from "@cashu/ui-logic/investments/v2/research/segments";
import {
  aheadEvents,
  dayBucket,
  MOOD_TONE,
  noteHeadline,
  storyTopics,
  thesisMoves,
} from "@cashu/ui-logic/investments/v2/research/storyLogic";
import type {
  ResearchNote,
  ResearchRun,
  ResearchSummary,
  SegmentAttribution,
  Workspace,
} from "@cashu/ui-logic/investments/v2/research/types";
import type { CalendarEvent } from "@cashu/ui-logic/investments/v2/types";
import {
  aheadDayRows,
  aheadSay,
  type StoryAheadDay,
  type StoryTone,
  type StoryTopicRow,
  topicMap,
  valuationView,
} from "../investments/home/research/researchStripModel.js";
import { S as R } from "./Research.strings.js";

export type StoryTab = "topics" | "mine" | "notes" | "calendar" | "candidates" | "runs";
const STORY_TABS: readonly StoryTab[] = [
  "topics",
  "mine",
  "notes",
  "calendar",
  "candidates",
  "runs",
];
export type NoteFilter = "all" | "thesis" | "earnings" | "news";

/** The old `?tab=` (and `?scope=candidates`) of the page link; else Tematy. */
export const initialTab = (tab: string | null | undefined): StoryTab =>
  STORY_TABS.find((t) => t === tab) ?? (tab === "scope=candidates" ? "candidates" : "topics");

interface Named {
  name: string;
  symbol: string | null;
}
/** Old research/index.tsx `watched(n)`: since when the candidate is watched, or the agent added it. */
export interface CandidateWatch {
  watchedSince?: string | null;
  agent?: boolean;
}

export interface ResearchPageInput {
  slug: string;
  today: string;
  /** Epoch ms (the restore window of a dismissed candidate). */
  now: number;
  /** The profile's MCP privacy level (`strict` / `amounts`). */
  privacy: string;
  /** The app's privacy mode: the research text stays hidden (native rule, data safety over parity). */
  hidden: boolean;
  runs: ResearchRun[];
  summary: ResearchSummary | null;
  /** Candidate notes, dismissed ones included. */
  candidates: ResearchNote[];
  /** Every live note (dismissed and expired left out). */
  notes: ResearchNote[];
  segments: SegmentAttribution | null;
  calendar: { events: CalendarEvent[]; stale: boolean } | null;
  calendarError: boolean;
  workspace: Workspace | null;
  strategyVersion: number | null;
  held: Map<number, Named>;
  watchedIds: Map<number, Named>;
  watched(n: ResearchNote): CandidateWatch | undefined;
  symOf(id: number): string | null;
}

export interface ResearchPageUi {
  tab: StoryTab;
  onTab(tab: StoryTab): void;
  filter: NoteFilter;
  onFilter(filter: NoteFilter): void;
  openNote: number | null;
  onToggleNote(id: number): void;
  shown: number;
  onMore(): void;
  how: boolean;
  onHow(): void;
  busy: number | null;
  onBack(): void;
  onOpenAsset(id: number, noteId?: number): void;
  onOpenTopic(key: string): void;
  onSettings(): void;
  /** Copy a command and confirm with `done`. */
  onCopy(command: string, done: string): void;
  onWatch(n: ResearchNote): void;
  onDismiss(n: ResearchNote): void;
  onRestore(n: ResearchNote): void;
}

export interface CopyModel {
  command: string;
  label: string;
  primary: boolean;
  showCommand: boolean;
  size: "sm" | "md";
  title?: string;
  onCopy(): void;
}

const copy = (
  ui: ResearchPageUi,
  command: string,
  label: string,
  o: { primary?: boolean; showCommand?: boolean; sm?: boolean; done?: string; title?: string } = {},
): CopyModel => ({
  command,
  label,
  primary: o.primary ?? true,
  showCommand: o.showCommand ?? true,
  size: o.sm ? "sm" : "md",
  title: o.title,
  onCopy: () => ui.onCopy(command, o.done ?? P.copiedPaste),
});

/** Old ScheduleHow: the local routine in the Claude app, in the profile's workspace folder. */
export interface ScheduleModel {
  /** `Rutyna w aplikacji Claude` (bold) before the schedule sentence. */
  menu: string;
  path: string;
  routine: CopyModel;
  folder: CopyModel;
  onSettings(): void;
}

interface EmptyStep {
  key: string;
  status: "done" | "on" | "todo";
  title:
    | { kind: "text"; text: string }
    | { kind: "skill"; state: string; skill: string; label: string };
  hint:
    | { kind: "text"; text: string }
    | { kind: "code"; before: string; code: string; after?: string }
    | null;
  tag: string | null;
  action:
    | { kind: "settings"; primary: boolean }
    | { kind: "copy"; copy: CopyModel }
    | { kind: "how"; open: boolean }
    | null;
}

export interface EmptyModel {
  steps: EmptyStep[];
  schedule: ScheduleModel | null;
}

export interface StoryHeadModel {
  story: string;
  sents: { text: string; tone: "neg" | "pos" | "info" | "" }[];
  next: string;
  tabs: { key: StoryTab; label: string; selected: boolean }[];
}

interface TopicCard {
  key: string;
  mood: { word: string; tone: StoryTone };
  label: string;
  draft: string | null;
  impact: string;
  headline: string;
  onOpen(): void;
  outlook: Pick<StoryTopicRow, "now" | "outlook" | "valuation">;
  notes: { id: number; text: string; onOpen(): void }[];
  tickers: string | null;
}

interface MineRow {
  id: number;
  name: string;
  symbol: string;
  health: { text: string; tone: "neg" | "pos" | "calm" };
  line: string;
  onOpen(): void;
  soon: string | null;
}

interface NoteItem {
  id: number;
  /** `Dzisiaj` etc. when the day changes before this note. */
  dayHead: string | null;
  dot: "pos" | "neg" | "";
  headline: string;
  open: boolean;
  onToggle(): void;
  meta: string;
  rel: { text: string; tone: "pos" | "neg" } | null;
  full: {
    tech: string | null;
    paragraphs: string[];
    sources: { href: string | null; text: string }[];
    onOpen: (() => void) | null;
  } | null;
  dismissLabel: string;
  busy: boolean;
  onDismiss(): void;
}

interface RunRow {
  id: number;
  date: string;
  status: { text: string; tone: "pos" | "info" | "neg" };
  scope: string;
  notes: string;
  signals: string;
  time: string;
  by: string;
}

export type TabModel =
  | { kind: "topics"; cards: TopicCard[]; quiet: string | null }
  | { kind: "mine"; rows: MineRow[] }
  | {
      kind: "notes";
      count: number;
      filters: { key: NoteFilter; label: string; pressed: boolean; onPress(): void }[];
      empty: boolean;
      items: NoteItem[];
      more: string | null;
      onMore(): void;
    }
  | { kind: "calendar"; say: string; days: StoryAheadDay[]; stale: boolean }
  | { kind: "candidates"; count: number | undefined; by: string; cards: CandidateCardProps[] }
  | {
      kind: "runs";
      count: string;
      rows: RunRow[];
      scope: {
        line: string;
        rest: string;
        privacy: string;
        path: string;
      };
    };

export interface ResearchPageModel {
  /** `Uruchom teraz` (copies the command); null while the workspace is known to be missing. */
  runNow: CopyModel | null;
  body:
    | { kind: "empty"; empty: EmptyModel }
    | { kind: "story"; head: StoryHeadModel; tab: TabModel }
    | { kind: "hidden"; text: string };
}

const relOf = (n: ResearchNote): { text: string; tone: "pos" | "neg" } | null => {
  const r = normRelation(n.thesis_relation);
  const key =
    r === "supports" || r === "weakens" || r === "invalidates" || r === "fulfills" ? r : null;
  return key
    ? { text: REL[key], tone: key === "weakens" || key === "invalidates" ? "neg" : "pos" }
    : null;
};

function emptyModel(p: ResearchPageInput, ui: ResearchPageUi, cmd: string): EmptyModel {
  const ws = p.workspace;
  const path = workspacePath(ws?.path, p.slug);
  const noWs = ws?.exists === false;
  const skill = ws?.skill_installed ?? null;
  const steps: EmptyStep[] = [
    noWs
      ? {
          key: "ws",
          status: "on",
          title: { kind: "text", text: S.createWorkspace },
          hint: null,
          tag: null,
          action: { kind: "settings", primary: true },
        }
      : {
          key: "skill",
          status: skill === true ? "done" : "on",
          title: {
            kind: "skill",
            label: S.skill,
            skill: "market-research",
            state: skill === true ? S.installed : skill === false ? S.toInstall : S.inWorkspace,
          },
          hint:
            skill === true
              ? { kind: "code", before: S.inWorkspaceAt, code: path }
              : {
                  kind: "code",
                  before: S.updateWorkspace,
                  code: "cashu workspace update",
                  after: ")",
                },
          tag: ws?.skill_installed_at ? dm(ws.skill_installed_at) : null,
          action: skill === true ? null : { kind: "settings", primary: false },
        },
    {
      key: "run",
      status: noWs ? "todo" : "on",
      title: { kind: "text", text: S.firstRun },
      hint: { kind: "text", text: S.about30 },
      tag: null,
      action: noWs ? null : { kind: "copy", copy: copy(ui, cmd, S.copy) },
    },
    {
      key: "schedule",
      status: "todo",
      title: { kind: "text", text: S.scheduleSaturdays },
      hint: ui.how ? null : { kind: "code", before: `${S.saturday} · `, code: ROUTINE_PROMPT },
      tag: null,
      action: { kind: "how", open: ui.how },
    },
  ];
  return {
    steps,
    schedule: ui.how
      ? {
          menu: L.routineMenu,
          path,
          routine: copy(ui, ROUTINE_PROMPT, P.copyRoutine, {
            primary: false,
            showCommand: false,
            sm: true,
            done: P.copiedPasteApp,
            title: P.localRoutineTitle,
          }),
          folder: copy(ui, path, P.copyFolder, {
            primary: false,
            showCommand: false,
            sm: true,
            done: P.copied,
          }),
          onSettings: ui.onSettings,
        }
      : null,
  };
}

function headModel(p: ResearchPageInput, ui: ResearchPageUi): StoryHeadModel {
  const last = latestRun(p.runs);
  const held = (p.summary?.instruments ?? []).filter((i) => i.held).length;
  const rows = p.segments?.segments ?? [];
  const top = [...rows]
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 2)
    .map((s) => s.label);
  const { weak, strong } = thesisMoves(p.summary, p.today);
  const signals = p.summary?.totals?.signals_open ?? 0;
  const candidates = p.candidates.filter(
    (n) => !n.dismissed_at && !n.candidate?.accepted_at,
  ).length;
  const labels: Record<StoryTab, string> = {
    topics: T.tabTopics,
    mine: T.tabMine,
    notes: T.tabNotes,
    calendar: T.tabCalendar,
    candidates: T.tabCandidates,
    runs: T.tabRuns,
  };
  return {
    story:
      (last ? T.story(wdm(last.started_at), held, rows.length) : "") +
      (top.length ? T.storyTop(top.join(", ")) : ""),
    sents: [
      ...(weak.length ? [{ text: T.sentWeak(weak.length), tone: "neg" as const }] : []),
      ...(strong.length ? [{ text: T.sentStrong(strong.length), tone: "pos" as const }] : []),
      ...(candidates > 0 ? [{ text: T.sentCands(candidates), tone: "info" as const }] : []),
      { text: signals ? T.sentSignals(signals) : T.sentNothing, tone: "" as const },
    ],
    next: T.nextRun(wdm(nextSaturday(p.today))),
    tabs: STORY_TABS.map((key) => ({ key, label: labels[key], selected: ui.tab === key })),
  };
}

/** Old Page openNote: the asset at the note, a topic / macro note's drawer, else the Notatki tab. */
const noteOpener = (ui: ResearchPageUi) => (n: ResearchNote) => {
  if (n.instrument_id != null) ui.onOpenAsset(n.instrument_id, n.id);
  else if (n.segment && (isMacroKey(n.segment) || isSegment(n.segment)))
    ui.onOpenTopic(isMacroKey(n.segment) ? n.segment : (canonKey(n.segment) ?? n.segment));
  else ui.onTab("notes");
};

function topicsTab(p: ResearchPageInput, ui: ResearchPageUi): TabModel {
  const recent = p.notes.filter((n) => dayBucket(n.observed_at, p.today) <= 2);
  const { topics, quiet } = storyTopics(p.segments, recent, p.symOf);
  const open = noteOpener(ui);
  return {
    kind: "topics",
    quiet: quiet.length ? T.quiet(quiet.join(", ")) : null,
    cards: topics.map((t) => ({
      key: t.key,
      mood: { word: MOOD[t.mood], tone: MOOD_TONE[t.mood] },
      label: t.label,
      draft: t.draft ? T.draft : null,
      impact: t.impact != null ? pp(t.impact * 100) : T.watchedTopic,
      headline: t.headline,
      onOpen: () => ui.onOpenTopic(t.key),
      outlook: {
        now: t.now,
        outlook: t.outlook,
        valuation: t.valuation ? valuationView(t.valuation) : null,
      },
      notes: t.notes.map((n) => ({ id: n.id, text: noteHeadline(n), onOpen: () => open(n) })),
      tickers: t.tickers.length ? t.tickers.slice(0, 10).join(" · ") : null,
    })),
  };
}

const RANK: Record<string, number> = { inv: 0, weak: 1, ful: 2, sup: 3 };

function mineTab(p: ResearchPageInput, ui: ResearchPageUi): TabModel {
  const byId = new Map(p.notes.map((n) => [n.id, n]));
  const soon = new Map<number, string>();
  for (const e of p.calendar?.events ?? [])
    if (e.kind === "earnings" && e.instrument_id != null && !soon.has(e.instrument_id))
      soon.set(e.instrument_id, wdm(e.date));
  const rows = (p.summary?.instruments ?? [])
    .filter((i) => i.held)
    .map((i) => ({ i, h: healthOf(i, p.today) }))
    .sort((a, b) => (RANK[a.h] ?? 9) - (RANK[b.h] ?? 9));
  return {
    kind: "mine",
    rows: rows.map(({ i, h }) => {
      const n = i.latest_note?.id != null ? byId.get(i.latest_note.id) : undefined;
      const known = p.held.get(i.instrument_id);
      const s = soon.get(i.instrument_id);
      return {
        id: i.instrument_id,
        name: known?.name ?? i.instrument?.name ?? i.label ?? `#${i.instrument_id}`,
        symbol: known?.symbol ?? i.instrument?.symbol ?? "",
        health: {
          text: T.thesis(HEALTH_LABEL[h]),
          tone: h === "inv" || h === "weak" ? "neg" : h === "sup" || h === "ful" ? "pos" : "calm",
        },
        line: n ? noteHeadline(n) : (i.latest_note?.title ?? T.nothingNew),
        onOpen: () => ui.onOpenAsset(i.instrument_id, i.latest_note?.id ?? undefined),
        soon: s ? T.earningsOn(s) : null,
      };
    }),
  };
}

function notesTab(p: ResearchPageInput, ui: ResearchPageUi): TabModel {
  const f = ui.filter;
  const list = p.notes
    .filter((n) => !n.dismissed_at && n.kind !== "candidate")
    .filter(
      (n) =>
        f === "all" ||
        (f === "thesis"
          ? relOf(n) != null
          : f === "earnings"
            ? n.kind === "earnings"
            : n.kind === "news"),
    )
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at));
  const named = (id: number) => p.held.get(id) ?? p.watchedIds.get(id);
  const who = (n: ResearchNote) => {
    const id = n.instrument_id;
    if (id != null) return named(id)?.name ?? n.instrument?.name ?? n.instrument?.label ?? `#${id}`;
    if (n.segment)
      return isMacroKey(n.segment)
        ? macroLabel(n.segment)
        : (n.segment_label ?? segmentLabel(n.segment));
    return n.theme ?? T.market;
  };
  const symOfNote = (n: ResearchNote) =>
    n.instrument_id != null
      ? (named(n.instrument_id)?.symbol ?? n.instrument?.symbol ?? null)
      : null;
  const target = (n: ResearchNote): (() => void) | null => {
    const id = n.instrument_id;
    if (id != null && (p.held.has(id) || p.watchedIds.has(id)))
      return () => ui.onOpenAsset(id, n.id);
    const seg = n.segment;
    if (seg && (isMacroKey(seg) || isSegment(seg)))
      return () => ui.onOpenTopic(isMacroKey(seg) ? seg : (canonKey(seg) ?? seg));
    return null;
  };
  const filters: [NoteFilter, string][] = [
    ["all", T.fAll],
    ["thesis", T.fThesis],
    ["earnings", T.fEarnings],
    ["news", T.fNews],
  ];
  let lastDay = -1;
  const items = list.slice(0, ui.shown).map((n): NoteItem => {
    const b = dayBucket(n.observed_at, p.today);
    const dayHead = b !== lastDay ? (T.day(b) ?? null) : null;
    lastDay = b;
    const rel = relOf(n);
    const sym = symOfNote(n);
    const open = ui.openNote === n.id;
    const headline = noteHeadline(n);
    return {
      id: n.id,
      dayHead,
      dot: rel?.tone ?? "",
      headline,
      open,
      onToggle: () => ui.onToggleNote(n.id),
      meta: `${who(n)}${sym ? ` (${sym})` : ""} · ${KIND_LABEL[n.kind] ?? n.kind}`,
      rel,
      full: open
        ? {
            tech: headline !== n.title ? n.title : null,
            paragraphs: n.summary.split(/\n{2,}/),
            sources: n.sources.map((s) => ({
              href: safeUrl(s.url),
              text: s.publisher ?? s.title ?? s.url ?? "",
            })),
            onOpen: target(n),
          }
        : null,
      dismissLabel: T.dismiss(n.title),
      busy: ui.busy === n.id,
      onDismiss: () => ui.onDismiss(n),
    };
  });
  return {
    kind: "notes",
    count: list.length,
    filters: filters.map(([key, label]) => ({
      key,
      label,
      pressed: f === key,
      onPress: () => ui.onFilter(key),
    })),
    empty: items.length === 0,
    items,
    more: list.length > ui.shown ? T.showMore(Math.min(15, list.length - ui.shown)) : null,
    onMore: ui.onMore,
  };
}

function calendarTab(p: ResearchPageInput): TabModel {
  const all = p.calendar?.events ?? [];
  const events = aheadEvents(all, p.today, 14, 60);
  const names = (id: number) => p.held.get(id)?.name ?? p.watchedIds.get(id)?.name ?? null;
  return {
    kind: "calendar",
    say: events.length ? aheadSay(aheadEvents(all, p.today, 7)) : T.calendarNone,
    days: aheadDayRows(
      events,
      topicMap(p.segments),
      (e) => (e.instrument_id != null ? names(e.instrument_id) : null) ?? e.label ?? e.title,
    ),
    stale: !!p.calendar?.stale || p.calendarError,
  };
}

/** Old CandidateCard (full): the note as packages/ui CandidateCard props. */
function candidateCard(
  n: ResearchNote,
  o: {
    today: string;
    now: number;
    state: CandidateWatch | undefined;
    busy: boolean;
    onWatch(): void;
    onDismiss(): void;
    onRestore(): void;
  },
): CandidateCardProps {
  const { name, sym } = noteSubject(n);
  const crit = candidateCriteria(n);
  const entry = entryTypeLabel(
    typeof n.details?.entry_type === "string" ? n.details.entry_type : null,
  );
  const back = n.cooldown_until ?? (n.dismissed_at ? candidateReturn(n.dismissed_at) : null);
  const context = typeof n.details?.context === "string" ? n.details.context : null;
  const symbol = n.instrument?.symbol ?? n.candidate?.symbol ?? null;
  const watched = o.state?.watchedSince != null || !!acceptedAt(n) || watchItemId(n) != null;
  return {
    id: n.id,
    name,
    monogram: instMono({ label: name, symbol, name }),
    sub: micName(n.instrument?.mic ?? n.candidate?.exchange) ?? (sym && !symbol ? sym : undefined),
    entry,
    criteria: crit.items.map((c) => ({
      text: criterionText(c),
      met: c.met,
      mark: c.met ? P.met : P.notMet,
    })),
    context,
    title: n.title,
    dismissed: n.dismissed_at
      ? {
          tag: P.candDismissedOn(dm(n.dismissed_at)),
          line: `${n.title}${context ? ` · ${context}` : ""}${back ? P.returnsEarliest(dm(back)) : ""}`,
          restore: isRestorable(n, o.now) ? { label: P.restore, onPress: o.onRestore } : undefined,
        }
      : null,
    state: o.state?.agent
      ? { kind: "agent", label: P.addedByAgent }
      : watched
        ? {
            kind: "watched",
            label: P.watchedSince(dm(o.state?.watchedSince ?? acceptedAt(n) ?? o.today)),
          }
        : {
            kind: "open",
            busy: o.busy,
            watch: { label: P.watch, title: P.watchTitle, onPress: o.onWatch },
            dismiss: { label: P.dismissBtn, title: P.dismissTitle, onPress: o.onDismiss },
          },
    sources: P.srcLine(n.sources.length, dm(n.observed_at)),
  };
}

function candidatesTab(p: ResearchPageInput, ui: ResearchPageUi): TabModel {
  const list = [...p.candidates].sort(
    (a, b) =>
      (a.dismissed_at ? 1 : 0) - (b.dismissed_at ? 1 : 0) ||
      b.observed_at.localeCompare(a.observed_at),
  );
  return {
    kind: "candidates",
    count: list.filter((n) => !n.dismissed_at).length || undefined,
    by: S.byStrategy(p.strategyVersion),
    cards: list.map((n) =>
      candidateCard(n, {
        today: p.today,
        now: p.now,
        state: p.watched(n),
        busy: ui.busy === n.id,
        onWatch: () => ui.onWatch(n),
        onDismiss: () => ui.onDismiss(n),
        onRestore: () => ui.onRestore(n),
      }),
    ),
  };
}

/** Run scope in words (held, watchlist, candidates, segments, explicit instrument ids). */
function scopeText(s: ResearchRun["scope"], symOf: (id: number) => string | null): string {
  if (!s || Array.isArray(s)) return Array.isArray(s) && s.length ? s.join(", ") : "-";
  const o = s as {
    held?: boolean;
    watchlist?: boolean;
    candidates?: boolean;
    segments?: string[];
    instrument_ids?: number[];
  };
  const ids = (o.instrument_ids ?? []).map((id) => symOf(id) ?? `#${id}`);
  const parts = [
    o.held && S.scopePositions,
    o.watchlist && S.scopeWatched,
    o.candidates && S.scopeCandidates,
    o.segments?.length ? S.scopeTopics : null,
    ids.length ? ids.join(", ") : null,
  ].filter(Boolean);
  return parts.join(", ") || "-";
}

function runsTab(p: ResearchPageInput): TabModel {
  const list = [...p.runs].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 12);
  return {
    kind: "runs",
    count: S.lastN(list.length),
    rows: list.map((r) => {
      const m = runMinutes(r);
      const scope = r.scope as ResearchRun["scope"] & { held?: boolean };
      const onDemand = r.scheduled === false && !!r.scope && !Array.isArray(r.scope) && !scope.held;
      return {
        id: r.id,
        date: `${localDay(r.started_at)} ${hm(r.started_at)}`,
        status:
          r.status === "done"
            ? { text: S.finished, tone: "pos" }
            : r.status === "running"
              ? { text: S.running, tone: "info" }
              : { text: S.interrupted, tone: "neg" },
        scope: scopeText(r.scope, p.symOf) + (onDemand ? S.onDemandSuffix : ""),
        notes: String(runNotes(r) ?? "-"),
        signals: String(r.counts?.signals ?? "-"),
        time: m != null ? `${m} min` : "-",
        by:
          r.scheduled === false || r.created_by === "user"
            ? S.you
            : S.routineBy(
                r.status === "failed"
                  ? r.reason === "interrupted" || r.interrupted
                    ? S.interrupted
                    : (r.reason ?? S.interrupted)
                  : "Claude Code",
              ),
      };
    }),
    scope: {
      line: S.scopeLine(p.held.size, p.watchedIds.size),
      rest: S.scopeRest(p.strategyVersion != null ? ` v${p.strategyVersion}` : ""),
      privacy: S.privacyLine(
        (PRIVACY_SHORT as Record<string, string>)[p.privacy] ?? p.privacy,
        p.privacy === "amounts",
      ),
      path: p.workspace?.path ?? `~/cashU/${p.slug}`,
    },
  };
}

export function researchPageModel(p: ResearchPageInput, ui: ResearchPageUi): ResearchPageModel {
  const cmd = researchCommand(p.workspace?.path, p.slug);
  if (p.hidden && p.runs.length) return { runNow: null, body: { kind: "hidden", text: R.hidden } };
  const runNow =
    !p.hidden && p.workspace?.exists !== false
      ? copy(ui, cmd, S.runNow, { primary: false, showCommand: false })
      : null;
  if (!p.runs.length) return { runNow, body: { kind: "empty", empty: emptyModel(p, ui, cmd) } };
  const tab =
    ui.tab === "topics"
      ? topicsTab(p, ui)
      : ui.tab === "mine"
        ? mineTab(p, ui)
        : ui.tab === "notes"
          ? notesTab(p, ui)
          : ui.tab === "calendar"
            ? calendarTab(p)
            : ui.tab === "candidates"
              ? candidatesTab(p, ui)
              : runsTab(p);
  return { runNow, body: { kind: "story", head: headModel(p, ui), tab } };
}
