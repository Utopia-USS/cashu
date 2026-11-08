import { parseDateTime } from "@cashu/domain";
import {
  asProfileId,
  type performance as perf,
  toCurrency,
  views,
} from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import type { Store } from "../../materialize.js";
import { viewHash } from "../../snapshot.js";
import { openTestStore } from "../../testing/store.js";
import { readResearchDigestInputs } from "../desktop-research/inputs.js";
import { performanceStrategy } from "../desktop-research/sources.js";
import { PerformanceService } from "../performance/service.js";
import type { Read } from "../queries/shared.js";
import { assertOrderedDelivery } from "../testing/delivery.js";
import { household } from "../testing/household.js";
import { det, ulid } from "../testing/kit.js";
import { makeReviewClock, type ReviewDigestRequest, readReviewDigestInputs } from "./reviews.js";

/** The digest inputs over a Store, computing the research attribution on demand. */
function reviewDigestInputs(store: Store, request: ReviewDigestRequest) {
  const read: Read = store.read.bind(store);
  const result = readReviewDigestInputs(read, request, () => {
    let computed: perf.ComputedPerformance | null = null;
    try {
      computed = (request.performance ?? new PerformanceService()).computed(store, {
        asOf: request.clock.today,
        strategy: performanceStrategy(request.strategy),
        ...(request.marketData === undefined
          ? { prices: request.prices }
          : { marketData: request.marketData }),
      });
    } catch {
      /* Source digest remains readable without attribution. */
    }
    return readResearchDigestInputs(
      read,
      {
        ...request,
        macro: { status: "current", value: request.macroCloses },
        calendar: { status: "unavailable", reason: "calendar_not_requested" },
      },
      computed,
    );
  });
  if (!result.ok) return result;
  return { ok: true as const, segmentTrends: result.segmentTrends, value: result.value };
}

/** The digest the way a screen reads it: its inputs, then the view. */
function readReviewDigest(store: Store, request: ReviewDigestRequest) {
  const input = reviewDigestInputs(store, request);
  return input.ok ? { ok: true as const, value: views.reviewDigestView(input.value) } : input;
}

