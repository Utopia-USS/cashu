/**
 * The refresh-plan parts of `tests/investments/persistence/test_p6_macro_refresh.py` (no store): the
 * backfill window, every series fetched with adjusted closes for the ETFs, errors as entries and the
 * circuit breaker. Fake chart sources only.
 *
 * Not translated here (HTTP client, daily check, store writes; S18 / S22c):
 * test_the_production_macro_source_has_a_short_timeout (only the constants are checked below),
 * test_daily_check_fetches_the_whole_window_every_run, test_offline_and_sources_without_macro_skip_it,
 * test_a_failing_series_never_aborts_the_run, test_an_unexpected_macro_failure_keeps_the_run,
 * test_no_transaction_is_held_while_fetching_macro, test_refresh_and_store_and_the_store_reads,
 * test_a_restated_adjusted_history_rescales_the_older_stored_bars,
 * test_a_failing_macro_write_keeps_the_market_data_and_the_run,
 * test_yahoo_chart_exposes_the_adjusted_close_without_changing_the_bars.
 */
import { describe, expect, it } from "vitest";
import { addDays, type IsoDate } from "../../dates.js";
import { D, type Decimal } from "../../decimal.js";
import { FetchStatus } from "../market/fetchReport.js";
import { SourceBlockedException, SourceException } from "../market/sources.js";
import {
  fetchJson,
  MAX_RETRIES,
  type MacroChartQuote,
  type MacroChartSource,
  refreshMacro,
  reportErrors,
  reportStats,
  SKIPPED_MESSAGE,
  TIMEOUT_SECONDS,
  windowStart,
} from "./refresh.js";
import { BACKFILL_DAYS, SERIES_KEYS } from "./series.js";
import { sessionsBetween } from "./testing/fixtures.js";

const LEVELS: Readonly<Record<string, string>> = {
  ACWI: "110.5",
  "^GSPC": "5600",
  "DX-Y.NYB": "101.2",
  EEM: "44.1",
  DBC: "22.3",
  "^TNX": "4.231",
  "^IRX": "3.9",
};

/**
 * Yahoo chart stand-in: weekday bars at a fixed level per symbol (adjusted closes at `adjust` x the
 * level); `fail` symbols reject.
 */
class FakeChart implements MacroChartSource {
  readonly calls: [string, IsoDate, IsoDate][] = [];
  private readonly fail: Readonly<Record<string, unknown>>;
  private readonly levels: Readonly<Record<string, string>>;
  private readonly adjust: Decimal | null;

  constructor(
    options: {
      fail?: Record<string, unknown>;
      levels?: Record<string, string>;
      adjust?: string | null;
    } = {},
  ) {
    this.fail = options.fail ?? {};
    this.levels = options.levels ?? LEVELS;
    this.adjust = options.adjust === null ? null : D(options.adjust ?? "0.9");
  }

  async chart(symbol: string, start: IsoDate, end: IsoDate): Promise<MacroChartQuote> {
    this.calls.push([symbol, start, end]);
    if (Object.hasOwn(this.fail, symbol)) throw this.fail[symbol];
    const level = this.levels[symbol];
    // one bar outside the window on each side: the refresh keeps only the window
    const bars =
      level === undefined
        ? []
        : sessionsBetween(addDays(start, -3), addDays(end, 3)).map((date) => ({
            date,
            close: D(level),
            source: "yahoo",
          }));
    const adjust = this.adjust;
    const adjusted =
      adjust === null
        ? []
        : bars.map((b) => [b.date, b.close.mul(adjust).quantize(D("0.0001"))] as const);
    return { bars, adjusted };
  }
}

const AS_OF: IsoDate = "2026-10-08";

