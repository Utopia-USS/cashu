import type { UpdateController } from "./controller.js";

/** First automatic check after the app (and its host) started. */
export const FIRST_CHECK_DELAY_MS = 90_000;
/** At most one automatic check per day of wall-clock time. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How often the schedule looks at the clock (a sleeping Mac does not advance timers). */
export const SCHEDULE_TICK_MS = 60 * 60 * 1000;

/**
 * The automatic update check of an installed release (the retired Python app's Sparkle checked once
 * a day without asking, and never downloaded on its own): one check FIRST_CHECK_DELAY_MS after
 * start, then hourly ticks that check again once CHECK_INTERVAL_MS of wall-clock time passed since
 * the last check that reached the feed. Every rule about whether a check may run (the release gate,
 * "Sprawdzaj codziennie", a busy or waiting update) lives in `controller.checkAutomatically`; a
 * refused tick retries at the next one. Started by Electron main only for a packaged app whose
 * update gate passed, so dev, tests, e2e, unsigned and staging builds never reach the network here.
 */
export function startUpdateSchedule(
  controller: Pick<UpdateController, "checkAutomatically">,
  now: () => number = Date.now,
): { stop(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCheck: number | null = null;
  const arm = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delay);
    timer.unref?.();
  };
  const tick = async () => {
    timer = undefined;
    if (stopped) return;
    if (lastCheck === null || now() - lastCheck >= CHECK_INTERVAL_MS) {
      let checked = false;
      try {
        checked = await controller.checkAutomatically();
      } catch {
        checked = false;
      }
      if (checked) lastCheck = now();
    }
    arm(SCHEDULE_TICK_MS);
  };
  arm(FIRST_CHECK_DELAY_MS);
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