describe("native review service clock and identity", () => {
  it("resolves Warsaw midnight across DST without consulting the process timezone", () => {
    const clock = makeReviewClock({
      now: parseDateTime("2026-10-25T12:00:00Z"),
      today: "2026-10-25",
      timeZone: "Europe/Warsaw",
    });
    expect(clock.localDate("2026-10-24T22:30:00Z")).toBe("2026-10-25");
    expect(clock.midnight("2026-10-25")).toEqual(parseDateTime("2026-10-24T22:00:00.000Z"));
    expect(clock.midnight("2026-10-26")).toEqual(parseDateTime("2026-10-25T23:00:00.000Z"));
  });
  it("recomputes time-sensitive digest fields on unchanged store/cache and counts future-created rows", () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes([
      ...h.events,
      h.ev.make("invTxn.imported", det("inv_transactions", h.accountA, "5".repeat(64)), {
        account: h.accountA,
        dedupHash: "5".repeat(64),
        type: "dividend",
        instrument: h.first,
        quantity: null,
        price: null,
        tradeDate: "2026-11-10",
        createdAt: "2026-10-31T10:00:00Z",
        cashAmount: "3",
        grossAmount: "3",
        source: "import",
      }),
    ]);
    const performance = new PerformanceService();
    const request = {
      vault: h.vault,
      prices: h.prices,
      strategy: h.strategy,
      lang: "en" as const,
      macroCloses: {},
      performance,
    };
    const before = viewHash(store),
      cache = h.prices.version();
    const a = readReviewDigest(store, {
      ...request,
      clock: {
        now: parseDateTime("2026-10-31T22:59:00Z"),
        today: "2026-10-31",
        timeZone: "Europe/Warsaw",
      },
    });
    const b = readReviewDigest(store, {
      ...request,
      clock: {
        now: parseDateTime("2026-10-31T23:01:00Z"),
        today: "2026-11-01",
        timeZone: "Europe/Warsaw",
      },
    });
    if (!a.ok || !b.ok) throw new Error("synthetic review fixture was refused");
    expect(a.value.until_at).not.toBe(b.value.until_at);
    expect(a.value.as_of).not.toBe(b.value.as_of);
    // Seven UTC days straddle Warsaw's autumn offset change; both local baselines are Oct25.
    expect(a.value.since).toBe("2026-10-25");
    expect(b.value.since).toBe("2026-10-25");
    expect(a.value.transactions.count).toBe(1);
    expect(a.value.transactions.by_type).toEqual({ dividend: 1 });
    expect(a.value.dividends.PLN?.toString()).toBe("3");
    expect(a.value.value.currency).toBe(toCurrency("PLN"));
    expect(viewHash(store)).toEqual(before);
    expect(h.prices.version()).toBe(cache);
    store.close();
  });
  it("refuses a foreign vault before returning any review details", () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes(h.events);
    expect(
      readReviewDigest(store, {
        vault: asProfileId("00000000000000000000000000000001"),
        prices: h.prices,
        strategy: h.strategy,
        lang: "en",
        macroCloses: {},
        clock: {
          now: parseDateTime("2026-10-31T12:00:00Z"),
          today: "2026-10-31",
          timeZone: "Europe/Warsaw",
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_identity" });
    store.close();
  });
  it("resolves reported episode aliases before matching escalations and preserves report duplicates", () => {
    const h = household();
    const store = openTestStore();
    const a = ulid(6001),
      b = ulid(6002),
      run = ulid(6003);
    store.applyEnvelopes([
      ...h.events,
      h.ev.make(
        "signal.opened",
        a,
        {
          dedupKey: "synthetic-alias",
          instrument: h.first,
          stamps: { first_seen_at: "2026-10-01T00:00:00Z" },
        },
        { wall: 1 },
      ),
      h.ev.make(
        "signal.opened",
        b,
        { dedupKey: "synthetic-alias", instrument: h.first },
        { wall: 2 },
      ),
      h.ev.make(
        "ruleRun.finished",
        run,
        {
          startedAt: "2026-10-31T11:00:00Z",
          finishedAt: "2026-10-31T11:01:00Z",
          report: { new: [], escalated: [b, b] },
        },
        { wall: 3 },
      ),
    ]);
    const request = {
      vault: h.vault,
      prices: h.prices,
      strategy: h.strategy,
      lang: "en" as const,
      macroCloses: {},
      clock: {
        now: parseDateTime("2026-10-31T12:00:00Z"),
        today: "2026-10-31",
        timeZone: "Europe/Warsaw",
      },
    };
    const input = reviewDigestInputs(store, request);
    const result = readReviewDigest(store, request);
    if (!input.ok || !result.ok) throw new Error("synthetic alias review was refused");
    expect(input.value.runs[0]?.escalated).toEqual([a, a]);
    expect(result.value.signals.escalated.map((row) => row.id)).toEqual([a]);
    expect(
      result.value.events
        .filter((row) => row.type === "signal_escalated")
        .map((row) => row.signal_id),
    ).toEqual([a]);
    store.close();
  });
  it("keeps ordered digest DTOs stable under shuffled delivery, duplicates and rebuild", () => {
    const h = household();
    const events = [
      ...h.events,
      h.ev.make(
        "review.done",
        ulid(7102),
        {
          module: "investments",
          doneAt: "2026-10-25T12:00:00Z",
          notes: "Earlier anchor",
          stats: {},
        },
        { wall: 1000 },
      ),
      h.ev.make(
        "review.done",
        ulid(7101),
        { module: "investments", doneAt: "2026-10-25T12:00:00Z", notes: "Later anchor", stats: {} },
        { wall: 1001 },
      ),
    ];
    const result = assertOrderedDelivery(events, (store) =>
      readReviewDigest(store, {
        vault: h.vault,
        prices: h.prices,
        strategy: h.strategy,
        lang: "en",
        macroCloses: {},
        clock: {
          now: parseDateTime("2026-10-31T12:00:00Z"),
          today: "2026-10-31",
          timeZone: "Europe/Warsaw",
        },
      }),
    );
    if (!result.ok) throw new Error("synthetic ordered review was refused");
    expect(result.value.last_review?.notes).toBe("Later anchor");
  });
});
