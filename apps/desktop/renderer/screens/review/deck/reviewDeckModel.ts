// The review deck's card contents as plain data (ab24ab6 v2/ReviewDeck.tsx `cardFor`, `SummaryCard`, the note
// sheet): every number and date formatted here, so ReviewDeckView renders strings only. Same texts, same order,
// same conditions as the old JSX.
import { S } from "@cashu/i18n/investments/v2/ReviewDeck.strings";
import { dm, money, pct, pp } from "@cashu/ui-logic/investments/labels";
import { clip } from "@cashu/ui-logic/investments/v2/homeLogic";
import { noteSubject } from "@cashu/ui-logic/investments/v2/research/logic";
import type { ResearchNote } from "@cashu/ui-logic/investments/v2/research/types";
import {
  CARD_TITLE,
  type CardId,
  DECIDE_GROUPS,
  type DecideGroup,
  type DecideItem,
  type DecideRest,
  GROUP_LABEL,
  sectorsTitle,
  summaryTitle,
  type Tone,
} from "@cashu/ui-logic/investments/v2/reviewDeckLogic";
import type { DigestV2, Performance } from "@cashu/ui-logic/investments/v2/types";
import type { ReviewDeckData, Verdict } from "./useReviewDeckData.js";

export type Card = CardId | "summary";
/** The deck as built once from the data at hand (decisions taken on it do not reshuffle the cards). */
export interface BuiltDeck {
  cards: Card[];
  skipped: { id: CardId; why: string }[];
  decide: DecideItem[];
  more: number;
  rest: DecideRest;
  ideas: ResearchNote[];
}

/** A run of text: `b` bold (`<b>`), `tone` the bold's colour class (`.pos` / `.neg`). */
export interface Run {
  text: string;
  b?: boolean;
  tone?: Signed;
}
export type Signed = "" | "pos" | "neg";
interface MoreItem {
  text: Run[];
  noteId: number | null;
  segment: string | null;
}
/** "Czytaj więcej": a bold lead and up to a few bullets, each with a link to the full note. */
export interface More {
  lead: string | null;
  items: MoreItem[];
}
export interface CmpRowModel {
  label: string;
  /** Bar width in percent of the track. */
  width: number;
  up: boolean;
  fill: "pos" | "neg" | "bench";
  value: string;
  bench: boolean;
}
interface DecideActionModel {
  action: string;
  label: string;
  look: "on" | "pri" | "";
  disabled: boolean;
}
export interface DecideItemModel {
  key: string;
  group: DecideGroup;
  tone: Tone;
  tag: string;
  title: string;
  why: string;
  context: string | null;
  choice: string | null;
  actions: DecideActionModel[];
}
export interface IdeaModel {
  id: number;
  tag: string;
  choice: string | null;
  name: string;
  sym: string | null;
  why: string;
  busy: boolean;
}
export type CardBody =
  | {
      kind: "world";
      value: string;
      valueTone: Signed;
      money: { text: string; tone: Signed } | null;
      since: string;
      rows: CmpRowModel[];
      stale: { label: string; title: string } | null;
      drawdown: { now: string; max: string | null } | null;
      sigma: string | null;
    }
  | {
      kind: "sectors";
      rows: {
        key: string;
        label: string;
        small: string;
        width: number;
        tone: Signed;
        currency: boolean;
        pp: string;
      }[];
    }
  | {
      kind: "positions";
      down: { id: number; label: string; ret: string; tone: Signed }[];
      up: { id: number; label: string; ret: string; tone: Signed }[];
    }
  | { kind: "events"; rows: { key: string; date: string; title: string; info: string }[] }
  | {
      kind: "decide";
      groups: { group: DecideGroup; label: string; count: number; items: DecideItemModel[] }[];
      hint: string;
    }
  | { kind: "ideas"; items: IdeaModel[] }
  | {
      kind: "calendar";
      loading: boolean;
      rows: {
        key: string;
        date: string;
        time: string;
        title: string;
        tags: { text: string; mine: boolean }[];
      }[];
      hint: string | null;
    };
export interface CardModel {
  id: CardId;
  eyebrow: string;
  tone: Tone;
  pill: string;
  title: string;
  body: CardBody;
  more: More | null;
}
export interface SummaryModel {
  title: string;
  stats: { value: number; label: string }[];
  agenda: { id: CardId; title: string; note: string | null }[];
  decisions: { key: string; title: string; choice: string }[];
  skipped: string | null;
}
export interface SheetModel {
  eyebrow: string;
  title: string;
  paragraphs: string[];
  sources: { url: string; text: string }[];
}

export interface CardContext {
  data: ReviewDeckData;
  digest: DigestV2;
  perfWeek: Performance | null | undefined;
  built: BuiltDeck | null;
  choices: Record<string, string>;
  pending: string | null;
  noteBusy: number | null;
}

