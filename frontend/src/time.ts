// Server timestamps (F7 FE1). The API sends ISO 8601 date-times with an explicit UTC offset ("...Z" or
// "+00:00"); older servers sent naive UTC ("2026-10-05T10:00:00.123456"), which ECMAScript would read as
// LOCAL time. Every date-time from the server goes through `parseServerTime`, which reads a missing offset
// as UTC and trims fractions to milliseconds (WebKit is strict about longer fractions). A bare calendar
// date ("2026-10-05") is a local calendar day, not an instant in UTC. Pure; tested in tests/time.test.mjs.

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:[.,](\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Server date or date-time -> epoch ms (NaN when absent or unreadable). A date-time without an offset is
 * UTC; a bare date is local midnight of that calendar day. */
export function parseServerTime(iso: string | null | undefined): number {
  if (!iso) return NaN;
  const s = iso.trim();
  const d = DATE_ONLY.exec(s);
  if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime();
  const m = DATE_TIME.exec(s);
  if (!m) return NaN;
  const frac = m[3] ? `.${m[3].slice(0, 3).padEnd(3, "0")}` : "";
  const time = m[2].length === 5 ? `${m[2]}:00` : m[2];
  let off = (m[4] ?? "Z").toUpperCase();
  if (/^[+-]\d{2}$/.test(off)) off = `${off}:00`;
  else if (/^[+-]\d{4}$/.test(off)) off = `${off.slice(0, 3)}:${off.slice(3)}`;
  return Date.parse(`${m[1]}T${time}${frac}${off}`);
}

/** Server date-time -> Date (null when absent or unreadable). */
export function serverDate(iso: string | null | undefined): Date | null {
  const t = parseServerTime(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Local calendar date "YYYY-MM-DD" of a Date. */
export const localIsoDate = (t: Date): string =>
  `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;

/** Today's local calendar date (never the UTC date, which is yesterday's around midnight in Poland). */
export const todayLocal = (now: Date = new Date()): string => localIsoDate(now);

/** Local calendar day of a server date or date-time ("2026-10-05T23:30:00Z" is 6 October in Warsaw). */
export function localDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  if (DATE_ONLY.test(iso.trim())) return iso.trim();
  const t = serverDate(iso);
  return t ? localIsoDate(t) : null;
}

/** Local calendar date `days` after (or before, negative) a local calendar date. */
export function addDays(iso: string, days: number): string {
  const m = DATE_ONLY.exec(iso);
  if (!m) return iso;
  return localIsoDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
}

/** "17:35" (local time) of a server datetime; "" for a bare date or an unreadable value. */
export function hmLocal(iso: string | null | undefined): string {
  if (!iso || !/[T ]\d/.test(iso)) return "";
  const t = serverDate(iso);
  return t ? `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}` : "";
}
