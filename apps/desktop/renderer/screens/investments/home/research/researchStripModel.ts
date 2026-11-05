// The research strip of the investments Home (ab24ab6 v2/research/index.tsx useResearchHome `strip` +
// research/Story.tsx ResearchStory): which branch shows, and every string and list the pure ResearchStripView
// renders. Only the formatting and derivations of the old component live here; the logic is ui-logic's verbatim
// port (storyLogic, research/logic, macro, segments).
import { intlLocale } from "@cashu/i18n";
import { MOOD, S } from "@cashu/i18n/investments/v2/research/Story.strings";
import { dm, pct, pp, wdm } from "@cashu/ui-logic/investments/labels";
import { instName } from "@cashu/ui-logic/investments/v2/logic";
import { latestRun } from "@cashu/ui-logic/investments/v2/research/logic";
import { isMacroKey } from "@cashu/ui-logic/investments/v2/research/macro";
import { canonKey } from "@cashu/ui-logic/investments/v2/research/segments";
import {
  aheadDays,
  aheadEvents,
  dayBucket,
  MOOD_TONE,
  noteHeadline,
  type StoryTopic,
  storyTopics,
  thesisMoves,
  valuationOf,
} from "@cashu/ui-logic/investments/v2/research/storyLogic";
import type {
  ResearchNote,
  SegmentAttribution,
  Valuation,
} from "@cashu/ui-logic/investments/v2/research/types";
import type { CalendarEvent } from "@cashu/ui-logic/investments/v2/types";
import type { InvestmentsHomeData } from "../useInvestmentsHomeData.js";

/** The research view's tab an old strip button opened (`research?tab=...`). */
type ResearchQuery = "tab=mine" | "tab=topics" | "tab=notes";

/** Navigation the Home screen hook owns (old StripCtx callbacks). Instrument and note ids are legacy numbers. */
export interface ResearchStripUi {
  onOpenAsset(instrumentId: number, noteId?: number): void;
  /** A segment key or a macro regime's `macro_<key>` (the topic drawer). */
  onOpenTopic(key: string): void;
  onOpenResearch(query?: ResearchQuery): void;
}

/** `.st-mood` tones (story.css). */
export type StoryTone = "pos" | "neg" | "warn" | "calm";

interface StoryChip {
  key: string;
  label: string;
  state: string;
  tone: StoryTone;
  /** The `nowe` tag: the state changed in the last two days. */
  fresh: boolean;
  /** `.st-mexp` when expanded: the brief (bold headline + why) or the plain sentence. */
  brief: { headline: string; why: string | null } | null;
  plain: string | null;
  onMore(): void;
}

interface StoryAheadItem {
  text: string;
  mine: boolean;
}
interface StoryAheadGroup {
  topic: string;
  /** `wyniki: A, B` (null when the group has no earnings). */
  earnings: StoryAheadItem[] | null;
  /** The other events, joined with ` · `. */
  other: StoryAheadItem[];
}
export interface StoryAheadDay {
  date: string;
  /** `.st-dd`: the bold day.month and the short weekday. */
  day: string;
  weekday: string;
  groups: StoryAheadGroup[];
  /** The market releases of the day (`Rynek: ...`), null when none. */
  market: string | null;
  /** `.st-dr`: how many of the owner's positions report that day ("" when none). */
  mine: string;
}

export interface StoryValuation {
  word: string | null;
  tone: StoryTone;
  sentence: string;
  from: string;
}

interface StoryTopicNote {
  id: number;
  headline: string;
  /** ` · dziś` etc. after the headline (muted). */
  day: string;
  onOpen(): void;
}

export interface StoryTopicRow {
  key: string;
  label: string;
  mood: { word: string; tone: StoryTone };
  headline: string;
  impact: string;
  now: string;
  outlook: string;
  valuation: StoryValuation | null;
  notes: StoryTopicNote[];
  onWholeTopic(): void;
}

