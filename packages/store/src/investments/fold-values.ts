// Payload -> view value helpers shared by the investments materializers.
import { ACCOUNTS } from "../core/accounts.js";
import type { FoldContext, FoldEvent } from "../engine/types.js";
import type { SqlValue } from "../sql/driver.js";
import { sqlJson, viewTimestamp } from "../sql/values.js";
import { INSTRUMENTS } from "./instruments.js";

/** A string field, or null for null / absent / non-string. */
export const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A JSON column value (null stays SQL NULL). */
export const json = (v: unknown): string | null =>
  v === null || v === undefined ? null : sqlJson(v);

/** The view id of a reference as named (no identity resolution), null when absent. */
export const refId = (ctx: FoldContext, v: unknown): number | null =>
  typeof v === "string" ? ctx.id(v) : null;

/** The view id of an instrument reference, resolved to its identity root (events.md 6.4). */
export const instrumentId = (ctx: FoldContext, v: unknown): number | null =>
  typeof v === "string" ? ctx.id(ctx.resolve(INSTRUMENTS, v)) : null;

/** The view id of an account reference, resolved to its identity root (events.md 6.4). */
export const accountId = (ctx: FoldContext, v: unknown): number | null =>
  typeof v === "string" ? ctx.id(ctx.resolve(ACCOUNTS, v)) : null;

/**
 * Domain time of a nullable timestamp column whose payload field may be null (events.md 4.4): a
 * stamp present (null included) wins, then the payload value; null stays null (never `at`, which
 * `ctx.time` falls back to).
 */
export function nullableTime(e: FoldEvent, column: string, explicit: unknown): string | null {
  const stamps = e.data.stamps as Record<string, string | null> | undefined;
  if (stamps !== undefined && column in stamps) return viewTimestamp(stamps[column] ?? null);
  return typeof explicit === "string" ? viewTimestamp(explicit) : null;
}

/** Whether `e` carries a stamp (null included) for `column`. */
export function hasStamp(e: FoldEvent, column: string): boolean {
  const stamps = e.data.stamps as Record<string, unknown> | undefined;
  return stamps !== undefined && column in stamps;
}

/** `?` placeholders and values for `UPDATE ... SET a = ?, b = ?` from a column map. */
export function setClause(values: Readonly<Record<string, SqlValue>>): [string, SqlValue[]] {
  const cols = Object.keys(values);
  return [cols.map((c) => `${c} = ?`).join(", "), cols.map((c) => values[c] as SqlValue)];
}