const signed = (v: number | null): Signed => (v == null ? "" : v >= 0 ? "pos" : "neg");
const b = (text: string, tone?: Signed): Run =>
  tone ? { text, b: true, tone } : { text, b: true };
const t = (text: string): Run => ({ text });

function cmpRow(label: string, v: number | null, max: number, bench = false): CmpRowModel {
  return {
    label,
    width: v == null ? 0 : (Math.abs(v) / max) * 100,
    up: v != null && v >= 0,
    fill: bench ? "bench" : v != null && v >= 0 ? "pos" : "neg",
    value: v != null ? pct(v, true) : "-",
    bench,
  };
}

function world(c: CardContext): CardModel {
  const { week, bench, macro, seg, macroChanges, verdict, ddNow, ddMax, sigma, benchStale } =
    c.data;
  const max = Math.max(Math.abs(week.pct ?? 0), Math.abs(bench ?? 0), 0.0001);
  const risk = macro.data?.regimes.find((r) => r.key === "risk");
  const briefs = (seg.data?.segments ?? [])
    .filter((s) => s.weight > 0 && s.briefs?.length)
    .sort((a, z) => Math.abs(z.contribution) - Math.abs(a.contribution))
    .slice(0, 2);
  const items: MoreItem[] = [];
  if (risk?.brief)
    items.push({
      text: [b(`${risk.brief.headline}.`), t(` ${risk.brief.why ?? ""}`)],
      noteId: risk.brief.note_id,
      segment: "macro_risk",
    });
  else if (risk?.summary)
    items.push({
      text: [b(`${risk.label}: ${risk.state_label}.`), t(` ${risk.summary}`)],
      noteId: null,
      segment: null,
    });
  for (const ch of macroChanges.slice(0, 2))
    items.push({
      text: [b(`${ch.label}:`), t(` ${ch.from_label} → ${ch.to_label} (${S.since(dm(ch.since))})`)],
      noteId: null,
      segment: null,
    });
  for (const s of briefs) {
    const first = s.briefs?.[0];
    if (!first) continue;
    items.push({
      text: [b(`${s.label}: ${first.headline}.`), t(` ${first.why ?? ""}`)],
      noteId: first.note_id,
      segment: s.segment,
    });
  }
  const rows = [cmpRow(S.yourPortfolio, week.pct, max)];
  if (!benchStale && bench != null) rows.push(cmpRow(c.data.benchLabel, bench, max, true));
  return {
    id: "world",
    eyebrow: CARD_TITLE.world,
    tone: verdict.tone,
    pill: verdict.pill,
    title: verdict.title,
    body: {
      kind: "world",
      value: week.pct != null ? pct(week.pct, true) : "-",
      valueTone: signed(week.pct),
      money:
        week.money != null
          ? {
              text: money(week.money, c.perfWeek?.base_currency ?? "PLN", true),
              tone: signed(week.money),
            }
          : null,
      since: S.since(dm(c.digest.since)),
      rows,
      stale: benchStale,
      drawdown: ddNow != null ? { now: pct(ddNow), max: ddMax != null ? pct(ddMax) : null } : null,
      sigma: sigma != null ? S.typicalWeek(pct(sigma)) : null,
    },
    more: items.length ? { lead: S.marketLead, items } : null,
  };
}

function sectors(c: CardContext): CardModel {
  const { sectors: rows, week, seg } = c.data;
  const head = sectorsTitle(rows, week.pct);
  const max = Math.max(...rows.map((r) => Math.abs(r.contribution)), 0.0001);
  const items: MoreItem[] = [];
  for (const s of seg.data?.segments ?? []) {
    const first = s.briefs?.[0];
    if (!first || !rows.some((r) => r.key === s.segment)) continue;
    if (items.length === 3) break;
    items.push({
      text: [b(`${s.label}: ${first.headline}.`), t(` ${first.why ?? ""}`)],
      noteId: first.note_id,
      segment: s.segment,
    });
  }
  return {
    id: "sectors",
    eyebrow: CARD_TITLE.sectors,
    ...head,
    body: {
      kind: "sectors",
      rows: rows.map((r) => ({
        key: r.key,
        label: r.label,
        small: r.currency
          ? S.fxVsPln
          : `${r.weight != null ? S.weight(pct(r.weight)) : ""}${r.ret != null ? ` · ${pct(r.ret, true)}` : ""}`,
        width: (Math.abs(r.contribution) / max) * 50,
        tone: r.contribution >= 0 ? "pos" : "neg",
        currency: !!r.currency,
        pp: pp(r.contribution * 100),
      })),
    },
    more: items.length ? { lead: S.sectorsLead, items } : null,
  };
}

