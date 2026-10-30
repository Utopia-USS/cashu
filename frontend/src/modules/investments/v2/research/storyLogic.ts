// Research as a story (Story.tsx): the plain headline first, the figures one level deeper. Pure logic: the mood
// word of a topic, the headline of a note, the topics worth a line this week, the theses that lost or gained
// ground and the dated events coming up.
import type { CalendarEvent } from "../api.ts";
import { healthOf } from "./logic.ts";
import type { InstrumentSummary, ResearchNote, SegmentAttribution, Valuation } from "./types.ts";

export type Mood = "up" | "tail" | "press" | "weak" | "unsure" | "calm";
export type Tone = "pos" | "neg" | "warn" | "calm";
export const MOOD_TONE: Record<Mood, Tone> = { up: "pos", tail: "pos", press: "neg", weak: "neg", unsure: "warn", calm: "calm" };

/** One word for a topic's week, from the equal-weighted price move of its instruments (`trend_1w`); a flat week
 * with a negative brief reads as uncertain. */
export function moodOf(trend: number | null | undefined, polarity?: string | null): Mood {
  const t = trend ?? 0;
  if (t >= 0.03) return "up";
  if (t >= 0.01) return "tail";
  if (t <= -0.03) return "press";
  if (t <= -0.01) return "weak";
  return polarity === "negative" ? "unsure" : "calm";
}

/** The first sentence of a longer text (a topic's market view), cut at `limit` characters on a word. */
export function firstSentence(text: string | null | undefined, limit = 220): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  const m = /^(.+?[.!?])(\s|$)/s.exec(t);
  const s = m ? m[1] : t;
  return s.length <= limit ? s : `${s.slice(0, limit).replace(/\s+\S*$/, "")}…`;
}

/** What a note says in plain words: the agent's `details.headline`, a brief's headline, else its title. */
export function noteHeadline(n: Pick<ResearchNote, "title" | "details">): string {
  const d = (n.details ?? {}) as { headline?: unknown; brief?: { headline?: unknown } | null };
  const h = typeof d.headline === "string" ? d.headline : typeof d.brief?.headline === "string" ? d.brief.headline : null;
  return h?.trim() || n.title;
}

/** True when the note has a headline in plain words (else the title with its figures stands in). */
export const hasPlainHeadline = (n: Pick<ResearchNote, "title" | "details">) => noteHeadline(n) !== n.title;

export interface StoryTopic {
  key: string; label: string; mood: Mood;
  /** Share of the portfolio's week (fraction); null for a watched-only topic. */
  impact: number | null;
  headline: string; now: string; outlook: string; draft: boolean;
  notes: ResearchNote[]; tickers: string[]; valuation: Valuation | null;
}

/** The topics with something to say this week (a brief or a note), biggest effect on the portfolio first; the
 * rest are only named (`quiet`). Up to 3 notes per topic, newest first. */
export function storyTopics(att: SegmentAttribution | null | undefined, notes: ResearchNote[], symOf: (id: number) => string | null): { topics: StoryTopic[]; quiet: string[] } {
  if (!att) return { topics: [], quiet: [] };
  const live = notes.filter((n) => !n.dismissed_at && n.kind !== "candidate");
  const rows = [...att.segments].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || b.weight - a.weight);
  const topics: StoryTopic[] = [], quiet: string[] = [];
  for (const s of rows) {
    const ids = new Set([...s.instruments.map((i) => i.instrument_id), ...(s.member_instruments ?? []).map((m) => m.instrument_id)]);
    const own = live.filter((n) => n.segment === s.segment || (n.instrument_id != null && ids.has(n.instrument_id)))
      .sort((a, b) => b.observed_at.localeCompare(a.observed_at) || b.strength - a.strength).slice(0, 3);
    const brief = s.briefs?.[0];
    const headline = brief?.headline ?? (own[0] ? noteHeadline(own[0]) : null);
    if (!headline) { quiet.push(s.label); continue; }
    const rest = own.filter((n) => noteHeadline(n) !== headline);
    const tickers = [...new Set([...s.instruments.map((i) => symOf(i.instrument_id) ?? i.label ?? ""), ...(s.member_instruments ?? []).map((m) => symOf(m.instrument_id) ?? m.label ?? "")])].filter(Boolean);
    topics.push({
      key: s.segment, label: s.label, mood: moodOf(s.trend_1w, brief?.polarity ?? own[0]?.polarity), impact: s.weight > 0 ? s.contribution : null,
      headline, now: firstSentence(s.thesis?.assessment), outlook: firstSentence(s.thesis?.outlook), draft: !!s.thesis?.draft, notes: rest, tickers, valuation: s.valuation ?? null,
    });
  }
  return { topics, quiet };
}

/** Held instruments whose thesis lost ground (invalidated, weakened) or gained it (supported, fulfilled). */
export function thesisMoves(summary: { instruments: InstrumentSummary[] } | null | undefined, today: string): { weak: InstrumentSummary[]; strong: InstrumentSummary[] } {
  const held = (summary?.instruments ?? []).filter((i) => i.held);
  return {
    weak: held.filter((i) => ["inv", "weak"].includes(healthOf(i, today))),
    strong: held.filter((i) => ["sup", "ful"].includes(healthOf(i, today))),
  };
}

