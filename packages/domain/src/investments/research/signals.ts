/**
 * Research signals, pure part (`research/signals.py`): which note qualifies (severity), the dedup key
 * of its signal, the lead note and the signal candidate with its message. The lifecycle against
 * stored signals (`sync`, `reopen_dismissed`, the notification policy, the week's notes query) needs
 * the store and lives with the research services (S21b).
 *
 * A note that invalidates the thesis (severity `action`) or has strength 3 (severity `info`) becomes
 * a signal; one signal per instrument, market segment or (old) theme and ISO week of storing. The
 * signal shows its lead note (highest severity, then strength, then the newest). Candidate notes
 * never become signals.
 *
 * The message reaches the owner, so it is rendered in the UI language with the dashboard's labels:
 * `Analiza (wiadomość, podważa tezę): <title>; siła 3/3, 2 źródła`.
 */

import { pickLabel, type UiLang } from "../../core/i18n.js";
import { PyValueError } from "../../dates.js";
import { pyStrip } from "../../text.js";
import { SignalSeverity, severityRank } from "../domain/enums.js";
import { asInstrumentId } from "../domain/values.js";
import type { SignalCandidate } from "../rules/index.js";
import { type Instant, instantDate } from "./instant.js";
import { researchDedupKey, researchRuleId } from "./keys.js";
import { CANDIDATE_KIND, isoWeek } from "./scoring.js";
import { segmentLabel } from "./segments.js";
import { themeKey } from "./themes.js";

export const CLOSED_DISMISSED = "note_dismissed";
export const CLOSED_EXPIRED = "notes_expired";

/** Polish labels of note kinds, as in the dashboard (`KIND_LABEL` in v2/research/logic.ts). */
export const KIND_LABEL: ReadonlyMap<string, string> = new Map([
  ["news", "wiadomość"],
  ["earnings", "wyniki"],
  ["community", "społeczność · szum"],
  ["trend", "trend"],
  ["macro", "makro"],
  ["candidate", "kandydat"],
]);

/** Polish labels of the thesis relations a message names (`neutral` / `none` are left out). */
export const RELATION_LABEL: ReadonlyMap<string, string> = new Map([
  ["invalidates", "podważa tezę"],
  ["weakens", "osłabia tezę"],
  ["supports", "wzmacnia tezę"],
  ["fulfills", "spełnia tezę"],
]);

/** English labels of note kinds (`KIND_LABEL` in v2/research/logic.strings.ts). */
export const KIND_LABEL_EN: ReadonlyMap<string, string> = new Map([
  ["news", "news"],
  ["earnings", "earnings"],
  ["community", "community · noise"],
  ["trend", "trend"],
  ["macro", "macro"],
  ["candidate", "candidate"],
]);

/** English labels of the thesis relations (`RELATION_LABEL` in v2/research/logic.strings.ts). */
export const RELATION_LABEL_EN: ReadonlyMap<string, string> = new Map([
  ["invalidates", "invalidates the thesis"],
  ["weakens", "weakens the thesis"],
  ["supports", "supports the thesis"],
  ["fulfills", "fulfills the thesis"],
]);

/** Polish plural: 1 źródło, 2-4 źródła (not 12-14), 0 / 5+ źródeł; English 1 source, 2 sources. */
export function sourcesPhrase(count: number, lang: UiLang): string {
  if (lang === "en") return `${count} ${Math.abs(count) === 1 ? "source" : "sources"}`;
  if (count === 1) return "1 źródło";
  const mod10 = ((count % 10) + 10) % 10;
  const mod100 = ((count % 100) + 100) % 100;
  if ((mod10 === 2 || mod10 === 3 || mod10 === 4) && !(mod100 >= 12 && mod100 <= 14)) {
    return `${count} źródła`;
  }
  return `${count} źródeł`;
}

/**
 * The signal message of a lead note: `Analiza (<kind>, <relation>): <title>; siła N/3, <sources>`
 * (an unknown kind shows as is; a relation outside `RELATION_LABEL` is left out).
 */
export function researchMessage(
  kind: string,
  relation: string | null,
  title: string,
  strength: number,
  sources: number,
  lang: UiLang,
): string {
  const label = (lang === "en" ? KIND_LABEL_EN : KIND_LABEL).get(kind) ?? kind;
  const relationText = (lang === "en" ? RELATION_LABEL_EN : RELATION_LABEL).get(relation ?? "");
  const head = relationText ? `${label}, ${relationText}` : label;
  const phrase = sourcesPhrase(sources, lang);
  return pickLabel(
    lang,
    `Analiza (${head}): ${title}; siła ${strength}/3, ${phrase}`,
    `Analysis (${head}): ${title}; strength ${strength}/3, ${phrase}`,
  );
}

