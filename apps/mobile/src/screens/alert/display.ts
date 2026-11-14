// Display text the alert sheet, the position page and the note reader put into their copy: instants of
// the store's views as device-local times, calendar days, public prices and shares (never hidden), and
// the owner's own average cost (hidden while amounts are hidden). Pure: the hooks pass the locale in.
// Times and dates go through `appClockLocale` (24 h "19:40", "14 Nov 2026" / "14 lis 2026") whatever
// English region the phone is set to; numbers keep the device locale.
import { D, Decimal, daysBetween, type IsoDate } from "@cashu/domain";
import {
  appClockLocale,
  formatCalendarDate,
  formatCalendarDay,
  formatClockTime,
  formatDecimalValue,
} from "@cashu/i18n/values";
import { localToday } from "../screenContext";
import { type DisplayEnv, MASK } from "../today/display";

/** Within this many calendar days a moment is named by its weekday ("Mon 07:30"), beyond it by its date. */
const WEEKDAY_DAYS = 6;

/**
 * A store timestamp as an instant: view rows carry naive UTC (`2026-11-12 05:45:00.000000`), events
 * and research notes ISO with an offset (`2026-11-07T08:00:00+00:00`).
 */
function instantOf(stamp: string): Date {
  const naive = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(stamp);
  return new Date(naive ? `${stamp.slice(0, 19).replace(" ", "T")}Z` : stamp);
}

/** The device-local calendar day of a store timestamp. */
export function dayOf(stamp: string): IsoDate {
  return localToday(instantOf(stamp));
}

/** When something happened, relative to `today`: a time today, a weekday and time within the week, else a date. */
export function momentText(
  stamp: string,
  today: IsoDate,
  locale: string,
): { readonly today: boolean; readonly day: string; readonly time: string } {
  const at = instantOf(stamp);
  const day = localToday(at);
  const days = daysBetween(day, today);
  const clock = appClockLocale(locale);
  return {
    today: days === 0,
    day:
      days > 0 && days <= WEEKDAY_DAYS
        ? formatCalendarDay(day, clock).weekday
        : formatCalendarDate(day, clock, "medium"),
    time: formatClockTime(at, clock),
  };
}

/** A calendar day in the medium style ("7 Nov 2026" / "7 lis 2026"). */
export function dayText(day: IsoDate, locale: string): string {
  return formatCalendarDate(day, appClockLocale(locale), "medium");
}

/** A public market price ("PLN 214.60"): quotes and levels are never hidden. */
export function priceText(value: Decimal, currency: string, locale: string): string {
  return formatDecimalValue(value, locale, { currency, fractionDigits: 2 }).text;
}

/** A ratio as a percent ("9.4%"); shares are never hidden. */
export function ratioText(
  ratio: number,
  locale: string,
  options: { readonly signed?: boolean; readonly fractionDigits?: number } = {},
): string {
  return formatDecimalValue(Decimal.fromFloat(ratio), locale, {
    percent: true,
    fractionDigits: options.fractionDigits ?? 1,
    signed: options.signed ?? false,
  }).text;
}

/** The owner's own price (the average cost, a quantity): masked while amounts are hidden, never on the
 * banana scale (a unit price in bananas would still give the cost away against the public price). */
export function ownPriceText(value: Decimal, currency: string, env: DisplayEnv): string {
  return env.privacy ? MASK : priceText(value, currency, env.locale);
}

/** A position's average cost per unit and its currency; null without one. */
export function averageCostOf(position: {
  readonly accounts: readonly {
    readonly quantity: Decimal;
    readonly average_cost: Decimal | null;
    readonly cost_currency: string | null;
  }[];
}): { readonly value: Decimal; readonly currency: string } | null {
  const priced = position.accounts.filter((a) => a.average_cost !== null && a.cost_currency);
  const currency = priced[0]?.cost_currency;
  if (!currency || priced.some((a) => a.cost_currency !== currency)) return null;
  let quantity = D("0");
  let cost = D("0");
  for (const a of priced) {
    quantity = quantity.add(a.quantity);
    cost = cost.add((a.average_cost as Decimal).mul(a.quantity));
  }
  return quantity.isZero() ? null : { value: cost.div(quantity), currency };
}

const shortFormats = new Map<string, Intl.DateTimeFormat>();
/** A chart axis day: "12 Nov" / "12 lis" (on its ISO day in every device timezone). */
export function axisDayText(day: IsoDate, locale: string): string {
  const clock = appClockLocale(locale);
  let format = shortFormats.get(clock);
  if (!format) {
    format = new Intl.DateTimeFormat(clock, { day: "numeric", month: "short", timeZone: "UTC" });
    shortFormats.set(clock, format);
  }
  return format.format(new Date(`${day}T12:00:00Z`));
}
