// Research as a story (Story.tsx): the plain headline first, the figures one level deeper. Pure logic: the mood
// word of a topic, the headline of a note, the topics worth a line this week, the theses that lost or gained
// ground and the dated events coming up.
import type { CalendarEvent } from "../api.ts";
import { healthOf } from "./logic.ts";
import type { InstrumentSummary, ResearchNote, SegmentAttribution } from "./types.ts";

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
  notes: ResearchNote[]; tickers: string[];
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
      headline, now: firstSentence(s.thesis?.assessment), outlook: firstSentence(s.thesis?.outlook), draft: !!s.thesis?.draft, notes: rest, tickers,
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
