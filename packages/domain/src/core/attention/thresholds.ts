/** The thresholds of the attention list (`rankAttention`): every one a named number, tunable as a whole. */
export const ATTENTION_THRESHOLDS = {
  /** Tier 1: uncategorized spending at least this share of the month's spending ... */
  uncategorizedShareOfSpent: 0.1,
  /** ... and at least this share of a usual month (both must hold). */
  uncategorizedFloorOfUsual: 0.05,
  /** Tier 2: a position of at least this portfolio weight ... */
  positionWeight: 0.03,
  /** ... that moved at least this much in a day (either way) ... */
  positionDayMove: 0.05,
  /** ... or at least this many standard deviations in a week (either way). */
  positionWeekSigma: 2,
  /** Banner: bank data older than this many hours. */
  staleAfterHours: 36,
  /** Banner: a bank consent ending within this many days. */
  consentWarnDays: 7,
  /**
   * Tier 4: a price rise worth at least this share of a usual month over a year. The only owner of this
   * baseline: budget `payeeChanges` returns every rise of 10 % or more with its yearly effect.
   */
  payeeChangeYearlyOfUsual: 0.01,
  /** How many rows the list shows. */
  maxRows: 3,
} as const;

export type AttentionThresholds = typeof ATTENTION_THRESHOLDS;
