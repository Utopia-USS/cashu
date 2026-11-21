// Crash-loop detection: `<run>/starts.json` lists the starts of this data dir's host that have not
// ended in a clean exit. A start appends itself (after taking the machine lock, so a spawn-race loser
// never counts) and a clean exit (stop, idle, handover) clears the list. When 3 or more unclean starts
// lie within the last 10 minutes, the next host starts in SAFE MODE: it serves reads and commands but
// runs no jobs and no network (a host that crashes during a fetch must not refetch in a loop, rule 6),
// and says so in `cashu host status` and the log. The file is written atomically (temp + rename).
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const CRASH_LOOP_STARTS = 3;
export const CRASH_LOOP_WINDOW_MS = 10 * 60 * 1000;

const startsSchema = z.object({
  format: z.literal(1),
  unclean: z.array(z.number().int().nonnegative()).max(100),
});

export interface StartRecord {
  /** Whether this start runs in safe mode. */
  readonly safeMode: boolean;
  /** Unclean starts within the window before this one. */
  readonly recentCrashes: number;
  /** Marks this host's exit as clean (clears the list). */
  clean(): void;
}

function read(path: string): number[] {
  try {
    const parsed = startsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data.unclean : [];
  } catch {
    return [];
  }
}

function write(path: string, unclean: readonly number[]): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ format: 1, unclean })}\n`, { mode: 0o600, flush: true });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** Unclean starts within the crash-loop window before `now` (read only; a failed start's fact). */
export function recentUncleanStarts(runDir: string, now: number): number {
  return read(join(runDir, "starts.json")).filter(
    (at) => at <= now && now - at < CRASH_LOOP_WINDOW_MS,
  ).length;
}

/** Records this start in `runDir` (the caller holds the machine lock). */
export function recordStart(runDir: string, now: number): StartRecord {
  const path = join(runDir, "starts.json");
  const recent = read(path).filter((at) => at <= now && now - at < CRASH_LOOP_WINDOW_MS);
  write(path, [...recent, now].slice(-50));
  return {
    safeMode: recent.length >= CRASH_LOOP_STARTS,
    recentCrashes: recent.length,
    clean: () => write(path, []),
  };
}
