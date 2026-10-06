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
  theme: string | null;
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
    scale?: string | null; event?: string | null; event_date?: string | null; [k: string]: unknown;
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

export interface ThemeSummary {
  theme: string;
  key?: string;
  sentiment_8w: (number | null)[];
  direction: Direction | string | null;
  notes: number;
  /** Instrument ids (server) or display symbols. */
  instruments: (number | string)[];
  last_note: LatestNote | null;
  last_observed_at?: string | null;
  /** F8 BE: unread agent notes of the theme. */
  unread?: number;
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
  themes: ThemeSummary[];
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
  scope: { held?: boolean; watchlist?: boolean; candidates?: boolean; themes?: string[]; instrument_ids?: number[]; covered_instrument_ids?: number[]; [k: string]: unknown } | string[] | null;
  counts: RunCounts | null;
  notes?: number;
  signals?: number;
  created_by: string | null;
}

export interface ThesisChange { instrument_id: number; label?: string | null; symbol?: string | null; from: string | null; to: string | null; note_ids?: number[]; counts?: RelationCounts }
export interface ThemeChange { theme: string; key?: string; from: string | null; to: string | null; sentiment_8w?: (number | null)[] }

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
  themes_changed: ThemeChange[];
  candidates: number[];
  highlights?: number[];
}

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
