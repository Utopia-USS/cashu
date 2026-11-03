import { addDays } from "@cashu/domain";
import type { ResearchScreenSnapshot } from "@cashu/store/investments/research-screen";
import { localDay } from "@cashu/ui-logic/core/time";
import { S } from "./Research.strings.js";
import type { ResearchNote, ResearchRun } from "./types.js";

/** DateText only accepts a calendar day; keep the source instant for ordering and age checks. */
export const researchDisplayDay = (instant: string | null | undefined): string | null =>
  localDay(instant);

export const researchField = (value: unknown, key: string) =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

export const researchStringField = (value: unknown, key: string): string | null => {
  const found = researchField(value, key);
  return typeof found === "string" ? found : null;
};

/** Sourced figures only; no investment verdict is inferred from missing or partial values. */
export function researchValuationFacts(value: unknown) {
  const number = (key: string) => {
    const found = researchField(value, key);
    return typeof found === "number" && Number.isFinite(found) ? found : null;
  };
  return {
    pe: number("pe"),
    forwardPe: number("forward_pe"),
    epsGrowth: number("eps_growth"),
    peAverage5y: number("pe_avg_5y"),
    basis: researchStringField(value, "basis"),
  };
}

export function researchNoteDates(note: ResearchNote) {
  return {
    observed: researchDisplayDay(note.observed_at),
    expires: researchDisplayDay(note.expires_at),
    cooldown: researchDisplayDay(note.cooldown_until),
    restorable: researchDisplayDay(note.restorable_until),
  };
}

function safeResearchUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function researchNoteFacts(note: ResearchNote) {
  const criteria = Array.isArray(note.details?.criteria)
    ? note.details.criteria.filter(
        (value): value is { text: string; met: boolean; threshold?: string | number | null } =>
          typeof value === "object" &&
          value !== null &&
          "text" in value &&
          "met" in value &&
          typeof value.text === "string" &&
          typeof value.met === "boolean",
      )
    : [];
  return {
    accepted: note.candidate?.accepted_at != null,
    candidateName: researchStringField(note.candidate, "name"),
    candidateSymbol: researchStringField(note.candidate, "symbol"),
    candidateExchange:
      researchStringField(note.candidate, "exchange") ??
      researchStringField(note.instrument, "mic"),
    entryType: researchStringField(note.details, "entry_type"),
    context: researchStringField(note.details, "context"),
    criteria,
    metCount: criteria.filter((item) => item.met).length,
    sources: note.sources.map((source) => ({
      key: JSON.stringify(source),
      url: safeResearchUrl(source.url),
      title:
        researchStringField(source, "title") ??
        researchStringField(source, "publisher") ??
        S.source,
    })),
  };
}

export type ResearchNoteRow =
  | { readonly kind: "day"; readonly day: string }
  | { readonly kind: "note"; readonly note: ResearchNote; readonly observedDay: string | null };

export function researchNoteGroups(notes: readonly ResearchNote[]): ResearchNoteRow[] {
  const grouped: ResearchNoteRow[] = [];
  let previous = "";
  for (const note of notes) {
    const day = researchDisplayDay(note.observed_at ?? note.created_at) ?? "";
    if (day !== previous) {
      grouped.push({ kind: "day", day });
      previous = day;
    }
    grouped.push({ kind: "note", note, observedDay: researchDisplayDay(note.observed_at) });
  }
  return grouped;
}

export function researchRunScope(run: ResearchRun): string {
  return [
    run.scope.held ? S.heldScope : null,
    run.scope.watchlist ? S.watchedScope : null,
    run.scope.candidates ? S.candidateScope : null,
    run.full_refresh ? S.fullRefresh : null,
    ...run.scope.themes.map(String),
    ...run.scope.segments.map(String),
  ]
    .filter(Boolean)
    .join(", ");
}

export function researchCalendarModel(data: ResearchScreenSnapshot) {
  if (data.status !== "current" || data.calendar.status !== "current") return null;
  const weekEnd = addDays(data.today, 7);
  const days = new Map<string, typeof data.calendar.value.events>();
  for (const event of data.calendar.value.events) {
    days.set(event.date, [...(days.get(event.date) ?? []), event]);
  }
  return {
    stale: data.calendar.value.stale,
    errors: data.calendar.value.errors,
    weekCount: data.calendar.value.events.filter(
      (event) => event.date >= data.today && event.date <= weekEnd,
    ).length,
    days: [...days].map(([date, events]) => ({
      date,
      groups: (["earnings", "macro", "research"] as const)
        .map((kind) => ({
          kind,
          events: events
            .filter((event) => event.kind === kind)
            .sort((a, b) => Number(b.held === true) - Number(a.held === true)),
        }))
        .filter((group) => group.events.length > 0),
    })),
  };
}

