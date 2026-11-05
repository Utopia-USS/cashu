// Research in the asset detail (ab24ab6 v2/research/AssetResearch.tsx): the thesis health of the position
// (useAssetHealth), whether the block shows (useResearchShown), the Research widget (one summary row with the
// 8-week sentiment, then one row per note) and the health pill of the Teza header (ThesisHealth). Pure data for
// AssetResearchView; the texts are the old catalogs.
import { S } from "@cashu/i18n/investments/v2/research/AssetResearch.strings";
import { S as P } from "@cashu/i18n/investments/v2/research/primitives.strings";
import type { HealthPillProps, NoteRowProps } from "@cashu/ui";
import { localDay } from "@cashu/ui-logic/core/time";
import { dm, wdm } from "@cashu/ui-logic/investments/labels";
import type { Thesis } from "@cashu/ui-logic/investments/types";
import {
  addDays,
  countsText,
  DIRECTION_LABEL,
  DIRECTION_TONE,
  direction,
  HEALTH_CLS,
  HEALTH_LABEL,
  healthOf,
  healthStale,
  isExpired,
  isRestorable,
  latestRun,
  nNotes,
  noteRowTitle,
  relationCounts,
  relationIcon,
  runTag,
  safeUrl,
  sentiment8w,
  sentimentBars,
  sourceParts,
  summaryWithoutCriteria,
  thesisHealth,
  weekLabels,
  weekStarts,
  windowStart,
} from "@cashu/ui-logic/investments/v2/research/logic";
import type {
  HealthKey,
  ResearchNote,
  ResearchRun,
  ResearchSummary,
} from "@cashu/ui-logic/investments/v2/research/types";

export interface AssetResearchInputs {
  instrumentId: number;
  held: boolean;
  thesis: Thesis | null;
  /** The instrument's notes, dismissed and expired included (old useInstrumentNotes). */
  notes: ResearchNote[];
  summary: ResearchSummary | null;
  runs: ResearchRun[];
  /** The calendar day (old `todayIso()` fallback). */
  today: string;
}

/** useAssetHealth: the summary's value, else derived from the notes (30 days, reset on a thesis edit). */
function assetHealth(p: AssetResearchInputs) {
  const row = p.summary?.instruments.find((x) => x.instrument_id === p.instrumentId) ?? null;
  const today = p.summary?.as_of?.slice(0, 10) ?? p.today;
  const notes = p.notes;
  const from = windowStart(today, p.thesis?.updated_at ?? null);
  const window = notes.filter(
    (n) =>
      !n.dismissed_at &&
      !isExpired(n, today) &&
      (localDay(n.observed_at) ?? "") >= from &&
      n.kind !== "candidate",
  );
  const researchedAt = row?.last_researched_at ?? null;
  const health: HealthKey = row?.health
    ? healthOf(row, today)
    : thesisHealth({
        hasThesis: !!p.thesis,
        notes,
        today,
        thesisEditedAt: p.thesis?.updated_at ?? null,
        researchedAt,
      });
  return { row, today, window, health, ran: p.runs.length > 0 };
}

/** Watched instruments show the block only with live notes; held ones always (useResearchShown). */
export function researchShown(p: AssetResearchInputs): boolean {
  const r = assetHealth(p);
  return p.held || p.notes.some((n) => !n.dismissed_at && !isExpired(n, r.today));
}

/** HealthPill (primitives.tsx): the old class list as tone / dashed / muted. */
function healthPill(
  state: HealthKey,
  o: { muted?: boolean; pre?: boolean; title?: string },
): HealthPillProps {
  const cls = HEALTH_CLS[state] ?? "";
  const base = o.title ?? P.thesisState(HEALTH_LABEL[state]);
  const hollow = !!o.pre && !o.muted;
  const tone =
    cls === "sup" || cls === "weak" || cls === "inv" || cls === "ful" ? cls : ("plain" as const);
  return {
    label: HEALTH_LABEL[state],
    tone,
    dashed: cls.includes("none"),
    muted: !!o.muted || cls.includes("muted"),
    hollow,
    title: hollow ? P.researchPredates(base) : base,
  };
}

/** ThesisHealth: the pill of the Teza header, only after research ran and for a held instrument. */
export function thesisHealthPill(p: AssetResearchInputs): HealthPillProps | null {
  const r = assetHealth(p);
  if (!r.ran || !p.held) return null;
  const latest = p.notes.find((n) => !n.dismissed_at);
  const counts = r.row?.counts ?? relationCounts(r.window);
  const title = [
    countsText(r.health, counts, { notes: r.window.length, latestPolarity: latest?.polarity }),
    r.health === "no_thesis" ? null : S.days30,
  ]
    .filter(Boolean)
    .join(" · ");
  return healthPill(r.health, {
    muted: healthStale(p.runs, p.today),
    pre: !!r.row?.health_predates_thesis,
    title: title || undefined,
  });
}

/** The zloty sign as Polish formatting writes it (the old pattern's literal sign). */
const ZL =
  new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" })
    .formatToParts(0)
    .find((part) => part.type === "currency")?.value ?? "PLN";
