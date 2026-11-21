/**
 * Currency picks: which currency a view shows when the caller names none. Net worth and budget
 * views default to the profile's base currency (no PLN assumption), list each currency on its own
 * and never sum currencies (`profiles.base_currency`, `budget/analytics.budget_currencies`,
 * `GET /budget/currencies`).
 */

import type { IsoDate } from "../dates.js";

/** `profiles.base_currency`: the profile's base currency, "PLN" when there is no profile or none set. */
export function baseCurrencyOf(profile: { baseCurrency: string | null } | null): string {
  return profile?.baseCurrency || "PLN";
}

/** Budget transactions in one currency (`analytics.CurrencyUse`). */
export interface CurrencyUse {
  readonly currency: string;
  readonly transactions: number;
  readonly first: IsoDate;
  readonly last: IsoDate;
}

/**
 * `budget_currencies` ordering: the base currency first (when it has data), then by number of
 * transactions (descending), then by code; rows without a currency are dropped.
 */
export function orderCurrencyUses(rows: readonly CurrencyUse[], base: string): CurrencyUse[] {
  const key = (c: CurrencyUse): [number, number, string] => [
    c.currency !== base ? 1 : 0,
    -c.transactions,
    c.currency,
  ];
  return rows
    .filter((r) => r.currency)
    .sort((a, b) => {
      const [a0, a1, a2] = key(a);
      const [b0, b1, b2] = key(b);
      if (a0 !== b0) return a0 - b0;
      if (a1 !== b1) return a1 - b1;
      return a2 < b2 ? -1 : a2 > b2 ? 1 : 0;
    });
}

/**
 * The picker's default (`GET /budget/currencies` "default"): the base currency when it has data or
 * nothing has data, else the first currency with data. The views themselves still answer in the base
 * currency unless asked (no silent switch).
 */
export function defaultCurrency(base: string, codesWithData: readonly string[]): string {
  return codesWithData.includes(base) || codesWithData.length === 0
    ? base
    : (codesWithData[0] ?? base);
}
