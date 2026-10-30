// Research as a story (storyLogic.ts has the logic): the plain headline first, the figures and sources one level
// deeper. The home strip (`ResearchStory`): one sentence on the market, the macro regimes as chips (a click
// explains), what is coming up (the owner's earnings, central banks), the theses that lost ground and one line per
// topic (mood word + headline; a click opens Teraz / Perspektywa and the notes). The research page (`StoryHead` +
// the tabs): a summary sentence, then Tematy, Twoje spółki, Notatki, Kalendarz.
import { useMemo, useState } from "react";
import { useAsync } from "../../../../hooks";
import { Widget } from "../../../../widgets";
import { dm, pct, pp, wdm } from "../../labels";
import { intlLocale } from "../../../../i18n";
import { type CalendarEvent, getCalendar, invKey } from "../api";
import { getResearch } from "./api";
import { useMacro, useResearchActions, useSegments } from "./data";
import { HEALTH_LABEL, healthOf, KIND_LABEL, latestRun, nextSaturday, normRelation } from "./logic";
import { isMacroKey, macroLabel } from "./macro";
import { canonKey, isSegment, segmentLabel } from "./segments";
import type { StripCtx } from "./Strip";
import type { ResearchNote, ResearchRun, ResearchSummary, SegmentAttribution, Valuation } from "./types";
import { aheadDays, aheadEvents, dayBucket, valuationOf, MOOD_TONE, noteHeadline, type StoryTopic, storyTopics, thesisMoves } from "./storyLogic";
import { MOOD, REL, S } from "./Story.strings.ts";
import "./story.css";

const relOf = (n: ResearchNote) => {
  const r = normRelation(n.thesis_relation);
  const key = r === "supports" ? "supports" : r === "weakens" ? "weakens" : r === "invalidates" ? "invalidates" : r === "fulfills" ? "fulfills" : null;
  return key ? { text: REL[key], tone: key === "weakens" || key === "invalidates" ? "neg" : "pos" } : null;
};

function Mood({ t }: { t: StoryTopic }) {
  return <span className={`st-mood ${MOOD_TONE[t.mood]}`}>{MOOD[t.mood]}</span>;
}

/** The coming events, one row per day: the companies by topic (own positions in bold), then the market. */
function AheadDays({ events, topicOf, nameOf, maxDays }: {
  events: CalendarEvent[]; topicOf: (id: number) => string | null; nameOf: (e: CalendarEvent) => string; maxDays?: number;
}) {
  const days = aheadDays(events, topicOf, nameOf).slice(0, maxDays ?? 99);
  return (
    <div className="st-days">
      {days.map((d) => (
        <div key={d.date} className="st-dayrow">
          <span className="st-dd"><b>{dm(d.date)}</b> {wdm(d.date).split(" ")[0]}</span>
          <div className="st-dg">
            {d.groups.map((g, k) => {
              const earn = g.items.filter((i) => i.earnings), other = g.items.filter((i) => !i.earnings);
              return (
                <div key={k} className="st-dgrp">
                  <span className="st-dtp">{g.topic ?? S.otherTopic}</span>
                  {earn.length > 0 && <span>{S.results}: {earn.map((i, j) => <span key={j}>{j ? ", " : ""}<span className={i.mine ? "st-dmine" : "muted"}>{i.name}</span></span>)}</span>}
                  {other.map((i, j) => <span key={`o${j}`}>{earn.length || j ? " · " : ""}<span className={i.mine ? "st-dmine" : ""}>{i.title ? `${i.name}: ${i.title}` : i.name}</span></span>)}
                </div>
              );
            })}
            {d.market.length > 0 && <div className="st-dgrp st-dmk"><span className="st-dtp">{S.marketTopic}</span>{d.market.join(", ")}</div>}
          </div>
          <span className="st-dr">{d.mine ? S.yoursN(d.mine) : ""}</span>
        </div>
      ))}
    </div>
  );
}

