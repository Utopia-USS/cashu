// Market calendar of the weekly review, the pure parts of tests/investments/persistence/test_calendar.py:
// feed parsing, freshness, matching earnings to the profile's own instruments, research events. The feed
// fetching and the cache are in @cashu/market (calendar.test.ts there). Feeds are synthetic.

import { describe, expect, it } from "vitest";
import { addDays, type DateTime, toUtc } from "../../dates.js";
import {
  type CalendarFeeds,
  type CalendarInstrument,
  type CalendarNote,
  calendarEvents,
  checkCalendarDays,
  emptyFeeds,
  isFresh,
  macroName,
  mergeFetched,
  parseFf,
  parseNasdaq,
  RESULTS,
  type ToLocalTime,
  uniqueRows,
  usSymbol,
  weekdaysFrom,
} from "./calendar.js";

const TODAY = "2026-11-01";
const NOW: DateTime = {
  date: TODAY,
  hour: 12,
  minute: 0,
  second: 0,
  microsecond: 0,
  offsetSeconds: 0,
};

/** The device zone in these tests: UTC. */
const toLocal: ToLocalTime = (moment) => {
  const utc = toUtc(moment);
  return {
    date: utc.date,
    time: `${String(utc.hour).padStart(2, "0")}:${String(utc.minute).padStart(2, "0")}`,
  };
};

function feeds(fields: Partial<CalendarFeeds> = {}): CalendarFeeds {
  return {
    fetched_at: "2026-11-01T11:00:00+00:00",
    from: TODAY,
    to: addDays(TODAY, 14),
    macro: [],
    earnings: [],
    errors: [],
    ...fields,
  };
}

describe("feed parsing", () => {
  it("the ForexFactory feed keeps high-impact releases of the big economies with Polish names", () => {
    const body = JSON.stringify([
      {
        title: "Federal Funds Rate",
        country: "USD",
        date: "2026-11-04T14:00:00-04:00",
        impact: "High",
      },
      {
        title: "FOMC Press Conference",
        country: "USD",
        date: "2026-11-04T14:30:00-04:00",
        impact: "High",
      },
      { title: "CPI y/y", country: "EUR", date: "2026-11-03T05:00:00-05:00", impact: "High" },
      {
        title: "Official Cash Rate",
        country: "NZD",
        date: "2026-11-03T20:00:00-05:00",
        impact: "High",
      },
      {
        title: "German ifo Business Climate",
        country: "EUR",
        date: "2026-11-03T05:00:00-05:00",
        impact: "Low",
      },
      {
        title: "Unemployment Rate",
        country: "USD",
        date: "2026-11-06T08:30:00-05:00",
        impact: "High",
      },
      { title: "Something New", country: "GBP", date: "2026-11-05T07:00:00-05:00", impact: "High" },
    ]);
    const rows = parseFf(body, toLocal);
    expect(rows.map((r) => [r.country, r.title])).toEqual([
      ["USD", "Fed: decyzja o stopach"],
      ["USD", "Fed: decyzja o stopach"],
      ["EUR", "inflacja CPI"],
      ["USD", "rynek pracy"],
      ["GBP", "Something New"],
    ]);
    expect(rows.every((r) => r.time?.length === 5)).toBe(true);
    expect(rows[0]).toMatchObject({
      date: "2026-11-04",
      time: "18:00",
      source_title: "Federal Funds Rate",
    });
  });

  it("rows without a parsable date are skipped; a non-list feed is refused", () => {
    const body = JSON.stringify([
      { title: "CPI", country: "USD", date: "soon", impact: "High" },
      { title: "CPI", country: "USD", impact: "High" },
    ]);
    expect(parseFf(body, toLocal)).toEqual([]);
    expect(() => parseFf("{}", toLocal)).toThrow(TypeError);
  });

  it("central bank meetings fold into one row per bank and day", () => {
    const rows = parseFf(
      JSON.stringify(
        ["Main Refinancing Rate", "Monetary Policy Statement", "ECB Press Conference"].map(
          (title) => ({
            title,
            country: "EUR",
            date: "2026-11-05T08:15:00-04:00",
            impact: "High",
          }),
        ),
      ),
      toLocal,
    );
    expect(uniqueRows(rows, ["date", "country", "title"])).toHaveLength(1);
  });

  it("release names render in either language", () => {
    expect(macroName("EUR", "Main Refinancing Rate", "en")).toBe("ECB: rate decision");
    expect(macroName("CNY", "Loan Prime Rate", "pl")).toBe("LBC: decyzja o stopach");
    expect(macroName("USD", "Core PCE Price Index m/m", "en")).toBe("PCE inflation");
    expect(macroName("USD", "Unemployment Rate", "en")).toBe("labor market");
    expect(macroName("AUD", "Cash Rate Statement", "en")).toBe("AUD: rate decision");
  });

  it("the Nasdaq list parses symbols and the session side", () => {
    const body = JSON.stringify({
      data: {
        rows: [
          { symbol: "xmpl", name: "Przyklad Corp", time: "time-after-hours" },
          { symbol: "OTHR", name: "Other Inc", time: "time-pre-market" },
          { symbol: "", name: "Empty" },
        ],
      },
    });
    expect(parseNasdaq(body, TODAY)).toEqual([
      { date: "2026-11-01", symbol: "XMPL", name: "Przyklad Corp", when: "after" },
      { date: "2026-11-01", symbol: "OTHR", name: "Other Inc", when: "pre" },
    ]);
    expect(parseNasdaq(JSON.stringify({ data: null }), TODAY)).toEqual([]);
    expect(() => parseNasdaq("[]", TODAY)).toThrow(TypeError);
  });

  it("the earnings days are the weekdays of the range", () => {
    expect(weekdaysFrom("2026-11-06", 4)).toEqual(["2026-11-06", "2026-11-09"]);
  });
});

