// Value encodings of the view (what ported Python queries expect to find in a column).

/**
 * Event timestamp (`YYYY-MM-DDTHH:MM:SS[.f{1,6}]Z`, UTC) -> the naive UTC text SQLAlchemy writes for
 * a `DateTime` column on SQLite (`YYYY-MM-DD HH:MM:SS.ffffff`), so string comparisons in ported
 * queries keep working.
 */
export function viewTimestamp(ts: string): string;
export function viewTimestamp(ts: string | null | undefined): string | null;
export function viewTimestamp(ts: string | null | undefined): string | null {
  if (ts === null || ts === undefined) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(ts);
  if (!m) throw new RangeError("not an event timestamp");
  return `${m[1]} ${m[2]}.${(m[3] ?? "").padEnd(6, "0")}`;
}

/** View timestamp -> event timestamp with 3 fractional digits (tests, projections). */
export function eventTimestamp(view: string | null): string | null {
  if (view === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{6})$/.exec(view);
  if (!m) throw new RangeError("not a view timestamp");
  return `${m[1]}T${m[2]}.${(m[3] ?? "").slice(0, 3)}Z`;
}

export function sqlBool(b: boolean): number {
  return b ? 1 : 0;
}

export function sqlJson(v: unknown): string {
  return JSON.stringify(v);
}
