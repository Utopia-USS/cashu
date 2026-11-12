// Display text the Today and month-closed hooks put into their copy: money inside a sentence (on the
// banana scale or masked while amounts are hidden, exactly as the value components show it), shares,
// month names and short dates. Pure: the hooks pass the UI environment in.
import { addMonths, type Decimal, type IsoDate } from "@cashu/domain";
import { type BananaScale, toBananas } from "@cashu/domain/core";
import { formatBananaValue, formatDecimalValue } from "@cashu/i18n/values";
import type { MonthName } from "../monthClosed/MonthClosed.strings";

/** The part of the UI environment display text depends on (`useUiEnv`). */
export interface DisplayEnv {
  readonly locale: string;
  readonly privacy: boolean;
  readonly bananas?: BananaScale | null;
}

/** The mask of a hidden amount without a banana scale (as `useNumberValue`). */
const MASK = "•••";

/** Money as text inside a sentence; hidden amounts show on the banana scale, else masked. */
export function moneyText(
  value: Decimal,
  currency: string,
  env: DisplayEnv,
  options: { readonly fractionDigits?: number; readonly signed?: boolean } = {},
): string {
  if (env.privacy) {
    const b = env.bananas ? toBananas(env.bananas, value, currency) : null;
    return b === null
      ? MASK
      : formatBananaValue(b, env.locale, { signed: options.signed ?? false }).text;
  }
  return formatDecimalValue(value, env.locale, {
    currency,
    ...(options.fractionDigits === undefined ? {} : { fractionDigits: options.fractionDigits }),
    ...(options.signed === undefined ? {} : { signed: options.signed }),
  }).text;
}

/** A ratio as a percent ("31%"); shares are never hidden. */
export function percentText(
  ratio: Decimal,
  locale: string,
  options: { readonly fractionDigits?: number; readonly signed?: boolean } = {},
): string {
  return formatDecimalValue(ratio, locale, {
    percent: true,
    fractionDigits: options.fractionDigits ?? 0,
    signed: options.signed ?? false,
  }).text;
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([locale, options]);
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    formats.set(key, f);
  }
  return f;
}

const noon = (date: IsoDate) => new Date(`${date}T12:00:00Z`);

/** The month of "YYYY-MM" in its forms (`MonthName`). */
export function monthName(month: string, locale: string): MonthName {
  const date = noon(`${month}-15`);
  const name = format(locale, { month: "long" }).format(date);
  const of =
    format(locale, { day: "numeric", month: "long" })
      .formatToParts(date)
      .find((p) => p.type === "month")?.value ?? name;
  return { title: name.charAt(0).toLocaleUpperCase(locale) + name.slice(1), of, name };
}

/** "November 30" / "30 listopada". */
export function dayMonth(date: IsoDate, locale: string): string {
  return format(locale, { day: "numeric", month: "long" }).format(noon(date));
}

/** "Tue, Nov 10" / "wt., 10 lis". */
export function shortDay(date: IsoDate, locale: string): string {
  return format(locale, { weekday: "short", day: "numeric", month: "short" }).format(noon(date));
}

/** The month `delta` months from "YYYY-MM". */
export function shiftMonth(month: string, delta: number): string {
  return addMonths(`${month}-01`, delta).slice(0, 7);
}
