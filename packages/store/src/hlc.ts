// The store's side of the hybrid logical clock. The one HLC implementation (format, order, send /
// receive, guards) lives in `@cashu/sync/hlc` (events.md 3.3); the store only persists a device's
// clock state in its meta table, in the same database (and transaction) as the events it stamped.
import type { StuckRecord } from "@cashu/sync/engine";
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

/** The sync engine's `GateStateStore` (S29c-B3) for one device, in `store_meta`. */
export interface MetaGateStateStore {
  load(): string | undefined;
  save(state: string): void;
  loadEvidence(): readonly string[];
  appendEvidence(records: readonly string[]): void;
  /** The engine's stuck records (JSON array of `StuckRecord`); undefined when none or unreadable. */
  loadStuck(): string | undefined;
  saveStuck(state: string): void;
}

/**
 * The frame gate's snapshot of `device` in `store_meta` (`gate:<device>`). The gate authenticates
 * its own text; the store only keeps it. It survives `reset()` (the snapshot describes the log, not
 * the view) and goes with the database file (`openOrRecover`: a new database replays the log).
 * The gate's evidence record (proven forks) is append only, one row per record
 * (`gate-evidence:<device>:<record>`), never replaced with the snapshot. The engine's stuck records
 * (D7: a writer's stream that did not move past one frame) are one JSON value (`gate-stuck:<device>`),
 * checked on load: a value that does not decode as a list of records reads as none (the next pass
 * that meets the frame records it again).
 */
export function metaGateStateStore(driver: SqlDriver, device: string): MetaGateStateStore {
  const key = `gate:${device}`;
  const get = driver.prepare("SELECT value FROM store_meta WHERE key = ?");
  const put = driver.prepare(
    "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  const evidence = `gate-evidence:${device}:`;
  const add = driver.prepare("INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, ?)");
  const all = driver.prepare("SELECT value FROM store_meta WHERE key LIKE ? ORDER BY rowid");
  const stuck = `gate-stuck:${device}`;
  return {
    load: () => get.get<{ value: string }>(key)?.value,
    save(state) {
      put.run(key, state);
    },
    loadEvidence: () => all.all<{ value: string }>(`${evidence}%`).map((r) => r.value),
    appendEvidence(records) {
      for (const record of records) add.run(`${evidence}${record}`, record);
    },
    loadStuck() {
      const value = get.get<{ value: string }>(stuck)?.value;
      return value !== undefined && isStuckList(value) ? value : undefined;
    },
    saveStuck(state) {
      put.run(stuck, state);
    },
  };
}

const STUCK_KINDS: ReadonlySet<unknown> = new Set(["waiting", "rejected", "final"]);

/** Whether `text` is a JSON array of well-formed stuck records (an empty one included). */
function isStuckList(text: string): boolean {
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    return false;
  }
  return Array.isArray(rows) && rows.every(isStuckRecord);
}

function isStuckRecord(value: unknown): value is StuckRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.device === "string" &&
    r.device.length > 0 &&
    Number.isSafeInteger(r.seg) &&
    Number.isSafeInteger(r.offset) &&
    typeof r.code === "string" &&
    r.code.length > 0 &&
    STUCK_KINDS.has(r.kind) &&
    Number.isSafeInteger(r.firstSeenAt) &&
    Number.isSafeInteger(r.passes) &&
    (r.passes as number) >= 1
  );
}
