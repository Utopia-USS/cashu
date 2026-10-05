// Pure helpers (no React, no DOM), unit-tested with `npm test` (frontend/tests).

/** decodeURIComponent that returns null instead of throwing on a malformed escape
 * (a typo or truncated link like `#/%zz/overview` must not blank the page). */
export function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export interface SerialSaver<T> {
  /** Ask for `value` to be saved: sent now, or after the save in flight, replacing
   * any value still waiting (the latest request always wins, none is lost). */
  push(value: T): void;
  readonly busy: boolean;
}

/** Serializes saves of a whole state (e.g. a profile's module list, which the
 * backend replaces exactly): never two requests at once, and the value requested
 * last is the value sent last. `onIdle` runs when the queue drains (error = the
 * failure that stopped it, which also drops the waiting value). */
export function serialSaver<T>(
  save: (value: T) => Promise<unknown>,
  onIdle?: (error: unknown | null) => void,
): SerialSaver<T> {
  let pending: { value: T } | null = null;
  let running = false;

  const run = async () => {
    running = true;
    let error: unknown | null = null;
    try {
      while (pending) {
        const { value } = pending;
        pending = null;
        await save(value);
      }
    } catch (e) {
      error = e;
      pending = null;
    }
    running = false;
    onIdle?.(error);
  };

  return {
    push(value: T) {
      pending = { value };
      if (!running) void run();
    },
    get busy() {
      return running;
    },
  };
}

/** Monthly income / spending norm from complete months (F7 FE10): the average of up to `n` months before
 * `today`'s month that have transactions. The running month is never the norm (early in the month its
 * spending is a few days' worth and the salary may not be in). Null when no closed month has data. */
export function closedMonthNorm(
  rows: { label: string; income: number; expense: number }[] | null | undefined,
  today: string,
  n = 6,
): { income: number; expense: number; months: number } | null {
  const current = today.slice(0, 7);
  const closed = (rows ?? []).filter((r) => r.label < current && (r.income !== 0 || r.expense !== 0)).slice(-n);
  if (!closed.length) return null;
  const avg = (f: (r: { income: number; expense: number }) => number) => closed.reduce((s, r) => s + f(r), 0) / closed.length;
  return { income: avg((r) => r.income), expense: avg((r) => Math.abs(r.expense)), months: closed.length };
}