/** Quoted thesis words and amounts with a unit (primitives.tsx richSummary). */
const RICH_SOURCE = `(„[^”"]{1,80}[”"]|[+\\-−]?\\d+(?:[.,]\\d+)?\\s?(?:%|pp|pb|mld\\s?\\$|mln\\s?\\$|mld\\s?${ZL}|mln\\s?${ZL}|${ZL}|\\$|€)(?:\\s?r\\/r|\\s?m\\/m)?)`;

/** Summary text with numbers and quoted thesis words in bold (primitives.tsx richSummary), as text parts. */
function richParts(text: string): { text: string; bold: boolean; key: string }[] {
  const re = new RegExp(RICH_SOURCE, "g");
  const out: { text: string; bold: boolean; key: string }[] = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false, key: `t${last}` });
    out.push({ text: m[0], bold: true, key: `b${m.index}` });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false, key: `t${last}` });
  return out;
}

type NoteRowModel = Omit<NoteRowProps, "summary" | "onToggle" | "restore" | "dismiss" | "badge"> & {
  noteId: number;
  /** `sprzed zmiany tezy` (PreTag) when the note predates the thesis' last change. */
  badge: string | null;
  summary: ReturnType<typeof richParts> | null;
  restore: { text: string; action: string } | null;
  dismiss: { label: string } | null;
  note: ResearchNote;
};

/** The Research widget (AssetResearch): never ran / the summary row and the note rows. */
export function assetResearchModel(
  p: AssetResearchInputs,
  ui: { older: boolean; openId: number | null; highlightId: number | null; now: number },
) {
  const r = assetHealth(p);
  if (!r.ran) return { ran: false as const, title: S.research, tag: S.neverRan, empty: S.noNotes };
  const notes = [...p.notes].sort((a, b) => b.observed_at.localeCompare(a.observed_at));
  const cutoff = addDays(r.today, -30);
  const canRestore = (n: ResearchNote) => isRestorable(n, ui.now);
  const recent = notes.filter(
    (n) =>
      (localDay(n.observed_at) ?? "") >= cutoff &&
      !isExpired(n, r.today) &&
      (!n.dismissed_at || canRestore(n)),
  );
  const old = notes.filter((n) => !recent.includes(n) && !n.dismissed_at);
  const last = latestRun(p.runs);
  const tag = runTag(p.runs, r.today);
  const weeks = p.summary?.week_starts?.length === 8 ? p.summary.week_starts : weekStarts(r.today);
  const values = r.row?.sentiment_8w?.length ? r.row.sentiment_8w : sentiment8w(notes, r.today);
  const dir = r.row?.direction ? r.row.direction : direction(values);
  const dirKey = (["up", "down", "flat"].includes(String(dir)) ? dir : direction(values)) as
    | "up"
    | "down"
    | "flat";
  const live = recent.filter((n) => !n.dismissed_at);
  const all = notes.filter((n) => !n.dismissed_at).length;
  const shown = ui.older ? [...recent, ...old] : recent;
  const desc = values
    .map((v) => (v == null ? P.noWeekData : v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1)))
    .join(", ");
  const rows: NoteRowModel[] = shown.map((n) => {
    const rel = relationIcon(n.thesis_relation);
    const dismissed = !!n.dismissed_at;
    const body = summaryWithoutCriteria(n.summary);
    return {
      noteId: n.id,
      note: n,
      id: `note-${n.id}`,
      title: n.title,
      badge: n.predates_thesis ? P.predatesThesis : null,
      tip: noteRowTitle(n, r.today),
      relation: { tone: rel.cls, glyph: rel.glyph, label: rel.label },
      open: ui.openId === n.id,
      dim: dismissed || isExpired(n, r.today),
      highlight: ui.highlightId === n.id,
      summary: body ? richParts(body) : null,
      sources: {
        label: P.sourcesN(n.sources.length),
        items: n.sources.map((s) => {
          const parts = sourceParts(s);
          const url = safeUrl(s.url);
          return { who: parts.who, url, title: s.title ?? url ?? undefined, date: parts.date };
        }),
      },
      restore:
        dismissed && canRestore(n)
          ? { text: P.dismissedOn(dm(n.dismissed_at)), action: P.restore }
          : null,
      dismiss: dismissed ? null : { label: P.dismiss },
    };
  });
  return {
    ran: true as const,
    title: S.research,
    head:
      tag.state === "fresh" && last
        ? {
            kind: "sub" as const,
            text: `${nNotes(live.length)} · ${wdm(last.finished_at ?? last.started_at)}`,
          }
        : { kind: "tag" as const, text: tag.text, tone: tag.tone },
    toggle:
      notes.length > recent.length && old.length > 0 ? (ui.older ? S.only30 : S.allN(all)) : null,
    sentiment: {
      label: S.sentiment8w,
      value: DIRECTION_LABEL[dirKey],
      tone: DIRECTION_TONE[dirKey],
      bars: {
        label: P.sentimentAria(desc),
        labels: weekLabels(weeks),
        layout: (w: number, h: number, band: number) => sentimentBars(values, w, h, band),
      },
    },
    empty: S.noNotes30,
    rows,
    olderIds: old.map((n) => n.id),
  };
}
export type AssetResearchModel = ReturnType<typeof assetResearchModel>;
