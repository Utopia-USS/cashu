// When the phone syncs: one pass in flight per vault (a second trigger joins it), 30 s between two
// foreground passes, push-only on the arrival in the background, nothing for a vault without a remote
// or in a phase that cannot sync; and the cause a stale banner names. Fake sessions and clock.
import type { SyncResult } from "@cashu/sync/engine";
import type { VaultSyncStatus } from "../services/vaultEngine";
import {
  createSyncRunner,
  FOREGROUND_MIN_INTERVAL_MS,
  FOREGROUND_PASS_EVERY_MS,
  type SyncTarget,
  syncCause,
  TASK_OPEN_WAIT_MS,
  WRITE_BACKOFF_START_MS,
  WRITE_PUSH_DEBOUNCE_MS,
  WRITE_QUOTA_BACKOFF_MS,
} from "./syncRunner";

const VAULT = "5f0c3a9e81d24b7690ae13c7d2f4b856";
const MINUTE = 60_000;

function fakeTarget(status: Partial<VaultSyncStatus> = {}) {
  const passes: ("full" | "push")[] = [];
  const pending: ((result?: SyncResult) => void)[] = [];
  let retries = 0;
  let markOpened: () => void = () => {};
  let opened = new Promise<void>((resolve) => {
    markOpened = resolve;
  });
  let current: VaultSyncStatus = {
    vault: VAULT,
    phase: "ready",
    syncing: false,
    remote: true,
    unpushed: false,
    ...status,
  };
  const target: SyncTarget = {
    vault: VAULT,
    status: () => current,
    get opened() {
      return opened;
    },
    retry() {
      if (current.phase !== "failed") return;
      retries++;
      current = { ...current, phase: "opening" };
      opened = new Promise<void>((resolve) => {
        markOpened = resolve;
      });
    },
    pass(mode) {
      passes.push(mode);
      return new Promise<SyncResult | undefined>((resolve) => {
        pending.push((result) => resolve(result));
      });
    },
  };
  return {
    target,
    passes,
    retries: () => retries,
    /** Settle the running passes; with `ran`, as passes that ran (a result), else as skipped. */
    finish: (ran = false) => {
      for (const done of pending.splice(0)) done(ran ? ({} as SyncResult) : undefined);
    },
    set: (patch: Partial<VaultSyncStatus>) => {
      current = { ...current, ...patch };
    },
    /** The open settles into `phase` (as `VaultSession.opened` does after its status changed). */
    open: (phase: VaultSyncStatus["phase"]) => {
      current = { ...current, phase };
      markOpened();
    },
  };
}

