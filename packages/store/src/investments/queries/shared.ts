// Shared pieces of the investments queries: the vault's read function, identity roots, FK id -> gid
// and the stored timestamp forms. A query takes the vault's `Read` (`Store.read`, `CommandContext.read`),
// so it can never span two vaults (one view database per vault).
import { type DateTime, parseDateTime } from "@cashu/domain";
import type { Read } from "../../core/queries.js";
import { INSTRUMENTS } from "../instruments.js";

export type { Read };

/** SQL for the gid of a view id column (FK columns hold view ids; `view_ids` maps them back). */
export const gidOf = (column: string) => `(SELECT gid FROM view_ids WHERE id = ${column})`;

/** The identity root of instrument `gid` (itself when no claim or merge folded it). */
export function instrumentRoot(read: Read, gid: string): string {
  return (
    read<{ root: string }>(
      "SELECT root FROM identity_roots WHERE kind = ? AND gid = ?",
      INSTRUMENTS,
      gid,
    )[0]?.root ?? gid
  );
}

/** The view gid of instrument `gid` when its row exists (a create is held), else undefined. */
export function instrumentGid(read: Read, gid: string): string | undefined {
  return read<{ gid: string }>(
    "SELECT gid FROM inv_instruments WHERE gid = ?",
    instrumentRoot(read, gid),
  )[0]?.gid;
}

/** A stored view timestamp (`YYYY-MM-DD HH:MM:SS.ffffff`, naive UTC) as an aware UTC `DateTime`. */
export function storedTime(text: string): DateTime {
  return { ...parseDateTime(text), offsetSeconds: 0 };
}

/**
 * A stored view timestamp as an event timestamp that folds back to the same text (all six fraction
 * digits kept, unlike `eventTimestamp`): GUARD payloads compare against the folded value.
 */
export function eventTimeOf(view: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{6})$/.exec(view);
  if (!m) throw new RangeError("not a view timestamp");
  return `${m[1]}T${m[2]}.${m[3]}Z`;
}

/** A JSON column holding a list of strings (tags); SQL NULL or JSON `null` read as null. */
export function jsonStrings(text: string | null): readonly string[] | null {
  const v: unknown = text === null ? null : JSON.parse(text);
  if (v === null) return null;
  if (!Array.isArray(v)) throw new RangeError("expected a JSON list");
  return v.map(String);
}

/** A JSON column holding an object (payloads, params, stats); SQL NULL or JSON `null` read as {}. */
export function jsonObject(text: string | null): Readonly<Record<string, unknown>> {
  const v: unknown = text === null ? null : JSON.parse(text);
  if (v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new RangeError("expected a JSON object");
  return { ...v };
}

/** A JSON column holding a list (errors, issues, sources); SQL NULL or JSON `null` read as []. */
export function jsonList(text: string | null): readonly unknown[] {
  const v: unknown = text === null ? null : JSON.parse(text);
  if (v === null) return [];
  if (!Array.isArray(v)) throw new RangeError("expected a JSON list");
  return v;
}

/** `?, ?, ?` for an IN list of `n` parameters. */
export const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");
