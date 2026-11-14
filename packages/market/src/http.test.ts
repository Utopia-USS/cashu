// MarketHttp: retries, backoff, Retry-After, timeouts, per-host pacing.

import { market } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { MarketHttp } from "./http.js";
import { FakeTime, makeHttp, recording, respond, type SeenRequest } from "./testing/support.js";

const { SourceBlockedException, SourceException } = market;
const URL_ = "https://api.example.test/data";

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * A fetch answering with the next outcome (a status code or an error to throw; the last one repeats),
 * recording request start times.
 */
function scripted(
  time: FakeTime,
  outcomes: (number | Error)[],
  headers: Record<string, string> = {},
) {
  const starts: number[] = [];
  let calls = 0;
  const fetch = recording([], () => {
    starts.push(time.now);
    const outcome = outcomes[Math.min(calls, outcomes.length - 1)] as number | Error;
    calls += 1;
    if (outcome instanceof Error) throw outcome;
    return respond(`body ${outcome}`, outcome, "text/plain", headers);
  });
  return { fetch, starts };
}

async function rejection(promise: Promise<unknown>): Promise<market.SourceException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SourceException) return error;
    throw error;
  }
  throw new Error("expected a SourceException");
}

describe("MarketHttp", () => {
  it("a 2xx answer is returned after one request", async () => {
    const time = new FakeTime();
    const { fetch, starts } = scripted(time, [200]);
    expect((await makeHttp(fetch, time).get(URL_, "test")).status).toBe(200);
    expect(starts).toHaveLength(1);
    expect(time.sleeps).toEqual([]);
  });

  it("a non-retryable status is returned without retrying", async () => {
    const time = new FakeTime();
    const { fetch, starts } = scripted(time, [404]);
    expect((await makeHttp(fetch, time).get(URL_, "test")).status).toBe(404);
    expect(starts).toHaveLength(1);
  });

  it("5xx is retried twice with exponential backoff, then succeeds", async () => {
    const time = new FakeTime();
    const { fetch, starts } = scripted(time, [503, 502, 200]);
    expect((await makeHttp(fetch, time).get(URL_, "test")).status).toBe(200);
    expect(starts).toHaveLength(3);
    expect(time.sleeps).toEqual([1, 2]);
  });

  it("persistent 5xx raises a retryable SourceException after 3 attempts", async () => {
    const time = new FakeTime();
    const { fetch, starts } = scripted(time, [500]);
    const error = await rejection(makeHttp(fetch, time).get(URL_, "test"));
    expect(starts).toHaveLength(3);
    expect(error).not.toBeInstanceOf(SourceBlockedException);
    expect(error.retryable).toBe(true);
    expect(error.sourceId).toBe("test");
    expect(error.detail).toContain("HTTP 500");
    expect(error.detail).toContain("3 attempts");
  });

  it("persistent 429 raises blocked, and Retry-After lengthens the wait", async () => {
    const time = new FakeTime();
    const { fetch, starts } = scripted(time, [429], { "retry-after": "5" });
    const error = await rejection(makeHttp(fetch, time).get(URL_, "yahoo"));
    expect(error).toBeInstanceOf(SourceBlockedException);
    expect(error.retryable).toBe(true);
    expect(error.detail).toContain("rate limited");
    expect(starts).toHaveLength(3);
    expect(time.sleeps).toEqual([5, 5]);
  });

  it("Retry-After is capped at maxRetryAfter", async () => {
    const time = new FakeTime();
    const { fetch } = scripted(time, [429, 200], { "retry-after": "3600" });
    await makeHttp(fetch, time).get(URL_, "yahoo");
    expect(time.sleeps).toEqual([30]);
  });

  it("network errors are retried and a later success wins", async () => {
    const time = new FakeTime();
    const { fetch, starts } = scripted(time, [
      new TypeError("fetch failed"),
      new TypeError("socket hang up"),
      200,
    ]);
    expect((await makeHttp(fetch, time).get(URL_, "test")).status).toBe(200);
    expect(starts).toHaveLength(3);
  });

  it("persistent network errors raise a retryable SourceException with the cause", async () => {
    const time = new FakeTime();
    const cause = new TypeError("scripted failure");
    const { fetch, starts } = scripted(time, [cause]);
    const error = await rejection(makeHttp(fetch, time).get(URL_, "nbp"));
    expect(starts).toHaveLength(3);
    expect(error.retryable).toBe(true);
    expect(error.detail).toContain("network error: scripted failure");
    expect(error.cause).toBe(cause);
  });

  it("a timeout is retried, then fails as retryable", async () => {
    const time = new FakeTime();
    const { fetch, starts } = scripted(time, [
      new TimeoutError("The operation was aborted due to timeout"),
    ]);
    const error = await rejection(makeHttp(fetch, time, 0.02).get(URL_, "test"));
    expect(starts).toHaveLength(3);
    expect(error.retryable).toBe(true);
    expect(error.detail).toContain("timed out after 20 ms");
    expect((error.cause as Error).name).toBe("TimeoutError");
  });

  it("the timeout is passed to every request", async () => {
    const asked: number[] = [];
    const signal = new AbortController().signal;
    const seen: SeenRequest[] = [];
    const http = new MarketHttp({
      fetch: recording(seen, () => respond("", 200)),
      sleep: new FakeTime().sleep,
      clock: () => 0,
      timeout: 7.5,
      timeoutSignal: (ms) => {
        asked.push(ms);
        return signal;
      },
    });
    await http.get(URL_, "test");
    await http.get(URL_, "test");
    expect(asked).toEqual([7500, 7500]);
    expect(seen.map((r) => r.signal)).toEqual([signal, signal]);
  });

  it("requests to one host start at least 300 ms apart, other hosts are not delayed", async () => {
    const time = new FakeTime();
    const starts = new Map<string, number[]>();
    const fetch = recording([], (request) => {
      const list = starts.get(request.url.hostname) ?? [];
      list.push(time.now);
      starts.set(request.url.hostname, list);
      return respond("ok");
    });
    const http = makeHttp(fetch, time);
    await http.get(URL_, "a");
    await http.get("https://other.example.test/", "b");
    await http.get(URL_, "a");
    await http.get(URL_, "a");

    const same = starts.get("api.example.test") as number[];
    expect(same).toHaveLength(3);
    for (let i = 1; i < same.length; i++) {
      expect((same[i] as number) - (same[i - 1] as number)).toBeGreaterThanOrEqual(0.3 - 1e-9);
    }
    expect(starts.get("other.example.test")).toEqual([1000]);

    // A host idle for longer than the gap is not delayed.
    time.sleeps.length = 0;
    time.now += 5;
    await http.get(URL_, "a");
    expect(time.sleeps).toEqual([]);
  });

  it("slots are reserved so callers queue up per host", async () => {
    const sleeps: number[] = [];
    // Time stands still while three calls reserve their slots.
    const http = new MarketHttp({
      fetch: recording([], () => respond("", 200)),
      clock: () => 50.0,
      sleep: async (s) => {
        sleeps.push(s);
      },
      timeoutSignal: () => undefined,
    });
    for (let i = 0; i < 3; i++) await http.get(URL_, "a");
    expect(sleeps.map((s) => Math.round(s * 1000) / 1000)).toEqual([0.3, 0.6]);
  });

  it("concurrent callers reserve consecutive slots before any request starts", async () => {
    const sleeps: number[] = [];
    const http = new MarketHttp({
      fetch: recording([], () => respond("", 200)),
      clock: () => 50.0,
      sleep: async (s) => {
        sleeps.push(s);
      },
      timeoutSignal: () => undefined,
    });
    await Promise.all([http.get(URL_, "a"), http.get(URL_, "a"), http.get(URL_, "a")]);
    expect(sleeps.map((s) => Math.round(s * 1000) / 1000)).toEqual([0.3, 0.6]);
  });

  it("shareSlotsWith paces two instances on one schedule per host", async () => {
    const time = new FakeTime();
    const first = makeHttp(
      recording([], () => respond("")),
      time,
    );
    const second = new MarketHttp({
      fetch: recording([], () => respond("")),
      sleep: time.sleep,
      clock: () => time.now,
      timeoutSignal: () => undefined,
      shareSlotsWith: first,
    });
    await first.get(URL_, "a");
    await second.get(URL_, "b");
    expect(time.sleeps.map((s) => Math.round(s * 1000) / 1000)).toEqual([0.3]);
  });

  it("post sends the JSON body with the same retries and pacing", async () => {
    const time = new FakeTime();
    const seen: SeenRequest[] = [];
    let calls = 0;
    const http = makeHttp(
      recording(seen, () => {
        calls += 1;
        return calls === 1 ? respond("busy", 503) : respond("[]");
      }),
      time,
    );
    const response = await http.post(
      "https://api.openfigi.example/v3/mapping",
      "openfigi",
      [{ idType: "ID_ISIN" }],
      {
        "Content-Type": "application/json",
      },
    );
    expect(response.status).toBe(200);
    expect(seen.map((r) => [r.method, r.body, r.headers["Content-Type"]])).toEqual([
      ["POST", '[{"idType":"ID_ISIN"}]', "application/json"],
      ["POST", '[{"idType":"ID_ISIN"}]', "application/json"],
    ]);
    expect(time.sleeps).toEqual([1]);
  });
});
