// Genesis source rows, investments owner / agent state (S26 spec 9.2 `rows.ts`, split by size):
// profile instrument overrides, strategy, theses, watchlist, alerts, planned deposits, signals, rule
// runs, decisions, the notification log and research. Same decoding conventions as rows.ts.

/** Decimal text in plain notation (`DECIMAL_RE`). */
type Dec = string;
/** `YYYY-MM-DDTHH:MM:SS[.f]Z`. */
type Ts = string;
/** `YYYY-MM-DD`. */
type Day = string;

export interface InvProfileInstrumentRow {
  readonly id: number;
  readonly profileId: number;
  readonly instrumentId: number;
  readonly name: string | null;
  readonly assetClass: string | null;
  readonly tags: unknown;
  readonly region: string | null;
  readonly sector: string | null;
  readonly valuationMode: string | null;
  readonly status: string | null;
  readonly needsClassification: boolean | null;
  readonly plan: string | null;
  readonly planAt: Ts | null;
  readonly planReason: string | null;
  readonly segment: string | null;
  readonly segmentBy: string | null;
  readonly createdAt: Ts;
  readonly updatedAt: Ts;
}

export interface InvStrategyVersionRow {
  readonly id: number;
  readonly profileId: number;
  readonly version: number;
  readonly sha256: string;
  readonly yamlText: string;
  readonly mdText: string | null;
  readonly state: string;
  readonly issues: unknown;
  readonly createdAt: Ts;
}

export interface InvThesisRow {
  readonly id: number;
  readonly profileId: number;
  readonly instrumentId: number;
  readonly entryType: string;
  readonly thesis: string;
  readonly invalidation: string | null;
  readonly exitPlan: string | null;
  readonly sizePlan: string | null;
  readonly reviewedAt: Ts | null;
  readonly createdAt: Ts;
  readonly updatedAt: Ts;
  readonly coreChangedAt: Ts | null;
  /** Schema 0025 has no column: backfilled as migration 0026 does (spec 2.2). */
  readonly exitPlanChangedAt: Ts | null;
}

export interface InvTopicThesisRow {
  readonly id: number;
  readonly profileId: number;
  readonly segment: string;
  readonly thesis: string;
  readonly invalidation: string | null;
  readonly draft: boolean;
  readonly createdBy: string;
  readonly coreChangedAt: Ts;
  readonly createdAt: Ts;
  readonly updatedAt: Ts;
  readonly rejectedAt: Ts | null;
  readonly assessment: string | null;
  readonly outlook: string | null;
  readonly viewUpdatedAt: Ts | null;
  readonly viewSources: unknown;
}

export interface WatchlistItemRow {
  readonly id: number;
  readonly profileId: number;
  readonly instrumentId: number;
  readonly note: string | null;
  readonly tags: unknown;
  readonly source: string;
  readonly addedAt: Ts;
  readonly removedAt: Ts | null;
}

export interface AlertRow {
  readonly id: number;
  readonly profileId: number;
  readonly instrumentId: number | null;
  readonly scope: string;
  readonly kind: string;
  readonly params: unknown;
  readonly polarity: string;
  readonly severity: string;
  readonly title: string;
  readonly note: string | null;
  readonly source: string;
  readonly createdBy: string;
  readonly status: string;
  readonly cooldownDays: number | null;
  readonly expiresAt: Ts | null;
  readonly snoozedUntil: Ts | null;
  readonly lastTriggeredAt: Ts | null;
  readonly lastCheckedAt: Ts | null;
  /** Free text in Python (`VARCHAR`), not a decimal column. */
  readonly lastValue: string | null;
  readonly createdAt: Ts;
  readonly updatedAt: Ts;
  readonly deletedAt: Ts | null;
  /** Owner / agent label (Alembic 0027); null before 0027 and when unset. */
  readonly tag: string | null;
}

export interface InvPlannedDepositRow {
  readonly id: number;
  readonly profileId: number;
  readonly accountId: number | null;
  readonly amount: Dec;
  readonly currency: string;
  readonly plannedDate: Day;
  readonly note: string | null;
  readonly status: string;
  readonly bookedTxnId: number | null;
  readonly bookedAt: Ts | null;
  readonly createdAt: Ts;
  readonly updatedAt: Ts;
}

export interface InvSignalRow {
  readonly id: number;
  readonly profileId: number;
  readonly ruleId: string;
  readonly kind: string;
  readonly dedupKey: string;
  readonly severity: string;
  readonly polarity: string;
  readonly status: string;
  readonly message: string;
  readonly instrumentId: number | null;
  readonly accountId: number | null;
  readonly payload: unknown;
  readonly firstSeenAt: Ts;
  readonly lastSeenAt: Ts;
  readonly createdRunId: number | null;
  readonly lastRunId: number | null;
  readonly acknowledgedAt: Ts | null;
  readonly closedAt: Ts | null;
  readonly snoozedUntil: Ts | null;
}

export interface InvRuleRunRow {
  readonly id: number;
  readonly profileId: number;
  readonly trigger: string;
  readonly asOf: Day;
  readonly status: string;
  readonly strategyVersionId: number | null;
  readonly stats: unknown;
  readonly errors: unknown;
  readonly report: unknown;
  readonly startedAt: Ts;
  readonly finishedAt: Ts | null;
}

export interface InvDecisionRow {
  readonly id: number;
  readonly profileId: number;
  readonly signalId: number | null;
  readonly instrumentId: number | null;
  readonly accountId: number | null;
  readonly action: string;
  readonly quantity: Dec | null;
  readonly price: Dec | null;
  readonly currency: string | null;
  readonly reason: string | null;
  readonly createdAt: Ts;
}

/** Embedded into its decision (no event of its own, no sync_ids entry). */
export interface InvDecisionSignalRow {
  readonly decisionId: number;
  readonly signalId: number;
}

/** Device-local (D-G10): never an event, written to the device-local sidecar. */
export interface InvNotificationRow {
  readonly id: number;
  readonly profileId: number;
  readonly signalId: number;
  readonly severity: string;
  readonly createdAt: Ts;
  readonly sentAt: Ts | null;
  readonly channel: string | null;
}

export interface ResearchRunRow {
  readonly id: number;
  readonly profileId: number;
  readonly startedAt: Ts;
  readonly finishedAt: Ts | null;
  readonly status: string;
  readonly scope: unknown;
  readonly counts: unknown;
  readonly createdBy: string;
}

export interface ResearchNoteRow {
  readonly id: number;
  readonly profileId: number;
  readonly runId: number | null;
  readonly instrumentId: number | null;
  readonly theme: string | null;
  readonly segment: string | null;
  readonly kind: string;
  readonly polarity: string;
  readonly strength: number;
  readonly thesisRelation: string;
  readonly thesisField: string | null;
  readonly title: string;
  readonly summary: string;
  readonly sources: unknown;
  readonly details: unknown;
  readonly candidateKey: string | null;
  readonly signalId: number | null;
  readonly observedAt: Ts;
  readonly expiresAt: Ts;
  readonly createdBy: string;
  readonly dismissedAt: Ts | null;
  readonly cooldownUntil: Ts | null;
  readonly readAt: Ts | null;
  readonly createdAt: Ts;
  readonly updatedAt: Ts;
}