export interface ResearchStoryProps {
  kind: "story";
  /** The header tag: the last run's weekday + date. */
  count: string | undefined;
  /** `Wszystko · n notatek`. */
  allLabel: string;
  onAll(): void;
  lead: string | null;
  chips: StoryChip[];
  aheadSay: string;
  days: StoryAheadDay[];
  /** `.st-alert`: theses that lost ground. */
  weak: { title: string; names: string; onReview(): void } | null;
  topics: StoryTopicRow[];
  /** `Bez nowości: ...` (null when every topic moved). */
  quiet: string | null;
  drafts: { count: number; text: string; onReview(): void } | null;
}

/** The old Home's research grid item: ResearchStory after the first run; null before it (the MacroStrip branch
 * is a follow-up, see contract-H3.md). */
export type ResearchStripProps = ResearchStoryProps;

const regimeTone = (t: string): StoryTone =>
  t === "pos" ? "pos" : t === "neg" ? "neg" : t === "warn" ? "warn" : "calm";

/** Instrument id -> its topic's label, from the segment attribution (held and watched members). */
function topicMap(att: SegmentAttribution | null | undefined): (id: number) => string | null {
  const m = new Map<number, string>();
  for (const s of att?.segments ?? []) {
    for (const i of s.instruments) m.set(i.instrument_id, s.label);
    for (const i of s.member_instruments ?? [])
      if (!m.has(i.instrument_id)) m.set(i.instrument_id, s.label);
  }
  return (id) => m.get(id) ?? null;
}

const aheadSay = (events: CalendarEvent[]) => {
  const mine = events.filter((e) => e.kind === "earnings" && e.held === true).length;
  return !events.length ? S.aheadQuiet : mine ? S.aheadMine(mine) : S.aheadNoneMine;
};

const num = (v: number) => (Math.round(v * 10) / 10).toLocaleString(intlLocale());

/** Wycena: the verdict word (from the figures, never the agent's opinion), one sentence, then where it comes from. */
function valuationView(v: Valuation): StoryValuation {
  const { verdict, multiple, growth } = valuationOf(v);
  const word =
    verdict === "cheap"
      ? S.valCheap
      : verdict === "rich"
        ? S.valRich
        : verdict === "fair"
          ? S.valFair
          : null;
  const tone: StoryTone = verdict === "cheap" ? "pos" : verdict === "rich" ? "neg" : "calm";
  const sentence =
    (v.pe && v.forward_pe && multiple
      ? multiple > 1
        ? S.valBoth(num(v.pe), num(v.forward_pe), num(multiple))
        : S.valFall(num(v.pe), num(v.forward_pe))
      : v.forward_pe
        ? S.valFwd(num(v.forward_pe))
        : v.pe
          ? S.valPe(num(v.pe))
          : "") +
    (v.eps_growth != null && growth != null ? S.valGrowth(pct(growth)) : "") +
    (v.pe_avg_5y ? S.valHistory(num(v.pe_avg_5y)) : "");
  return {
    word,
    tone,
    sentence,
    from: S.valFrom(
      v.basis ?? "",
      (v.sources ?? []).join(", "),
      v.observed_at ? dm(v.observed_at) : "",
    ),
  };
}

interface Named {
  name: string;
  symbol: string | null;
}

