/**
 * Test-for-test translation of `tests/investments/performance/test_p7_topics.py`, the pure parts of
 * topics (P7): snapshot-held positions count as held at the window start (`snapshotOpenings`) and
 * the topic trend independent of holdings weight (`segmentTrends`: equal weight, held and watched
 * alike, missing / stale / same-bar closes left out). Synthetic input only. Each `it` names its
 * Python test in a comment.
 *
 * Not translated: `test_the_owner_topics_labels_and_the_power_rename` exercises
 * `research.segments` (segment labels, `LEGACY_KEYS`, `FUND_SEGMENTS`, `auto_segment`,
 * `segment_of`), which is not ported yet.
 */
import { describe, expect, it } from "vitest";
import { D, decimalKey, roundFloat } from "../../decimal.js";
import { TxnSource, TxnType } from "../domain/enums.js";
import type { PriceBar } from "../domain/marketData.js";
import { type Transaction, transaction } from "../domain/transaction.js";
import {
  asAccountId,
  asInstrumentId,
  asProfileId,
  asTxnId,
  type CalendarDate,
  Currencies,
  type InstrumentId,
} from "../domain/values.js";
import { buildSnapshot } from "../portfolio/index.js";
import {
  memberReturn,
  type SegmentTrend,
  segmentTrends,
  snapshotOpenings,
  TREND_WINDOWS,
} from "./segmentAttribution.js";
import { bars, day } from "./testing/support.js";

const iid = (text: string): InstrumentId => asInstrumentId(text);

const START = day("2026-10-01");
const END = day("2026-10-08");

interface TopicTxnOptions {
  readonly kind?: TxnType;
  readonly source?: TxnSource;
  readonly instrument?: string;
  readonly account?: string;
  readonly quantity?: string;
}

/** The local `txn` builder of the Python file: a zero-cash USD booking created 2026-10-08 + n s. */
function txn(n: number, when: string, options: TopicTxnOptions = {}): Transaction {
  return transaction({
    id: asTxnId(`t${n}`),
    accountId: asAccountId(options.account ?? "1"),
    type: options.kind ?? TxnType.ADJUSTMENT,
    tradeDate: day(when),
    currency: Currencies.USD,
    grossAmount: D("0"),
    cashAmount: D("0"),
    cashCurrency: Currencies.USD,
    instrumentId: asInstrumentId(options.instrument ?? "BTC"),
    quantity: D(options.quantity ?? "0.5"),
    source: options.source ?? TxnSource.RECONCILIATION,
    createdAt: {
      date: "2026-10-08",
      hour: 0,
      minute: 0,
      second: n,
      microsecond: 0,
      offsetSeconds: 0,
    },
  });
}

/** `{instrument: quantity}` of the snapshot on `on`, quantities compared by value. */
function held(txns: readonly Transaction[], on: CalendarDate): Record<string, string> {
  const snapshot = buildSnapshot(asProfileId("1"), txns, on);
  return Object.fromEntries(snapshot.holdings.map((h) => [h.instrumentId, decimalKey(h.quantity)]));
}

// --------------------------------------------------------------------------- //
// Snapshot-held positions
// --------------------------------------------------------------------------- //

describe("snapshot-held positions (P7)", () => {
  // test_a_snapshot_opening_inside_the_window_counts_as_held_at_start
  it("a snapshot opening inside the window counts as held at start", () => {
    const opening = txn(1, "2026-10-06"); // the broker snapshot of 6 Oct, imported this week
    const moved = snapshotOpenings([opening], START);
    expect(moved[0]?.tradeDate).toBe(START);
    expect(moved[0]?.settleDate).toBeNull();
    expect(held(moved, START)).toEqual({ BTC: "0.5" });
    expect(held([opening], START)).toEqual({}); // what the history alone says
  });

  // test_an_opening_before_the_window_and_real_history_keep_their_dates
  it("an opening before the window and real history keep their dates", () => {
    const before = txn(1, "2026-09-20");
    expect(snapshotOpenings([before], START)).toEqual([before]);
    // a real buy first: the history is the information, the later correction stays where it is
    const buy = txn(2, "2026-10-03", {
      kind: TxnType.BUY,
      source: TxnSource.IMPORT,
      instrument: "ETH",
    });
    const fix = txn(3, "2026-10-06", { instrument: "ETH" });
    expect(snapshotOpenings([buy, fix], START)).toEqual([buy, fix]);
    // a later correction of a snapshot-held position is a real change reported by the broker
    const later = txn(4, "2026-10-07", { instrument: "SOL" });
    const first = txn(5, "2026-10-05", { instrument: "SOL" });
    const out = snapshotOpenings([later, first], START);
    expect(out.map((t) => t.tradeDate)).toEqual([day("2026-10-07"), START]);
  });

  // test_openings_are_per_account_and_a_transfer_out_is_never_moved
  it("openings are per account and a transfer out is never moved", () => {
    const otherAccount = txn(1, "2026-10-06", { account: "2" });
    const real = txn(2, "2026-09-01", { kind: TxnType.BUY, source: TxnSource.IMPORT });
    const out = snapshotOpenings([real, otherAccount], START);
    expect(out[1]?.tradeDate).toBe(START); // account 2 knows BTC only from its snapshot
    const surplus = txn(3, "2026-10-06", { kind: TxnType.TRANSFER_OUT, instrument: "ADA" });
    expect(snapshotOpenings([surplus], START)).toEqual([surplus]);
  });

  // test_a_coin_first_reported_by_a_later_snapshot_is_a_new_position
  it("a coin first reported by a later snapshot is a new position", () => {
    // BTC in the account's first snapshot of 1 Sep; ETH bought 5 Oct and first reported by the
    // snapshot of 6 Oct: the earlier snapshot without ETH is the information, so ETH keeps its date.
    const btc = txn(1, "2026-09-01");
    const eth = txn(2, "2026-10-06", { instrument: "ETH", quantity: "2" });
    let out = snapshotOpenings([btc, eth], START);
    expect(out).toEqual([btc, eth]);
    expect(held(out, START)).toEqual({ BTC: "0.5" });
    // the first snapshot of a snapshot-only account imported this week still moves (both coins)
    const firstBtc = txn(3, "2026-10-06");
    const firstEth = txn(4, "2026-10-06", { instrument: "ETH" });
    const moved = snapshotOpenings([firstBtc, firstEth], START);
    expect(held(moved, START)).toEqual({ BTC: "0.5", ETH: "0.5" });
    // an account with a real history: an old holding reported by its first snapshot moves, a coin
    // reported only by a later snapshot does not
    const buy = txn(5, "2026-03-01", {
      kind: TxnType.BUY,
      source: TxnSource.IMPORT,
      instrument: "SOL",
    });
    const old = txn(6, "2026-10-03", { instrument: "ADA" });
    const fresh = txn(7, "2026-10-07", { instrument: "DOT" });
    out = snapshotOpenings([buy, old, fresh], START);
    expect(out.map((t) => t.tradeDate)).toEqual([day("2026-03-01"), START, day("2026-10-07")]);
  });
});

