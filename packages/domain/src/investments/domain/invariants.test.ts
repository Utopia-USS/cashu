/**
 * Warning messages and value identity, timestamp ordering, the plan helpers and instrument value
 * equality.
 */
import { describe, expect, it } from "vitest";
import { parseDateTime } from "../../dates.js";
import { D } from "../../decimal.js";
import {
  AssetClass,
  asAccountId,
  asInstrumentId,
  asTxnId,
  Currencies,
  cashHistoryGap,
  compareChronological,
  dedupeWarnings,
  effectivePlan,
  historyGap,
  holding,
  InvariantError,
  instrument,
  isGenericBucket,
  isPlan,
  lastKnownPriceUsed,
  missingPrice,
  mixedLotCurrencies,
  openedOn,
  openLot,
  type PortfolioWarning,
  planLabel,
  realizedTrade,
  sameInstrument,
  TxnType,
  transaction,
  warningKey,
  warningMessage,
} from "./index.js";

const a = asAccountId("a");
const i = asInstrumentId("i");
const t = asTxnId("t");
const { PLN, USD, EUR } = Currencies;
const day = "2026-01-02";
const rateDay = "2025-12-01";

describe("warnings", () => {
  const cases: ReadonlyArray<readonly [PortfolioWarning, string]> = [
    [
      historyGap({ accountId: a, instrumentId: i, date: day, shortfall: D("3.50"), txnId: t }),
      "History gap: t on 2026-01-02 needs 3.50 more units of i than held",
    ],
    [
      mixedLotCurrencies({ accountId: a, instrumentId: i, currencies: [USD, EUR] }),
      "Lots of i in one account use several currencies: EUR, USD",
    ],
    [
      cashHistoryGap({ accountId: a, currency: PLN, amount: D("-1.20"), asOf: day }),
      "Cash history gap: PLN cash of a is -1.20 on 2026-01-02 (deposits missing from the history?); counted as 0",
    ],
    [
      lastKnownPriceUsed({ instrumentId: i, priceDate: rateDay, price: D("1E+1") }),
      "No market price for i: valued at the last known price 1E+1 from 2025-12-01",
    ],
  ];

  it("messages render amounts as written and currency lists sorted", () => {
    for (const [w, message] of cases) expect(warningMessage(w), w.kind).toBe(message);
  });

  it("value identity: decimals by value, sets by members, field order irrelevant", () => {
    const one = cashHistoryGap({ accountId: a, currency: PLN, amount: D("-1.0"), asOf: day });
    const same = cashHistoryGap({ asOf: day, amount: D("-1"), currency: PLN, accountId: a });
    expect(warningKey(one)).toBe(warningKey(same));
    const mixedA = mixedLotCurrencies({ accountId: a, instrumentId: i, currencies: [USD, EUR] });
    const mixedB = mixedLotCurrencies({ accountId: a, instrumentId: i, currencies: [EUR, USD] });
    expect(dedupeWarnings([mixedA, one, mixedB, same])).toEqual([mixedA, one]);
    expect(warningKey(missingPrice({ instrumentId: i, asOf: day }))).not.toBe(
      warningKey(missingPrice({ instrumentId: i, asOf: rateDay })),
    );
  });
});

describe("transaction", () => {
  const base = {
    id: t,
    accountId: a,
    type: TxnType.BUY,
    tradeDate: day,
    currency: PLN,
    grossAmount: D("0"),
    cashAmount: D("0"),
    cashCurrency: PLN,
  };

  it("negative zero is not negative", () => {
    expect(
      transaction({ ...base, quantity: D("-0"), grossAmount: D("-0.00") }).quantity?.isZero(),
    ).toBe(true);
    expect(() => transaction({ ...base, quantity: D("-0.0001") })).toThrow(InvariantError);
  });

  it("orders naive (read as UTC) and aware timestamps by instant", () => {
    const naive = transaction({
      ...base,
      id: asTxnId("z"),
      createdAt: parseDateTime("2026-01-01T09:30:00"),
    });
    const aware = transaction({
      ...base,
      id: asTxnId("a"),
      createdAt: parseDateTime("2026-01-01T10:00:00+01:00"),
    });
    // 10:00+01:00 is 09:00 UTC, before the naive 09:30.
    expect([naive, aware].sort(compareChronological).map((x) => x.id)).toEqual(["a", "z"]);
  });

  it("ties fall back to the id in code point order", () => {
    const astral = transaction({ ...base, id: asTxnId("\u{1F600}") });
    const bmp = transaction({ ...base, id: asTxnId("～") });
    expect([astral, bmp].sort(compareChronological).map((x) => x.id)).toEqual(["～", "\u{1F600}"]);
  });
});

