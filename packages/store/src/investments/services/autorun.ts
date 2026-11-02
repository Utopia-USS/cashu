/** Scheduling policy only. Host startup/tick/wake drivers remain S40/S56e. */

import { parseDateTime, utcIso } from "@cashu/domain";
import type { Read } from "../queries/shared.js";
import { ruleRuns } from "../queries/signals.js";

export interface LocalMoment {
  readonly day: string;
  readonly hour: number;
  readonly minute: number;
}
export function dailyDue(lastOk: string | null, now: LocalMoment, atStart: boolean): boolean {
  return (
    !(lastOk !== null && lastOk >= now.day) &&
    (atStart || now.hour > 7 || (now.hour === 7 && now.minute >= 30))
  );
}
export function lastOkDay(read: Read, localDay: (instant: string) => string): string | null {
  const run = ruleRuns(read, -1).find((r) => r.status === "ok" || r.status === "partial");
  return run ? localDay(utcIso(parseDateTime(run.startedAt))) : null;
}
export async function runIfDue(deps: {
  readonly enabled: boolean;
  readonly profiles: readonly { readonly vault: string; readonly lastOk: string | null }[];
  readonly now: LocalMoment;
  readonly atStart: boolean;
  readonly run: (vaults: readonly string[]) => Promise<{ readonly status: string }>;
  readonly backfill: () => Promise<void>;
}): Promise<{
  status: "disabled" | "not_due" | "ran" | "busy" | "failed";
  profiles: readonly string[];
}> {
  if (!deps.enabled) return { status: "disabled", profiles: [] };
  const profiles = deps.profiles
    .filter((p) => dailyDue(p.lastOk, deps.now, deps.atStart))
    .map((p) => p.vault);
  if (!profiles.length) return { status: "not_due", profiles };
  try {
    const report = await deps.run(profiles);
    if (report.status === "busy") return { status: "busy", profiles };
    try {
      await deps.backfill();
    } catch {
      /* Optional housekeeping never fails a daily run. */
    }
    return { status: "ran", profiles };
  } catch {
    return { status: "failed", profiles };
  }
}