// --------------------------------------------------------------------------- //
// Topic trends
// --------------------------------------------------------------------------- //

const CLOSES = new Map<InstrumentId, PriceBar[]>([
  // +10 % over 1w, +21 % over 4w
  [iid("A"), bars("A", { "2026-09-10": 100, "2026-10-01": 110, "2026-10-08": 121 })],
  // -10 % over 1w; no close 28 days back
  [iid("B"), bars("B", { "2026-10-01": 50, "2026-10-08": 45 })],
  // last close 6 days old: stale for both windows
  [iid("C"), bars("C", { "2026-09-10": 10, "2026-10-01": 10, "2026-10-02": 12 })],
  // quantum, watched only: +30 % over 1w
  [iid("Q"), bars("Q", { "2026-10-01": 10, "2026-10-08": 13 })],
]);

function closes(id: string): PriceBar[] {
  return CLOSES.get(iid(id)) as PriceBar[];
}

function trendOf(found: Map<string, SegmentTrend>, segment: string): SegmentTrend {
  const trend = found.get(segment);
  expect(trend).toBeDefined();
  return trend as SegmentTrend;
}

describe("topic trends (P7)", () => {
  // test_trend_is_equal_weighted_over_held_and_watched_members
  it("trend is equal weighted over held and watched members", () => {
    const members = new Map<InstrumentId, readonly [string, boolean]>([
      [iid("A"), ["semis_ai", true]],
      [iid("B"), ["semis_ai", false]],
      [iid("C"), ["semis_ai", true]],
      [iid("Q"), ["quantum", false]],
      [iid("N"), ["quantum", false]], // no bars at all
    ]);
    const found = segmentTrends(members, CLOSES, END, { maxPriceAgeDays: 5 });
    expect(TREND_WINDOWS).toEqual([7, 28]);
    const ai = trendOf(found, "semis_ai");
    expect(ai.trends[0]).toBe(0.0); // (+10 % - 10 %) / 2, whatever the weights; C is stale
    expect(roundFloat(ai.trends[1] as number, 6)).toBe(0.21); // only A has a 4w close
    expect(ai.members).toBe(2);
    expect(ai.instruments.map((m) => m.instrumentId)).toEqual(["A", "C", "B"]); // held first, priced first
    const quantum = trendOf(found, "quantum");
    expect(roundFloat(quantum.trends[0] as number, 6)).toBe(0.3);
    expect(quantum.trends[1]).toBeNull();
    expect(quantum.members).toBe(1);
    expect(new Set(quantum.instruments.map((m) => m.held))).toEqual(new Set([false]));
  });

  // test_a_segment_without_any_price_has_no_trend
  it("a segment without any price has no trend", () => {
    const found = segmentTrends(new Map([[iid("N"), ["crypto", true] as const]]), new Map(), END);
    expect(trendOf(found, "crypto").trends).toEqual([null, null]);
    expect(trendOf(found, "crypto").members).toBe(0);
  });

  // test_member_return_rules
  it("member return rules", () => {
    expect(roundFloat(memberReturn(closes("A"), END, 7, 5) as number, 9)).toBe(0.1);
    expect(memberReturn(closes("C"), END, 7, 5)).toBeNull(); // end close 6 days old
    const same = bars("S", { "2026-09-28": 10 });
    expect(memberReturn(same, END, 7, 5)).toBeNull(); // one bar for both ends (and stale)
    const one = bars("S", { "2026-10-08": 10 });
    expect(memberReturn(one, END, 7, 5)).toBeNull(); // no close at the window start
    const oldStart = bars("S", { "2026-09-20": 10, "2026-10-08": 11 });
    expect(memberReturn(oldStart, END, 7, 5)).toBeNull(); // start close 11 days before the start
  });

  // test_the_owner_topics_labels_and_the_power_rename: not translated (research.segments is not
  // ported yet; see the header).
});
