/// <reference types="node" />
// Differential tests against Python (parity/python/generators/domain/research_vectors.py): every section replays
// the oracle's synthetic inputs through the TS port and expects the same output. Regenerate with
// `.venv/bin/python parity/python/generators/domain/research_vectors.py` after a Python change.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pyCasefold } from "../../casefold.js";
import { PyOverflowError } from "../../dates.js";
import { floatRepr } from "../../decimal.js";
import { expectAll, loadVectors, Mismatches } from "../../testing/vectors.js";
import { type AssetClass, SignalSeverity } from "../domain/enums.js";
import { AliasNamespace, instrument, instrumentAlias } from "../domain/instrument.js";
import { asInstrumentId, Currencies } from "../domain/values.js";
import {
  FULFILLS_THESIS_FIELDS,
  RESEARCH_CANDIDATE_COOLDOWN_DAYS,
  RESEARCH_CREATORS,
  RESEARCH_NOTE_KINDS,
  RESEARCH_NOTE_TTL_DAYS,
  RESEARCH_POLARITIES,
  RESEARCH_RESTORE_MINUTES,
  RESEARCH_RUN_STATUSES,
  RESEARCH_SUMMARY_MAX,
  RESEARCH_THESIS_FIELDS,
  RESEARCH_THESIS_RELATIONS,
  RESEARCH_TITLE_MAX,
  THESIS_ENTRY_TYPES,
} from "./contract.js";
import { formatInstant, type Instant, utcInstant } from "./instant.js";
import { isResearchKey, RESEARCH_PREFIX, researchDedupKey } from "./keys.js";
import { parseMoment } from "./moment.js";
import {
  ADVICE_CORE_PATTERN,
  ADVICE_PATTERN,
  ATTRIBUTION_PATTERN,
  FORECAST_PATTERN,
  INSTITUTION_PATTERN,
  MARKET_ADVICE_PATTERN,
  NOT_INSTITUTIONAL_PATTERN,
  PERIOD_PATTERN,
  PRICE_CALL_PATTERN,
  SENTENCE_PATTERN,
  SPAN_PATTERN,
  YEAR_PATTERN,
} from "./patterns.js";
import {
  direction,
  isoWeek,
  type ScoredNote,
  sentimentWeeks,
  thesisHealth,
  weekStart,
} from "./scoring.js";
import {
  autoSegment,
  bareSymbol,
  catalog,
  catalogOrder,
  FUNDS,
  isMacroKey,
  isNoteSegment,
  isSegment,
  LEGACY_KEYS,
  MACRO_SEGMENTS,
  macroCatalog,
  regimeOf,
  SEGMENTS,
  STABLECOINS,
  segmentGroup,
  segmentLabel,
  segmentOf,
  UNASSIGNED,
  UNASSIGNED_LABEL,
  UNASSIGNED_LABEL_EN,
} from "./segments.js";
import {
  candidateFor,
  KIND_LABEL,
  KIND_LABEL_EN,
  noteKey,
  RELATION_LABEL,
  RELATION_LABEL_EN,
  type ResearchNoteRecord,
  researchMessage,
  severityOf,
  sourcesPhrase,
} from "./signals.js";
import {
  body,
  DOWN_WORDS,
  directions,
  numbers,
  STOPWORDS_TEXT,
  tokens,
  UP_WORDS,
} from "./similarity.js";
import {
  FENCE_PATTERN,
  foldHeading,
  HEADING_PATTERN,
  SECTION_KEYWORDS,
  sectionKind,
  strategySections,
} from "./strategyText.js";
import { cleanTheme, themeKey } from "./themes.js";
import { BYPASS_HOSTS, CONTROL_PATTERN, checkUrl } from "./url.js";
import {
  BRIEF_KEYS,
  CANDIDATE_SYMBOL_PATTERN,
  COMMUNITY_SCALES,
  CURRENCY_PATTERN,
  candidateJson,
  candidateKey,
  DETAILS_KEYS,
  EXCHANGE_PATTERN,
  type NoteInput,
  noteExpiresAt,
  noteSourcesJson,
  ResearchInputError,
  RUN_COUNT_KEYS,
  SEGMENT_NOTE_KINDS,
  TOPIC_THESIS_RELATIONS,
  VALUATION_KEYS,
  validateAssessment,
  validateCounts,
  validateNote,
  validateOutlook,
  validateScope,
  validateViewSources,
} from "./validation.js";

