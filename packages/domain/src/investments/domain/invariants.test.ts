/**
 * Invariants of the port that the Python contract test does not pin down: warning messages byte-equal
 * to Python (expected strings produced by the Python classes from the same synthetic values), value
 * identity of warnings, timestamp ordering, the plan helpers and instrument value equality.
 */
import { describe, expect, it } from "vitest";
import { parseDateTime } from "../../dates.js";
import { D } from "../../decimal.js";
import {
  ALL_WARNING_KINDS,
  AssetClass,
  asAccountId,
  asInstrumentId,
  asTxnId,
  Currencies,
  cashHistoryGap,
  compareChronological,
  dedupeWarnings,
  effectivePlan,
  frozenValuedAtZero,
  historyGap,
  holding,
  InvariantError,
  instrument,
  invalidTransaction,
  isGenericBucket,
  isPlan,
  lastKnownPriceUsed,
  missingCostBasis,
  missingFxRate,
  missingInstrument,
  missingManualValuation,
  missingPrice,
  mixedLotCurrencies,
  openedOn,
  openLot,
  type PortfolioWarning,
  planLabel,
  realizedCurrencyMismatch,
  realizedTrade,
  sameInstrument,
  staleFxRate,
  stalePrice,
  TxnType,
  transaction,
  unknownCostBasis,
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
      unknownCostBasis({ accountId: a, instrumentId: i, txnId: t, date: day }),
      "Unknown cost basis: t on 2026-01-02 opened a lot of i without a price",
    ],
    [
      invalidTransaction({ accountId: a, txnId: t, date: day, reason: "no quantity" }),
      "Ignored transaction t on 2026-01-02 for lots: no quantity",
    ],
    [
      mixedLotCurrencies({ accountId: a, instrumentId: i, currencies: [USD, EUR] }),
      "Lots of i in one account use several currencies: EUR, USD",
    ],
    [
      realizedCurrencyMismatch({
        accountId: a,
        instrumentId: i,
        txnId: t,
        date: day,
        saleCurrency: USD,
        lotCurrencies: [PLN, EUR],
      }),
      "Sale t of i on 2026-01-02 is in USD but closed lots in EUR, PLN: realized result only in the base currency",
    ],
    [
      cashHistoryGap({ accountId: a, currency: PLN, amount: D("-1.20"), asOf: day }),
      "Cash history gap: PLN cash of a is -1.20 on 2026-01-02 (deposits missing from the history?); counted as 0",
    ],
    [
      staleFxRate({ currency: USD, base: PLN, date: day, rateDate: rateDay, ageDays: 32 }),
      "Stale USD/PLN FX rate for 2026-01-02: newest rate 2025-12-01 is 32 days old",
    ],
    [
      missingFxRate({ currency: USD, base: PLN, date: day }),
      "No USD/PLN FX rate on or before 2026-01-02",
    ],
    [
      missingPrice({ instrumentId: i, asOf: day }),
      "No price for i on or before 2026-01-02: excluded from weights",
    ],
    [
      lastKnownPriceUsed({ instrumentId: i, priceDate: rateDay, price: D("1E+1") }),
      "No market price for i: valued at the last known price 1E+1 from 2025-12-01",
    ],
    [
      stalePrice({ instrumentId: i, priceDate: rateDay, ageDays: 32 }),
      "Stale price for i: last close 2025-12-01 is 32 days old",
    ],
    [
      missingInstrument({ instrumentId: i }),
      "No instrument metadata for i: valued with a placeholder",
    ],
    [
      missingCostBasis({ accountId: a, instrumentId: i }),
      "Cannot value i at cost: its cost basis is unknown, excluded from weights",
    ],
    [
      missingManualValuation({ instrumentId: i, asOf: day }),
      "No manual valuation of i on or before 2026-01-02: excluded from weights",
    ],
    [
      frozenValuedAtZero({ instrumentId: i }),
      "i is frozen and has no manual valuation: valued at 0",
    ],
  ];

  it("messages are byte-equal to Python, one case per kind in Python order", () => {
    expect(cases.map(([w]) => w.kind)).toEqual(ALL_WARNING_KINDS);
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

  it("warnings are frozen", () => {
    expect(Object.isFrozen(missingInstrument({ instrumentId: i }))).toBe(true);
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

  it("negative zero is not negative (Python `Decimal('-0') < 0` is False)", () => {
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

  it("ties fall back to the id in Python str order (code points)", () => {
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

  it("instrument equality ignores the profile-view fields (Python compare=False)", () => {
    const base = { id: i, name: "Orlen", currency: PLN, assetClass: AssetClass.EQUITY };
    const shared = instrument(base);
    const viewed = instrument({ ...base, plan: "buy", segment: "energy", segmentBy: "owner" });
    expect(sameInstrument(shared, viewed)).toBe(true);
    expect(sameInstrument(shared, instrument({ ...base, tags: ["pl"] }))).toBe(false);
  });
});