/** Lets every settled promise run its continuations. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("the sync runner", () => {
  it("joins a running pass instead of starting a second one", async () => {
    const fake = fakeTarget();
    const runner = createSyncRunner({ targets: () => [fake.target], now: () => 0 });
    const first = runner.request("start");
    const second = runner.request("task");
    expect(fake.passes).toEqual(["full"]);
    fake.finish();
    await Promise.all([first, second]);
    const third = runner.request("task");
    fake.finish();
    await third;
    expect(fake.passes).toEqual(["full", "full"]);
  });

  it("keeps 30 s between foreground passes, counted from the last start or pull", async () => {
    let now = 1_000_000;
    const fake = fakeTarget();
    const runner = createSyncRunner({ targets: () => [fake.target], now: () => now });
    const start = runner.request("start");
    fake.finish();
    await start;
    now += FOREGROUND_MIN_INTERVAL_MS - 1;
    await runner.request("foreground");
    expect(fake.passes).toEqual(["full"]);
    now += 1;
    const foreground = runner.request("foreground");
    fake.finish();
    await foreground;
    expect(fake.passes).toEqual(["full", "full"]);
    fake.set({ lastPullAt: now + 10_000 });
    now += FOREGROUND_MIN_INTERVAL_MS + 5_000;
    await runner.request("foreground");
    expect(fake.passes).toEqual(["full", "full"]);
  });

  it("passes every few minutes while the app stays in the foreground, and stops when it leaves", async () => {
    let now = 1_000_000;
    const fake = fakeTarget();
    const timers: { ms: number; tick: () => void; stopped: boolean }[] = [];
    const runner = createSyncRunner({
      targets: () => [fake.target],
      now: () => now,
      every: (ms, tick) => {
        const timer = { ms, tick, stopped: false };
        timers.push(timer);
        return () => {
          timer.stopped = true;
        };
      },
    });
    const start = runner.request("start");
    fake.finish();
    await start;
    runner.foreground(true);
    runner.foreground(true);
    // One timer, under the 5 minutes the owner may wait for the paused line.
    expect(timers.map((t) => t.ms)).toEqual([FOREGROUND_PASS_EVERY_MS]);
    expect(FOREGROUND_PASS_EVERY_MS).toBeLessThanOrEqual(5 * MINUTE);
    now += FOREGROUND_PASS_EVERY_MS;
    timers[0]?.tick();
    fake.finish();
    await flush();
    expect(fake.passes).toEqual(["full", "full"]);
    runner.foreground(false);
    expect(timers[0]?.stopped).toBe(true);
  });

  it("pushes on the arrival in the background only when own writes wait", async () => {
    const fake = fakeTarget();
    const runner = createSyncRunner({ targets: () => [fake.target], now: () => 0 });
    await runner.request("background");
    expect(fake.passes).toEqual([]);
    fake.set({ unpushed: true });
    const push = runner.request("background");
    fake.finish();
    await push;
    expect(fake.passes).toEqual(["push"]);
  });

  it("skips a vault without a remote and one that cannot sync", async () => {
    const local = fakeTarget({ remote: false });
    const removed = fakeTarget({ phase: "removed" });
    const failed = fakeTarget({ phase: "failed" });
    const receiving = fakeTarget({ phase: "receiving" });
    const runner = createSyncRunner({
      targets: () => [local.target, removed.target, failed.target, receiving.target],
      now: () => 0,
    });
    const start = runner.request("start");
    receiving.finish();
    await start;
    expect([local.passes, removed.passes, failed.passes, receiving.passes]).toEqual([
      [],
      [],
      [],
      ["full"],
    ]);
  });

  it("remembers a start for a vault still opening and runs one pass once it opened", async () => {
    const fake = fakeTarget({ phase: "opening" });
    const runner = createSyncRunner({ targets: () => [fake.target], now: () => 0 });
    let settled = false;
    const start = runner.request("start").then(() => {
      settled = true;
    });
    const again = runner.request("start");
    await flush();
    expect(fake.passes).toEqual([]);
    expect(settled).toBe(false);
    fake.open("receiving");
    await flush();
    expect(fake.passes).toEqual(["full"]);
    fake.finish();
    await Promise.all([start, again]);
    expect(fake.passes).toEqual(["full"]);
  });

  it("runs a full pass for a foreground that arrived during the open, even after a background", async () => {
    const fake = fakeTarget({ phase: "opening", unpushed: false });
    const runner = createSyncRunner({ targets: () => [fake.target], now: () => 1_000_000 });
    const background = runner.request("background");
    const foreground = runner.request("foreground");
    fake.open("ready");
    await flush();
    expect(fake.passes).toEqual(["full"]);
    fake.finish();
    await Promise.all([background, foreground]);
  });

  it("decides nothing for a vault whose open failed", async () => {
    const fake = fakeTarget({ phase: "opening" });
    const runner = createSyncRunner({ targets: () => [fake.target], now: () => 0 });
    const start = runner.request("start");
    fake.open("failed");
    await start;
    expect(fake.passes).toEqual([]);
  });

  it("lets the background task wait for an open, bounded", async () => {
    const fake = fakeTarget({ phase: "opening" });
    const slept: number[] = [];
    let wake: () => void = () => {};
    const runner = createSyncRunner({
      targets: () => [fake.target],
      now: () => 0,
      sleep: (ms) => {
        slept.push(ms);
        return new Promise<void>((resolve) => {
          wake = resolve;
        });
      },
    });
    // Opens in time: the task resolves after its pass.
    let done = false;
    const task = runner.request("task").then(() => {
      done = true;
    });
    fake.open("ready");
    await flush();
    expect(fake.passes).toEqual(["full"]);
    expect(done).toBe(false);
    fake.finish();
    await task;
    expect(slept).toEqual([TASK_OPEN_WAIT_MS]);

    // Never opens: the bound releases the task without a pass.
    const stuck = fakeTarget({ phase: "opening" });
    const second = createSyncRunner({
      targets: () => [stuck.target],
      now: () => 0,
      sleep: () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
    });
    let released = false;
    const late = second.request("task").then(() => {
      released = true;
    });
    await flush();
    expect(released).toBe(false);
    wake();
    await late;
    expect(stuck.passes).toEqual([]);
  });

  it("opens a failed vault again on a foreground after a back-off of 1, 5, then 30 minutes", async () => {
    const fake = fakeTarget({ phase: "failed", failure: "keystore_unavailable" });
    let now = 1_000_000;
    const runner = createSyncRunner({
      targets: () => [fake.target],
      now: () => now,
      sleep: async () => {},
    });
    // The failure is first seen at the start; start and task never reopen.
    await runner.request("start");
    now += 2 * MINUTE;
    await runner.request("task");
    expect(fake.retries()).toBe(0);
    // A foreground a minute later reopens it once; a second foreground meanwhile joins.
    const foreground = runner.request("foreground");
    const again = runner.request("foreground");
    expect(fake.retries()).toBe(1);
    fake.open("failed");
    await Promise.all([foreground, again]);
    expect(fake.passes).toEqual([]);
    // Failed again: the next try waits 5 minutes, the one after it 30, and every later one 30.
    for (const wait of [5, 30, 30]) {
      const tries = fake.retries();
      now += (wait - 1) * MINUTE;
      await runner.request("foreground");
      expect(fake.retries()).toBe(tries);
      now += MINUTE;
      const retried = runner.request("foreground");
      expect(fake.retries()).toBe(tries + 1);
      fake.open("failed");
      await retried;
    }
    // Healed: the foreground's pass runs once it opened, and the back-off starts over.
    now += 30 * MINUTE;
    const healed = runner.request("foreground");
    fake.open("ready");
    await flush();
    expect(fake.passes).toEqual(["full"]);
    fake.finish();
    await healed;
    fake.set({ phase: "failed" });
    now += 10 * MINUTE;
    await runner.request("foreground");
    const tries = fake.retries();
    now += MINUTE;
    const next = runner.request("foreground");
    expect(fake.retries()).toBe(tries + 1);
    fake.open("ready");
    await flush();
    fake.finish();
    await next;
  });

  it.each([
    "needs_repair",
    "untrusted_identity",
    "profile_mismatch",
    "vault_rolled_back",
    "vault_log_mismatch",
  ])("never reopens a vault that failed with %s", async (failure) => {
    const fake = fakeTarget({ phase: "failed", failure });
    let now = 0;
    const runner = createSyncRunner({ targets: () => [fake.target], now: () => now });
    await runner.request("start");
    for (let i = 0; i < 4; i++) {
      now += 60 * MINUTE;
      await runner.request("foreground");
    }
    expect(fake.retries()).toBe(0);
    expect(fake.passes).toEqual([]);
  });

  it("keeps pulling for a vault waiting for a key rotation", async () => {
    const fake = fakeTarget({ phase: "waiting", failure: "rotation_pending" });
    const runner = createSyncRunner({ targets: () => [fake.target], now: () => 0 });
    const start = runner.request("start");
    fake.finish();
    await start;
    expect(fake.passes).toEqual(["full"]);
  });

  it("settles a request when a pass rejects", async () => {
    const target: SyncTarget = {
      vault: VAULT,
      opened: Promise.resolve(),
      status: () => ({
        vault: VAULT,
        phase: "ready",
        syncing: false,
        remote: true,
        unpushed: false,
      }),
      pass: () => Promise.reject(new Error("relay_unreachable")),
    };
    const runner = createSyncRunner({ targets: () => [target], now: () => 0 });
    await expect(runner.request("start")).resolves.toBeUndefined();
  });
});

/** A virtual clock with one-shot timers: `advance` fires every timer that falls due, in order. */
function virtualClock(start = 1_000_000) {
  let now = start;
  const timers: { at: number; fire: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    after: (ms: number, fire: () => void) => {
      const timer = { at: now + ms, fire, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    /** Timers still to fire. */
    pending: () => timers.filter((t) => !t.cancelled).length,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers
          .filter((t) => !t.cancelled && t.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.cancelled = true;
        now = due.at;
        due.fire();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

describe("the push after an own write", () => {
  /** A runner in the foreground over one vault with own writes waiting, on a virtual clock. */
  function setup() {
    const clock = virtualClock();
    const fake = fakeTarget({ unpushed: true, lastPullAt: clock.now() });
    const runner = createSyncRunner({
      targets: () => [fake.target],
      now: clock.now,
      after: clock.after,
      every: () => () => {},
    });
    runner.foreground(true);
    return { clock, fake, runner };
  }

  it("starts a push pass 2 s after the last write while the app stays open", async () => {
    const { clock, fake, runner } = setup();
    runner.wrote();
    await clock.advance(1_500);
    // A second write moves the push: one pass for both, 2 s after the later one.
    runner.wrote();
    await clock.advance(WRITE_PUSH_DEBOUNCE_MS - 1);
    expect(fake.passes).toEqual([]);
    await clock.advance(1);
    expect(fake.passes).toEqual(["push"]);
    expect(WRITE_PUSH_DEBOUNCE_MS).toBe(2_000);
    fake.finish(true);
    await flush();
    // Nothing more without a new write.
    await clock.advance(10 * MINUTE);
    expect(fake.passes).toEqual(["push"]);
  });

  it("pushes nothing when the write left nothing unpushed, or outside the foreground", async () => {
    const { clock, fake, runner } = setup();
    fake.set({ unpushed: false });
    runner.wrote();
    await clock.advance(WRITE_PUSH_DEBOUNCE_MS);
    expect(fake.passes).toEqual([]);
    fake.set({ unpushed: true });
    runner.wrote();
    // Leaving the foreground drops the timer (the background trigger pushes there).
    runner.foreground(false);
    expect(clock.pending()).toBe(0);
    runner.wrote();
    await clock.advance(MINUTE);
    expect(fake.passes).toEqual([]);
  });

  it("looks again after a pass that was running when the write came", async () => {
    const { clock, fake, runner } = setup();
    fake.set({ unpushed: false });
    const running = runner.request("start");
    expect(fake.passes).toEqual(["full"]);
    fake.set({ unpushed: true });
    runner.wrote();
    await clock.advance(WRITE_PUSH_DEBOUNCE_MS);
    expect(fake.passes).toEqual(["full"]);
    fake.finish(true);
    await running;
    await flush();
    expect(fake.passes).toEqual(["full", "push"]);
  });

  it("waits out the relay back-off: 60 s doubling after failed passes, 1 h after the quota, none after a clean pass", async () => {
    const { clock, fake, runner } = setup();
    const failedPush = async (lastError: "unavailable" | "quota") => {
      runner.wrote();
      await clock.advance(WRITE_PUSH_DEBOUNCE_MS);
      fake.set({ relay: { lastError, lastErrorAt: clock.now() } });
      fake.finish(true);
      await flush();
    };
    await failedPush("unavailable");
    expect(fake.passes).toEqual(["push"]);
    // A write 2 s later waits for the 60 s back-off counted from the failed pass.
    runner.wrote();
    await clock.advance(WRITE_BACKOFF_START_MS - 1);
    expect(fake.passes).toEqual(["push"]);
    await clock.advance(1);
    expect(fake.passes).toEqual(["push", "push"]);
    // That one fails too: the next waits 120 s.
    fake.finish(true);
    await flush();
    runner.wrote();
    await clock.advance(2 * WRITE_BACKOFF_START_MS - 1);
    expect(fake.passes).toHaveLength(2);
    await clock.advance(1);
    expect(fake.passes).toHaveLength(3);
    // The quota: an hour.
    fake.set({ relay: { lastError: "quota", lastErrorAt: clock.now() } });
    fake.finish(true);
    await flush();
    runner.wrote();
    await clock.advance(WRITE_QUOTA_BACKOFF_MS - 1);
    expect(fake.passes).toHaveLength(3);
    await clock.advance(1);
    expect(fake.passes).toHaveLength(4);
    // That one hit the quota again; a pass that reaches the relay meanwhile (the open's) ends the
    // back-off: the next write goes up 2 s later, not an hour later.
    fake.finish(true);
    await flush();
    fake.set({ relay: { lastOk: clock.now() } });
    const start = runner.request("start");
    fake.finish(true);
    await start;
    expect(fake.passes).toHaveLength(5);
    runner.wrote();
    await clock.advance(WRITE_PUSH_DEBOUNCE_MS);
    expect(fake.passes).toEqual(["push", "push", "push", "push", "full", "push"]);
    fake.finish(true);
  });
});

describe("syncCause", () => {
  const base: VaultSyncStatus = {
    vault: VAULT,
    phase: "ready",
    syncing: false,
    remote: true,
    unpushed: false,
  };
  it.each([
    [{}, null],
    [{ remote: false, phase: "failed" as const }, null],
    [{ phase: "receiving" as const }, "receiving"],
    [{ phase: "waiting" as const }, "receiving"],
    [{ phase: "removed" as const }, "removed"],
    [{ relay: { lastError: "forbidden" as const } }, "removed"],
    [{ phase: "failed" as const }, "failed"],
    [{ relay: { lastError: "quota" as const } }, "quota"],
    [{ relay: { lastError: "unavailable" as const } }, "offline"],
    [{ failure: "relay_unreachable" }, "offline"],
  ])("%j -> %s", (patch, cause) => {
    expect(syncCause({ ...base, ...patch })).toBe(cause);
  });
  it("says nothing for a vault this phone does not hold", () => {
    expect(syncCause(undefined)).toBeNull();
  });
});