export function researchTopicsModel(data: ResearchScreenSnapshot) {
  if (data.status !== "current" || data.segments1w.status !== "current") return null;
  return data.segments1w.value.segments.map((row) => ({
    ...row,
    headline: researchStringField(row.note, "title"),
    assessment: researchStringField(row.thesis, "assessment"),
    outlook: researchStringField(row.thesis, "outlook"),
    draft: researchField(row.thesis, "draft") === true,
    quiet: row.note === null && row.thesis !== null,
    valuationDay: researchDisplayDay(researchStringField(row.valuation, "observed_at")),
    valuationSource: Array.isArray(researchField(row.valuation, "sources"))
      ? (researchField(row.valuation, "sources") as unknown[])
          .filter((s): s is string => typeof s === "string")
          .join(", ")
      : null,
    valuationFacts: researchValuationFacts(row.valuation),
  }));
}

export function researchHeldModel(data: ResearchScreenSnapshot) {
  if (data.status !== "current" || data.summary.status !== "current") return null;
  const rank: Record<string, number> = { invalidated: 0, weakened: 1, fulfilled: 2, supported: 3 };
  const through = addDays(data.today, 14);
  return data.summary.value.instruments
    .filter((row) => row.held)
    .map((row) => ({
      ...row,
      earnings:
        data.calendar.status === "current"
          ? (data.calendar.value.events.find(
              (event) =>
                event.kind === "earnings" &&
                event.instrument_id === row.instrument_id &&
                event.date >= data.today &&
                event.date <= through,
            ) ?? null)
          : null,
    }))
    .sort(
      (a, b) => (rank[a.health] ?? 4) - (rank[b.health] ?? 4) || a.label.localeCompare(b.label),
    );
}

export function researchScopeModel(data: ResearchScreenSnapshot) {
  if (data.status !== "current") return null;
  return {
    strategyVersion: data.strategyVersion,
    strategyChanged: data.strategyChanged,
    held:
      data.summary.status === "current"
        ? data.summary.value.instruments.filter((row) => row.held).length
        : null,
    watched:
      data.summary.status === "current"
        ? data.summary.value.instruments.filter((row) => row.watched).length
        : null,
  };
}

export function researchHomeModel(data: ResearchScreenSnapshot) {
  if (data.status !== "current") return null;
  if (data.lastRun === null && data.macro.status !== "current") return null;
  const topics = data.segments1w.status === "current" ? data.segments1w.value.segments : [];
  const weak =
    data.summary.status === "current"
      ? data.summary.value.instruments.filter(
          (row) => row.held && (row.health === "invalidated" || row.health === "weakened"),
        )
      : [];
  const through = addDays(data.today, 7);
  const events =
    data.calendar.status === "current"
      ? data.calendar.value.events
          .filter((event) => event.date >= data.today && event.date <= through)
          .slice(0, 7)
      : [];
  return {
    data,
    riskSummary:
      data.macro.status === "current"
        ? (data.macro.value.find((regime) => regime.key === "risk")?.summary ?? null)
        : null,
    weak,
    events,
    quiet: topics.filter((row) => row.note === null && row.thesis !== null),
    draftCount: topics.filter((row) => researchField(row.thesis, "draft") === true).length,
    topics: topics.slice(0, 8).map((row) => ({
      ...row,
      headline: researchStringField(row.note, "title"),
      outlook: researchStringField(row.thesis, "outlook"),
      valuationDay: researchDisplayDay(researchStringField(row.valuation, "observed_at")),
      valuationFacts: researchValuationFacts(row.valuation),
    })),
  };
}

export function researchCandidateRail(data: ResearchScreenSnapshot) {
  if (data.status !== "current" || data.lastRun === null) return null;
  return data.candidateRail.map((note) => ({
    note,
    day: researchDisplayDay(note.observed_at),
    facts: researchNoteFacts(note),
  }));
}

