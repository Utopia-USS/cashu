import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  SCHEDULE_TICK_MS,
  startUpdateSchedule,
} from "./schedule.js";

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2027-01-01T08:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

/** A fake controller: resolves `answers` in turn (true = the feed was asked), then true. */
function fakeController(answers: boolean[] = []) {
  const checkAutomatically = vi.fn(async () => answers.shift() ?? true);
  return { checkAutomatically };
}

describe("automatic update schedule", () => {
  it("checks once shortly after start, then once a day", async () => {
    const controller = fakeController();
    const schedule = startUpdateSchedule(controller);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(controller.checkAutomatically).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.checkAutomatically).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - SCHEDULE_TICK_MS);
    expect(controller.checkAutomatically).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
    expect(controller.checkAutomatically).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(controller.checkAutomatically).toHaveBeenCalledTimes(3);
    schedule.stop();
  });

  it("retries a refused check (gate, setting off, busy) at the next hourly tick", async () => {
    const controller = fakeController([false, false, true]);
    const schedule = startUpdateSchedule(controller);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(controller.checkAutomatically).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
    expect(controller.checkAutomatically).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
    expect(controller.checkAutomatically).toHaveBeenCalledTimes(3);
    // That one reached the feed: the next is a day later.
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - SCHEDULE_TICK_MS);
    expect(controller.checkAutomatically).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
    expect(controller.checkAutomatically).toHaveBeenCalledTimes(4);
    schedule.stop();
  });

  it("counts wall-clock time, so a Mac that slept a day checks at the next tick", async () => {
    const controller = fakeController();
    const schedule = startUpdateSchedule(controller);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(controller.checkAutomatically).toHaveBeenCalledOnce();
    // Asleep: the wall clock moves a day, the timers do not.
    vi.setSystemTime(Date.now() + CHECK_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
    expect(controller.checkAutomatically).toHaveBeenCalledTimes(2);
    schedule.stop();
  });

  it("a throwing controller does not stop the schedule; stop() cancels everything", async () => {
    const controller = { checkAutomatically: vi.fn(async () => Promise.reject(new Error("x"))) };
    const schedule = startUpdateSchedule(controller);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + SCHEDULE_TICK_MS);
    expect(controller.checkAutomatically).toHaveBeenCalledTimes(2);
    schedule.stop();
    await vi.advanceTimersByTimeAsync(10 * CHECK_INTERVAL_MS);
    expect(controller.checkAutomatically).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never asks before the first delay when stopped at once", async () => {
    const controller = fakeController();
    startUpdateSchedule(controller).stop();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(controller.checkAutomatically).not.toHaveBeenCalled();
  });
});
