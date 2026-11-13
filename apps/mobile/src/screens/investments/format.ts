// Calendar and clock labels of the investments screens, in the device locale. Calendar dates stay on
// their ISO day in every time zone (formatted at noon UTC); view timestamps (`YYYY-MM-DD HH:MM:SS.ffffff`,
// naive UTC) and ISO instants are shown in the device time zone. No `formatToParts` (Hermes on iOS has
// none).
import { daysBetween, type IsoDate } from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import { formatClockTime } from "@cashu/i18n/values";
import { localToday } from "../screenContext";

/** The store's UI language for a device locale. */
export function uiLang(locale: string): UiLang {
  return locale.toLowerCase().startsWith("pl") ? "pl" : "en";
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([locale, options]);
  let made = formats.get(key);
  if (!made) {
    made = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    formats.set(key, made);
  }
  return made;
}

const noon = (date: IsoDate) => new Date(`${date}T12:00:00Z`);

/** "Nov 7" / "7 lis". */
export function dayMonth(date: IsoDate, locale: string): string {
  return format(locale, { day: "numeric", month: "short" }).format(noon(date));
}

/** "Sat, Nov 7" / "sob., 7 lis". */
export function weekdayDayMonth(date: IsoDate, locale: string): string {
  return format(locale, { weekday: "short", day: "numeric", month: "short" }).format(noon(date));
}

/** "Sunday" / "niedziela". */
export function weekdayName(date: IsoDate, locale: string): string {
  return format(locale, { weekday: "long" }).format(noon(date));
}

/** "Nov 9 - 15" / "9-15 lis" where the runtime formats ranges, else both ends; never a dash glyph. */
export function dayRange(from: IsoDate, to: IsoDate, locale: string): string {
  const f = format(locale, { day: "numeric", month: "short" });
  const text =
    typeof f.formatRange === "function"
      ? f.formatRange(noon(from), noon(to))
      : `${f.format(noon(from))} - ${f.format(noon(to))}`;
  return text.replace(/[‒-―]/g, "-");
}

/** A view timestamp (naive UTC) or an ISO instant as a Date. */
export function instantOf(value: string): Date {
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return new Date(iso);
}

/** When an instant happened, from the device's day: "07:31" today, "Wed 07:31" within the week, else
 * the calendar date ("Nov 2"). */
export function whenLabel(at: Date, now: Date, locale: string): string {
  const days = daysBetween(localToday(at), localToday(now));
  if (days === 0) return formatClockTime(at, locale);
  if (days > 0 && days < 7) return formatClockTime(at, locale, { weekday: true });
  return dayMonth(localToday(at), locale);
}

/** A chart axis month: "Nov 2025" / "lis 2025". */
export function monthYear(date: IsoDate, locale: string): string {
  return format(locale, { month: "short", year: "numeric" }).format(noon(date));
}
