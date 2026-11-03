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
export type JobStatus = "ok" | "partial" | "failed" | "skipped";
export interface JobOutcome {
  readonly status: JobStatus;
  readonly code?: string;
  readonly stats?: Readonly<Record<string, number>>;
}
export interface JobRun extends JobOutcome {
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
export interface WorkerAuthority {
  isHolder(): boolean;
}
export interface ExclusiveJobOwnership {
  /** Already-exclusive local runtime ownership, supplied after a genuine drain/handover. */
  isExclusive(job: WorkerJob): boolean;
}
export interface WorkerNotification {
  readonly title: string;
  readonly subtitle: string;
  readonly message: string;
  readonly group: string;
  readonly url?: string;
}
export interface WorkerNotifier {
  readonly name: string;
  send(notification: WorkerNotification): Promise<{ readonly ok: boolean }>;
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
export interface InvestmentWorkerPorts {
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
  authority(vault: OpenVault): WorkerAuthority | null;
  readonly investments?: InvestmentWorkerPorts;
  readonly budget?: BudgetSyncPort;
  readonly notifier?: WorkerNotifier;
  readonly offline?: boolean;
  readonly schedule?: { readonly hour: number; readonly minute: number };
  language(vault: OpenVault): "pl" | "en";
  /** S56f cold-launch routing is separately bound; no inferred legacy profile identity. */
  notificationUrl?(vault: OpenVault, target: "investments" | "review" | string): string | undefined;
}
export interface WorkerStatus {
  readonly state: "off" | "safe-mode" | "idle" | "running" | "stopped" | "error";
  readonly schedule: string;
  readonly nextRunAt: string | null;
  readonly lastTickAt: string | null;
  readonly jobs: readonly ({ readonly job: WorkerJob; readonly ordinal: number } & JobRun)[];
}
export const emptyWorkerState = (): WorkerState => ({
  version: 1,
  runs: {},
  backfills: {},
  budget: {},
  digests: {},
});
export const runKey = (job: WorkerJob, vault: string): string => JSON.stringify([job, vault]);