function positions(c: CardContext): CardModel {
  const { movers } = c.data;
  const row = (m: (typeof movers.down)[number]) => ({
    id: m.id,
    label: m.label,
    ret: pct(m.ret, true),
    tone: signed(m.ret),
  });
  const worst = movers.down[0],
    best = movers.up[0];
  const title =
    worst && (!best || Math.abs(worst.ret) >= Math.abs(best.ret))
      ? S.fellMost(worst.label)
      : best
        ? S.roseMost(best.label)
        : S.noBigMoves;
  return {
    id: "positions",
    eyebrow: CARD_TITLE.positions,
    tone: "info",
    pill: S.positions(movers.all.length),
    title,
    body: { kind: "positions", down: movers.down.map(row), up: movers.up.map(row) },
    more:
      movers.all.length > movers.down.length + movers.up.length
        ? {
            lead: S.allPositionsLead,
            items: [...movers.all].reverse().map((m) => ({
              text: [
                t(`${m.label} `),
                b(pct(m.ret, true), signed(m.ret)),
                t(` · ${pp(m.contribution * 100)}${S.ofResult}`),
              ],
              noteId: null,
              segment: null,
            })),
          }
        : null,
  };
}

const relation = (r: string) =>
  r === "invalidates"
    ? S.relInvalidates
    : r === "weakens"
      ? S.relWeakens
      : r === "supports"
        ? S.relSupports
        : "";

function events(c: CardContext): CardModel {
  const { events: list, macroChanges } = c.data;
  const first = list[0];
  return {
    id: "events",
    eyebrow: CARD_TITLE.events,
    tone: "warn",
    pill: S.events(list.length + macroChanges.length),
    title: first ? `${first.note.title}.` : S.marketChanged,
    body: {
      kind: "events",
      rows: [
        ...macroChanges.map((m) => ({
          key: `m:${m.key}`,
          date: dm(m.since),
          title: `${m.label}: ${m.to_label}`,
          info: `${S.before}${m.from_label}`,
        })),
        ...list.map((e) => ({
          key: String(e.note.id),
          date: dm(e.note.observed_at),
          title: e.note.title,
          info: `${noteSubject(e.note).name}${relation(e.note.thesis_relation)}`,
        })),
      ],
    },
    more: list.length
      ? {
          lead: S.detailsLead,
          items: list.map((e) => ({
            text: [b(`${e.note.title}.`), t(` ${clip(e.note.summary, 220)}`)],
            noteId: e.note.id,
            segment: null,
          })),
        }
      : null,
  };
}

function decide(c: CardContext): CardModel {
  const list = c.built?.decide ?? [];
  const done = list.filter((d) => c.choices[d.key]).length;
  const item = (d: DecideItem): DecideItemModel => {
    const choice = c.choices[d.key] ?? null;
    return {
      key: d.key,
      group: d.group,
      tone: d.tone,
      tag: d.tag,
      title: d.title,
      why: d.why,
      context: d.context || null,
      choice,
      // No answer is highlighted (the card never suggests a trade); a proposal's only one is.
      actions: d.actions.map((a, k) => ({
        action: a.action,
        label: a.label,
        look: choice === a.label ? "on" : k === 0 && d.kind === "proposal" && !choice ? "pri" : "",
        disabled: (!!choice && d.kind !== "proposal") || c.pending === d.key,
      })),
    };
  };
  const more = c.built?.more ?? 0;
  const rest = c.built?.rest;
  return {
    id: "decide",
    eyebrow: CARD_TITLE.decide,
    tone: "warn",
    pill: S.items(list.length),
    title: list.length === 1 ? S.oneWaits : S.manyWait(list.length),
    body: {
      kind: "decide",
      groups: DECIDE_GROUPS.filter((g) => list.some((d) => d.group === g)).map((g) => {
        const items = list.filter((d) => d.group === g);
        return { group: g, label: GROUP_LABEL[g], count: items.length, items: items.map(item) };
      }),
      hint: `${S.resolved(done, list.length)}${more ? S.moreInSignals(more) : ""}${rest ? S.restLine(rest.review, rest.research) : ""}${S.noTrade}`,
    },
    more: null,
  };
}

const entryType = (e: string) =>
  e === "trend"
    ? S.trend
    : e === "sentiment_correction"
      ? S.sentimentCorrection
      : S.specialSituation;

