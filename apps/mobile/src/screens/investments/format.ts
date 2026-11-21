// Calendar and clock labels of the investments screens, through `appClockLocale` (24 h "07:31", "7 Nov" /
// "7 lis") whatever English region the phone is set to. Calendar dates stay on
// their ISO day in every time zone (formatted at noon UTC); view timestamps (`YYYY-MM-DD HH:MM:SS.ffffff`,
// naive UTC) and ISO instants are shown in the device time zone. No `formatToParts` (Hermes on iOS has
// none).
import { daysBetween, type IsoDate } from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import { appClockLocale, formatClockTime } from "@cashu/i18n/values";
import { dateLabel } from "../../format/calendar";
import { localToday } from "../screenContext";

/** The store's UI language for a device locale. */
export function uiLang(locale: string): UiLang {
  return locale.toLowerCase().startsWith("pl") ? "pl" : "en";
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const clock = appClockLocale(locale);
  const key = JSON.stringify([clock, options]);
  let made = formats.get(key);
  if (!made) {
    made = new Intl.DateTimeFormat(clock, { ...options, timeZone: "UTC" });
    formats.set(key, made);
  }
  return made;
}

const noon = (date: IsoDate) => new Date(`${date}T12:00:00Z`);

/** "7 Nov" / "7 lis", with the year outside the year of `today` (`dateLabel`). */
export function dayMonth(date: IsoDate, today: IsoDate, locale: string): string {
  return dateLabel(date, today, locale);
}

/** "Sat 7 Nov" / "sob., 7 lis", with the year outside the year of `today` (`dateLabel`). */
export function weekdayDayMonth(date: IsoDate, today: IsoDate, locale: string): string {
  return dateLabel(date, today, locale, { weekday: true });
}

/** "Sunday" / "niedziela". */
export function weekdayName(date: IsoDate, locale: string): string {
  return format(locale, { weekday: "long" }).format(noon(date));
}

/** "9-15 Nov" / "9-15 lis" where the runtime formats ranges, else both ends; never a dash glyph. A
 * range reaching outside the year of `today` carries the year ("29 Dec 2025 - 4 Jan 2026"). */
export function dayRange(from: IsoDate, to: IsoDate, today: IsoDate, locale: string): string {
  const year = today.slice(0, 4);
  const f = format(locale, {
    day: "numeric",
    month: "short",
    ...(from.slice(0, 4) === year && to.slice(0, 4) === year ? {} : { year: "numeric" }),
  });
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
 * the calendar date ("2 Nov"). */
export function whenLabel(at: Date, now: Date, locale: string): string {
  const today = localToday(now);
  const days = daysBetween(localToday(at), today);
  if (days === 0) return formatClockTime(at, appClockLocale(locale));
  if (days > 0 && days < 7) return formatClockTime(at, appClockLocale(locale), { weekday: true });
  return dayMonth(localToday(at), today, locale);
}

/** A chart axis month: "Nov 2025" / "lis 2025". */
export function monthYear(date: IsoDate, locale: string): string {
  return format(locale, { month: "short", year: "numeric" }).format(noon(date));
}