export function researchStripProps(
  data: InvestmentsHomeData,
  ui: ResearchStripUi,
): ResearchStripProps | null {
  const r = data.research;
  if (!r.ran || !r.runs) return null;
  const today = data.today;
  const held = new Map<number, Named>(
    (data.pos.data?.positions ?? []).map((p) => [
      Number(p.instrument.id),
      { name: instName(p.instrument), symbol: p.instrument.symbol ?? null },
    ]),
  );
  const watchedIds = new Map<number, Named>();
  for (const w of data.watchQ.data ?? []) {
    if (w.instrument)
      watchedIds.set(w.instrument_id, {
        name: instName(w.instrument),
        symbol: w.instrument.symbol ?? null,
      });
  }
  const summary = r.summary;
  const symOf = (id: number) =>
    held.get(id)?.symbol ??
    watchedIds.get(id)?.symbol ??
    summary?.instruments.find((s) => s.instrument_id === id)?.instrument?.symbol ??
    null;
  const ctxNameOf = (id: number) => held.get(id)?.name ?? watchedIds.get(id)?.name ?? null;

  const { topics, quiet } = storyTopics(r.segments, r.weekNotes, symOf);
  const { weak } = thesisMoves(summary, today);
  const regimes = r.macro?.regimes ?? [];
  const risk = regimes.find((x) => x.key === "risk");
  const lead = risk?.brief?.headline ?? risk?.summary ?? null;
  const events = aheadEvents(r.calendar.data?.events ?? [], today, 7);
  const drafts = topics.filter((t) => t.draft).length;
  const last = latestRun(r.runs);
  const nameOf = (i: {
    instrument_id: number;
    instrument?: { name?: string | null; label?: string | null } | null;
    label?: string | null;
  }) =>
    held.get(i.instrument_id)?.name ??
    i.instrument?.name ??
    i.label ??
    i.instrument?.label ??
    `#${i.instrument_id}`;
  const openNote = (n: ResearchNote) =>
    n.instrument_id != null
      ? ui.onOpenAsset(n.instrument_id, n.id)
      : n.segment
        ? ui.onOpenTopic(isMacroKey(n.segment) ? n.segment : (canonKey(n.segment) ?? n.segment))
        : ui.onOpenResearch("tab=notes");

  const chips: StoryChip[] = regimes.map((x) => ({
    key: x.key,
    label: x.label,
    state: x.state_label,
    tone: regimeTone(x.tone),
    fresh: !!x.since && dayBucket(x.since, today) <= 2,
    brief: x.brief ? { headline: x.brief.headline, why: x.brief.why } : null,
    plain: x.summary ?? x.plain ?? null,
    onMore: () => ui.onOpenTopic(`macro_${x.key}`),
  }));

  const topicOf = topicMap(r.segments);
  const days: StoryAheadDay[] = aheadDays(
    events,
    topicOf,
    (e) =>
      (e.instrument_id != null
        ? (held.get(e.instrument_id)?.name ?? ctxNameOf(e.instrument_id))
        : null) ??
      e.label ??
      e.title,
  )
    .slice(0, 5)
    .map((d) => ({
      date: d.date,
      day: dm(d.date),
      weekday: wdm(d.date).split(" ")[0] ?? "",
      groups: d.groups.map((g) => {
        const earn = g.items.filter((i) => i.earnings);
        return {
          topic: g.topic ?? S.otherTopic,
          earnings: earn.length ? earn.map((i) => ({ text: i.name, mine: i.mine })) : null,
          other: g.items
            .filter((i) => !i.earnings)
            .map((i) => ({ text: i.title ? `${i.name}: ${i.title}` : i.name, mine: i.mine })),
        };
      }),
      market: d.market.length ? d.market.join(", ") : null,
      mine: d.mine ? S.yoursN(d.mine) : "",
    }));

  const topicRow = (t: StoryTopic): StoryTopicRow => ({
    key: t.key,
    label: t.label,
    mood: { word: MOOD[t.mood], tone: MOOD_TONE[t.mood] },
    headline: t.headline,
    impact: t.impact != null ? pp(t.impact * 100) : S.watchedTopic,
    now: t.now,
    outlook: t.outlook,
    valuation: t.valuation ? valuationView(t.valuation) : null,
    notes: t.notes.map((n) => ({
      id: n.id,
      headline: noteHeadline(n),
      day: (S.day(dayBucket(n.observed_at, today)) ?? "").toLowerCase(),
      onOpen: () => openNote(n),
    })),
    onWholeTopic: () => ui.onOpenTopic(t.key),
  });

  return {
    kind: "story",
    count: last ? wdm(last.started_at) : undefined,
    allLabel: S.all(summary?.totals?.notes_active ?? r.weekNotes.length),
    onAll: () => ui.onOpenResearch(),
    lead,
    chips,
    aheadSay: aheadSay(events),
    days,
    weak: weak.length
      ? {
          title: S.lostGround(weak.length),
          names: weak.map(nameOf).join(", "),
          onReview: () => ui.onOpenResearch("tab=mine"),
        }
      : null,
    topics: topics.map(topicRow),
    quiet: quiet.length ? S.quiet(quiet.join(", ")) : null,
    drafts: drafts
      ? {
          count: drafts,
          text: S.drafts(drafts).replace(/^\d+\s/, ""),
          onReview: () => ui.onOpenResearch("tab=topics"),
        }
      : null,
  };
}