export function researchAssetModel(
  data: ResearchScreenSnapshot,
  instrument: string,
  held: boolean,
  today: string,
  noteGid: string | null | undefined,
  older: boolean,
) {
  if (data.status !== "current" && data.status !== "partial") return null;
  const rows = data.notes.filter(
    (row) => row.instrument_id === instrument && row.kind !== "candidate",
  );
  const summary =
    data.status === "current" && data.summary.status === "current"
      ? (data.summary.value.instruments.find((row) => row.instrument_id === instrument) ?? null)
      : null;
  if (!held && !summary?.held && !rows.some((row) => !row.expired && !row.dismissed)) return null;
  const cutoff = addDays(today, -30);
  const recent = rows.filter(
    (row) =>
      (row.observed_at ?? row.created_at ?? "").slice(0, 10) >= cutoff &&
      !row.expired &&
      !row.dismissed,
  );
  const hidden = rows.filter((row) => !recent.includes(row) && !row.dismissed);
  const shown = [
    ...recent,
    ...(older || (noteGid && hidden.some((row) => row.id === noteGid)) ? hidden : []),
  ];
  const run = data.runs.find((item) => item.id === data.lastRun);
  const runDay = researchDisplayDay(run?.finished_at ?? run?.started_at);
  return {
    data,
    summary,
    focusedNote: noteGid ?? null,
    runStatus: run?.status ?? null,
    runDay,
    runFreshness:
      run?.status === "done" && runDay !== null
        ? runDay < addDays(today, -7)
          ? "stale"
          : "fresh"
        : null,
    lastResearchDay: researchDisplayDay(summary?.last_researched_at),
    shown: shown.map((note) => ({ note, day: researchDisplayDay(note.observed_at) })),
    hasOlder: hidden.length > 0 && !older,
  };
}

export function researchTopicModel(
  data: ResearchScreenSnapshot,
  key: string | null,
  notes: readonly ResearchNote[],
  viewUpdatedAt: string | null | undefined,
  viewSources: readonly Readonly<Record<string, unknown>>[],
) {
  if (!key) return null;
  const isMacro = key.startsWith("macro_");
  const macro =
    isMacro && data.status === "current" && data.macro.status === "current"
      ? (data.macro.value.find((row) => `macro_${row.key}` === key) ?? null)
      : null;
  const segment =
    !isMacro && data.status === "current" && data.segments1w.status === "current"
      ? (data.segments1w.value.segments.find((row) => row.segment === key) ?? null)
      : null;
  return {
    key,
    isMacro,
    macro,
    segment,
    title: macro?.label ?? segment?.label ?? key,
    related: notes
      .filter((row) => row.segment === key)
      .map((note) => ({ note, day: researchDisplayDay(note.observed_at) })),
    members: segment ? [...segment.instruments, ...(segment.member_instruments ?? [])] : [],
    viewUpdatedDay: researchDisplayDay(viewUpdatedAt),
    viewSources: viewSources.map((source) => ({
      key: JSON.stringify(source),
      title:
        researchStringField(source, "publisher") ??
        researchStringField(source, "title") ??
        S.source,
      url: safeResearchUrl(researchField(source, "url")),
    })),
    valuationDay: researchDisplayDay(researchStringField(segment?.valuation, "observed_at")),
    valuationSources: Array.isArray(researchField(segment?.valuation, "sources"))
      ? (researchField(segment?.valuation, "sources") as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : [],
    valuationFacts: researchValuationFacts(segment?.valuation),
    macroSupports: Array.isArray(macro?.brief?.supports)
      ? macro.brief.supports.filter((s): s is string => typeof s === "string")
      : [],
    macroRisks: Array.isArray(macro?.brief?.risks)
      ? macro.brief.risks.filter((s): s is string => typeof s === "string")
      : [],
  };
}

export function researchHealthLabel(value: string): string {
  switch (value) {
    case "invalidated":
      return S.healthInvalidated;
    case "weakened":
      return S.healthWeakened;
    case "fulfilled":
      return S.healthFulfilled;
    case "supported":
      return S.healthSupported;
    case "current":
      return S.healthCurrent;
    case "no_research":
      return S.healthNoResearch;
    case "no_thesis":
      return S.healthNoThesis;
    default:
      return S.unavailable;
  }
}

export function researchRelationLabel(value: string): string | null {
  switch (value) {
    case "supports":
      return S.healthSupported;
    case "weakens":
      return S.healthWeakened;
    case "invalidates":
      return S.healthInvalidated;
    case "fulfills":
      return S.healthFulfilled;
    default:
      return null;
  }
}

export function researchRunStatus(value: string): string {
  switch (value) {
    case "done":
      return S.runDone;
    case "running":
      return S.runRunning;
    default:
      return S.runFailed;
  }
}
