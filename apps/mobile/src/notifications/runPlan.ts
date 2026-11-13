// One planner run with the device's clock, zone and language (the shell's hook and the background task
// call it the same way, and share one run: never two plans at once), and the runner that spaces the
// shell's runs: one at a time, a request during a run runs once after it, and unforced requests at most
// once a minute. A changed choice (a toggle, a marked alert, a granted permission) is forced: the user
// expects its effect now, so a forced call during a run queues one more run after it.
import { intlLocale, lang } from "@cashu/i18n";
import { localToday } from "../format/calendar";
import { deviceTimeZone } from "../services/investments";
import { type PlannerServices, type PlanOutcome, planNotifications } from "./planner";
import type { NotificationScheduler } from "./scheduler";

/** What triggered a run (the bench log's `trigger`). */
export type PlanTrigger = "start" | "background" | "settings" | "permission" | "task";

/** The platform half of a run: the OS scheduler and the measurement log. */
export interface NotificationPlatform {
  readonly scheduler: NotificationScheduler;
  log(entry: Readonly<Record<string, unknown>>): void;
}

/** The run in flight, shared by every unforced caller until it settles. */
let inFlight: Promise<PlanOutcome | null> | null = null;

/** The one run queued behind `inFlight` by forced calls; later forced calls join it (latest wins). */
let queued: {
  services: PlannerServices;
  platform: NotificationPlatform;
  trigger: PlanTrigger;
  readonly promise: Promise<PlanOutcome | null>;
  readonly start: (run: Promise<PlanOutcome | null>) => void;
} | null = null;

/**
 * Plan now; logs the outcome (or the failure) and never throws. A call while a run is in flight (the
 * background task and the shell's planner on a background launch, which also mounts the root view)
 * returns that run's promise instead of starting a second one: two concurrent plans would read the same
 * ledger and deliver the same "now" notifications twice. A `force`d call (a changed choice) cannot share
 * it, since that run may have read the choices before the change: it queues exactly one more run after
 * the current one, and every further forced call before that run starts joins it.
 */
export function runPlan(
  services: PlannerServices,
  platform: NotificationPlatform,
  trigger: PlanTrigger,
  force = false,
): Promise<PlanOutcome | null> {
  if (inFlight === null) return startRun(services, platform, trigger);
  if (!force) return inFlight;
  if (queued !== null) {
    queued.services = services;
    queued.platform = platform;
    queued.trigger = trigger;
    return queued.promise;
  }
  let start: (run: Promise<PlanOutcome | null>) => void = () => undefined;
  const promise = new Promise<PlanOutcome | null>((resolve) => {
    start = resolve;
  });
  queued = { services, platform, trigger, promise, start };
  return promise;
}

function startRun(
  services: PlannerServices,
  platform: NotificationPlatform,
  trigger: PlanTrigger,
): Promise<PlanOutcome | null> {
  const run = planOnce(services, platform, trigger).finally(() => {
    inFlight = null;
    const next = queued;
    queued = null;
    // Started in the same callback, so no caller sees an idle gap between the two runs.
    if (next !== null) next.start(startRun(next.services, next.platform, next.trigger));
  });
  inFlight = run;
  return run;
}

async function planOnce(
  services: PlannerServices,
  platform: NotificationPlatform,
  trigger: PlanTrigger,
): Promise<PlanOutcome | null> {
  try {
    const now = new Date();
    const outcome = await planNotifications({
      services,
      scheduler: platform.scheduler,
      now,
      today: localToday(now),
      timeZone: deviceTimeZone(),
      lang: lang(),
      locale: intlLocale(),
    });
    const { kind, ...counts } = outcome;
    platform.log({ kind: "notifications", trigger, outcome: kind, ...counts });
    return outcome;
  } catch (error) {
    platform.log({ kind: "notifications", trigger, error: String(error) });
    return null;
  }
}

/** Unforced runs closer together than this are skipped. */
const PLAN_INTERVAL_MS = 60_000;

export interface PlanRunner {
  /** Run now, or once after the current run; `force` skips the once-a-minute gate. */
  request(trigger: PlanTrigger, force: boolean): void;
  /** No more runs (a run in flight finishes on its own). */
  dispose(): void;
}

export function createPlanRunner(deps: {
  run(trigger: PlanTrigger, force: boolean): Promise<unknown>;
  now(): number;
  intervalMs?: number;
}): PlanRunner {
  const interval = deps.intervalMs ?? PLAN_INTERVAL_MS;
  let lastStart = Number.NEGATIVE_INFINITY;
  let running = false;
  let queued: { trigger: PlanTrigger; force: boolean } | null = null;
  let disposed = false;
  const start = (trigger: PlanTrigger, force: boolean) => {
    running = true;
    lastStart = deps.now();
    void deps
      .run(trigger, force)
      .catch(() => undefined)
      .finally(() => {
        running = false;
        const next = queued;
        queued = null;
        if (next !== null && !disposed) start(next.trigger, next.force);
      });
  };
  return {
    request(trigger, force) {
      if (disposed) return;
      if (!force && deps.now() - lastStart < interval) return;
      if (running) queued = { trigger, force: force || (queued?.force ?? false) };
      else start(trigger, force);
    },
    dispose() {
      disposed = true;
      queued = null;
    },
  };
}
