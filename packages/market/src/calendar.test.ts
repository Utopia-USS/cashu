// The calendar feeds over a fake fetch and their cache: stale cache on failure, no network without a
// fetcher, and the fetcher's error codes.

import { addDays, type DateTime } from "@cashu/domain";
import type { market as m } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import {
  type CalendarCacheStore,
  calendarHttp,
  type FeedFetcher,
  FF_URLS,
  feedFetcher,
  feeds,
  systemLocalTime,
} from "./calendar.js";
import { FakeTime, recording, respond, type SeenRequest } from "./testing/support.js";

const TODAY = "2026-11-01";
const NOW: DateTime = {
  date: TODAY,
  hour: 12,
  minute: 0,
  second: 0,
  microsecond: 0,
  offsetSeconds: 0,
};

class MemoryCache implements CalendarCacheStore {
  data: unknown = null;
  writes = 0;
  async read(): Promise<unknown> {
    return this.data;
  }
  async write(data: m.CalendarFeeds): Promise<void> {
    this.writes += 1;
    this.data = JSON.parse(JSON.stringify(data));
  }
}

function feedsOf(fields: Partial<m.CalendarFeeds> = {}): m.CalendarFeeds {
  return {
    fetched_at: "ignored",
    from: TODAY,
    to: addDays(TODAY, 14),
    macro: [],
    earnings: [],
    errors: [],
    ...fields,
  };
}

const FED: m.MacroRow = {
  date: "2026-11-04",
  time: "20:00",
  country: "USD",
  title: "Fed: decyzja o stopach",
};

describe("feeds cache", () => {
  it("feeds are cached, and a failed refresh serves the old cache's rows as stale", async () => {
    const cache = new MemoryCache();
    const calls: string[] = [];
    const ok: FeedFetcher = async (today) => {
      calls.push(today);
      return feedsOf({ macro: [FED] });
    };

    const [first, stale] = await feeds(TODAY, { cache, now: NOW, fetch: ok });
    const [again] = await feeds(TODAY, { cache, now: { ...NOW, hour: 13 }, fetch: ok });
    expect(stale).toBe(false);
    expect(again).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(first.fetched_at).toBe("2026-11-01T12:00:00+00:00");

    const later: DateTime = { ...NOW, hour: 18, minute: 1 }; // past the 6 h TTL
    const failing: FeedFetcher = async () =>
      feedsOf({ errors: ["macro_unavailable", "earnings_unavailable"] });
    const [served, staleNow] = await feeds(TODAY, { cache, now: later, fetch: failing });
    expect(staleNow).toBe(true);
    expect(served.macro).toEqual(first.macro);
    expect(cache.writes).toBe(2);
  });

  it("without a fetcher nothing is fetched: the cache, else empty offline feeds", async () => {
    const [data, stale] = await feeds(TODAY, { cache: new MemoryCache(), now: NOW });
    expect(stale).toBe(true);
    expect(data.errors).toEqual(["offline"]);
    const cache = new MemoryCache();
    cache.data = feedsOf({ fetched_at: "2026-10-01T00:00:00+00:00", macro: [FED] });
    const [old, oldStale] = await feeds(TODAY, { cache, now: NOW });
    expect([old.macro, oldStale]).toEqual([[FED], true]);
  });
});

describe("feed fetcher", () => {
  const ff = JSON.stringify([
    { title: "CPI y/y", country: "USD", date: "2026-11-03T08:30:00-05:00", impact: "High" },
  ]);
  const nasdaq = (symbol: string) =>
    JSON.stringify({ data: { rows: [{ symbol, name: "X", time: "time-pre-market" }] } });
  const utcLocal: m.ToLocalTime = (moment) => ({ date: moment.date, time: "00:00" });

  function fetcher(
    handler: (request: SeenRequest) => ReturnType<typeof respond>,
    requests: SeenRequest[] = [],
  ) {
    const time = new FakeTime();
    const http = calendarHttp({
      fetch: recording(requests, handler),
      sleep: time.sleep,
      clock: time.clock,
      timeoutSignal: () => undefined,
    });
    return feedFetcher(http, { toLocal: utcLocal, now: () => NOW });
  }

  it("fetches both weekly feeds and one Nasdaq list per weekday", async () => {
    const requests: SeenRequest[] = [];
    const got = await fetcher((request) => {
      if (request.url.hostname === "nfs.faireconomy.media") {
        return request.url.pathname.endsWith("nextweek.json")
          ? respond("Not Found", 404)
          : respond(ff);
      }
      return respond(nasdaq(`S${request.url.searchParams.get("date")?.slice(-2)}`));
    }, requests)(TODAY, 7);

    expect(requests.slice(0, 2).map((r) => r.url.toString())).toEqual([...FF_URLS]);
    expect(requests.slice(2).map((r) => r.url.searchParams.get("date"))).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
    ]);
    expect(requests[0]?.headers["User-Agent"]).toContain("Mozilla/5.0");
    expect(got.macro.map((r) => r.title)).toEqual(["inflacja CPI"]);
    expect(got.earnings.map((e) => e.symbol)).toEqual(["S02", "S03", "S04", "S05", "S06"]);
    expect([got.errors, got.from, got.to, got.fetched_at]).toEqual([
      [],
      TODAY,
      "2026-11-08",
      "2026-11-01T12:00:00+00:00",
    ]);
  });

  it("each failed request adds its error code once; nothing is retried", async () => {
    const requests: SeenRequest[] = [];
    const got = await fetcher((request) => {
      if (request.url.hostname === "nfs.faireconomy.media") return respond("<html>", 200);
      return request.url.searchParams.get("date") === "2026-11-03"
        ? respond("busy", 503)
        : respond(nasdaq("OK"));
    }, requests)(TODAY, 3);
    expect(got.errors).toEqual(["earnings_unavailable", "macro_unavailable"]);
    expect(got.earnings.map((e) => e.date)).toEqual(["2026-11-02"]);
    expect(requests).toHaveLength(4); // 2 feeds + 2 weekdays, no retry of the 503
  });
});

describe("local time", () => {
  it("a naive time is taken as local, an aware one keeps its instant", () => {
    expect(systemLocalTime({ ...NOW, hour: 9, minute: 5, offsetSeconds: null })).toEqual({
      date: TODAY,
      time: "09:05",
    });
    const local = systemLocalTime({ ...NOW, offsetSeconds: -14400 });
    const expected = new Date(Date.UTC(2026, 10, 1, 16, 0));
    expect(local.time).toBe(
      `${String(expected.getHours()).padStart(2, "0")}:${String(expected.getMinutes()).padStart(2, "0")}`,
    );
  });
});