describe("plan", () => {
  const lotOn = (openDate: string) =>
    openLot({
      accountId: a,
      instrumentId: i,
      openTxnId: t,
      openDate,
      quantity: D("1"),
      currency: PLN,
    });
  const closed = (openDate: string, closeDate: string, instrumentId = i) =>
    realizedTrade({
      accountId: a,
      instrumentId,
      openTxnId: t,
      closeTxnId: t,
      openDate,
      closeDate,
      quantity: D("1"),
      closeUnitPrice: D("1"),
      currency: PLN,
    });

  it("isPlan and labels", () => {
    expect(isPlan("exit_asap")).toBe(true);
    expect(isPlan("sell")).toBe(false);
    expect(planLabel("reduce", { held: true, lang: "pl" })).toBe("redukuj");
    expect(planLabel("reduce", { held: false, lang: "pl" })).toBeNull();
    expect(planLabel("hold", { held: false, lang: "en" })).toBe("wait");
    expect(planLabel("buy_asap", { held: true, lang: "en" })).toBe("buy more asap");
    expect(planLabel(null, { held: true, lang: "pl" })).toBeNull();
    expect(planLabel("toString", { held: true, lang: "pl" })).toBeNull();
  });

  it("effectivePlan drops held-only plans when not held or written before the reopening", () => {
    expect(effectivePlan("bogus", { held: true })).toBeNull();
    expect(effectivePlan("reduce", { held: false })).toBeNull();
    expect(effectivePlan("reduce", { held: null })).toBe("reduce");
    expect(effectivePlan("buy", { held: false })).toBe("buy");
    const planAt = parseDateTime("2026-01-01T23:00:00+00:00");
    expect(effectivePlan("reduce", { held: true, planAt, opened: "2026-01-02" })).toBeNull();
    expect(effectivePlan("reduce", { held: true, planAt, opened: "2026-01-01" })).toBe("reduce");
  });

  it("openedOn walks back over closed parts that bridge the gap", () => {
    const h = holding({
      accountId: a,
      instrumentId: i,
      currency: PLN,
      quantity: D("2"),
      lots: [lotOn("2026-03-01"), lotOn("2026-02-01")],
    });
    expect(openedOn([])).toBeNull();
    expect(openedOn([h])).toBe("2026-02-01");
    // closed 2026-01-10..2026-02-01 bridges, then 2025-12-01..2026-01-10 bridges too
    expect(
      openedOn([h], [closed("2026-01-10", "2026-02-01"), closed("2025-12-01", "2026-01-10")]),
    ).toBe("2025-12-01");
    // a gap (closed before the candidate date) does not bridge; other instruments are ignored
    expect(
      openedOn(
        [h],
        [
          closed("2025-12-01", "2026-01-31"),
          closed("2025-01-01", "2026-03-01", asInstrumentId("x")),
        ],
      ),
    ).toBe("2026-02-01");
  });
});

describe("buckets and instruments", () => {
  it("generic bucket ids are exact and case-sensitive", () => {
    expect(isGenericBucket("global_equity")).toBe(true);
    expect(isGenericBucket("Global_Equity")).toBe(false);
    expect(isGenericBucket("core")).toBe(false);
    expect(isGenericBucket(42)).toBe(false);
  });

  it("instrument equality ignores the profile-view fields", () => {
    const base = { id: i, name: "Orlen", currency: PLN, assetClass: AssetClass.EQUITY };
    const shared = instrument(base);
    const viewed = instrument({ ...base, plan: "buy", segment: "energy", segmentBy: "owner" });
    expect(sameInstrument(shared, viewed)).toBe(true);
    expect(sameInstrument(shared, instrument({ ...base, tags: ["pl"] }))).toBe(false);
  });
});
