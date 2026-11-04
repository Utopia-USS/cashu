/** S40 host-lifetime worker. No default ownership, Python handover or closed-app wake binding. */
import { enabledModuleIds } from "@cashu/store/core";
import { DurableWriteUnknown, lastOkDay } from "@cashu/store/investments/services";
import type { OpenVault } from "../stores.js";
import { WorkerAuthorityLost, workerGuard } from "./authority.js";
import { syncWorkerBudget } from "./budget.js";
import {
  emptyWorkerState,
  JOBS,
  type JobOutcome,
  runKey,
  type WorkerBindings,
  type WorkerHostContext,
  type WorkerJob,
  type WorkerState,
  type WorkerStatus,
} from "./contracts.js";
import { nativeInvestmentJobs, type WorkerWriteAttempts } from "./investments.js";
import { deliverWorkerNotifications, sendWorkerDigest } from "./notifications.js";
import { checkedSchedule, localDay, nextSlot, slotPassed, slotText } from "./schedule.js";

const TICK_MS = 60_000,
  UI_PRICES_MS = 15 * 60_000;
/** Existing Python AutoRunner CHECK_EVERY: failures do not become a 60-second fetch loop. */
const DAILY_RETRY_MS = 60 * 60_000;
export class WorkerTickBusy extends Error {
  constructor() {
    super("worker_busy");
  }
}
export class HostWorker {
  private readonly host: WorkerHostContext;
  private readonly bindings: WorkerBindings | undefined;
  private readonly schedule: ReturnType<typeof checkedSchedule>;
  private readonly investments: ReturnType<typeof nativeInvestmentJobs>;
  private state: WorkerState = emptyWorkerState();
  private loaded = false;
  private stateName: WorkerStatus["state"];
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;
  private tickOffline = false;
  private tickConstrained = false;
  private working = false;
  private stopping = false;
  private lastTick: string | null = null;
  private readonly priceFinished = new Map<string, number>();

