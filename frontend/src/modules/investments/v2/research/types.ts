// Research layer shapes (track RS CONTRACT FINAL in stock/docs/fork/progress/F6-RS.md; F6 spec "Research
// layer"; implementation-plan Wave F item 28). Types only (no runtime code), so the pure logic and `npm test`
// can import them. Loose values (health / relation / direction names) are normalised in logic.ts.

export type NoteKind = "news" | "earnings" | "community" | "trend" | "macro" | "candidate";
export type NotePolarity = "positive" | "negative" | "neutral";
export type Relation = "supports" | "weakens" | "invalidates" | "fulfills" | "neutral" | "none";
/** Thesis health per position (research.md 5): podważona, osłabiona, spełniona (P1), wzmocniona, aktualna, bez tezy,
 * bez researchu. Server names: invalidated, weakened, fulfilled, supported, current, no_thesis, no_research. */
export type HealthKey = "inv" | "weak" | "ful" | "sup" | "ok" | "no_thesis" | "no_research";
export type Direction = "up" | "down" | "flat";
/** Thesis record field a note bears on. */
export type ThesisField = "entry_type" | "thesis" | "invalidation" | "exit_plan" | "size_plan";

export interface NoteSource { title?: string | null; url: string; publisher?: string | null; published_at?: string | null }

export interface Criterion { text: string; met: boolean; threshold?: string | number | null }

export interface NoteInstrument { id: number | string; label?: string | null; symbol?: string | null; name?: string | null; mic?: string | null; isin?: string | null; currency?: string | null }

/** `candidate` block of a candidate note (an instrument that is not held or watched yet). */
export interface NoteCandidate {
  symbol?: string | null; name?: string | null; exchange?: string | null; currency?: string | null; key?: string | null;
  accepted_at?: string | null; watchlist_item_id?: number | null; thesis_id?: number | null;
}

export interface ResearchNote {
  id: number;
  run_id?: number | null;
  instrument_id: number | null;
  instrument?: NoteInstrument | null;
  /** Old free-text theme (pre-P5 notes; never written any more, kept readable). */
  theme: string | null;
  /** P5: market segment key of a segment note (no instrument, no candidate) and its Polish label. */
  segment?: string | null;
  segment_label?: string | null;
  kind: NoteKind | string;
  polarity: NotePolarity | string;
  strength: number;
  thesis_relation: Relation | string;
  thesis_field?: ThesisField | string | null;
  title: string;
  summary: string;
  sources: NoteSource[];
  candidate?: NoteCandidate | null;
  /** Candidate notes: criteria vs the strategy thresholds, entry type, context; community notes: scale. */
  details?: {
    criteria?: Criterion[]; entry_type?: string | null; context?: string | null; bucket?: string | null; criteria_version?: number | string | null;
    scale?: string | null; event?: string | null; event_date?: string | null; assessment?: string | null; outlook?: string | null; [k: string]: unknown;
  } | null;
  /** The research signal this note created or joined (card tag `sygnał`). */
  signal_id?: number | null;
  signal?: { id: number; status: string; severity: string } | null;
  held?: boolean;
  watched?: boolean;
  observed_at: string;
  expires_at: string | null;
  expired?: boolean;
  created_by: "agent" | "user" | string;
  created_at?: string | null;
  dismissed?: boolean;
  dismissed_at: string | null;
  /** F8 BE (Q10): when the owner opened it; agent notes are born unread. */
  read_at?: string | null;
  unread?: boolean;
  /** P2: stored before the thesis' last core change (judged against the previous thesis). */
  predates_thesis?: boolean;
  /** dismissed_at + 15 minutes: `przywróć` / `Cofnij` only before this. */
  restorable_until?: string | null;
  /** Dismissed candidate: not re-proposed before this date (90 days). */
  cooldown_until?: string | null;
}

/** `fulfills` (P1) is absent on older servers. */
export interface RelationCounts { supports: number; weakens: number; invalidates: number; fulfills?: number; neutral: number; community: number }

export interface LatestNote { id?: number; title: string; kind?: string; polarity?: string | null; thesis_relation?: string | null; observed_at?: string | null; strength?: number | null }

export interface InstrumentSummary {
  instrument_id: number;
  instrument?: NoteInstrument | null;
  label?: string | null;
  symbol?: string | null;
  held?: boolean;
  watched?: boolean;
  weight?: number | null;
  has_thesis?: boolean;
  entry_type?: string | null;
  health: HealthKey | string | null;
  health_rank?: number;
  counts: RelationCounts;
  thesis_relation: Relation | string | null;
  note_ids?: number[];
  /** Per thesis field counts (the chip on the Teza field). */
  fields?: { field: string; supports: number; weakens: number; invalidates: number; fulfills?: number; neutral: number }[];
  latest_polarity: NotePolarity | string | null;
  latest_note?: LatestNote | null;
  notes?: number;
  /** 8 weekly scores in [-1, 1], oldest first; null = no notes that week. */
  sentiment_8w: (number | null)[];
  direction?: Direction | string | null;
  last_researched_at: string | null;
  /** F8 BE: unread agent notes of the instrument. */
  unread?: number;
  /** P2: the health rests only on notes stored before the thesis' last core change. */
  health_predates_thesis?: boolean;
}