const NOW = utcInstant("2026-10-09", 12);
type Row = readonly unknown[];

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function pairs(map: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>): unknown[] {
  return map instanceof Map ? [...map].map(([k, v]) => [k, v]) : Object.entries(map);
}

/** The outcome of a validation call as the generator writes it. */
function outcome(fn: () => unknown): unknown {
  try {
    return { ok: fn() };
  } catch (error) {
    if (!(error instanceof ResearchInputError)) throw error;
    return { issues: error.issues.map((i) => [...i]), message: error.message };
  }
}

describe("research word lists (byte hash vs the Python module)", () => {
  const ours: Record<string, unknown> = {
    FORECAST: FORECAST_PATTERN,
    ADVICE_CORE: ADVICE_CORE_PATTERN,
    ADVICE: ADVICE_PATTERN,
    MARKET_ADVICE: MARKET_ADVICE_PATTERN,
    PRICE_CALL: PRICE_CALL_PATTERN,
    SENTENCE: SENTENCE_PATTERN,
    INSTITUTION: INSTITUTION_PATTERN,
    ATTRIBUTION: ATTRIBUTION_PATTERN,
    NOT_INSTITUTIONAL: NOT_INSTITUTIONAL_PATTERN,
    YEAR: YEAR_PATTERN,
    SPAN: SPAN_PATTERN,
    PERIOD: PERIOD_PATTERN,
    CANDIDATE_SYMBOL: CANDIDATE_SYMBOL_PATTERN,
    EXCHANGE: EXCHANGE_PATTERN,
    CURRENCY: CURRENCY_PATTERN,
    CONTROL: CONTROL_PATTERN,
    BYPASS_HOSTS,
    DETAILS_KEYS,
    VALUATION_KEYS,
    BRIEF_KEYS,
    RUN_COUNT_KEYS,
    COMMUNITY_SCALES,
    SEGMENT_NOTE_KINDS,
    TOPIC_THESIS_RELATIONS,
    HEADING: HEADING_PATTERN,
    FENCE: FENCE_PATTERN,
    SECTION_KEYWORDS: pairs(SECTION_KEYWORDS),
    STOPWORDS_TEXT,
    UP_WORDS: [[...UP_WORDS[0]], [...UP_WORDS[1]].sort()],
    DOWN_WORDS: [[...DOWN_WORDS[0]], [...DOWN_WORDS[1]].sort()],
    SEGMENTS: SEGMENTS.map((s) => [s.key, s.label, s.group, s.labelEn]),
    MACRO_SEGMENTS: MACRO_SEGMENTS.map((s) => [s.key, s.label, s.group, s.labelEn]),
    UNASSIGNED: [UNASSIGNED, UNASSIGNED_LABEL, UNASSIGNED_LABEL_EN],
    LEGACY_KEYS: pairs(LEGACY_KEYS),
    STABLECOINS: [...STABLECOINS].sort(),
    FUNDS: pairs(FUNDS),
    SUFFIX: "[.:].*$",
    KIND_LABEL: pairs(KIND_LABEL),
    KIND_LABEL_EN: pairs(KIND_LABEL_EN),
    RELATION_LABEL: pairs(RELATION_LABEL),
    RELATION_LABEL_EN: pairs(RELATION_LABEL_EN),
    RESEARCH_NOTE_KINDS,
    RESEARCH_POLARITIES,
    RESEARCH_THESIS_RELATIONS,
    RESEARCH_THESIS_FIELDS,
    FULFILLS_THESIS_FIELDS,
    THESIS_ENTRY_TYPES,
    RESEARCH_RUN_STATUSES,
    RESEARCH_CREATORS,
    RESEARCH_BOUNDS: [
      RESEARCH_TITLE_MAX,
      RESEARCH_SUMMARY_MAX,
      RESEARCH_NOTE_TTL_DAYS,
      RESEARCH_RESTORE_MINUTES,
      RESEARCH_CANDIDATE_COOLDOWN_DAYS,
    ],
    RESEARCH_PREFIX,
  };
  const { rows } = loadVectors("research-wordlists");

  it("every Python table has a TS copy with the same sha256", () => {
    const m = new Mismatches();
    for (const [name, hash] of rows as readonly Row[]) {
      const value = ours[name as string];
      m.check(String(name), value === undefined ? "missing" : sha(value), hash);
    }
    expect(Object.keys(ours).sort()).toEqual(
      (rows as readonly Row[]).map((r) => r[0] as string).sort(),
    );
    expectAll(m);
  });
});