/** What the signal logic reads from a stored research note (aware UTC instants). */
export interface ResearchNoteRecord {
  readonly id: number | null;
  readonly kind: string;
  readonly polarity: string;
  readonly strength: number;
  readonly thesisRelation: string;
  readonly thesisField: string | null;
  readonly title: string;
  /** The stored source list (only its length is read). */
  readonly sources: readonly unknown[] | null;
  readonly details: unknown;
  readonly instrumentId: string | null;
  readonly segment: string | null;
  readonly theme: string | null;
  readonly createdAt: Instant;
  readonly expiresAt: Instant;
  readonly dismissedAt: Instant | null;
}

/** The severity a note's signal would have at `at` (null: the note does not qualify). */
export function severityOf(note: ResearchNoteRecord, at: Instant): SignalSeverity | null {
  if (note.kind === CANDIDATE_KIND || note.dismissedAt !== null) return null;
  if (note.expiresAt <= at) return null;
  if (note.instrumentId === null && !note.segment && !note.theme) return null;
  if (note.thesisRelation === "invalidates") return SignalSeverity.ACTION;
  if (note.strength >= 3) return SignalSeverity.INFO;
  return null;
}

/**
 * The dedup key of the signal this note would create or join (null for candidates and notes without
 * an instrument, segment or theme).
 */
export function noteKey(note: ResearchNoteRecord): string | null {
  if (note.kind === CANDIDATE_KIND) return null;
  const week = isoWeek(instantDate(note.createdAt));
  if (note.instrumentId !== null)
    return researchDedupKey(week, { instrumentId: note.instrumentId });
  if (note.segment) return researchDedupKey(week, { segment: note.segment });
  if (note.theme) return researchDedupKey(week, { theme: themeKey(note.theme) });
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python truthiness of a decoded JSON value. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return !!value;
}

/** The note's plain-language sentence (`details.headline`, else the brief's), for the review deck. */
export function noteHeadline(note: ResearchNoteRecord): string | null {
  const details = isPlainObject(note.details) ? note.details : {};
  const brief = isPlainObject(details.brief) ? details.brief : {};
  const value = truthy(details.headline) ? details.headline : brief.headline;
  if (typeof value !== "string") return null;
  return pyStrip(value) || null;
}

/** The qualifying notes, lead first (severity, strength, newest, id; ties keep their order). */
export function leadNotes(notes: Iterable<ResearchNoteRecord>, at: Instant): ResearchNoteRecord[] {
  const qualifying: { n: ResearchNoteRecord; rank: number; i: number }[] = [];
  let i = 0;
  for (const n of notes) {
    const severity = severityOf(n, at);
    if (severity !== null) qualifying.push({ n, rank: severityRank(severity), i: i++ });
  }
  qualifying.sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    if (a.n.strength !== b.n.strength) return b.n.strength - a.n.strength;
    if (a.n.createdAt !== b.n.createdAt) return a.n.createdAt > b.n.createdAt ? -1 : 1;
    const ida = a.n.id ?? 0;
    const idb = b.n.id ?? 0;
    if (ida !== idb) return idb - ida;
    return a.i - b.i;
  });
  return qualifying.map(({ n }) => n);
}

const POLARITIES = new Set(["positive", "negative", "neutral"]);

/**
 * What a research signal wants to become (or refresh) as a stored signal: the fields of the rules'
 * `SignalCandidate`.
 */
export type ResearchSignalCandidate = SignalCandidate;

/** The signal candidate of `key` from its notes (null when no note qualifies). */
export function candidateFor(
  key: string,
  notes: Iterable<ResearchNoteRecord>,
  at: Instant,
  lang: UiLang,
): ResearchSignalCandidate | null {
  const ordered = leadNotes(notes, at);
  const lead = ordered[0];
  if (lead === undefined) return null;
  const severity = severityOf(lead, at) as SignalSeverity;
  const sources = (lead.sources ?? []).length;
  const message = researchMessage(
    lead.kind,
    lead.thesisRelation,
    lead.title,
    lead.strength,
    sources,
    lang,
  );
  const week = key.split("|", 1)[0]?.replace(/^research:/, "") ?? "";
  if (!POLARITIES.has(lead.polarity)) {
    throw new PyValueError(`'${lead.polarity}' is not a valid SignalPolarity`);
  }
  return {
    ruleId: researchRuleId(lead.kind),
    kind: researchRuleId(lead.kind),
    dedupKey: key,
    severity,
    message,
    instrumentId: lead.instrumentId === null ? null : asInstrumentId(lead.instrumentId),
    accountId: null,
    payload: {
      note_id: lead.id,
      note_ids: ordered.map((n) => n.id),
      notes: ordered.length,
      kind: lead.kind,
      relation: lead.thesisRelation,
      thesis_field: lead.thesisField,
      strength: lead.strength,
      sources,
      title: lead.title,
      headline: noteHeadline(lead),
      theme: lead.theme,
      segment: lead.segment,
      segment_label: lead.segment ? segmentLabel(lead.segment, lang) : null,
      week,
    },
    polarity: lead.polarity as "positive" | "negative" | "neutral",
  };
}
