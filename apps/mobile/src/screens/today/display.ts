// Display text the Today and month-closed hooks put into their copy: money inside a sentence (on the
// banana scale or masked while amounts are hidden, exactly as the value components show it), shares,
// month names and short dates. Pure: the hooks pass the UI environment in.
import type { Decimal, IsoDate } from "@cashu/domain";
import { type BananaScale, toBananas } from "@cashu/domain/core";
import { formatBananaValue, formatDecimalValue } from "@cashu/i18n/values";
import { dateFormat, noon } from "../../format/calendar";

export { dayMonth, monthName, shiftMonth } from "../../format/calendar";

/** The part of the UI environment display text depends on (`useUiEnv`). */
export interface DisplayEnv {
  readonly locale: string;
  readonly privacy: boolean;
  readonly bananas?: BananaScale | null;
}

/** The mask of a hidden amount without a banana scale (as `useNumberValue`); the one mask the
 * screens' sentences use. */
export const MASK = "•••";

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

/** "Tue, Nov 10" / "wt., 10 lis". */
export function shortDay(date: IsoDate, locale: string): string {
  return dateFormat(locale, { weekday: "short", day: "numeric", month: "short" }).format(
    noon(date),
  );
}