describe("check_url (urlsplit + ipaddress semantics)", () => {
  it("gives Python's reason (or none) for every URL", () => {
    const m = new Mismatches();
    for (const [url, expected] of loadVectors("research-urls").rows as readonly Row[]) {
      m.check(JSON.stringify(url).slice(0, 100), checkUrl(url), expected);
    }
    expectAll(m);
  });
});

describe("parse_moment (date.fromisoformat / C datetime.fromisoformat)", () => {
  it("parses every text to Python's UTC instant, None or error", () => {
    const m = new Mismatches();
    for (const [text, expected] of loadVectors("research-moments").rows as readonly Row[]) {
      let actual: unknown;
      try {
        const at = parseMoment(text);
        actual = at === null ? null : formatInstant(at);
      } catch (error) {
        if (!(error instanceof PyOverflowError)) throw error;
        actual = { error: "OverflowError" };
      }
      m.check(JSON.stringify(text), actual, expected);
    }
    expectAll(m);
  });
});

describe("text folds (themes, similarity tokens, symbols, strategy headings)", () => {
  it("every text folds like Python", () => {
    const m = new Mismatches();
    for (const row of loadVectors("research-text").rows as readonly Row[]) {
      const text = row[0] as string;
      const label = JSON.stringify(text);
      const head = Array.from(text).slice(0, 10).join("");
      m.check(`clean_theme ${label}`, cleanTheme(text), row[1]);
      m.check(`theme_key ${label}`, themeKey(text), row[2]);
      m.check(`tokens ${label}`, [...tokens(text)].sort(), row[3]);
      m.check(`tokens(numbers) ${label}`, [...tokens(text, { numbers: true })].sort(), row[4]);
      m.check(`directions ${label}`, [...directions(text)].sort(), row[5]);
      m.check(`numbers ${label}`, [...numbers(text)].sort(), row[6]);
      m.check(`body ${label}`, body(text, head || null), row[7]);
      m.check(`bare_symbol ${label}`, bareSymbol(text), row[8]);
      m.check(`fold ${label}`, foldHeading(text), row[9]);
      m.check(`kind ${label}`, sectionKind(text), row[10]);
      m.check(`casefold ${label}`, pyCasefold(text), row[11]);
    }
    expectAll(m);
  });

  it("strategy sections of generated markdown", () => {
    const m = new Mismatches();
    for (const [md, expected] of loadVectors("research-sections").rows as readonly Row[]) {
      const actual = strategySections(md as string | null).map((s) => [s.kind, s.heading, s.text]);
      m.check(JSON.stringify(md).slice(0, 80), actual, expected);
    }
    expectAll(m);
  });
});

/** Floats as `{float: repr}` like the generator (JSON cannot tell 15.0 from 15). */
function markFloats(details: Readonly<Record<string, unknown>> | null): unknown {
  if (details === null) return null;
  const valuation = details.valuation as Record<string, unknown> | undefined;
  if (valuation === undefined) return details;
  const marked = Object.fromEntries(
    Object.entries(valuation).map(([k, v]) => [
      k,
      typeof v === "number" ? { float: floatRepr(v) } : v,
    ]),
  );
  return { ...details, valuation: marked };
}

function noteJson(note: NoteInput): unknown {
  return {
    kind: note.kind,
    polarity: note.polarity,
    strength: note.strength,
    thesis_relation: note.thesisRelation,
    title: note.title,
    summary: note.summary,
    sources: noteSourcesJson(note),
    theme: note.theme,
    thesis_field: note.thesisField,
    observed_at: note.observedAt === null ? null : formatInstant(note.observedAt),
    expires_in_days: note.expiresInDays,
    expires_at: formatInstant(noteExpiresAt(note, NOW)),
    details: markFloats(note.details),
    candidate:
      note.candidate === null
        ? null
        : { ...candidateJson(note.candidate), key: candidateKey(note.candidate) },
    segment: note.segment,
  };
}

