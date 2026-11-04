/** Injection-only worker capabilities. Writer ownership is never fetch authority. */
import type {
  LocalRunStatus,
  NotificationQueue,
  TransactionalPriceCache,
} from "@cashu/store/investments/local";
import type {
  DailyPriceLock,
  DailySources,
  runDaily,
  StrategyFilesPort,
} from "@cashu/store/investments/services";
import type { HostStores, OpenVault } from "../stores.js";

export const JOBS = [
  "connectors.fetch",
  "investments.daily",
  "budget.sync",
  "notifications",
  "digest",
] as const;
export type WorkerJob = (typeof JOBS)[number];
type JobStatus = "ok" | "partial" | "failed" | "skipped";
export interface JobOutcome {
  readonly status: JobStatus;
  readonly code?: string;
  readonly stats?: Readonly<Record<string, number>>;
}
interface JobRun extends JobOutcome {
  readonly day: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}
export interface BudgetBook {
  last_attempt?: string;
  last_success?: string;
  throttled_until?: string;
  last_status?: string;
}
export interface WorkerState {
  readonly version: 1;
  runs: Record<string, JobRun>;
  /** Housekeeping subphase, not another synchronized/public job identity. */
  backfills: Record<string, JobRun>;
  budget: Record<string, BudgetBook>;
  digests: Record<string, string>;
  /** Opaque durable identity only. A user or recovery flow must reconcile before a new write. */
  uncertain: Record<
    string,
    {
      job: "investments.daily" | "investments.backfill";
      phase: "prepared" | "outcome_unknown";
      command: string;
      key: string;
    }
  >;
}
export interface WorkerStatePort {
  load(): Promise<WorkerState>;
  /** Must atomically persist before resolving. Failure never authorizes network or delivery. */
  save(state: WorkerState): Promise<void>;
}
export interface WorkerHostContext {
  readonly stores: HostStores;
  now(): number;
  isCurrent(vault: OpenVault): boolean;
  jobsEnabled(): boolean;
  networkEnabled(): boolean;
  uiCount(): number;
}
interface WorkerAuthority {
  isHolder(): boolean;
}
interface ExclusiveJobOwnership {
  /** Already-exclusive local runtime ownership, supplied after a genuine drain/handover. */
  isExclusive(job: WorkerJob, vault: OpenVault): boolean;
}
export interface WorkerNotification {
  readonly vaultId: string;
  readonly kind: "signal" | "signalsSummary" | "reviewDigest" | "generic";
  readonly signalId?: string;
  readonly locale: "pl" | "en";
}
export type WorkerNotificationResult =
  | { readonly state: "accepted" }
  | { readonly state: "unknown" }
  | {
      /** Only when the adapter proves OS submission has not started. */
      readonly state: "rejected";
      readonly reason: "denied" | "pending" | "unavailable" | "invalid";
    };
export interface WorkerNotifier {
  readonly name: string;
  /** Once platform invocation may have started, every exception and missing ACK is unknown. */
  send(notification: WorkerNotification): Promise<WorkerNotificationResult>;
}
export interface BudgetSyncPort {
  configured(vault: OpenVault): boolean;
  hasSavedSessions(vault: OpenVault): boolean;
  /** One attempt only; the adapter rechecks guard before each actual request. No login flow. */
  sync(
    vault: OpenVault,
    days: number,
    guard: () => void,
  ): Promise<{
    readonly ok: boolean;
    readonly inserted?: number;
    readonly banks?: number;
    readonly errors?: readonly string[];
  }>;
}
interface InvestmentWorkerPorts {
  readonly prices: TransactionalPriceCache;
  /** Same instance used by daily, UI prices and proposal publication. */
  readonly dailyLock: DailyPriceLock;
  files(vault: OpenVault): StrategyFilesPort | null;
  sources?(): DailySources;
  readonly notifications?: NotificationQueue;
  readonly activity?: LocalRunStatus;
  readonly macroStore?: NonNullable<Parameters<typeof runDaily>[0]["macroStore"]>;
}
export interface WorkerBindings {
  readonly state: WorkerStatePort;
  readonly ownership: ExclusiveJobOwnership;
  /** Current local append capability, independent of remote fetch leadership. */
  authority(vault: OpenVault): WorkerAuthority | null;
  /** Fresh action-specific leadership. Missing means no bank or public network request. */
  fetchAuthority?(vault: OpenVault, job: WorkerJob): WorkerAuthority | null;
  readonly investments?: InvestmentWorkerPorts;
  readonly budget?: BudgetSyncPort;
  readonly notifier?: WorkerNotifier;
  readonly offline?: boolean;
  readonly schedule?: { readonly hour: number; readonly minute: number };
  language(vault: OpenVault): "pl" | "en";
  /** Metadata-only current eligibility. It never records a run or changes due policy. */
  unavailable?(vault: OpenVault, job: WorkerJob): string | null;
}
export interface WorkerStatus {
  readonly state: "off" | "safe-mode" | "idle" | "running" | "stopped" | "error";
  readonly schedule: string;
  readonly nextRunAt: string | null;
  readonly lastTickAt: string | null;
  readonly jobs: readonly ({ readonly job: WorkerJob; readonly ordinal: number } & JobRun)[];
  readonly unavailable: readonly {
    readonly job: WorkerJob;
    readonly ordinal: number;
    readonly code: string;
  }[];
}
export const emptyWorkerState = (): WorkerState => ({
  version: 1,
  runs: {},
  backfills: {},
  budget: {},
  digests: {},
  uncertain: {},
});
export const runKey = (job: WorkerJob, vault: string): string => JSON.stringify([job, vault]);