/** 0 today, 1 yesterday, 2 this week (7 days), 3 older. */
export function dayBucket(iso: string, today: string): 0 | 1 | 2 | 3 {
  const d = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${iso.slice(0, 10)}T12:00:00Z`)) / 86400000);
  return d <= 0 ? 0 : d === 1 ? 1 : d <= 7 ? 2 : 3;
}

/** The dated events of the next `days` days: every one of the owner's own, then the market's, at most `max`, by date. */
export function aheadEvents(events: CalendarEvent[], today: string, days = 7, max = 8): CalendarEvent[] {
  const end = Date.parse(`${today}T12:00:00Z`) + days * 86400000;
  const near = events.filter((e) => Date.parse(`${e.date}T12:00:00Z`) <= end && e.date >= today);
  const mine = near.filter((e) => e.instrument_id != null);
  const rest = near.filter((e) => e.instrument_id == null).slice(0, Math.max(0, max - mine.length));
  return [...mine, ...rest].sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
}

export interface AheadItem { name: string; mine: boolean; earnings: boolean; title: string | null }
export interface AheadGroup { topic: string | null; items: AheadItem[] }
export interface AheadDay { date: string; mine: number; groups: AheadGroup[]; market: string[] }

/** `HH:MM` of a macro release (an earnings `przed sesją` / `po sesji` stays out of the day line). */
const clock = (t: string | null) => (t && /^\d{1,2}:\d{2}$/.test(t) ? t : null);

/** The coming events one row per day: the companies grouped by topic (a topic with one of the owner's positions
 * first, own positions first inside it), a research event under its company or topic, the market's releases in
 * one list. `topicOf` names an instrument's topic, `nameOf` its display name. */
export function aheadDays(events: CalendarEvent[], topicOf: (id: number) => string | null, nameOf: (e: CalendarEvent) => string): AheadDay[] {
  const days = new Map<string, AheadDay>();
  const own = new Map<string, Set<number>>();
  for (const e of events) {
    const day = days.get(e.date) ?? { date: e.date, mine: 0, groups: [], market: [] };
    days.set(e.date, day);
    if (e.kind === "macro") {
      const base = e.country_label && !e.title.includes(":") ? `${e.title} (${e.country_label})` : e.title;
      const text = clock(e.time) ? `${base} ${clock(e.time)}` : base;
      if (!day.market.includes(text)) day.market.push(text);
      continue;
    }
    const topic = e.instrument_id != null ? topicOf(e.instrument_id) : e.country_label;
    let g = day.groups.find((x) => x.topic === topic);
    if (!g) { g = { topic, items: [] }; day.groups.push(g); }
    const mine = e.held === true;
    const name = e.instrument_id != null || e.kind === "earnings" ? nameOf(e) : e.title;
    // A name that fell back to the event's own title carries no second copy of it.
    const item: AheadItem = { name, mine, earnings: e.kind === "earnings", title: e.kind === "earnings" || name === e.title ? null : e.title };
    if (!g.items.some((x) => x.name === item.name && x.title === item.title)) g.items.push(item);
    if (mine && e.instrument_id != null) {
      const set = own.get(e.date) ?? new Set<number>();
      set.add(e.instrument_id);
      own.set(e.date, set);
      day.mine = set.size;
    }
  }
  for (const d of days.values()) {
    for (const g of d.groups) g.items.sort((a, b) => Number(b.mine) - Number(a.mine));
    d.groups.sort((a, b) => Number(b.items.some((i) => i.mine)) - Number(a.items.some((i) => i.mine)) || b.items.length - a.items.length);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export type ValVerdict = "cheap" | "fair" | "rich";

/** Is the topic priced cheaply or richly for its growth. In order: the PEG from the sourced yearly earnings growth
 * (forward P/E per % of growth: under 1 cheap, up to 2 fair, above rich); without that figure the forward P/E
 * against its 5-year average (15 % either way); without both the PEG from the growth P/E / forward P/E implies.
 * Earnings expected to shrink never read as cheap (no verdict). `multiple` = P/E / forward P/E. */
export function valuationOf(v: Valuation | null | undefined): { verdict: ValVerdict | null; multiple: number | null; growth: number | null; peg: number | null } {
  const pe = v?.pe ?? null, fwd = v?.forward_pe ?? null;
  const multiple = pe && fwd ? pe / fwd : null;
  const sourced = v?.eps_growth ?? null;
  const growth = sourced ?? (multiple != null ? multiple - 1 : null);
  const pegOf = (g: number | null) => (fwd && g != null && g > 0 ? fwd / (g * 100) : null);
  const byPeg = (p: number): ValVerdict => (p < 1 ? "cheap" : p <= 2 ? "fair" : "rich");
  if (growth != null && growth <= 0) return { verdict: null, multiple, growth, peg: null };
  let peg = pegOf(sourced);
  let verdict: ValVerdict | null = peg != null ? byPeg(peg) : null;
  if (!verdict && fwd && v?.pe_avg_5y) verdict = fwd < v.pe_avg_5y * 0.85 ? "cheap" : fwd > v.pe_avg_5y * 1.15 ? "rich" : "fair";
  if (!verdict) { peg = pegOf(growth); verdict = peg != null ? byPeg(peg) : null; }
  return { verdict, multiple, growth, peg };
}
