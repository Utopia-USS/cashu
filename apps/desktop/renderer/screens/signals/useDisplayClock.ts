import { useState } from "react";
import { minuteInstant } from "./signalModels.js";

/**
 * A display-only clock per hook instance (the current minute, refreshed when the calendar day changes)
 * for values such as note ages. It is never part of a query key: the Signals query reads
 * `dayReadInstant(today)`, so a new instance after a minute does not change what is asked for.
 */
export function useDisplayClock(day: string, now: () => Date = () => new Date()): string {
  const [clock, setClock] = useState(() => ({ day, instant: minuteInstant(now()) }));
  if (clock.day === day) return clock.instant;
  const next = { day, instant: minuteInstant(now()) };
  setClock(next);
  return next.instant;
}
