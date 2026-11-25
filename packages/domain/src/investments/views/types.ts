/** Portable inputs for pure investment projections; no storage rows, ambient clock or wire rounding. */
import type { UiLang } from "../../core/i18n.js";
import type { DateTime, IsoDate } from "../../dates.js";
import type { Decimal } from "../../decimal.js";
import type { EffectiveAlertStatus } from "../alerts/index.js";
import type {
  AccountId,
  AccountWrapper,
  AllocationResult,
  Currency,
  ImportBatchId,
  Instrument,
  InstrumentId,
  ManualValuation,
  MarketView,
  PortfolioSnapshot,
  PriceBar,
  ProfileId,
  SignalSeverity,
  SignalStatus,
  Transaction,
  ValuedPortfolio,
} from "../domain/index.js";
import type { Freshness, FreshnessNote } from "../plan/freshness.js";
import type { Hint } from "../plan/hints.js";
import type { HealthResult } from "../research/index.js";
import type { SignalCandidate, SignalPolarity } from "../rules/index.js";
import type { StrategyConfig } from "../strategy/index.js";

export interface ViewClock {
  readonly now: DateTime;
  readonly today: IsoDate;
  readonly timeZone: string;
}
export interface ViewOptions {
  readonly lang: UiLang;
  readonly forOwner: boolean;
  readonly accounts: readonly AccountId[] | null;
}
/** Canonical references plus the applied creation anchor; never a local view id. */
export interface StableReadRank {
  readonly gid: string;
  readonly hlc: string;
  readonly eid: string;
}
export interface AccountImportFact {
  readonly batchId: ImportBatchId;
  readonly at: DateTime;
  readonly fileName: string;
}
export interface BrokerageAccountFact {
  readonly id: AccountId;
  readonly name: string;
  readonly broker: string;
  readonly brokerName: string;
  readonly wrapper: AccountWrapper;
  readonly currency: Currency;
  readonly importer: string | null;
  readonly hasMapping: boolean;
  readonly active: boolean;
  readonly snapshotDate: IsoDate | null;
  readonly lastImport: AccountImportFact | null;
}
export interface PortfolioViewState {
  readonly vault: ProfileId;
  readonly asOf: IsoDate;
  readonly base: Currency;
  readonly accounts: readonly BrokerageAccountFact[];
  readonly accountFilter: readonly AccountId[] | null;
  readonly txns: readonly Transaction[];
  readonly snapshot: PortfolioSnapshot;
  /** The SAME bounded valuation/evaluation market used to construct valued (Python default800days). */
  readonly market: MarketView;
  /** Independent full through-asOf history for chart/detail; never substituted into rule quality checks. */
  readonly historyBars: ReadonlyMap<InstrumentId, readonly PriceBar[]>;
  /** Canonical owned transaction/rename/watch/explicit-detail references, independently of held-only market. */
  readonly instruments: ReadonlyMap<InstrumentId, Instrument>;
  readonly valued: ValuedPortfolio;
  readonly allocation: AllocationResult | null;
  readonly config: StrategyConfig | null;
}
export interface ViewWatch {
  readonly id: string;
  readonly instrumentId: InstrumentId;
  readonly note: string | null;
  readonly tags: readonly string[];
  readonly source: string;
  readonly addedAt: DateTime;
}
export interface ViewRuleRun {
  readonly id: string;
  readonly trigger: string;
  readonly asOf: IsoDate;
  readonly status: string;
  readonly startedAt: DateTime;
  readonly finishedAt: DateTime | null;
  readonly errors: readonly string[];
  readonly stats: Readonly<Record<string, unknown>>;
  readonly newSignalIds: readonly string[];
  readonly escalatedSignalIds: readonly string[];
}
export interface ViewFacts {
  readonly clock: ViewClock;
  readonly subjects: readonly AnnotationSubject[];
  readonly signals: readonly ViewSignal[];
  readonly alerts: readonly ViewAlert[];
  readonly watched: readonly ViewWatch[];
  readonly unread: ReadonlyMap<InstrumentId, number>;
  readonly lastRun: ViewRuleRun | null;
  readonly lastGoodRunId: string | null;
}
export interface ViewThesis {
  readonly id: string;
  readonly instrumentId: InstrumentId;
  readonly entryType: string;
  readonly thesis: string;
  readonly invalidation: string | null;
  readonly exitPlan: string | null;
  readonly sizePlan: string | null;
  readonly reviewedAt: DateTime | null;
  readonly createdAt: DateTime;
  readonly updatedAt: DateTime;
  readonly coreChangedAt: DateTime;
  readonly exitPlanChangedAt: DateTime | null;
}
export interface ViewDecision {
  readonly id: string;
  readonly signalId: string | null;
  readonly signalIds: readonly string[];
  readonly instrumentId: InstrumentId | null;
  readonly accountId: AccountId | null;
  readonly action: string;
  readonly quantity: Decimal | null;
  readonly price: Decimal | null;
  readonly currency: Currency | null;
  readonly reason: string | null;
  readonly createdAt: DateTime;
}
export interface ViewManualValuation extends ManualValuation {
  readonly id: string;
}
export interface PositionHistory {
  readonly theses: readonly ViewThesis[];
  readonly decisions: readonly ViewDecision[];
  /** Full history, including future rows; valuation history is a separate loader input. */
  readonly manualValuations: readonly ViewManualValuation[];
}
export interface PortfolioProjectionInput {
  readonly state: PortfolioViewState;
  readonly facts: ViewFacts;
  readonly annotations: ReadonlyMap<InstrumentId, InstrumentAnnotation>;
  readonly options: ViewOptions;
}
export interface InstrumentAnnotation {
  readonly hints: readonly Hint[];
  readonly freshness: Freshness | null;
  readonly plan: string | null;
  readonly planAt: DateTime | null;
  readonly health: HealthResult;
}
/** Wire-only float selectors. Unselected Decimal warning/payload context values remain text. */
const HINT_FLOATS = ["gain", "loss", "drawdown", "threshold", "weight", "max_weight"].map(
  (k) => `hints.*.params.${k}`,
);
export const POSITION_FLOAT_PATHS: readonly string[] = [
  "quantity",
  "price",
  "value",
  "cost",
  "unrealized",
  "unrealized_pct",
  "weight",
  "realized",
  "dividends.*",
  "accounts.*.quantity",
  "accounts.*.average_cost",
  "accounts.*.value",
  "accounts.*.cost",
  "accounts.*.unrealized_pct",
  "accounts.*.weight",
  "lots.*.quantity",
  "lots.*.unit_cost",
  "lots.*.result",
  "closes_30d.*.close",
  ...HINT_FLOATS,
];
export const ACCOUNT_FLOAT_PATHS: readonly string[] = ["*.value", "*.share"];
export const ALLOCATION_FLOAT_PATHS: readonly string[] = [
  "total",
  "buckets.*.weight",
  "buckets.*.target",
  "buckets.*.drift_pp",
  "buckets.*.value",
  "buckets.*.to_target",
  "unclassified.value",
  "unclassified.weight",
  "unallocated_cash",
  "by_asset_class.*.value",
  "by_asset_class.*.weight",
  "by_region.*.value",
  "by_region.*.weight",
  "band.absolute_band_pp",
  "band.relative_band",
  "band.min_trade_value",
];
export const POSITIONS_FLOAT_PATHS: readonly string[] = [
  "total",
  "cash.*.amount",
  "cash.*.amount_base",
  ...POSITION_FLOAT_PATHS.map((p) => `positions.*.${p}`),
];
export const POSITION_DETAIL_FLOAT_PATHS: readonly string[] = [
  "high_52w",
  "series.*.close",
  ...POSITION_FLOAT_PATHS.map((p) => `position.${p}`),
  ...HINT_FLOATS,
  ...["quantity", "price", "gross_amount", "fee", "tax", "cash_amount", "fx_rate"].map(
    (k) => `transactions.*.${k}`,
  ),
  "decisions.*.quantity",
  "decisions.*.price",
  "manual_valuations.*.unit_value",
];
export const POSITION_CHART_FLOAT_PATHS: readonly string[] = [
  "series.*.close",
  "high_52w",
  "last.close",
  "cost.average",
  "thresholds.*.threshold",
  "thresholds.*.y",
  "markers.*.quantity",
  "markers.*.price",
];
export const WATCHLIST_FLOAT_PATHS: readonly string[] = [
  "*.price.close",
  "*.price.change_1d",
  "*.price.change_1m",
  "*.price.high_52w",
  "*.price.from_high_52w",
  "*.alerts.nearest.level",
  "*.alerts.nearest.distance_pct",
  "*.closes_30d.*.close",
  ...HINT_FLOATS.map((p) => `*.${p}`),
];
export const OVERVIEW_FLOAT_PATHS: readonly string[] = [
  "kpis.value.total",
  "kpis.value.holdings",
  "kpis.value.cash",
  "kpis.unrealized.amount",
  "kpis.unrealized.pct",
  "kpis.unrealized.cost",
  "kpis.cash.amount",
  "kpis.cash.weight",
  "kpis.max_drift.drift_pp",
  "kpis.realized",
  "freshness.prices.stale_weight",
  ...ALLOCATION_FLOAT_PATHS.map((p) => `allocation.${p}`),
  ...ACCOUNT_FLOAT_PATHS.map((p) => `accounts.${p}`),
];
export interface ViewSignal extends SignalCandidate {
  readonly id: string;
  readonly status: SignalStatus;
  readonly firstSeenAt: DateTime;
  readonly lastSeenAt: DateTime;
  readonly snoozedUntil: DateTime | null;
  readonly acknowledgedAt: DateTime | null;
  readonly closedAt: DateTime | null;
  readonly createdRun: string | null;
  readonly lastRun: string | null;
  readonly rank: StableReadRank;
}
export interface ViewAlert {
  readonly params: Readonly<Record<string, unknown>>;
  readonly polarity: SignalPolarity;
  readonly id: string;
  readonly instrumentId: InstrumentId | null;
  readonly kind: string;
  readonly title: string;
  readonly source: string;
  readonly status: EffectiveAlertStatus;
  readonly severity: SignalSeverity;
  readonly lastTriggeredAt: DateTime | null;
  readonly expiresAt: DateTime | null;
  readonly snoozedUntil: DateTime | null;
  readonly createdAt: DateTime;
  readonly updatedAt: DateTime;
}
/** The scored id is the established convergent research storing rank, not a SQL row id or public identity. */
export type AnnotationNote = FreshnessNote;
export interface AnnotationSubject {
  /** False for saved/unheld/unwatched detail: compute freshness without watched hints. */
  readonly hintsWanted: boolean;
  readonly instrument: Instrument;
  readonly held: boolean;
  readonly weight: number | null;
  readonly health: HealthResult;
  readonly hasThesis: boolean;
  readonly hasExitPlan: boolean;
  readonly thesisTracked: boolean;
  readonly plan: string | null;
  readonly planAt: DateTime | null;
  /** The model's position strength (`POSITION_STRENGTHS`); null = not assessed. */
  readonly positionStrength?: string | null;
  readonly strengthBasis?: string | null;
  readonly strengthAt?: DateTime | null;
  readonly coreChangedAt: DateTime | null;
  readonly notes: readonly AnnotationNote[];
  readonly allOpenSignals: readonly ViewSignal[];
  readonly hintTriggeredAlerts: readonly ViewAlert[];
  readonly freshnessTriggeredAlerts: readonly ViewAlert[];
}
