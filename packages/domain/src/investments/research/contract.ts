/**
 * The research layer's data contract (`investments/models.py`, "Research layer"): enums and bounds
 * that validation and the store share.
 */

export const RESEARCH_RUN_STATUSES: readonly string[] = Object.freeze([
  "running",
  "done",
  "failed",
]);
export const RESEARCH_NOTE_KINDS: readonly string[] = Object.freeze([
  "news",
  "earnings",
  "community",
  "trend",
  "macro",
  "candidate",
]);
export const RESEARCH_POLARITIES: readonly string[] = Object.freeze([
  "positive",
  "negative",
  "neutral",
]);
export const RESEARCH_THESIS_RELATIONS: readonly string[] = Object.freeze([
  "supports",
  "weakens",
  "invalidates",
  "fulfills",
  "neutral",
  "none",
]);
/** The thesis fields a `fulfills` note may name (the expected outcome, the exit target; P1). */
export const FULFILLS_THESIS_FIELDS: readonly string[] = Object.freeze(["thesis", "exit_plan"]);
export const RESEARCH_THESIS_FIELDS: readonly string[] = Object.freeze([
  "entry_type",
  "thesis",
  "invalidation",
  "exit_plan",
  "size_plan",
]);
export const RESEARCH_CREATORS: readonly string[] = Object.freeze(["agent", "user"]);
export const RESEARCH_TITLE_MAX = 120;
export const RESEARCH_SUMMARY_MAX = 1200;
export const RESEARCH_NOTE_TTL_DAYS = 30;
export const RESEARCH_RESTORE_MINUTES = 15;
export const RESEARCH_CANDIDATE_COOLDOWN_DAYS = 90;
export const THESIS_ENTRY_TYPES: readonly string[] = Object.freeze([
  "sentiment_correction",
  "trend",
  "special_situation",
]);