describe("validate_note", () => {
  it("normalizes or refuses every raw note like Python (issues, order, message)", () => {
    const m = new Mismatches();
    for (const [raw, expected] of loadVectors("research-notes").rows as readonly Row[]) {
      const actual = outcome(() => noteJson(validateNote(raw as Record<string, unknown>, NOW)));
      m.check(JSON.stringify(raw).slice(0, 160), actual, expected);
    }
    expectAll(m);
  });
});

describe("validate_scope / counts / market view", () => {
  it("every run input gives Python's outcome", () => {
    const m = new Mismatches();
    for (const [kind, raw, expected] of loadVectors("research-runs").rows as readonly Row[]) {
      let actual: unknown;
      switch (kind) {
        case "scope":
          actual = outcome(() => {
            const s = validateScope(raw as Record<string, unknown> | null);
            return {
              held: s.held,
              watchlist: s.watchlist,
              candidates: s.candidates,
              themes: s.themes,
              segments: s.segments,
              instruments: s.instruments,
              scheduled: s.scheduled,
              full_refresh: s.fullRefresh,
            };
          });
          break;
        case "counts":
          actual = outcome(() => validateCounts(raw as Record<string, unknown> | null));
          break;
        case "assessment":
          actual = outcome(() => validateAssessment(raw));
          break;
        case "outlook":
          actual = outcome(() => validateOutlook(raw));
          break;
        case "outlook_q":
          actual = outcome(() => validateOutlook(raw, true));
          break;
        case "view_sources":
          actual = outcome(() => validateViewSources(raw, NOW));
          break;
        default:
          throw new Error(`unknown kind ${String(kind)}`);
      }
      m.check(`${String(kind)} ${JSON.stringify(raw).slice(0, 100)}`, actual, expected);
    }
    expectAll(m);
  });
});

function instantOf(text: unknown): Instant {
  const at = parseMoment(text);
  if (at === null) throw new Error(`not an instant: ${String(text)}`);
  return at;
}

describe("scoring (sentiment weeks, direction, thesis health)", () => {
  it("random note sets score like Python", () => {
    const m = new Mismatches();
    for (const row of loadVectors("research-scoring").rows as readonly Row[]) {
      const at = instantOf(row[0]);
      const notes: ScoredNote[] = (row[1] as readonly Row[]).map((n) => ({
        id: n[0] as number,
        kind: n[1] as string,
        polarity: n[2] as string,
        strength: n[3] as number,
        thesisRelation: n[4] as string,
        observedAt: instantOf(n[5]),
        createdAt: instantOf(n[6]),
        expiresAt: instantOf(n[7]),
        dismissedAt: n[8] === null ? null : instantOf(n[8]),
      }));
      const changed = row[2] === null ? null : instantOf(row[2]);
      const [hasThesis, researched] = row[3] as [boolean, boolean];
      const h = thesisHealth(notes, at, { hasThesis, thesisChangedAt: changed, researched });
      m.check(
        `health ${String(row[0])}`,
        [h.state, h.counts, h.relation, h.noteIds, h.predatesThesis],
        row[4],
      );
      const weeks = sentimentWeeks(notes, at);
      m.check(`weeks ${String(row[0])}`, weeks, row[5]);
      m.check(`direction ${String(row[0])}`, direction(weeks), row[6]);
      const day = formatInstant(at).slice(0, 10);
      m.check(`week ${String(row[0])}`, [isoWeek(day), weekStart(day)], row[7]);
    }
    expectAll(m);
  });
});

function noteRecord(n: Record<string, unknown>): ResearchNoteRecord {
  return {
    id: n.id as number | null,
    kind: n.kind as string,
    polarity: n.polarity as string,
    strength: n.strength as number,
    thesisRelation: n.thesis_relation as string,
    thesisField: n.thesis_field as string | null,
    title: n.title as string,
    sources: n.sources as unknown[] | null,
    details: n.details,
    instrumentId: n.instrument_id as string | null,
    segment: n.segment as string | null,
    theme: n.theme as string | null,
    createdAt: instantOf(n.created_at),
    expiresAt: instantOf(n.expires_at),
    dismissedAt: n.dismissed_at === null ? null : instantOf(n.dismissed_at),
  };
}

