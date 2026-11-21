import { type core, D } from "@cashu/domain";
import { setLanguageForTests } from "@cashu/i18n";
import { beforeEach, describe, expect, it } from "vitest";
import { heroModel } from "./overviewModel.js";

beforeEach(() => setLanguageForTests("en"));

const facts: core.HeroFacts = {
  currency: "PLN",
  net: D("50000.00"),
  assets: D("50000.00"),
  liabilities: D("0.00"),
  liabilityTypes: [],
  homeEquity: null,
  liquid: D("50000.00"),
  accounts: 3,
  otherCurrencies: { EUR: D("1000.00"), USD: D("13888.89") },
};
const converted: core.ConvertedHero = {
  currency: "PLN",
  net: D("100000.00"),
  assets: D("100000.00"),
  liabilities: D("0.00"),
  liquid: D("100000.00"),
  parts: [
    { currency: "EUR", amount: D("1000.00"), quote: null },
    { currency: "USD", amount: D("13888.89"), quote: { rate: D("3.60"), date: "2026-11-02" } },
  ],
  rateDate: "2026-11-02",
};
const plain = (v: string | null) => v?.replace(/\s/g, " ") ?? null;

describe("heroModel: net worth converted to the headline currency", () => {
  it("shows the converted figures and keeps every currency's own amount beside them", () => {
    const m = heroModel({
      facts,
      converted,
      change: null,
      norm: null,
      modules: 2,
      investments: null,
    });
    expect(m.label).toBe("Net worth, converted to PLN");
    expect(plain(m.value)).toBe("PLN 100,000.00");
    expect(m.facts.map((f) => [f.label, plain(String(f.value))])).toEqual([
      ["Assets", "PLN 100,000"],
      ["Liquid", "PLN 100,000"],
    ]);
    expect(plain(m.other)).toBe("incl. €1,000.00 · $13,888.89");
    expect(m.meta).toMatch(/NBP mid rate of Nov 2, 2026.*No rate, so left out: EUR\.$/);
  });

  it("without any rate every currency stays on its own, as before", () => {
    const m = heroModel({
      facts,
      converted: { ...converted, rateDate: null },
      change: null,
      norm: null,
      modules: 2,
      investments: null,
    });
    expect(m.label).toBe("Net worth");
    expect(plain(m.value)).toBe("PLN 50,000.00");
    expect(plain(m.other)).toBe("other currencies: €1,000.00 · $13,888.89");
  });
});
