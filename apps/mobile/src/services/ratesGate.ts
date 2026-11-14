// The gate of a refresh from the network: a key (the NBP rates' currency set, the prices' vault) runs at
// most once per interval (an hour for the rates) after a run that reached the network, never twice at
// once, and an offline run leaves the gate open so the next activation tries again (rates.ts: "the
// phone tries again at the next activation").

const HOUR_MS = 3_600_000;

export interface RatesGate {
  /** Whether a run for `key` may start at `now` (ms); when it may, the run counts as in flight. */
  begin(key: string, now: number): boolean;
  /** Ends the run of `key` that began at `at`; only a run that was not offline closes the gate. */
  finish(key: string, at: number, offline: boolean): void;
}

export function createRatesGate(intervalMs = HOUR_MS): RatesGate {
  // One timestamp and one in-flight flag per key: switching profiles A -> B -> A inside the interval does not
  // fetch A again, and A and B can each run once at the same time.
  const last = new Map<string, number>();
  const running = new Set<string>();
  return {
    begin(key, now) {
      if (running.has(key)) return false;
      const at = last.get(key);
      if (at !== undefined && now - at < intervalMs) return false;
      running.add(key);
      return true;
    },
    finish(key, at, offline) {
      running.delete(key);
      if (!offline) last.set(key, at);
    },
  };
}
