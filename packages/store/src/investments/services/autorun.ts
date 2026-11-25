/** The day of the vault's last successful rule run (the host worker's daily due policy reads it). */

import { parseDateTime, utcIso } from "@cashu/domain";
import type { Read } from "../queries/shared.js";
import { ruleRuns } from "../queries/signals.js";

export function lastOkDay(read: Read, localDay: (instant: string) => string): string | null {
  const run = ruleRuns(read, -1).find((r) => r.status === "ok" || r.status === "partial");
  return run ? localDay(utcIso(parseDateTime(run.startedAt))) : null;
}
