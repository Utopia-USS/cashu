// Shared rule helpers: guard ordering, first-seen aggregation and exact owner-facing formatting.
import { expect, it } from "vitest";
import { D } from "../../decimal.js";
import { AssetClass } from "../domain/enums.js";
import { buildRuleContext } from "./context.js";
import { missingFxProblem, portfolioValueProblem, unclassifiedProblem } from "./dataQuality.js";
import {
  daysPhrase,
  decimalText,
  formatAmount,
  formatDecimal,
  formatPct,
  formatPp,
} from "./format.js";
import { DEFAULT_DATA_QUALITY } from "./kind.js";
import { taggedWeight, windowBars } from "./metricInputs.js";
import { filterAccepts, filterPayload, positionsByInstrument } from "./positions.js";
import {
  AS_OF,
  alloc,
  bars,
  context,
  day,
  h,
  instrument,
  PLN,
  portfolio,
  USD,
} from "./testing/fixtures.js";

it("formats Python ratio rounding and arbitrary-size Decimal messages in both languages", () => {
  expect(formatPct(0.1235, "pl")).toBe("12,4\u00a0%");
  expect(formatPct(0.1235, "en")).toBe("12.4%");
  expect(formatPp(-0.00001, "pl")).toBe("0,0\u00a0pp");
  expect(formatPp(7.55, "en")).toBe("7.6\u00a0pp");
  expect(formatAmount(D("900719925474099312345.5"), "pl")).toBe(
    "900\u00a0719\u00a0925\u00a0474\u00a0099\u00a0312\u00a0346",
  );
  expect(formatAmount(D("-3750.5"), "en")).toBe("-3,751");
  expect(formatDecimal(D("1234.500"), "pl")).toBe("1\u00a0234,5");
  expect(decimalText(D("-0.00"))).toBe("0");
  expect(daysPhrase(1, "en")).toBe("1 day");
  expect(daysPhrase(5, "pl")).toBe("5 dni");
});
it("filters by AND across dimensions, all normalized tags, and excludes cash unless named", () => {
  const a = instrument("A", { tags: [" CORE ", "global"], assetClass: AssetClass.ETF });
  const cash = instrument("CASH", { assetClass: AssetClass.CASH });
  const filter = {
    assetClasses: new Set([AssetClass.ETF]),
    tags: ["core", " GLOBAL "],
    instrumentIds: new Set([a.id]),
  };
  expect(filterAccepts(filter, a)).toBe(true);
  expect(filterAccepts({ ...filter, tags: ["absent"] }, a)).toBe(false);
  expect(filterAccepts(undefined, cash)).toBe(false);
  expect(
    filterAccepts(
      { ...filter, assetClasses: new Set([AssetClass.CASH]), tags: [], instrumentIds: new Set() },
      cash,
    ),
  ).toBe(true);
  expect(filterPayload(filter)).toEqual({
    filter_asset_class: ["etf"],
    filter_tags: ["core", " GLOBAL "],
    filter_instrument_ids: ["i-A"],
  });
  const ctx = context({
    portfolioValue: portfolio([h(a, { value: "100" }), h(cash, { value: "900" })]),
  });
  expect(taggedWeight(ctx, ["core"])).toEqual([0.1, ["A"]]);
});
it("keeps first high on ties and refuses manual, FX, stale, short and invalid windows in order", () => {
  const a = instrument("A");
  const c = context({
    portfolioValue: portfolio([h(a)]),
    series: new Map([[a, bars(a, ["10", "20", "20", "15"])]]),
  });
  const position = positionsByInstrument(c)[0];
  if (position === undefined) throw new Error("missing synthetic position");
  const result = windowBars(c, position, 4);
  expect(typeof result).toBe("object");
  if (typeof result === "string") throw new Error(result);
  expect(result.high.date).toBe(day("2026-09-30"));
  expect(result.last.close).toEqual(D("15"));
  const stale = {
    ...c,
    market: { ...c.market, bars: new Map([[a.id, bars(a, ["0"], day("2026-09-20"))]]) },
  };
  expect(windowBars(stale, position, 5)).toContain("Nieaktualna cena");
  const fresh = { ...stale, market: { ...stale.market, bars: new Map([[a.id, bars(a, ["0"])]]) } };
  expect(windowBars(fresh, position, 5)).toBe("Tylko 1 z 5 notowań: A");
  expect(windowBars(fresh, position, 1)).toBe("Nieprawidłowe ceny: A");
  const manual = context({
    portfolioValue: portfolio([h(a, { manual: true })], { missingFxCurrencies: new Set([PLN]) }),
  });
  const manualPosition = positionsByInstrument(manual)[0];
  if (manualPosition === undefined) throw new Error("missing synthetic manual position");
  expect(windowBars(manual, manualPosition, 2)).toBe("A: wycena ręczna, brak notowań rynkowych");
});
it("uses an explicit context language and does not include private bucket ids in reasons", () => {
  const a = instrument("A");
  const c = context({ portfolioValue: portfolio([h(a, { stale: true })]), lang: "en" });
  expect(portfolioValueProblem(c)).toBe("Stale prices: 100.0% of the portfolio (max 5.0%)");
  const b = buildRuleContext({
    profileId: c.profileId,
    asOf: AS_OF,
    portfolio: c.portfolio,
    market: c.market,
  });
  expect(b.lang).toBe("en");
  expect(b.allocations).toEqual([]);
  const p = portfolio([h(a)]);
  const classified = context({
    portfolioValue: p,
    allocations: [alloc("private", { weight: 1, target: 1 })],
    unclassified: p.valued,
    lang: "en",
  });
  expect(unclassifiedProblem(classified)).toBe(
    "Positions without a bucket: 100.0% of the portfolio (max 2.0%): A; classify or tag them to put them in a bucket",
  );
  const fx = context({
    portfolioValue: portfolio([h(instrument("USD", { currency: USD }))], {
      missingFxCurrencies: new Set([USD]),
    }),
    lang: "en",
  });
  expect(missingFxProblem(fx)).toBe(
    "No USD/PLN rate on 2026-10-02 (missing or older than 10 days): cannot value 1 position (USD); portfolio weights incomplete",
  );
  expect(classified.data).toBe(DEFAULT_DATA_QUALITY);
});
