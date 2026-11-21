// Calendar text and arithmetic the screens and the notifications share (neutral: imports no screen):
// the device's day, month shifts, month names in their grammatical forms and "30 November". Pure; the
// caller passes the UI locale. Dates follow the APP language, never the phone's region
// (`appClockLocale`): English "12 Nov", "12 Nov 2026", "November 2026", Polish "12 lis", "12 lis 2026",
// "listopad 2026", whatever English region the device is set to.
import { addMonths, type IsoDate } from "@cashu/domain";
import { appClockLocale } from "@cashu/i18n/values";

/** Calendar day on this device, rather than the UTC day of an ISO timestamp. */
export function localToday(now = new Date()): IsoDate {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The month `delta` months from "YYYY-MM". */
export function shiftMonth(month: string, delta: number): string {
  return addMonths(`${month}-01`, delta).slice(0, 7);
}

/** A month in the forms a sentence needs, from `Intl`. */
export interface MonthName {
  /** Nominative, capitalized: "November", "Listopad". */
  readonly title: string;
  /** As in "kept in November" / "zostało z listopada": "November", "listopada". */
  readonly of: string;
  /** Nominative, as inside a sentence: "December", "grudzień". */
  readonly name: string;
}

const formats = new Map<string, Intl.DateTimeFormat>();
/**
 * A cached UTC date format in the app's date locale (`appClockLocale` of the UI locale; calendar days
 * are placed at UTC noon, so no zone shifts the day).
 */
export function dateFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const app = appClockLocale(locale);
  const key = JSON.stringify([app, options]);
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(app, { ...options, timeZone: "UTC" });
    formats.set(key, f);
  }
  return f;
}

/** A calendar day as the instant `dateFormat` formats. */
export const noon = (date: IsoDate) => new Date(`${date}T12:00:00Z`);

/** The month of "YYYY-MM" in its forms (`MonthName`). */
export function monthName(month: string, locale: string): MonthName {
  const date = noon(`${month}-15`);
  const name = dateFormat(locale, { month: "long" }).format(date);
  const of =
    dateFormat(locale, { day: "numeric", month: "long" })
      .formatToParts(date)
      .find((p) => p.type === "month")?.value ?? name;
  return { title: name.charAt(0).toLocaleUpperCase(locale) + name.slice(1), of, name };
}

/** "30 November" / "30 listopada". */
export function dayMonth(date: IsoDate, locale: string): string {
  return dateFormat(locale, { day: "numeric", month: "long" }).format(noon(date));
}
