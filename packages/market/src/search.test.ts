// The search HTTP adapters (tests/investments/market/test_f12_search_sources.py: the search and
// OpenFIGI parts of test_http_adapters_send_the_right_requests_and_report_failures, and
// test_network_errors_are_source_exceptions). The chart part of the adapters test and the parsers are
// in yahoo.test.ts and @cashu/domain's market/search.test.ts.

import { market } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { OpenFigiIsinLookup, YahooSymbolSearch } from "./search.js";
import { YahooPriceSource } from "./sources.js";
import {
  FakeTime,
  fixture,
  makeHttp,
  recording,
  respond,
  type SeenRequest,
} from "./testing/support.js";

const body = (name: string) => fixture(`search/${name}`);

async function rejection(promise: Promise<unknown>): Promise<market.SourceException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof market.SourceException) return error;
    throw error;
  }
  throw new Error("expected a SourceException");
}

describe("search adapters", () => {
  // test_http_adapters_send_the_right_requests_and_report_failures (search and OpenFIGI parts)
  it("send the right requests and report failures", async () => {
    const requests: SeenRequest[] = [];
    const jobs = JSON.parse(body("figi_map.json")) as unknown[];
    const http = makeHttp(
      recording(requests, (request) => {
        if (request.url.host === "api.openfigi.com") return respond(JSON.stringify([jobs[1]]));
        if (request.url.pathname === "/v1/finance/search") {
          if (request.url.searchParams.get("q") === "boom") return respond("busy", 503);
          return respond(body("yq_orlen.json"));
        }
        return respond("{}", 404);
      }),
      new FakeTime(),
    );
    http.maxRetries = 0;
    const hits = await new YahooSymbolSearch(http).search("orlen");
    expect(hits[0]?.yahooSymbol).toBe("PKN.WA");
    let sent = requests.at(-1) as SeenRequest;
    expect(sent.method).toBe("GET");
    expect(sent.url.searchParams.get("q")).toBe("orlen");
    expect(sent.url.searchParams.get("quotesCount")).toBe("10");
    expect(sent.url.searchParams.get("newsCount")).toBe("0");
    expect(sent.headers["User-Agent"]).toBe(YahooPriceSource.DEFAULT_USER_AGENT);
    await rejection(new YahooSymbolSearch(http).search("boom"));

    const figi = await new OpenFigiIsinLookup(http).lookup("plpkn0000018");
    sent = requests.at(-1) as SeenRequest;
    expect(sent.method).toBe("POST");
    expect(sent.url.pathname).toBe("/v3/mapping");
    expect(JSON.parse(sent.body ?? "")).toEqual([{ idType: "ID_ISIN", idValue: "PLPKN0000018" }]);
    expect(figi[0]?.yahooSymbol).toBe("PKN.WA");
  });

  // test_network_errors_are_source_exceptions
  it("network errors are source exceptions", async () => {
    const http = makeHttp(
      recording([], () => {
        const error = new Error("slow");
        error.name = "TimeoutError";
        throw error;
      }),
      new FakeTime(),
      5.0,
    );
    http.maxRetries = 0;
    const error = await rejection(new YahooSymbolSearch(http).search("orlen"));
    expect(error.detail).toContain("timed out after 5000 ms");
    await rejection(new OpenFigiIsinLookup(http).lookup("PLPKN0000018"));
  });

  it("401 / 403 block the source", async () => {
    const http = makeHttp(
      recording([], () => respond("denied", 403)),
      new FakeTime(),
    );
    const error = await rejection(new YahooSymbolSearch(http).search("orlen"));
    expect(error).toBeInstanceOf(market.SourceBlockedException);
  });
});