describe("freshness", () => {
  it("a complete fetch is fresh for 6 hours, one with errors for 30 minutes, and it must cover the range", () => {
    const later = (minutes: number): DateTime => ({
      ...NOW,
      hour: 11 + Math.floor(minutes / 60),
      minute: minutes % 60,
    });
    expect(isFresh(feeds(), TODAY, 14, later(359))).toBe(true);
    expect(isFresh(feeds(), TODAY, 14, { ...NOW, hour: 17, minute: 1 })).toBe(false);
    expect(isFresh(feeds({ errors: ["macro_unavailable"] }), TODAY, 14, later(29))).toBe(true);
    expect(isFresh(feeds({ errors: ["macro_unavailable"] }), TODAY, 14, later(31))).toBe(false);
    expect(isFresh(feeds(), TODAY, 15, NOW)).toBe(false);
    expect(isFresh(feeds(), addDays(TODAY, -1), 14, NOW)).toBe(false);
    expect(isFresh(feeds({ fetched_at: "2026-11-01T11:00:00" }), TODAY, 14, NOW)).toBe(false); // naive
    expect(isFresh(emptyFeeds(TODAY, 14, ["offline"]), TODAY, 14, NOW)).toBe(false);
    expect(isFresh(null, TODAY, 14, NOW)).toBe(false);
  });

  it("a failed part keeps the previous cache's rows", () => {
    const old = feeds({
      macro: [
        { date: "2026-11-04", time: "20:00", country: "USD", title: "Fed: decyzja o stopach" },
      ],
    });
    const got = feeds({ errors: ["macro_unavailable"] });
    const merged = mergeFetched(got, old, "2026-11-01T18:00:00+00:00");
    expect(merged.macro).toEqual(old.macro);
    expect(merged.fetched_at).toBe("2026-11-01T18:00:00+00:00");
    expect(mergeFetched(feeds(), old, "x").macro).toEqual([]); // no error: the new (empty) part wins
  });
});

// ---- the profile's view --------------------------------------------------------------------------

const instrument = (
  fields: Partial<CalendarInstrument> & Pick<CalendarInstrument, "id">,
): CalendarInstrument => ({
  name: "Przyklad Corp",
  symbol: "XMPL",
  mic: null,
  label: null,
  yahoo: null,
  held: false,
  ...fields,
});

const annas = [
  instrument({ id: "us", yahoo: "XMPL" }),
  instrument({ id: "pl", name: "Przyklad SA", yahoo: "XMPL.WA", mic: "XWAR" }),
];

const feed = feeds({
  macro: [
    { date: "2026-11-04", time: "20:00", country: "USD", title: "Fed: decyzja o stopach" },
    { date: "2026-11-30", time: "20:00", country: "USD", title: "Fed: decyzja o stopach" },
  ],
  earnings: [
    { date: "2026-11-03", symbol: "XMPL", name: "Przyklad Corp", when: "after" },
    { date: "2026-11-03", symbol: "OTHR", name: "Other Inc", when: "pre" },
  ],
});

