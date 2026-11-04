import { useState } from "react";
import { minuteInstant } from "./signalModels.js";

/**
 * A read-only fallback clock for the Signals query, per hook instance and refreshed when the
 * calendar day changes; the host's live clock overrides it once bound. It never grants write or
 * fetch authority. The first read suspends and React retries the render without kept state, so the
 * instant is the current minute: retries within that minute ask for the same query key.
 */
export function useDisplayClock(day: string, now: () => Date = () => new Date()): string {
  const [clock, setClock] = useState(() => ({ day, instant: minuteInstant(now()) }));
  if (clock.day === day) return clock.instant;
  const next = { day, instant: minuteInstant(now()) };
  setClock(next);
  return next.instant;
}