describe("research signals (messages, severities, keys, candidates)", () => {
  it("every signal vector matches", () => {
    const m = new Mismatches();
    for (const row of loadVectors("research-signals").rows as readonly Row[]) {
      const kind = row[0];
      if (kind === "sources") {
        m.check(
          `sources ${row[1]} ${row[2]}`,
          sourcesPhrase(row[2] as number, row[1] as "pl"),
          row[3],
        );
      } else if (kind === "message") {
        const [k, relation, title, strength, sources] = row[2] as [
          string,
          string | null,
          string,
          number,
          number,
        ];
        m.check(
          `message ${JSON.stringify(row[2])}`,
          researchMessage(k, relation, title, strength, sources, row[1] as "pl"),
          row[3],
        );
      } else if (kind === "candidate") {
        const at = instantOf(row[2]);
        const notes = (row[4] as Record<string, unknown>[]).map(noteRecord);
        m.check(
          `severities ${String(row[2])}`,
          notes.map((n) => [severityOf(n, at), noteKey(n)]),
          row[5],
        );
        const candidate = candidateFor(row[3] as string, notes, at, row[1] as "pl");
        const actual =
          candidate === null
            ? null
            : {
                rule_id: candidate.ruleId,
                kind: candidate.kind,
                dedup_key: candidate.dedupKey,
                severity: candidate.severity,
                message: candidate.message,
                instrument_id: candidate.instrumentId,
                payload: Object.entries(candidate.payload),
                polarity: candidate.polarity,
              };
        m.check(`candidate ${String(row[2])}`, actual, row[6]);
      } else if (kind === "key") {
        const scope = row[2] as Record<string, string>;
        m.check(
          `key ${JSON.stringify(scope)}`,
          researchDedupKey(row[1] as string, {
            instrumentId: scope.instrument_id ?? null,
            segment: scope.segment ?? null,
            theme: scope.theme ?? null,
          }),
          row[3],
        );
      } else if (kind === "is_key") {
        m.check(`is_key ${String(row[1])}`, isResearchKey(row[1] as string | null), row[2]);
      }
    }
    expect(SignalSeverity.ACTION).toBe("action");
    expectAll(m);
  });
});

describe("market segments (auto assignment, precedence, labels, catalog)", () => {
  it("every segment vector matches", () => {
    const m = new Mismatches();
    for (const row of loadVectors("research-segments").rows as readonly Row[]) {
      if (row[0] === "auto") {
        const [, assetClass, symbol, aliases, auto, explicit, setBy, of] = row;
        const inst = instrument({
          id: asInstrumentId("1"),
          name: "Example fund",
          currency: Currencies.USD,
          assetClass: assetClass as AssetClass,
          symbol: symbol as string | null,
          aliases: (aliases as [string, string][]).map(([ns, v]) => instrumentAlias(ns, v)),
        });
        const label = `${String(assetClass)} ${JSON.stringify(symbol)} ${JSON.stringify(aliases)}`;
        m.check(`auto ${label}`, autoSegment(inst), auto);
        m.check(
          `of ${label} ${String(explicit)} ${String(setBy)}`,
          [...segmentOf(inst, explicit as string | null, setBy as string | null)],
          of,
        );
      } else if (row[0] === "label") {
        const [, lang, key] = row as [string, "pl" | "en", string];
        m.check(
          `label ${lang} ${key}`,
          [
            segmentLabel(key, lang),
            segmentGroup(key),
            catalogOrder(key),
            isSegment(key),
            isMacroKey(key),
            isNoteSegment(key),
            regimeOf(key),
          ],
          row.slice(3),
        );
      } else if (row[0] === "catalog") {
        const lang = row[1] as "pl" | "en";
        m.check(`catalog ${lang}`, [catalog(lang), macroCatalog(lang)], row.slice(2));
      }
    }
    expect(AliasNamespace.YAHOO).toBe("yahoo");
    expectAll(m);
  });
});