export interface ResearchSummary {
  as_of?: string;
  window_days?: number;
  /** ISO week labels ("2026-W34") and their Monday dates, oldest first. */
  weeks?: string[];
  week_starts?: string[];
  last_run?: ResearchRun | null;
  running?: boolean;
  instruments: InstrumentSummary[];
  candidates?: { open: number; accepted: number; dismissed_in_cooldown: number };
  totals?: { notes_active: number; notes_this_week: number; candidates_open: number; signals_open: number; notes_unread?: number };
}

export interface RunCounts { notes?: number; signals?: number; candidates?: number; by_kind?: Record<string, number>; sources_checked?: number; instruments_covered?: number; [k: string]: unknown }

export interface ResearchRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: "running" | "done" | "failed" | string;
  interrupted?: boolean;
  reason?: string | null;
  duration_s?: number | null;
  /** true = the Saturday routine ("rutyna"), false = on demand. */
  scheduled?: boolean | null;
  scope: { held?: boolean; watchlist?: boolean; candidates?: boolean; segments?: string[]; instrument_ids?: number[]; covered_instrument_ids?: number[]; [k: string]: unknown } | string[] | null;
  counts: RunCounts | null;
  notes?: number;
  signals?: number;
  created_by: string | null;
}

export interface ThesisChange { instrument_id: number; label?: string | null; symbol?: string | null; from: string | null; to: string | null; note_ids?: number[]; counts?: RelationCounts }

/** `review-digest.research` (RS CONTRACT 6). `run: null` = never ran (no block); `ran_in_period: false` = not run. */
export interface DigestResearch {
  since?: string;
  run: ResearchRun | null;
  ran_in_period?: boolean;
  runs_in_period?: number;
  notes_count: number;
  signals_count?: number;
  counts?: RelationCounts;
  by_kind?: Record<string, number>;
  theses_changed: ThesisChange[];
  theses_unchanged?: number;
  /** P5: the 1w segment attribution rows as of the digest end (top 6); missing on older servers. */
  segments?: SegmentRow[];
  /** P5: the rest of that 1w view (header move, currency, stale); null on an attribution error. */
  market?: Omit<SegmentAttribution, "segments"> | null;
  /** P6: macro regimes whose state changed inside the digest period; missing on older servers. */
  macro_changes?: MacroChange[];
  candidates: number[];
  highlights?: number[];
}

// ---- P5 market segments (`GET .../research/segments?window=1w|4w`, spec P5 section 5) ----------------------

export type SegmentWindow = "1w" | "4w";
/** `label` / `weight`: BE extras (a position sold inside the window is not in the held map, the label names it). */
export interface SegmentInstrument { instrument_id: number; contribution: number; return: number | null; label?: string | null; weight?: number | null }
export interface SegmentNoteRef { id: number; title: string; observed_at: string; polarity?: string | null; kind?: string; strength?: number | null }
export interface SegmentRow {
  segment: string; label: string; group: "asset" | "sector";
  weight: number; contribution: number; return: number | null;
  instruments: SegmentInstrument[];
  note: SegmentNoteRef | null; note_this_week: boolean; unread: number; notes_8w: number;
  /** Newest stored segment note, expired included (BE extra): the small date when `note` (active) is null. */
  last_note_at?: string | null;
  /** P7: equal-weighted local-currency return of the held and watched instruments with prices; null when none. */
  trend_1w: number | null; trend_4w: number | null;
  /** P7: count of those instruments (0 = no priced member). */
  members: number;
  /** P7 BE extra: the priced members (held now or watched) with their own returns; missing on older servers. */
  member_instruments?: SegmentMember[];
  /** P9: up to 3 latest active brief notes of the topic, newest first; missing on older servers. */
  briefs?: TopicBrief[];
  /** P9: the topic thesis; null when none, missing on older servers. */
  thesis?: TopicThesis | null;
  /** The newest sourced valuation of the topic (a segment note's `details.valuation`); null when none. */
  valuation?: Valuation | null;
}
/** How the market prices a topic: trailing and forward P/E, expected yearly earnings growth (fraction), the 5-year
 * average P/E, what the figures describe, when and from whom. */
