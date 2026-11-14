// Device-local signed-history clock observation state (the sync `ClockGuardStore`) in the vault's
// `store_meta` table: one JSON object of per-writer high-water walls under `fetch-clock-guard:<device>`.
// The key and the JSON shape are a persisted format of existing vaults: keep them byte-identical.
import type { ClockGuardStore } from "@cashu/sync/engine";
import { z } from "zod";
import type { SqlDriver } from "../sql/driver.js";

const DEVICE = /^[0-9a-f]{32}$/;
const wallsSchema = z.record(
  z.string().regex(DEVICE),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
);

const guardKey = (device: string): string => `fetch-clock-guard:${device}`;

export function metaClockGuardStore(driver: SqlDriver, device: string): ClockGuardStore {
  if (!DEVICE.test(device)) throw new Error("clock_guard_invalid");
  const key = guardKey(device);
  const get = driver.prepare("SELECT value FROM store_meta WHERE key=?");
  const put = driver.prepare("UPDATE store_meta SET value=? WHERE key=?");
  const parse = (raw: string | undefined): Record<string, number> => {
    if (raw === undefined) throw new Error("clock_guard_missing");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("clock_guard_corrupt");
    }
    const validated = wallsSchema.safeParse(value);
    if (!validated.success) throw new Error("clock_guard_corrupt");
    const walls: Record<string, number> = Object.create(null);
    for (const [writer, wall] of Object.entries(validated.data)) walls[writer] = wall;
    return walls;
  };
  return {
    load() {
      return parse(get.get<{ value: string }>(key)?.value);
    },
    save(walls) {
      const current = parse(get.get<{ value: string }>(key)?.value);
      const validated = wallsSchema.safeParse(walls);
      if (!validated.success) throw new Error("clock_guard_invalid");
      const next: Record<string, number> = Object.create(null);
      for (const [writer, wall] of Object.entries(validated.data)) {
        if (wall < (current[writer] ?? 0)) throw new Error("clock_guard_invalid");
        next[writer] = wall;
      }
      for (const writer of Object.keys(current))
        if (next[writer] === undefined) throw new Error("clock_guard_invalid");
      if (put.run(JSON.stringify(next), key).changes !== 1) throw new Error("clock_guard_missing");
    },
  };
}

/** Call only on a brand-new empty view, before the first event or cursor is applied. */
export function initializeMetaClockGuard(driver: SqlDriver, device: string): void {
  if (!DEVICE.test(device)) throw new Error("clock_guard_invalid");
  driver.transaction(() => {
    const applied = driver.prepare("SELECT 1 FROM event_log LIMIT 1").get();
    const cursor = driver.prepare("SELECT 1 FROM sync_cursors LIMIT 1").get();
    if (applied !== undefined || cursor !== undefined)
      throw new Error("clock_guard_existing_history");
    driver.prepare("INSERT INTO store_meta (key,value) VALUES (?,?)").run(guardKey(device), "{}");
  });
}