describe("the refresh plan (no store)", () => {
  // test_window_is_always_the_whole_backfill
  it("the window is always the whole backfill", () => {
    expect(windowStart(AS_OF)).toBe(addDays(AS_OF, -BACKFILL_DAYS));
    expect(windowStart(AS_OF)).toBe("2021-10-04");
  });

  // test_refresh_fetches_the_window_and_stores_adjusted_closes_for_etfs
  it("fetches the window and stores adjusted closes for ETFs", async () => {
    const chart = new FakeChart();
    const report = await refreshMacro(chart, AS_OF);
    expect(report.series.map((f) => f.series)).toEqual([...SERIES_KEYS]);
    expect(new Set(chart.calls.map(([, s, e]) => `${s}..${e}`))).toEqual(
      new Set([`${addDays(AS_OF, -BACKFILL_DAYS)}..${AS_OF}`]),
    );
    const by = Object.fromEntries(report.series.map((f) => [f.series, f]));
    const acwi = by.acwi;
    expect([acwi?.status, acwi?.source, acwi?.adjusted]).toEqual([FetchStatus.OK, "yahoo", true]);
    const closes = acwi?.closes ?? [];
    expect((closes[0]?.[0] as IsoDate) >= windowStart(AS_OF)).toBe(true);
    expect((closes.at(-1)?.[0] as IsoDate) <= AS_OF).toBe(true);
    expect(closes.map(([d]) => d)).toEqual(closes.map(([d]) => d).sort());
    expect(closes.at(-1)?.[1].eq(D("99.45"))).toBe(true); // adjusted (0.9 x 110.5)
    expect(by.eem?.adjusted && by.dbc?.adjusted).toBe(true);
    // indices and yields keep the raw close
    expect(by.spx?.adjusted).toBe(false);
    expect(by.spx?.closes.at(-1)?.[1].eq(D("5600"))).toBe(true);
    expect(by.us10y?.closes.at(-1)?.[1].eq(D("4.231"))).toBe(true);
    expect(reportStats(report).series_ok).toBe(7);
    expect(reportErrors(report)).toEqual([]);
    // an answer without adjclose: the raw close, flagged
    const bare = await refreshMacro(new FakeChart({ adjust: null }), AS_OF);
    const raw = bare.series.find((f) => f.series === "dbc");
    expect(raw?.closes.at(-1)?.[1].eq(D("22.3"))).toBe(true);
    expect(raw?.adjusted).toBe(true);
    expect(raw?.message).toContain("raw close");
  });

  // test_refresh_errors_are_entries_never_exceptions
  it("errors are entries, never rejections", async () => {
    const levels = Object.fromEntries(Object.entries(LEVELS).filter(([k]) => k !== "DBC"));
    const chart = new FakeChart({
      fail: {
        "DX-Y.NYB": new SourceException("yahoo", "no such symbol"),
        "^IRX": new TypeError("bad"),
      },
      levels,
    });
    const report = await refreshMacro(chart, AS_OF);
    expect(chart.calls).toHaveLength(7); // a non-retryable error never trips the breaker
    const byKey = Object.fromEntries(report.series.map((f) => [f.series, f]));
    expect(byKey.dxy?.status).toBe(FetchStatus.ERROR);
    expect(byKey.dxy?.message).toBe("yahoo: no such symbol");
    expect(byKey.us3m?.status).toBe(FetchStatus.ERROR);
    expect(byKey.us3m?.message).toContain("TypeError");
    expect(byKey.dbc?.status).toBe(FetchStatus.NO_DATA);
    expect(byKey.dbc?.closes).toEqual([]);
    expect(byKey.acwi?.status).toBe(FetchStatus.OK);
    expect(reportStats(report)).toEqual({
      series_ok: 4,
      series_no_data: 1,
      series_error: 2,
      series_skipped: 0,
      bars_fetched: report.series.reduce((n, f) => n + f.closes.length, 0),
    });
    expect(reportErrors(report)).toEqual([
      "macro dxy (DX-Y.NYB): yahoo: no such symbol",
      "macro us3m (^IRX): TypeError: bad",
    ]);
    expect(byKey.dxy && fetchJson(byKey.dxy).status).toBe("error");
  });

  // test_a_blocked_or_retryable_failure_stops_the_remaining_series
  it.each([
    new SourceBlockedException("yahoo", "HTTP 403"),
    new SourceException("yahoo", "timed out", { retryable: true }),
  ])("a blocked or retryable failure stops the remaining series (%s)", async (error) => {
    const chart = new FakeChart({ fail: { "^GSPC": error } });
    const report = await refreshMacro(chart, AS_OF);
    expect(chart.calls.map(([symbol]) => symbol)).toEqual(["ACWI", "^GSPC"]);
    expect(report.series.map((f) => [f.series, f.status])).toEqual([
      ["acwi", FetchStatus.OK],
      ["spx", FetchStatus.ERROR],
      ["dxy, eem, dbc, us10y, us3m", FetchStatus.SKIPPED],
    ]);
    const skipped = report.series.at(-1);
    expect(skipped?.symbol).toBe("DX-Y.NYB, EEM, DBC, ^TNX, ^IRX");
    expect(skipped?.closes).toEqual([]);
    expect(skipped?.message).toBe(SKIPPED_MESSAGE);
    const stats = reportStats(report);
    expect([stats.series_ok, stats.series_error, stats.series_skipped]).toEqual([1, 1, 5]);
    expect(reportErrors(report)).toEqual([`macro spx (^GSPC): yahoo: ${error.message}`]);
  });

  // test_the_production_macro_source_has_a_short_timeout (the constants; the HTTP client is S18)
  it("the macro source's timeout constants", () => {
    expect([TIMEOUT_SECONDS, MAX_RETRIES]).toEqual([10.0, 1]);
  });
});
