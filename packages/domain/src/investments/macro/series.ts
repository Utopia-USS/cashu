/**
 * The fixed list of macro reference series (`macro/series.py`, P6): public Yahoo symbols behind the
 * regime cards.
 *
 * Values are daily closes as Yahoo quotes them: distribution-adjusted closes for the ETFs (`adjusted`:
 * a yearly payout would otherwise bias their 6 / 12-month changes), index points for `^GSPC` and
 * `DX-Y.NYB`, and yields in percent for `^TNX` / `^IRX` (4.231 = 4,231 %; `^IRX` is a discount yield,
 * converted in `regimes`). USD/PLN comes from the NBP rates (quote USD), not from this list.
 */

export type SeriesUnit = "price" | "index" | "percent";

export interface MacroSeries {
  /** Stable id (the stored series key). */
  readonly key: string;
  /** Yahoo chart symbol. */
  readonly symbol: string;
  readonly meaning: string;
  readonly unit: SeriesUnit;
  /** Store Yahoo's distribution-adjusted close (ETFs) instead of the raw close. */
  readonly adjusted: boolean;
}

function macroSeries(
  key: string,
  symbol: string,
  meaning: string,
  unit: SeriesUnit,
  adjusted = false,
): MacroSeries {
  return Object.freeze({ key, symbol, meaning, unit, adjusted });
}

export const SERIES: readonly MacroSeries[] = Object.freeze([
  macroSeries("acwi", "ACWI", "global equity (MSCI ACWI ETF, USD)", "price", true),
  macroSeries("spx", "^GSPC", "S&P 500", "index"),
  macroSeries("dxy", "DX-Y.NYB", "US dollar index", "index"),
  macroSeries("eem", "EEM", "emerging-markets equity ETF", "price", true),
  macroSeries("dbc", "DBC", "broad commodity ETF", "price", true),
  macroSeries("us10y", "^TNX", "US 10-year yield", "percent"),
  macroSeries("us3m", "^IRX", "US 13-week bill yield", "percent"),
]);

export const SERIES_KEYS: readonly string[] = Object.freeze(SERIES.map((s) => s.key));

/** Pseudo series key of the NBP USD/PLN rate in the regime input. */
export const USDPLN = "usdpln";

/**
 * Calendar days every refresh fetches (about 5 years: 260 sessions for the regimes plus years of
 * state history). The whole window is fetched again each run, so restated adjusted closes and late
 * corrections replace the stored ones; bars older than the window stay stored.
 */
export const BACKFILL_DAYS = 1830;

const BY_KEY: ReadonlyMap<string, MacroSeries> = new Map(SERIES.map((s) => [s.key, s]));

/** The series of a key, or null. */
export function seriesOf(key: string): MacroSeries | null {
  return BY_KEY.get(key) ?? null;
}