export interface Valuation {
  pe?: number | null; forward_pe?: number | null; eps_growth?: number | null; pe_avg_5y?: number | null; basis?: string | null;
  note_id?: number; observed_at?: string | null; sources?: string[];
}
/** P9: a topic brief (a segment note with `details.brief`): a plain headline and what is going on. */
export interface TopicBrief { note_id: number; headline: string; why: string | null; observed_at: string; kind?: string | null; polarity?: string | null; unread: boolean }
/** P9: a macro brief: the plain headline, why the state holds, what supports it, what to watch. */
export interface MacroBrief { note_id: number; headline: string; why: string | null; supports: string[]; risks: string[]; observed_at: string; unread: boolean }
/** P9: the owner's (or the agent's draft) thesis of a topic (`GET/PUT /investments/topics/{segment}/thesis`). */
export interface TopicThesis {
  id?: number | null; segment?: string | null; thesis: string; invalidation: string | null; draft: boolean; created_by: "owner" | "agent" | string;
  assessment?: string | null; outlook?: string | null; view_updated_at?: string | null;
  /** P11: the sources of the industry estimates the view cites (empty when none). */
  view_sources?: NoteSource[];
  core_changed_at?: string | null; created_at?: string | null; updated_at: string | null;
}
/** A topic member: `held` = held at the window end (else watched only). */
export interface SegmentMember { instrument_id: number; label: string | null; held: boolean; return_1w: number | null; return_4w: number | null }
export interface SegmentCurrency { currency: string; weight: number; return: number; contribution: number }
export interface SegmentAttribution {
  as_of: string; start: string; end: string; window: SegmentWindow; base_currency: string;
  portfolio_return: number | null; explained: number; residual: number | null;
  new_positions: number; stale: number[];
  segments: SegmentRow[];
  unassigned: { weight: number; contribution: number; return: number | null; instruments: SegmentInstrument[] } | null;
  currency: { contribution: number; currencies: SegmentCurrency[] };
}

// ---- P6 macro regimes (`GET .../research/macro`, spec P6 section 4) ----------------------------------------

export type MacroKey = "risk" | "dollar" | "em" | "commodities" | "rates";
export type MacroTone = "pos" | "neg" | "warn" | "";
export type MacroUnit = "pct" | "pp" | "bp" | "level";
/** `text` = the server-formatted Polish string (`+6,2 %`, `+45 bp`, `4,23 %`); the UI never formats `value`. */
/** `stale` (BE fix pass): the metric's source is older than the regime's data; `as_of` its last date when sent. */
export interface MacroMetric { label: string; value: number | null; unit: MacroUnit | string; text: string; change_label?: string | null; stale?: boolean; as_of?: string | null }
/** `state_label`: BE extra (the Polish word of a past state); the FE catalog wins for known states. `open`: the
 * state already held before `date` (the first evaluated session of the stored window, not a real change). */
export interface MacroHistoryItem { date: string; state: string; state_label?: string | null; open?: boolean }
export interface MacroRegime {
  key: MacroKey | string; label: string;
  state: string; state_label: string; tone: MacroTone | string;
  since: string | null; as_of: string | null; stale: boolean; missing: boolean;
  /** The state held since before the data window (`since` is null then); `since_min` = the first evaluated session. */
  since_open: boolean; since_min: string | null;
  /** P7: 1-2 plain Polish sentences (<= ~140 chars), the one human line shown on screen. */
  summary: string | null;
  /** P7: 3-6 sentences (what the cycle is, how the app measures it, what the current state means); popover only. */
  explain: string | null;
  /** One factual sentence (kept for compatibility: the fallback of summary / explain, the card tooltip). */
  meaning: string | null;
  metrics: MacroMetric[];
  /** State changes over the stored window, newest last, at most 12. */
  history: MacroHistoryItem[];
  note: SegmentNoteRef | null; last_note_at: string | null; note_this_week: boolean; unread: number;
  /** P9: the latest active macro brief of the regime (null until the first one; missing on older servers). */
  brief?: MacroBrief | null;
  /** P9: a deterministic beginner sentence from the state only, shown until a brief exists. */
  plain?: string | null;
}
/** `as_of` = the last bar date in the data (null when none). */
export interface MacroRegimes { as_of: string | null; regimes: MacroRegime[] }
/** `review-digest.research.macro_changes`: a regime whose state changed inside the digest period. */
export interface MacroChange { key: string; label: string; from_label: string; to_label: string; since: string }

/** `GET /api/p/{slug}/workspace` (track AW): the folder, whether cashU set it up, the managed skills. */
export interface Workspace {
  path: string | null;
  exists: boolean;
  skills?: { name: string; module?: string | null; state: string }[];
  claude_command?: string | null;
  routine_command?: string | null;
  updated_at?: string | null;
  /** Derived by the client: the market-research skill is in the workspace (null = unknown). */
  skill_installed?: boolean | null;
  skill_installed_at?: string | null;
}
