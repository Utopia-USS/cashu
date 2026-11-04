/** Device-local signed-history clock observation state for fetch lease evidence. */
import type { SqlDriver } from "@cashu/store";
import type { ClockGuardStore } from "@cashu/sync";
import { z } from "zod";

const DEVICE = /^[0-9a-f]{32}$/;
const wallsSchema = z.record(
  z.string().regex(DEVICE),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
);

export function nativeClockGuard(driver: SqlDriver, device: string): ClockGuardStore {
  if (!DEVICE.test(device)) throw new Error("market_clock_guard_invalid");
  const key = `fetch-clock-guard:${device}`;
  const get = driver.prepare("SELECT value FROM store_meta WHERE key=?");
  const put = driver.prepare("UPDATE store_meta SET value=? WHERE key=?");
  const parse = (raw: string | undefined): Record<string, number> => {
    if (raw === undefined) throw new Error("market_clock_guard_missing");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("market_clock_guard_corrupt");
    }
    const validated = wallsSchema.safeParse(value);
    if (!validated.success) throw new Error("market_clock_guard_corrupt");
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
      if (!validated.success) throw new Error("market_clock_guard_invalid");
      const next: Record<string, number> = Object.create(null);
      for (const [writer, wall] of Object.entries(validated.data)) {
        if (wall < (current[writer] ?? 0)) throw new Error("market_clock_guard_invalid");
        next[writer] = wall;
      }
      for (const writer of Object.keys(current))
        if (next[writer] === undefined) throw new Error("market_clock_guard_invalid");
      if (put.run(JSON.stringify(next), key).changes !== 1)
        throw new Error("market_clock_guard_missing");
    },
  };
}

/** Call only on a brand-new empty view, before the first event or cursor is applied. */
export function initializeNativeClockGuard(driver: SqlDriver, device: string): void {
  if (!DEVICE.test(device)) throw new Error("market_clock_guard_invalid");
  driver.transaction(() => {
    const applied = driver.prepare("SELECT 1 FROM event_log LIMIT 1").get();
    const cursor = driver.prepare("SELECT 1 FROM sync_cursors LIMIT 1").get();
    if (applied !== undefined || cursor !== undefined)
      throw new Error("market_clock_guard_existing_history");
    const key = `fetch-clock-guard:${device}`;
    driver.prepare("INSERT INTO store_meta (key,value) VALUES (?,?)").run(key, "{}");
  });
}
