// The refresh policy over fake guards and a fake pass: which lease states run a pass, the back-off
// after a pass without evidence, shared passes and waiting for a pass already running.
import { expect, it } from "vitest";
import {
  FETCH_PULL_BACKOFF_MAX_MS,
  FETCH_PULL_BACKOFF_MS,
  fetchAuthorityRefresh,
} from "./fetchAuthority.js";
import type { FetchLeaseState } from "./guards.js";
import { REFRESH_PASS_FAILED } from "./sync.js";

const T0 = Date.UTC(2026, 10, 8, 12);

function harness(initial: FetchLeaseState = "pull_stale") {
  let time = T0;
  let state: FetchLeaseState = initial;
  let syncing = false;
  const listeners = new Set<() => void>();
  const world = {
    passes: 0,
    /** What a pass does: by default it brings fresh evidence. */
    onPass: async (): Promise<void> => {
      state = "pull_fresh";
    },
    advance(ms: number) {
      time += ms;
    },
    set state(next: FetchLeaseState) {
      state = next;
    },
    get state() {
      return state;
    },
    startConcurrentPass() {
      syncing = true;
      return () => {
        syncing = false;
        for (const listener of [...listeners]) listener();
      };
    },
  };
  const refresh = fetchAuthorityRefresh(
    { now: () => time },
    {
      canFetchPublicMarket: () => !syncing && state === "pull_fresh",
      fetchLeaseState: () => (syncing ? "unavailable" : state),
    },
    {
      refreshPass: async () => {
        world.passes++;
        await world.onPass();
        return {} as never;
      },
      isSyncing: () => syncing,
      onSyncSettled(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  );
  return { world, refresh };
}

it("runs a pass only for the named leader whose evidence is stale", async () => {
  for (const state of ["not_leader", "handover_pending", "clock_suspect", "pull_fresh"] as const) {
    const { world, refresh } = harness(state);
    await refresh.refreshFetchAuthority();
    expect(world.passes, state).toBe(0);
  }
  const { world, refresh } = harness("handover_pending");
  expect(refresh.fetchAuthorityIssue()).toBe("fetch_handover_pending");
  expect(refresh.mayObtainFetchAuthority()).toBe(false);
  world.state = "clock_suspect";
  expect(refresh.fetchAuthorityIssue()).toBe("fetch_clock_suspect");
  world.state = "not_leader";
  expect(refresh.fetchAuthorityIssue()).toBe("fetch_not_leader");
  world.state = "pull_stale";
  expect(refresh.fetchAuthorityIssue()).toBeNull();
  expect(refresh.mayObtainFetchAuthority()).toBe(true);
  expect(await refresh.refreshFetchAuthority()).toBe(true);
  expect(world.passes).toBe(1);
});

it("backs off, growing and capped, after passes that produced no evidence", async () => {
  const { world, refresh } = harness();
  world.onPass = async () => {}; // An offline remote: the evidence stays stale.
  expect(await refresh.refreshFetchAuthority()).toBe(false);
  expect(world.passes).toBe(1);
  expect(refresh.fetchAuthorityIssue()).toBe("fetch_pull_incomplete");
  expect(refresh.mayObtainFetchAuthority()).toBe(false);
  // Every 60 s worker tick until the delay passes runs nothing.
  world.advance(FETCH_PULL_BACKOFF_MS - 1);
  await refresh.refreshFetchAuthority();
  expect(world.passes).toBe(1);
  world.advance(1);
  await refresh.refreshFetchAuthority();
  expect(world.passes).toBe(2);
  world.advance(FETCH_PULL_BACKOFF_MS);
  await refresh.refreshFetchAuthority();
  expect(world.passes).toBe(2); // Second miss: 120 s.
  world.advance(FETCH_PULL_BACKOFF_MS);
  await refresh.refreshFetchAuthority();
  expect(world.passes).toBe(3);
  // A day of 60 s ticks stays far below one pass per tick, and the delay never exceeds the cap.
  let passes = world.passes;
  for (let tick = 0; tick < 24 * 60; tick++) {
    world.advance(60_000);
    const before = world.passes;
    await refresh.refreshFetchAuthority();
    if (world.passes > before) passes++;
  }
  expect(passes - 3).toBeLessThanOrEqual(24 * 60 * (60_000 / FETCH_PULL_BACKOFF_MAX_MS) + 6);
  expect(passes - 3).toBeGreaterThanOrEqual(24 * 60 * (60_000 / FETCH_PULL_BACKOFF_MAX_MS) - 1);
  // Evidence again: the back-off resets.
  world.onPass = async () => {
    world.state = "pull_fresh";
  };
  world.advance(FETCH_PULL_BACKOFF_MAX_MS);
  expect(await refresh.refreshFetchAuthority()).toBe(true);
  world.state = "pull_stale";
  world.advance(1);
  world.onPass = async () => {};
  await refresh.refreshFetchAuthority();
  const after = world.passes;
  world.advance(FETCH_PULL_BACKOFF_MS);
  await refresh.refreshFetchAuthority();
  expect(world.passes).toBe(after + 1);
});

it("reports a failed pass that kept the session, and backs off after it", async () => {
  const { world, refresh } = harness();
  world.onPass = async () => {
    throw new Error(REFRESH_PASS_FAILED);
  };
  expect(await refresh.refreshFetchAuthority()).toBe(false);
  expect(refresh.fetchAuthorityIssue()).toBe("fetch_pull_failed");
  await refresh.refreshFetchAuthority();
  expect(world.passes).toBe(1);
});

it("shares one pass between concurrent callers", async () => {
  const { world, refresh } = harness();
  let release!: () => void;
  world.onPass = () =>
    new Promise<void>((resolve) => {
      release = () => {
        world.state = "pull_fresh";
        resolve();
      };
    });
  const first = refresh.refreshFetchAuthority();
  const second = refresh.refreshFetchAuthority();
  await Promise.resolve();
  release();
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(world.passes).toBe(1);
});

it("waits for a pass already running and needs none of its own when that pass brought evidence", async () => {
  const { world, refresh } = harness();
  const settle = world.startConcurrentPass();
  const waiting = refresh.refreshFetchAuthority();
  await new Promise((resolve) => setImmediate(resolve));
  world.state = "pull_fresh";
  settle();
  expect(await waiting).toBe(true);
  expect(world.passes).toBe(0);
});
