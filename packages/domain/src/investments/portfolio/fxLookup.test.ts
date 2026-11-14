/** In-memory FX lookup: identity, newest rate on or before, inverse and cross rates. Synthetic data. */
import { describe, expect, it } from "vitest";
import { type Decimal, decimalKey } from "../../decimal.js";
import { fxQuoteAgeDays } from "../domain/fx.js";
import { asProfileId, Currencies } from "../domain/values.js";
import { buildSnapshot, convert, fxCurrenciesFor, InMemoryFxLookup } from "./index.js";
import {
  acc,
  buy,
  cashTxn,
  d,
  EUR,
  fxRate,
  GBP,
  instrument,
  marketView,
  newId,
  PLN,
  USD,
} from "./testing/fixtures.js";

const CHF = Currencies.CHF;

/** Decimal compared by value (Python `==`); null stays null. */
const k = (value: Decimal | null | undefined): string | null =>
  value == null ? null : decimalKey(value);

// 2026-01-02 is a Friday, 2026-01-05 a Monday.
const FX = new InMemoryFxLookup([
  fxRate(USD, "2026-01-02", "4.00"),
  fxRate(USD, "2026-01-05", "4.10"),
  fxRate(EUR, "2026-01-02", "5.00"),
  fxRate(EUR, "2026-01-05", "4.92"),
]);

describe("fx lookup", () => {
  it("identity for equal currencies also without any stored rate", () => {
    expect(k(FX.rateOnOrBefore(PLN, "2020-01-01"))).toBe(k(d("1")));
    expect(k(FX.rateOnOrBefore(CHF, "2020-01-01", CHF))).toBe(k(d("1")));
    const quote = FX.quoteOnOrBefore(PLN, "2020-01-01");
    expect(quote === null ? null : [k(quote.rate), quote.date]).toEqual([k(d("1")), "2020-01-01"]);
  });

  it("newest rate on or before the date and none before the first", () => {
    expect(k(FX.rateOnOrBefore(USD, "2026-01-02"))).toBe(k(d("4.00")));
    expect(k(FX.rateOnOrBefore(USD, "2026-01-04"))).toBe(k(d("4.00"))); // weekend uses Friday
    expect(k(FX.rateOnOrBefore(USD, "2026-01-05"))).toBe(k(d("4.10")));
    expect(k(FX.rateOnOrBefore(USD, "2026-06-30"))).toBe(k(d("4.10")));
    expect(FX.rateOnOrBefore(USD, "2026-01-01")).toBeNull();
    expect(FX.rateOnOrBefore(GBP, "2026-01-05")).toBeNull();
  });

  it("inverse and cross rates", () => {
    expect(k(FX.rateOnOrBefore(PLN, "2026-01-02", USD))).toBe(k(d("0.25")));
    expect(k(FX.rateOnOrBefore(USD, "2026-01-02", EUR))).toBe(k(d("0.8"))); // 4.00 / 5.00
    expect(k(FX.rateOnOrBefore(EUR, "2026-01-05", USD))).toBe(k(d("1.2"))); // 4.92 / 4.10
    expect(FX.rateOnOrBefore(GBP, "2026-01-05", USD)).toBeNull();
  });

  it("quote dates: inverse keeps the stored date, cross takes the older leg", () => {
    const fx = new InMemoryFxLookup([
      fxRate(USD, "2026-01-02", "4.00"),
      fxRate(EUR, "2026-01-02", "5.00"),
      fxRate(EUR, "2026-01-07", "4.80"),
    ]);
    const inverse = fx.quoteOnOrBefore(PLN, "2026-01-09", USD);
    expect(inverse === null ? null : [k(inverse.rate), inverse.date]).toEqual([
      k(d("0.25")),
      "2026-01-02",
    ]);
    const cross = fx.quoteOnOrBefore(USD, "2026-01-09", EUR);
    expect(cross === null ? null : [k(cross.rate), cross.date]).toEqual([
      k(d("0.8333333333")),
      "2026-01-02",
    ]);
    expect(cross === null ? null : fxQuoteAgeDays(cross, "2026-01-09")).toBe(7);
  });

  it("convert ignores non-positive rates and the last rate of a day wins", () => {
    const lookup = new InMemoryFxLookup([
      fxRate(USD, "2026-01-02", "3.90"),
      fxRate(USD, "2026-01-02", "4.00"),
      fxRate(USD, "2026-01-05", "0"),
    ]);
    expect(k(lookup.rateOnOrBefore(USD, "2026-01-05"))).toBe(k(d("4.00")));
    expect(k(convert(lookup, d("25"), USD, PLN, "2026-01-05"))).toBe(k(d("100")));
    expect(convert(lookup, d("25"), GBP, PLN, "2026-01-05")).toBeNull();
  });

  it("fx currencies for lists every currency valuation needs from the oldest lot", () => {
    const account = acc(newId());
    const usdEtf = instrument(null, { currency: USD, symbol: "VT", mic: "ARCX" });
    const eurFund = instrument(null, { currency: EUR, symbol: "FND", mic: null });
    const snapshot = buildSnapshot(
      asProfileId(newId()),
      [
        buy(account, usdEtf.id, "2026-01-05", "1", "100", { currency: USD }),
        buy(account, eurFund.id, "2026-02-05", "1", "100", { currency: PLN }),
        cashTxn(account, "2026-02-02", "50", { currency: GBP }),
      ],
      "2026-03-31",
    );
    const { currencies, oldest } = fxCurrenciesFor(
      snapshot,
      marketView("2026-03-31", { instruments: [usdEtf, eurFund] }),
      CHF,
    );
    expect(currencies).toEqual(new Set([USD, PLN, EUR, GBP, CHF]));
    expect(oldest).toBe("2026-01-05");
  });
});