  constructor(context: WorkerHostContext, bindings?: WorkerBindings) {
    this.host = {
      stores: context.stores,
      now: () => context.now(),
      isCurrent: (vault) => context.isCurrent(vault),
      jobsEnabled: () => !this.stopping && context.jobsEnabled(),
      networkEnabled: () => !this.stopping && context.networkEnabled(),
      uiCount: () => context.uiCount(),
    };
    this.bindings = bindings;
    this.schedule = checkedSchedule(bindings?.schedule);
    this.investments =
      bindings === undefined
        ? undefined
        : nativeInvestmentJobs(this.host, bindings, this.writeAttempts());
    this.stateName = !this.host.jobsEnabled()
      ? "safe-mode"
      : bindings === undefined
        ? "off"
        : "idle";
  }
  get pending(): number {
    return this.working ? 1 : 0;
  }
  get hasAppNotifier(): boolean {
    return this.bindings?.notifier !== undefined;
  }
  /** Startup is nonblocking; tick owns all errors and concurrent ticks coalesce. */
  start(): void {
    if (
      this.bindings === undefined ||
      this.stopping ||
      this.timer !== undefined ||
      !this.host.jobsEnabled()
    )
      return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    this.timer.unref();
    void this.tick();
  }
  tick(
    force = false,
    options: {
      readonly offline?: boolean;
      readonly budget?: boolean;
      readonly notifier?: "auto" | "app" | "none";
    } = {},
  ): Promise<void> {
    if (this.stopping || this.bindings === undefined || !this.host.jobsEnabled())
      return Promise.resolve();
    const constrained =
      options.offline === true || options.budget === false || options.notifier === "none";
    if (this.active !== undefined) {
      if (constrained || this.tickConstrained) return Promise.reject(new WorkerTickBusy());
      return this.active;
    }
    this.tickOffline = options.offline === true;
    this.tickConstrained = constrained;
    this.stateName = "running";
    this.active = this.runTick(
      force,
      this.tickOffline,
      options.budget !== false,
      options.notifier !== "none",
    )
      .then(
        () => {
          if (!this.stopping) this.stateName = "idle";
        },
        () => {
          if (!this.stopping) this.stateName = "error";
        },
      )
      .finally(() => {
        this.active = undefined;
        this.tickOffline = false;
        this.tickConstrained = false;
        this.working = false;
      });
    return this.active;
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
    this.stateName = "stopped";
  }
  status(): WorkerStatus {
    const jobs: WorkerStatus["jobs"][number][] = [];
    const unavailable: WorkerStatus["unavailable"][number][] = [];
    let ordinal = 0;
    for (const vault of this.host.stores.vaults.values()) {
      for (const job of JOBS) {
        const run = this.state.runs[runKey(job, vault.id)];
        if (run !== undefined) jobs.push({ job, ordinal, ...run });
        try {
          const code = this.bindings?.unavailable?.(vault, job);
          if (code) unavailable.push({ job, ordinal, code });
        } catch {
          unavailable.push({ job, ordinal, code: "authority_unavailable" });
        }
      }
      ordinal++;
    }
    return {
      state: this.stateName,
      schedule: slotText(this.schedule),
      nextRunAt:
        this.stateName === "off" || this.stateName === "stopped" || this.stateName === "safe-mode"
          ? null
          : nextSlot(this.host.now(), this.schedule),
      lastTickAt: this.lastTick,
      jobs,
      unavailable,
    };
  }
  private async save(): Promise<void> {
    if (this.stopping || !this.host.jobsEnabled() || this.bindings === undefined)
      throw new WorkerAuthorityLost();
    await this.bindings.state.save(this.state);
    if (this.stopping || !this.host.jobsEnabled()) throw new WorkerAuthorityLost();
  }
  private writeAttempts(): WorkerWriteAttempts {
    return {
      reserve: async (vault, job, command, key) => {
        this.guard(vault, "investments.daily")();
        const existing = this.state.uncertain[vault.id];
        if (existing !== undefined) throw new DurableWriteUnknown(existing.key, existing.command);
        this.state.uncertain[vault.id] = { job, phase: "prepared", command, key };
        await this.save();
        this.guard(vault, "investments.daily")();
      },
      settle: async (vault, key) => {
        const pending = this.state.uncertain[vault.id];
        if (pending?.key !== key) throw new Error("worker_attempt_key_mismatch");
        delete this.state.uncertain[vault.id];
        try {
          await this.save();
        } catch (error) {
          this.state.uncertain[vault.id] = pending;
          throw error;
        }
      },
    };
  }
  private guard(vault: OpenVault, job: WorkerJob): () => void {
    const bindings = this.bindings;
    if (bindings === undefined) throw new WorkerAuthorityLost();
    return workerGuard(this.host, bindings, vault, job, {
      network:
        !this.tickOffline &&
        (job === "connectors.fetch" ||
          job === "budget.sync" ||
          (job === "investments.daily" && bindings.offline !== true)),
    });
  }
  private async due(
    job: WorkerJob,
    vaults: readonly OpenVault[],
    force: boolean,
  ): Promise<OpenVault[]> {
    const day = localDay(this.host.now()),
      due: OpenVault[] = [];
    for (const vault of vaults) {
      try {
        if (
          this.state.uncertain[vault.id] !== undefined &&
          (job === "investments.daily" || job === "notifications" || job === "digest")
        )
          continue;
        const guard = this.guard(vault, job);
        guard();
        const old = this.state.runs[runKey(job, vault.id)];
        if (
          !force &&
          job !== "investments.daily" &&
          old !== undefined &&
          old.finishedAt !== null &&
          old.day >= day
        )
          continue;
        if (!force && job === "investments.daily") {
          const last = await vault.queue.run(() => {
            guard();
            return lastOkDay(vault.store.read.bind(vault.store), (date) =>
              localDay(Date.parse(date)),
            );
          });
          guard();
          if (last !== null && last >= day) continue;
          if (old !== undefined && old.code !== "busy") {
            const attempted = Date.parse(old.finishedAt ?? old.startedAt);
            if (this.host.now() - attempted < DAILY_RETRY_MS) continue;
          }
        }
        due.push(vault);
      } catch {
        /* One unavailable vault never prevents another vault's job. */
      }
    }
    return due;
  }
  private async recordStart(job: WorkerJob, vaults: readonly OpenVault[]): Promise<OpenVault[]> {
    const time = this.host.now(),
      started: OpenVault[] = [];
    for (const vault of vaults) {
      try {
        this.guard(vault, job)();
      } catch {
        continue;
      }
      this.state.runs[runKey(job, vault.id)] = {
        day: localDay(time),
        startedAt: new Date(time).toISOString(),
        finishedAt: null,
        status: "failed",
        code: "interrupted",
      };
      started.push(vault);
    }
    if (started.length !== 0) {
      this.working = true;
      await this.save();
    }
    return started;
  }
  private async recordFinish(job: WorkerJob, vault: OpenVault, outcome: JobOutcome): Promise<void> {
    const old = this.state.runs[runKey(job, vault.id)];
    if (old === undefined) throw new Error("worker_missing_attempt");
    this.state.runs[runKey(job, vault.id)] = {
      day: old.day,
      startedAt: old.startedAt,
      finishedAt: new Date(this.host.now()).toISOString(),
      ...outcome,
    };
    await this.save();
  }
  private async phase(
    job: WorkerJob,
    vaults: readonly OpenVault[],
    force: boolean,
    execute: (vault: OpenVault, guard: () => void) => Promise<JobOutcome>,
  ): Promise<void> {
    for (const vault of await this.due(job, vaults, force)) {
      const guard = this.guard(vault, job);
      let started = false;
      try {
        if ((await this.recordStart(job, [vault])).length === 0) continue;
        started = true;
        guard();
        const outcome = await execute(vault, guard);
        guard();
        await this.recordFinish(job, vault, outcome);
      } catch (error) {
        if (this.stopping || !this.host.jobsEnabled()) return;
        if (!started) throw error; // failed durable bookkeeping forbids later network jobs too
        await this.recordFinish(job, vault, {
          status: "failed",
          code: error instanceof WorkerAuthorityLost ? "authority_lost" : "job_failed",
        });
      }
    }
  }
  private async runTick(
    force: boolean,
    offline: boolean,
    budget: boolean,
    notifications: boolean,
  ): Promise<void> {
    const bindings = this.bindings;
    if (bindings === undefined) return;
    if (!this.loaded) {
      this.state = structuredClone(await bindings.state.load());
      if (this.stopping || !this.host.jobsEnabled()) return;
      this.loaded = true;
    }
    const time = this.host.now();
    this.lastTick = new Date(time).toISOString();
    const investors: OpenVault[] = [],
      budgeters: OpenVault[] = [];
    for (const vault of this.host.stores.vaults.values()) {
      if (this.stopping) return;
      try {
        if (!this.host.isCurrent(vault)) continue;
        const modules = await vault.queue.run(() => {
          if (this.host.stores.vaults.get(vault.id) !== vault || !this.host.isCurrent(vault))
            throw new WorkerAuthorityLost();
          return enabledModuleIds(vault.store.read.bind(vault.store));
        });
        if (modules.has("investments")) investors.push(vault);
        if (modules.has("budget")) budgeters.push(vault);
      } catch {
        /* Closed/replaced vaults are isolated from the remaining profiles. */
      }
    }
    if (force || slotPassed(time, this.schedule)) {
      if (!offline && bindings.connectors !== undefined) {
        const connectors = bindings.connectors;
        const candidates = [
          ...new Map([...investors, ...budgeters].map((v) => [v.id, v])).values(),
        ];
        await this.phase("connectors.fetch", candidates, force, (vault, guard) =>
          connectors.fetch(vault, guard),
        );
      }
      if (this.investments !== undefined) {
        const busy = new Set<string>();
        const due = await this.recordStart(
          "investments.daily",
          await this.due("investments.daily", investors, force),
        );
        if (due.length !== 0) {
          let outcomes: ReadonlyMap<string, JobOutcome>;
          try {
            outcomes = await this.investments.daily(due, offline);
          } catch (error) {
            if (error instanceof DurableWriteUnknown) {
              const target = error.vault ?? due[0]?.id;
              if (target !== undefined) {
                this.state.uncertain[target] = {
                  job: "investments.daily",
                  phase: "outcome_unknown",
                  command: error.commandId,
                  key: error.key,
                };
                await this.save();
              }
            }
            outcomes = new Map(
              due.map((v) => [
                v.id,
                {
                  status: "failed",
                  code:
                    error instanceof DurableWriteUnknown && v.id === (error.vault ?? due[0]?.id)
                      ? "outcome_unknown"
                      : error instanceof WorkerAuthorityLost
                        ? "authority_lost"
                        : "daily_failed",
                },
              ]),
            );
          }
          for (const vault of due) {
            if (this.stopping) return;
            if (outcomes.get(vault.id)?.code === "busy") busy.add(vault.id);
            await this.recordFinish(
              "investments.daily",
              vault,
              outcomes.get(vault.id) ?? { status: "failed", code: "daily_failed" },
            );
          }
        }
        if (!offline) await this.backfillPhase(investors, force, busy);
      }
      if (!offline && budget && bindings.budget !== undefined)
        await this.phase("budget.sync", budgeters, force, (vault, guard) =>
          syncWorkerBudget({
            vault,
            port: bindings.budget as NonNullable<WorkerBindings["budget"]>,
            state: this.state,
            now: () => this.host.now(),
            save: () => this.save(),
            guard,
          }),
        );
      const notifier = bindings.notifier,
        queue = bindings.investments?.notifications;
      if (notifications && notifier !== undefined && queue !== undefined)
        await this.phase("notifications", investors, force, (vault, guard) =>
          deliverWorkerNotifications({
            vault,
            bindings,
            notifier,
            queue,
            now: () => this.host.now(),
            guard,
          }),
        );
      if (notifications && notifier !== undefined && bindings.investments !== undefined)
        await this.phase("digest", investors, force, (vault, guard) =>
          sendWorkerDigest({
            vault,
            bindings,
            notifier,
            state: this.state,
            save: () => this.save(),
            now: () => this.host.now(),
            guard,
          }),
        );
    }
    if (
      !offline &&
      this.investments !== undefined &&
      this.host.uiCount() > 0 &&
      !bindings.offline
    ) {
      for (const vault of investors) {
        const last = this.priceFinished.get(vault.id);
        if (last !== undefined && this.host.now() - last < UI_PRICES_MS) continue;
        try {
          this.working = true;
          if ((await this.investments.prices(vault)) === "finished")
            this.priceFinished.set(vault.id, this.host.now());
        } catch {
          /* Authority loss or a transient source failure never makes a tick overlap. */
        }
      }
    }
  }

