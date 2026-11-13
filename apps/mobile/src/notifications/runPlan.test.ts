// The shell's plan runner: one run at a time, a request during a run runs once after it, unforced
// requests at most once a minute, nothing after dispose; and `runPlan`, which the background task and the
// shell share, never runs two plans at once, and runs a forced call made during a run once after it.
// Synthetic data.
import { moneyStore } from "../screens/testing/moneyStore";
import { createPlanRunner, type PlanTrigger, runPlan } from "./runPlan";
import type { NotificationPermission } from "./scheduler";
import { memoryScheduler } from "./testing/memoryScheduler";

function harness() {
  let clock = 0;
  const runs: PlanTrigger[] = [];
  const forced: boolean[] = [];
  const pending: (() => void)[] = [];
  const runner = createPlanRunner({
    run: (trigger, force) => {
      runs.push(trigger);
      forced.push(force);
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    now: () => clock,
    intervalMs: 60_000,
  });
  const finish = async () => {
    pending.shift()?.();
    // Let the runner's `finally` run.
    await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    runner,
    runs,
    forced,
    finish,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createPlanRunner", () => {
  it("skips unforced requests within the interval and runs forced ones", async () => {
    const h = harness();
    h.runner.request("start", true);
    await h.finish();
    h.advance(10_000);
    h.runner.request("background", false);
    expect(h.runs).toEqual(["start"]);
    h.runner.request("settings", true);
    expect(h.runs).toEqual(["start", "settings"]);
    await h.finish();
    h.advance(61_000);
    h.runner.request("background", false);
    expect(h.runs).toEqual(["start", "settings", "background"]);
  });

  it("runs a request made during a run once, after it", async () => {
    const h = harness();
    h.runner.request("start", true);
    h.runner.request("settings", true);
    h.runner.request("permission", true);
    expect(h.runs).toEqual(["start"]);
    await h.finish();
    expect(h.runs).toEqual(["start", "permission"]);
    await h.finish();
    expect(h.runs).toEqual(["start", "permission"]);
  });

  it("passes force on to the run, also for a queued request", async () => {
    const h = harness();
    h.runner.request("start", true);
    h.advance(61_000);
    h.runner.request("settings", true);
    h.runner.request("background", false);
    await h.finish();
    expect(h.runs).toEqual(["start", "background"]);
    expect(h.forced).toEqual([true, true]);
  });

  it("starts nothing after dispose", async () => {
    const h = harness();
    h.runner.request("start", true);
    h.runner.request("settings", true);
    h.runner.dispose();
    await h.finish();
    h.runner.request("settings", true);
    expect(h.runs).toEqual(["start"]);
  });
});

describe("runPlan", () => {
  it("returns the run in flight to a second caller, then plans afresh once it settled", async () => {
    const fixture = moneyStore();
    const scheduler = memoryScheduler("denied");
    let asked = 0;
    let answer: (permission: NotificationPermission) => void = () => undefined;
    scheduler.permission = () => {
      asked++;
      return new Promise((resolve) => {
        answer = resolve;
      });
    };
    const log: Readonly<Record<string, unknown>>[] = [];
    const platform = {
      scheduler,
      log: (entry: Readonly<Record<string, unknown>>) => log.push(entry),
    };

    const task = runPlan(fixture.services, platform, "task");
    // The shell's start plan on the same background launch.
    const shell = runPlan(fixture.services, platform, "start");
    expect(shell).toBe(task);
    await new Promise((resolve) => setImmediate(resolve));
    answer("denied");
    expect(await task).toEqual({ kind: "no_permission", cancelled: 0 });
    expect(asked).toBe(1);
    expect(log).toEqual([
      { kind: "notifications", trigger: "task", outcome: "no_permission", cancelled: 0 },
    ]);

    const next = runPlan(fixture.services, platform, "background");
    expect(next).not.toBe(task);
    await new Promise((resolve) => setImmediate(resolve));
    answer("denied");
    await next;
    expect(asked).toBe(2);
    fixture.close();
  });
});

describe("runPlan with force", () => {
  function gatedPlatform() {
    const scheduler = memoryScheduler("denied");
    const answers: ((permission: NotificationPermission) => void)[] = [];
    scheduler.permission = () => new Promise((resolve) => answers.push(resolve));
    const log: Readonly<Record<string, unknown>>[] = [];
    const platform = {
      scheduler,
      log: (entry: Readonly<Record<string, unknown>>) => log.push(entry),
    };
    // Answer the oldest permission question once the run asked it.
    const release = async () => {
      await new Promise((resolve) => setImmediate(resolve));
      answers.shift()?.("denied");
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { platform, log, asked: () => answers.length, release };
  }

  it("queues one more run after the one in flight for a forced call", async () => {
    const fixture = moneyStore();
    const g = gatedPlatform();

    const task = runPlan(fixture.services, g.platform, "task");
    // A toggle flipped while the background task plans.
    const toggled = runPlan(fixture.services, g.platform, "settings", true);
    expect(toggled).not.toBe(task);
    // An unforced caller still shares the run in flight.
    expect(runPlan(fixture.services, g.platform, "start")).toBe(task);

    await g.release();
    await task;
    expect(g.log.map((entry) => entry.trigger)).toEqual(["task"]);
    await g.release();
    expect(await toggled).toEqual({ kind: "no_permission", cancelled: 0 });
    expect(g.log.map((entry) => entry.trigger)).toEqual(["task", "settings"]);
    fixture.close();
  });

  it("coalesces further forced calls into the one queued run", async () => {
    const fixture = moneyStore();
    const g = gatedPlatform();

    const task = runPlan(fixture.services, g.platform, "task");
    const first = runPlan(fixture.services, g.platform, "settings", true);
    const second = runPlan(fixture.services, g.platform, "permission", true);
    expect(second).toBe(first);

    await g.release();
    await task;
    // The queued run is the one in flight now, and an unforced caller shares it.
    const unforced = runPlan(fixture.services, g.platform, "background");
    expect(unforced).not.toBe(task);
    await g.release();
    await first;
    expect(await unforced).toEqual(await first);
    expect(g.log.map((entry) => entry.trigger)).toEqual(["task", "permission"]);
    fixture.close();
  });
});