function ideas(c: CardContext): CardModel {
  const list = c.built?.ideas ?? [];
  return {
    id: "ideas",
    eyebrow: CARD_TITLE.ideas,
    tone: "info",
    pill: S.candidates(list.length),
    title: list.length === 1 ? S.oneIdea : S.manyIdeas(list.length),
    body: {
      kind: "ideas",
      items: list.map((n) => {
        const s = noteSubject(n);
        const kind = n.details?.entry_type;
        return {
          id: n.id,
          tag: `${S.candidate}${kind ? ` · ${entryType(kind)}` : ""}`,
          choice: c.choices[`i:${n.id}`] ?? null,
          name: s.name,
          sym: s.sym,
          why: n.details?.context ?? clip(n.summary, 160),
          busy: c.noteBusy === n.id,
        };
      }),
    },
    more: {
      lead: S.ideasLead,
      items: list.map((n) => ({
        text: [b(`${noteSubject(n).name}:`), t(` ${clip(n.summary, 220)}`)],
        noteId: n.id,
        segment: null,
      })),
    },
  };
}

function calendar(c: CardContext): CardModel {
  const cal = c.data.cal;
  const evs = (cal.data?.events ?? []).slice(0, 8);
  const mine = evs.filter((e) => e.instrument_id != null);
  const loading = cal.loading;
  return {
    id: "calendar",
    eyebrow: CARD_TITLE.calendar,
    tone: "info",
    pill: cal.data ? S.until(dm(cal.data.to)) : "...",
    title: loading
      ? S.loadingCalendar
      : !evs.length
        ? S.calmTwoWeeks
        : mine.length
          ? S.nextTwoWeeksOf(
              mine
                .slice(0, 2)
                .map((e) =>
                  e.title.replace(/^(?:Wyniki kwartalne|Quarterly results) /, S.resultsShort),
                )
                .join(", "),
            )
          : S.nextTwoWeeks,
    body: {
      kind: "calendar",
      loading,
      rows: evs.map((e, k) => {
        const tags: { text: string; mine: boolean }[] = [];
        if (e.country_label) tags.push({ text: e.country_label, mine: false });
        if (e.held === true) tags.push({ text: S.yourPosition, mine: true });
        if (e.held === false) tags.push({ text: S.watched, mine: true });
        if (e.kind === "research") tags.push({ text: S.fromResearch, mine: false });
        return { key: String(k), date: dm(e.date), time: e.time ?? "", title: e.title, tags };
      }),
      hint:
        cal.data?.stale || cal.error
          ? cal.error
            ? S.calendarUnavailable(String(cal.error))
            : S.calendarStale
          : null,
    },
    more: null,
  };
}

/** One card's eyebrow, pill, title, body and "Czytaj więcej" (old `cardFor`). */
export function cardModel(id: CardId, c: CardContext): CardModel {
  switch (id) {
    case "world":
      return world(c);
    case "sectors":
      return sectors(c);
    case "positions":
      return positions(c);
    case "events":
      return events(c);
    case "decide":
      return decide(c);
    case "ideas":
      return ideas(c);
    case "calendar":
      return calendar(c);
  }
}

/** The cards shown (summary excluded) and the agenda for the research agent (old SummaryCard / finish). */
export function agendaOf(
  built: BuiltDeck,
  verdicts: Partial<Record<CardId, Verdict>>,
  notes: Partial<Record<CardId, string>>,
) {
  const shown = built.cards.filter((c): c is CardId => c !== "summary");
  const agenda = shown.filter((id) => verdicts[id] === "flag" || (notes[id] ?? "").trim());
  return { shown, agenda };
}

export function summaryModel(
  built: BuiltDeck,
  verdicts: Partial<Record<CardId, Verdict>>,
  notes: Partial<Record<CardId, string>>,
  choices: Record<string, string>,
): SummaryModel {
  const { shown, agenda } = agendaOf(built, verdicts, notes);
  const decided = built.decide.filter((d) => choices[d.key]);
  return {
    title: summaryTitle(agenda.length),
    stats: [
      { value: shown.length, label: S.statCards(shown.length) },
      { value: decided.length, label: S.statDecisions(decided.length) },
      { value: agenda.length, label: S.statAgent },
    ],
    agenda: agenda.map((id) => ({
      id,
      title: CARD_TITLE[id],
      note: (notes[id] ?? "").trim() || null,
    })),
    decisions: decided.map((d) => ({ key: d.key, title: d.title, choice: choices[d.key] ?? "" })),
    skipped: built.skipped.length
      ? S.skipped(built.skipped.map((s) => `${CARD_TITLE[s.id]} (${s.why})`).join(", "))
      : null,
  };
}

/** The full research note in the bottom sheet (old `.rd-sheet`). */
export function sheetModel(note: ResearchNote): SheetModel {
  return {
    eyebrow: S.researchNote(dm(note.observed_at)),
    title: note.title,
    paragraphs: note.summary.split(/\n{2,}/),
    sources: note.sources.map((s) => ({
      url: s.url,
      text: `${s.publisher ? `${s.publisher}: ` : ""}${s.title ?? s.url}`,
    })),
  };
}