  private async backfillPhase(
    vaults: readonly OpenVault[],
    force: boolean,
    busyDaily: ReadonlySet<string>,
  ): Promise<void> {
    const investments = this.investments;
    if (investments === undefined || !investments.backfillEnabled()) return;
    for (const vault of vaults) {
      if (this.stopping) return;
      if (this.state.uncertain[vault.id] !== undefined) continue;
      if (busyDaily.has(vault.id)) continue;
      const guard = this.guard(vault, "investments.daily");
      try {
        guard();
      } catch {
        continue;
      }
      const time = this.host.now(),
        day = localDay(time),
        old = this.state.backfills[vault.id];
      if (!force && old !== undefined) {
        if (old.status === "ok" && old.day >= day) continue;
        if (
          old.code !== "busy" &&
          time - Date.parse(old.finishedAt ?? old.startedAt) < DAILY_RETRY_MS
        )
          continue;
      }
      const startedAt = new Date(time).toISOString();
      this.state.backfills[vault.id] = {
        day,
        startedAt,
        finishedAt: null,
        status: "failed",
        code: "interrupted",
      };
      this.working = true;
      await this.save();
      let outcome: JobOutcome;
      try {
        guard();
        const result = await investments.backfill(vault);
        guard();
        outcome =
          result === "finished"
            ? { status: "ok" }
            : result === "failed"
              ? { status: "failed", code: "backfill_failed" }
              : { status: "skipped", code: result === "busy" ? "busy" : "backfill_unavailable" };
      } catch (error) {
        if (error instanceof DurableWriteUnknown) {
          this.state.uncertain[vault.id] = {
            job: "investments.backfill",
            phase: "outcome_unknown",
            command: error.commandId,
            key: error.key,
          };
          // The prepared record was saved before dispatch. During shutdown it remains on disk.
          if (!this.stopping && this.host.jobsEnabled()) await this.save();
        }
        if (this.stopping || !this.host.jobsEnabled()) return;
        outcome = {
          status: "failed",
          code:
            error instanceof DurableWriteUnknown
              ? "outcome_unknown"
              : error instanceof WorkerAuthorityLost
                ? "authority_lost"
                : "backfill_failed",
        };
      }
      this.state.backfills[vault.id] = {
        day,
        startedAt,
        finishedAt: new Date(this.host.now()).toISOString(),
        ...outcome,
      };
      await this.save();
    }
  }
}

export function startWorker(host: WorkerHostContext, bindings?: WorkerBindings): HostWorker {
  const worker = new HostWorker(host, bindings);
  worker.start();
  return worker;
}
