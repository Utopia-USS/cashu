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