describe("calendar view", () => {
  it("earnings match only the profile's own US instruments", () => {
    const view = calendarEvents({
      feeds: feed,
      stale: false,
      today: TODAY,
      instruments: annas,
      notes: [],
      lang: "pl",
    });
    const empty = calendarEvents({
      feeds: feed,
      stale: false,
      today: TODAY,
      instruments: [],
      notes: [],
      lang: "pl",
    });

    expect(view.events.map((e) => [e.date, e.kind])).toEqual([
      ["2026-11-03", "earnings"],
      ["2026-11-04", "macro"],
    ]);
    const earning = view.events[0];
    expect([earning?.instrument_id, earning?.held, earning?.time]).toEqual([
      "us",
      false,
      "po sesji",
    ]);
    expect(empty.events.map((e) => e.kind)).toEqual(["macro"]); // no instrument of the other profile
    expect([view.as_of, view.from, view.to, view.stale]).toEqual([
      TODAY,
      TODAY,
      "2026-11-15",
      false,
    ]);
  });

  it("renders the macro title and country label in the UI language", () => {
    const english = feeds({
      macro: [
        {
          date: "2026-11-04",
          time: "20:00",
          country: "EUR",
          title: "inflacja CPI",
          source_title: "CPI y/y",
        },
      ],
    });
    const [event] = calendarEvents({
      feeds: english,
      stale: true,
      today: TODAY,
      instruments: [],
      notes: [],
      lang: "en",
    }).events;
    expect([event?.title, event?.country_label]).toEqual(["CPI inflation", "euro area"]);
    const polish = calendarEvents({
      feeds: feed,
      stale: false,
      today: TODAY,
      instruments: annas,
      notes: [],
      lang: "en",
    });
    expect(polish.events.map((e) => e.title)).toEqual([
      "Quarterly results XMPL",
      "Fed: decyzja o stopach",
    ]);
    expect(polish.events[0]?.time).toBe("after the close");
  });

  it("days out of range are refused", () => {
    expect(() => checkCalendarDays(0)).toThrow("days must be between 1 and 31");
    expect(() => checkCalendarDays(32)).toThrow();
    expect(() =>
      calendarEvents({
        feeds: feed,
        stale: false,
        today: TODAY,
        days: 0,
        instruments: [],
        notes: [],
        lang: "pl",
      }),
    ).toThrow();
  });

  it("research events do not repeat the feed or each other", () => {
    const note = (id: string, title: string, kind = "news"): CalendarNote => ({
      id,
      kind,
      title,
      instrumentId: "us",
      segment: null,
      details: { event_date: "2026-11-03", event: title },
    });
    const notes = [
      note("1", "Wyniki Przyklad za III kwartał"),
      note("2", "Wyniki Przyklad za III kwartał"),
      note("3", "Zapisy na 2027"),
      note("4", "Zapisy na 2027"),
    ];
    const withEarnings = feeds({
      earnings: [{ date: "2026-11-03", symbol: "XMPL", name: "Przyklad Corp", when: "after" }],
    });
    const view = calendarEvents({
      feeds: withEarnings,
      stale: false,
      today: TODAY,
      instruments: [instrument({ id: "us", yahoo: "XMPL" })],
      notes,
      lang: "pl",
    });
    expect(view.events.map((e) => [e.kind, e.title])).toEqual([
      ["earnings", "Wyniki kwartalne XMPL"],
      ["research", "Zapisy na 2027"],
    ]);
    expect(view.events[1]).toMatchObject({ label: "XMPL", held: false, note_id: "3" });
  });

  it("the US ticker of an instrument", () => {
    expect(usSymbol(instrument({ id: "a", yahoo: "nvda" }))).toBe("NVDA");
    expect(usSymbol(instrument({ id: "b", yahoo: "VWCE.DE", symbol: "VWCE" }))).toBeNull();
    expect(usSymbol(instrument({ id: "c", symbol: "AAPL.US" }))).toBe("AAPL");
    expect(usSymbol(instrument({ id: "d", symbol: "msft", mic: "XNAS" }))).toBe("MSFT");
    expect(usSymbol(instrument({ id: "e", symbol: " ", mic: "XNAS" }))).toBeNull();
  });
});

describe("periodic results titles", () => {
  it.each([
    "Wyniki Amazon za III kwartał 2026",
    "Wyniki IV kw. roku obrotowego 2026",
    "Raport za III kwartał",
    "Q3 report",
    "Jednostkowe sprawozdanie za III kwartał",
    "Quarterly results",
  ])("%s is recognised", (title) => {
    expect(RESULTS.test(title)).toBe(true);
  });

  it.each([
    "Wynik głosowania WZA nad podziałem spółki",
    "Wyniki badania klinicznego fazy 3",
    "Phase 3 trial results",
    "Wynik wezwania na akcje",
    "Zapisy ACA na 2027",
  ])("%s stays on the calendar", (title) => {
    expect(RESULTS.test(title)).toBe(false);
  });
});
