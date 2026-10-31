// The store's side of the hybrid logical clock. The one HLC implementation (format, order, send /
// receive, guards) lives in `@cashu/sync/hlc` (events.md 3.3); the store only persists a device's
// clock state in its meta table, in the same database (and transaction) as the events it stamped.
import type { HlcState } from "@cashu/sync/hlc";
import type { SqlDriver } from "./sql/driver.js";

export { HybridClock } from "@cashu/sync/hlc";

/** Durable clock state of one device in this vault (structurally the sync `ClockStore`). */
export interface MetaClockStore {
  load(): HlcState | undefined;
  save(state: HlcState): void;
}

export function metaClockStore(driver: SqlDriver, device: string): MetaClockStore {
  const key = `clock:${device}`;
  const get = driver.prepare("SELECT value FROM store_meta WHERE key = ?");
  const put = driver.prepare(
    "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  return {
    load() {
      const row = get.get<{ value: string }>(key);
      if (!row) return undefined;
      const s = JSON.parse(row.value) as HlcState;
      return { wall: s.wall, counter: s.counter };
    },
    save(state) {
      put.run(key, JSON.stringify({ wall: state.wall, counter: state.counter }));
    },
  };
}
