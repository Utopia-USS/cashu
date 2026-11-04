/** Python worker/budget.py policy; transport/session authority is an explicit injected capability. */

import { parseDateTime, toUtc, utcIso } from "@cashu/domain";
import type { OpenVault } from "../stores.js";
import type { BudgetBook, BudgetSyncPort, JobOutcome, WorkerState } from "./contracts.js";

export const BANK_INTERVAL_MS = 20 * 60 * 60 * 1000;
export const BANK_BACKOFF_MS = 48 * 60 * 60 * 1000;
function instant(value: string | undefined, roundUp = false): number | undefined {
  if (value === undefined) return undefined;
  try {
    // Source _parse treats naive legacy timestamps as UTC, independent of the host timezone.
    const date = toUtc(
      parseDateTime(/^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00` : value),
    );
    const second = Date.parse(utcIso({ ...date, microsecond: 0 }));
    return second + (roundUp ? Math.ceil(date.microsecond / 1000) : date.microsecond / 1000);
  } catch {
    return undefined;
  }
}
export function budgetBlockedUntil(book: BudgetBook, now: number): number | null {
  const attempt = instant(book.last_attempt, true),
    throttled = instant(book.throttled_until, true);
  const candidates = [
    attempt === undefined ? undefined : attempt + BANK_INTERVAL_MS,
    throttled,
  ].filter((value): value is number => value !== undefined && value > now);
  return candidates.length === 0 ? null : Math.max(...candidates);
}
export function budgetDaysToFetch(book: BudgetBook, now: number): number {
  const success = instant(book.last_success);
  return success === undefined
    ? 90
    : Math.max(10, Math.min(90, Math.ceil((now - success) / 86_400_000) + 3));
}
export async function syncWorkerBudget(deps: {
  readonly vault: OpenVault;
  readonly port: BudgetSyncPort;
  readonly state: WorkerState;
  readonly now: () => number;
  readonly save: () => Promise<void>;
  readonly guard: () => void;
}): Promise<JobOutcome> {
  const { vault, port, state, guard } = deps;
  guard();
  if (!port.configured(vault)) return { status: "skipped", code: "eb_not_configured" };
  if (!port.hasSavedSessions(vault)) return { status: "skipped", code: "no_bank_sessions" };
  guard();
  const now = deps.now();
  const book = state.budget[vault.id] ?? {};
  state.budget[vault.id] = book;
  if (budgetBlockedUntil(book, now) !== null) return { status: "skipped", code: "throttled" };
  const days = budgetDaysToFetch(book, now);
  book.last_attempt = new Date(now).toISOString();
  // Durability precedes the first request. An ambiguous/failed save never authorizes a retry.
  await deps.save();
  guard();
  let result: Awaited<ReturnType<BudgetSyncPort["sync"]>>;
  try {
    result = await port.sync(vault, days, guard);
  } catch {
    guard();
    book.last_status = "failed";
    await deps.save();
    return { status: "failed", code: "budget_sync_failed", stats: { days } };
  }
  guard();
  const errors = result.errors ?? [];
  if (errors.some((error) => error.includes("429") || error.toLowerCase().includes("rate limit")))
    book.throttled_until = new Date(now + BANK_BACKOFF_MS).toISOString();
  if (!result.ok) {
    book.last_status = "failed";
    await deps.save();
    return { status: "failed", code: "budget_sync_failed", stats: { days } };
  }
  book.last_status = errors.length === 0 ? "ok" : "partial";
  if (errors.length === 0) book.last_success = new Date(now).toISOString();
  await deps.save();
  return {
    status: errors.length === 0 ? "ok" : "partial",
    ...(errors.length === 0 ? {} : { code: "budget_sync_partial" }),
    stats: {
      days,
      inserted: result.inserted ?? 0,
      banks: result.banks ?? 0,
      errors: errors.length,
    },
  };
}