/** Instrument id -> its topic's label, from the segment attribution (held and watched members). */
function topicMap(att: SegmentAttribution | null | undefined): (id: number) => string | null {
  const m = new Map<number, string>();
  for (const s of att?.segments ?? []) {
    for (const i of s.instruments) m.set(i.instrument_id, s.label);
    for (const i of s.member_instruments ?? []) if (!m.has(i.instrument_id)) m.set(i.instrument_id, s.label);
  }
  return (id) => m.get(id) ?? null;
}

const aheadSay = (events: CalendarEvent[]) => {
  const mine = events.filter((e) => e.kind === "earnings" && e.held === true).length;
  return !events.length ? S.aheadQuiet : mine ? S.aheadMine(mine) : S.aheadNoneMine;
};

/** The notes of the last 7 days (the topics' lines) and the calendar, shared by the strip and the page. */
function useWeek(slug: string, today: string, nonce = 0) {
  const since = useMemo(() => new Date(Date.parse(`${today}T12:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10), [today]);
  const notes = useAsync(() => getResearch(slug, { since }), [slug, since, nonce], { key: invKey(slug, "research", "week", since) });
  const cal = useAsync(() => getCalendar(slug, 14), [slug], { key: invKey(slug, "calendar") });
  return { notes: notes.data ?? [], cal: cal.data, calError: cal.error };
}

// ---- the home strip ------------------------------------------------------------------------------------------

export function ResearchStory({ ctx, summary, runs }: { ctx: StripCtx; summary: ResearchSummary | null | undefined; runs: ResearchRun[] }) {
  const macro = useMacro(ctx.slug, ctx.nonce ?? 0);
  const seg = useSegments(ctx.slug, "1w", ctx.nonce ?? 0);
  const week = useWeek(ctx.slug, ctx.today, ctx.nonce ?? 0);
  const [openMacro, setOpenMacro] = useState<string | null>(null);
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const symOf = ctx.symOf;
  const { topics, quiet } = useMemo(() => storyTopics(seg.data, week.notes, symOf), [seg.data, week.notes, symOf]);
  const { weak } = thesisMoves(summary, ctx.today);
  const regimes = macro.data?.regimes ?? [];
  const risk = regimes.find((r) => r.key === "risk");
  const lead = risk?.brief?.headline ?? risk?.summary ?? null;
  const events = aheadEvents(week.cal?.events ?? [], ctx.today, 7);
  const drafts = topics.filter((t) => t.draft).length;
  const last = latestRun(runs);
  const opened = regimes.find((r) => r.key === openMacro);
  const nameOf = (i: { instrument_id: number; instrument?: { name?: string | null; label?: string | null } | null; label?: string | null }) =>
    ctx.held.get(i.instrument_id)?.name ?? i.instrument?.name ?? i.label ?? i.instrument?.label ?? `#${i.instrument_id}`;
  const openNote = (n: ResearchNote) => (n.instrument_id != null ? ctx.onOpenAsset(n.instrument_id, n.id) : n.segment ? ctx.onOpenTopic(isMacroKey(n.segment) ? n.segment : canonKey(n.segment) ?? n.segment) : ctx.onOpenResearch("tab=notes"));
  return (
    <Widget title={S.research} id="inv-research" className="st" count={last ? wdm(last.started_at) : undefined} body="tight"
      controls={<button className="lnk" onClick={() => ctx.onOpenResearch()}>{S.all(summary?.totals?.notes_active ?? week.notes.length)}</button>}>
      <div className="st-home">
        <div className="st-left">
          {lead && <p className="st-lead">{lead}</p>}
          <div className="st-chips" role="group" aria-label="Makro">
            {regimes.map((r) => {
              const fresh = r.since && dayBucket(r.since, ctx.today) <= 2;
              return (
                <button key={r.key} className="st-mchip" data-macro={r.key} aria-expanded={openMacro === r.key} onClick={() => setOpenMacro(openMacro === r.key ? null : r.key)}>
                  <span className={`st-mood ${r.tone === "pos" ? "pos" : r.tone === "neg" ? "neg" : r.tone === "warn" ? "warn" : "calm"}`}>{r.state_label}</span>
                  <b>{r.label}</b>{fresh && <span className="new">{S.newTag}</span>}
                </button>
              );
            })}
          </div>
          {opened && (
            <div className="st-mexp">
              {opened.brief ? <><b>{opened.brief.headline}.</b> {opened.brief.why}</> : opened.summary ?? opened.plain}
              {" "}<button className="lnk" onClick={() => ctx.onOpenTopic(`macro_${opened.key}`)}>{S.more}</button>
            </div>
          )}
          <div className="st-ahead">
            <h4>{S.ahead}</h4>
            <div className="st-say">{aheadSay(events)}</div>
            <AheadDays events={events} topicOf={topicMap(seg.data)} maxDays={5}
              nameOf={(e) => (e.instrument_id != null ? ctx.held.get(e.instrument_id)?.name ?? ctx.nameOf?.(e.instrument_id) : null) ?? e.label ?? e.title} />
          </div>
        </div>
        <div className="st-right">
          {weak.length > 0 && (
            <div className="st-alert">
              <div className="x"><b>{S.lostGround(weak.length)}</b> <span>{weak.map(nameOf).join(", ")}</span></div>
              <button className="btn" onClick={() => ctx.onOpenResearch("tab=mine")}>{S.review}</button>
            </div>
          )}
          <h4>{S.topicsWeek}</h4>
          <div className="st-topics">
            {topics.map((t) => (
              <div key={t.key}>
                <button className="st-trow" data-topic={t.key} aria-expanded={openTopic === t.key} onClick={() => setOpenTopic(openTopic === t.key ? null : t.key)}>
                  <span className="nm">{t.label}</span>
                  <span className="hl"><Mood t={t} />{t.headline}</span>
                  <span className="imp">{t.impact != null ? pp(t.impact * 100) : S.watchedTopic}</span>
                </button>
                {openTopic === t.key && (
                  <div className="st-texp">
                    <NowOutlook t={t} />
                    {t.notes.map((n) => <button key={n.id} className="st-nlink" onClick={() => openNote(n)}>{noteHeadline(n)} <span className="muted">· {S.day(dayBucket(n.observed_at, ctx.today)).toLowerCase()}</span></button>)}
                    <button className="lnk" onClick={() => ctx.onOpenTopic(t.key)}>{S.wholeTopic}</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="st-foot">
            {quiet.length > 0 && <span className="muted">{S.quiet(quiet.join(", "))}</span>}
            <span className="spacer" />
            {drafts > 0 && <><span><span className="st-badge">{drafts}</span> {S.drafts(drafts).replace(/^\d+\s/, "")}</span>
              <button className="btn" onClick={() => ctx.onOpenResearch("tab=topics")}>{S.reviewDrafts}</button></>}
          </div>
        </div>
      </div>
    </Widget>
  );
}

function NowOutlook({ t }: { t: StoryTopic }) {
  if (!t.now && !t.outlook && !t.valuation) return null;
  return (
    <div className="st-nowout">
      {t.now && <div><b>{S.now}</b>{t.now}</div>}
      {t.outlook && <div><b>{S.outlook}</b>{t.outlook}</div>}
      {t.valuation && <ValuationBox v={t.valuation} />}
    </div>
  );
}

const num = (v: number) => (Math.round(v * 10) / 10).toLocaleString(intlLocale());

/** Wycena: the verdict word (from the figures, never the agent's opinion), one sentence, then where it comes from. */
function ValuationBox({ v }: { v: Valuation }) {
  const { verdict, multiple, growth } = valuationOf(v);
  const word = verdict === "cheap" ? S.valCheap : verdict === "rich" ? S.valRich : verdict === "fair" ? S.valFair : null;
  const tone = verdict === "cheap" ? "pos" : verdict === "rich" ? "neg" : "calm";
  const sentence = (v.pe && v.forward_pe && multiple ? (multiple > 1 ? S.valBoth(num(v.pe), num(v.forward_pe), num(multiple)) : S.valFall(num(v.pe), num(v.forward_pe)))
    : v.forward_pe ? S.valFwd(num(v.forward_pe)) : v.pe ? S.valPe(num(v.pe)) : "")
    + (v.eps_growth != null && growth != null ? S.valGrowth(pct(growth)) : "")
    + (v.pe_avg_5y ? S.valHistory(num(v.pe_avg_5y)) : "");
  return (
    <div className="st-val">
      <b>{S.valuation}</b>
      {word && <span className={`st-mood ${tone}`}>{word}</span>} {sentence}
      <small>{S.valFrom(v.basis ?? "", (v.sources ?? []).join(", "), v.observed_at ? dm(v.observed_at) : "")}</small>
    </div>
  );
}

// ---- the research page -----------------------------------------------------------------------------------------

export type StoryTab = "topics" | "mine" | "notes" | "calendar" | "candidates" | "runs";
export const STORY_TABS: StoryTab[] = ["topics", "mine", "notes", "calendar", "candidates", "runs"];

export function StoryHead({ today, runs, summary, segments, candidates, tab, onTab }: {
  today: string; runs: ResearchRun[]; summary: ResearchSummary | null | undefined; segments: SegmentAttribution | null | undefined;
  candidates: number; tab: StoryTab; onTab: (t: StoryTab) => void;
}) {
  const last = latestRun(runs);
  const held = (summary?.instruments ?? []).filter((i) => i.held).length;
  const rows = segments?.segments ?? [];
  const top = [...rows].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 2).map((s) => s.label);
  const { weak, strong } = thesisMoves(summary, today);
  const signals = summary?.totals?.signals_open ?? 0;
  const labels: Record<StoryTab, string> = { topics: S.tabTopics, mine: S.tabMine, notes: S.tabNotes, calendar: S.tabCalendar, candidates: S.tabCandidates, runs: S.tabRuns };
  return (
    <Widget title={null} label={S.research} className="st st-head" body="tight">
      <p className="st-story">{last ? S.story(wdm(last.started_at), held, rows.length) : ""}{top.length ? S.storyTop(top.join(", ")) : ""}</p>
      <div className="st-sents">
        {weak.length > 0 && <span className="st-sent neg">{S.sentWeak(weak.length)}</span>}
        {strong.length > 0 && <span className="st-sent pos">{S.sentStrong(strong.length)}</span>}
        {candidates > 0 && <span className="st-sent info">{S.sentCands(candidates)}</span>}
        <span className="st-sent">{signals ? S.sentSignals(signals) : S.sentNothing}</span>
      </div>
      <div className="st-next">{S.nextRun(wdm(nextSaturday(today)))}</div>
      <div className="st-tabs" role="tablist" aria-label={S.tabs}>
        {STORY_TABS.map((k) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => onTab(k)}>{labels[k]}</button>)}
      </div>
    </Widget>
  );
}

export function TopicsTab({ segments, notes, symOf, today, onOpenTopic, onOpenNote }: {
  segments: SegmentAttribution | null | undefined; notes: ResearchNote[]; symOf: (id: number) => string | null; today: string;
  onOpenTopic: (key: string) => void; onOpenNote: (n: ResearchNote) => void;
}) {
  const recent = notes.filter((n) => dayBucket(n.observed_at, today) <= 2);
  const { topics, quiet } = useMemo(() => storyTopics(segments, recent, symOf), [segments, recent, symOf]);
  return (
    <Widget title={S.tabTopics} className="st" body="tight" footer={quiet.length ? <span className="muted">{S.quiet(quiet.join(", "))}</span> : undefined}>
      <div className="st-tgrid">
        {topics.map((t) => (
          <article key={t.key} className="st-tcard" data-topic={t.key}>
            <div className="top"><Mood t={t} /><span>{t.label}</span><span className="spacer" />{t.draft && <span className="st-draft">{S.draft}</span>}<span>{t.impact != null ? pp(t.impact * 100) : S.watchedTopic}</span></div>
            <h3><button className="st-h" onClick={() => onOpenTopic(t.key)}>{t.headline}</button></h3>
            <NowOutlook t={t} />
            {t.notes.length > 0 && <div className="st-nlist">{t.notes.map((n) => <button key={n.id} className="st-nlink" onClick={() => onOpenNote(n)}>{noteHeadline(n)}</button>)}</div>}
            {t.tickers.length > 0 && <div className="st-tick">{t.tickers.slice(0, 10).join(" · ")}</div>}
          </article>
        ))}
      </div>
    </Widget>
  );
}

export function MineTab({ summary, notes, today, cal, names, onOpenAsset }: {
  summary: ResearchSummary | null | undefined; notes: ResearchNote[]; today: string; cal: CalendarEvent[];
  names: Map<number, { name: string; symbol: string | null }>; onOpenAsset: (id: number, noteId?: number) => void;
}) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const soon = new Map<number, string>();
  for (const e of cal) if (e.kind === "earnings" && e.instrument_id != null && !soon.has(e.instrument_id)) soon.set(e.instrument_id, wdm(e.date));
  const rank: Record<string, number> = { inv: 0, weak: 1, ful: 2, sup: 3 };
  const rows = (summary?.instruments ?? []).filter((i) => i.held).map((i) => ({ i, h: healthOf(i, today) })).sort((a, b) => (rank[a.h] ?? 9) - (rank[b.h] ?? 9));
  return (
    <Widget title={S.tabMine} className="st" body="tight">
      <div className="st-rows">
        {rows.map(({ i, h }) => {
          const n = i.latest_note?.id != null ? byId.get(i.latest_note.id) : undefined;
          const line = n ? noteHeadline(n) : i.latest_note?.title ?? S.nothingNew;
          const name = names.get(i.instrument_id)?.name ?? i.instrument?.name ?? i.label ?? `#${i.instrument_id}`;
          return (
            <div key={i.instrument_id} className="st-prow">
              <span className="nm">{name}<small>{names.get(i.instrument_id)?.symbol ?? i.instrument?.symbol ?? ""}</small></span>
              <span className={`st-health ${h === "inv" || h === "weak" ? "neg" : h === "sup" || h === "ful" ? "pos" : "calm"}`}>{S.thesis(HEALTH_LABEL[h])}</span>
              <button className="st-nlink" onClick={() => onOpenAsset(i.instrument_id, i.latest_note?.id)}>{line}</button>
              {soon.has(i.instrument_id) ? <span className="st-soon">{S.earningsOn(soon.get(i.instrument_id)!)}</span> : <span />}
            </div>
          );
        })}
      </div>
    </Widget>
  );
}

type NoteFilter = "all" | "thesis" | "earnings" | "news";

export function NotesTab({ slug, notes, today, held, watchedIds, onOpenAsset, onOpenTopic, onChanged }: {
  slug: string; notes: ResearchNote[]; today: string;
  held: Map<number, { name: string; symbol: string | null }>; watchedIds: Map<number, { name: string; symbol: string | null }>;
  onOpenAsset: (id: number, noteId?: number) => void; onOpenTopic: (key: string) => void; onChanged: () => void;
}) {
  const [filter, setFilter] = useState<NoteFilter>("all");
  const [open, setOpen] = useState<number | null>(null);
  const [shown, setShown] = useState(15);
  const actions = useResearchActions(slug, onChanged);
  const list = notes
    .filter((n) => !n.dismissed_at && n.kind !== "candidate")
    .filter((n) => filter === "all" || (filter === "thesis" ? relOf(n) != null : filter === "earnings" ? n.kind === "earnings" : n.kind === "news"))
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at));
  const visible = list.slice(0, shown);
  const who = (n: ResearchNote) => {
    const id = n.instrument_id;
    if (id != null) return held.get(id)?.name ?? watchedIds.get(id)?.name ?? n.instrument?.name ?? n.instrument?.label ?? `#${id}`;
    if (n.segment) return isMacroKey(n.segment) ? macroLabel(n.segment) : n.segment_label ?? segmentLabel(n.segment);
    return n.theme ?? S.market;
  };
  const symOfNote = (n: ResearchNote) => (n.instrument_id != null ? held.get(n.instrument_id)?.symbol ?? watchedIds.get(n.instrument_id)?.symbol ?? n.instrument?.symbol ?? null : null);
  const target = (n: ResearchNote) => (n.instrument_id != null && (held.has(n.instrument_id) || watchedIds.has(n.instrument_id)) ? () => onOpenAsset(n.instrument_id!, n.id)
    : n.segment && (isMacroKey(n.segment) || isSegment(n.segment)) ? () => onOpenTopic(isMacroKey(n.segment) ? n.segment! : canonKey(n.segment)!) : null);
  const filters: [NoteFilter, string][] = [["all", S.fAll], ["thesis", S.fThesis], ["earnings", S.fEarnings], ["news", S.fNews]];
  let lastDay = -1;
  return (
    <Widget title={S.tabNotes} id="rsch-notes" className="st" count={list.length} body="tight">
      <div className="st-filters" role="group" aria-label={S.filters}>
        {filters.map(([k, l]) => <button key={k} aria-pressed={filter === k} onClick={() => { setFilter(k); setShown(15); }}>{l}</button>)}
      </div>
      {!visible.length && <div className="muted">{S.noNotes}</div>}
      {visible.map((n) => {
        const b = dayBucket(n.observed_at, today);
        const head = b !== lastDay ? <div className="st-day">{S.day(b)}</div> : null;
        lastDay = b;
        const rel = relOf(n);
        const go = target(n);
        return (
          <div key={n.id}>
            {head}
            <article className="st-note" data-note={n.id} id={`note-${n.id}`}>
              <i className={rel?.tone ?? ""} aria-hidden />
              <div className="body">
                <button className="h" aria-expanded={open === n.id} onClick={() => setOpen(open === n.id ? null : n.id)}>{noteHeadline(n)}</button>
                <div className="m">{who(n)}{symOfNote(n) ? ` (${symOfNote(n)})` : ""} · {KIND_LABEL[n.kind] ?? n.kind}{rel && <> · <span className={`st-rel ${rel.tone}`}>{rel.text}</span></>}</div>
                {open === n.id && (
                  <div className="st-full">
                    {noteHeadline(n) !== n.title && <div className="tech">{n.title}</div>}
                    {n.summary.split(/\n{2,}/).map((p, k) => <p key={k}>{p}</p>)}
                    {n.sources.length > 0 && <div className="srcs">{S.sources}: {n.sources.map((s, k) => <a key={k} href={s.url} target="_blank" rel="noreferrer">{s.publisher ?? s.title ?? s.url}</a>)}</div>}
                    {go && <button className="lnk" onClick={go}>{S.openIn}</button>}
                  </div>
                )}
              </div>
              <button className="st-x" aria-label={S.dismiss(n.title)} title={S.dismiss(n.title)} disabled={actions.busy === n.id} onClick={() => void actions.dismiss(n)}>✕</button>
            </article>
          </div>
        );
      })}
      {list.length > shown && <button className="lnk st-more" onClick={() => setShown((s) => s + 15)}>{S.showMore(Math.min(15, list.length - shown))}</button>}
    </Widget>
  );
}

export function CalendarTab({ slug, today, names }: { slug: string; today: string; names: (id: number) => string | null }) {
  const { cal, calError } = useWeek(slug, today);
  const seg = useSegments(slug, "1w");
  const events = aheadEvents(cal?.events ?? [], today, 14, 60);
  return (
    <Widget title={S.tabCalendar} className="st" body="tight" footer={<span className="muted">{S.calendarSources}</span>}>
      <div className="st-say">{events.length ? aheadSay(aheadEvents(cal?.events ?? [], today, 7)) : S.calendarNone}</div>
      <AheadDays events={events} topicOf={topicMap(seg.data)} nameOf={(e) => (e.instrument_id != null ? names(e.instrument_id) : null) ?? e.label ?? e.title} />
      {(cal?.stale || calError) && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{S.calendarStale}</div>}
    </Widget>
  );
}

export { useWeek };
