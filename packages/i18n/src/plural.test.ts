import { describe, expect, it } from "vitest";
import { enCount, enForm, plCount, plForm, setPluralRulesForTests } from "./plural.js";

/** The last-digit rule the app used before Intl.PluralRules (the reference for whole numbers). */
function digitRule(n: number): "one" | "few" | "many" {
  const abs = Math.abs(n);
  if (abs === 1) return "one";
  const n10 = abs % 10;
  const n100 = abs % 100;
  return n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? "few" : "many";
}

describe("plurals through Intl.PluralRules", () => {
  it("pick the Polish form of every whole number as the last-digit rule does", () => {
    for (let n = -1000; n <= 1000; n++) expect(plForm(n, "one", "few", "many")).toBe(digitRule(n));
  });

  it("keep the last-digit rule for fractions (Intl alone would say other)", () => {
    expect(plForm(2.5, "one", "few", "many")).toBe("few");
    expect(plForm(1.5, "one", "few", "many")).toBe("many");
    expect(plForm(Number.NaN, "one", "few", "many")).toBe("many");
  });

  it("pick the English form: one for 1 and -1 only", () => {
    expect([1, -1, 0, 2, 1.5].map((n) => enForm(n, "rule", "rules"))).toEqual([
      "rule",
      "rule",
      "rules",
      "rules",
      "rules",
    ]);
  });

  it("put the number in front", () => {
    expect(plCount(5, "reguła", "reguły", "reguł")).toBe("5 reguł");
    expect(plCount(22, "reguła", "reguły", "reguł")).toBe("22 reguły");
    expect(enCount(1, "rule", "rules")).toBe("1 rule");
  });
});

describe("plurals without Intl.PluralRules (Hermes on iOS)", () => {
  it("agrees with Intl.PluralRules for every whole number and for fractions", () => {
    const pl = new Intl.PluralRules("pl");
    const en = new Intl.PluralRules("en");
    try {
      setPluralRulesForTests(false);
      for (let n = 0; n <= 300; n += 1) {
        const expected = pl.select(n);
        expect(plForm(n, "one", "few", "many")).toBe(
          expected === "one" ? "one" : expected === "few" ? "few" : "many",
        );
        expect(enForm(n, "one", "other")).toBe(en.select(n));
        expect(enForm(-n, "one", "other")).toBe(en.select(-n));
      }
      expect(plForm(2.5, "one", "few", "many")).toBe("few");
      expect(enForm(1.5, "one", "other")).toBe("other");
      expect(plCount(22, "reguła", "reguły", "reguł")).toBe("22 reguły");
      expect(enCount(1, "rule", "rules")).toBe("1 rule");
    } finally {
      setPluralRulesForTests(null);
    }
  });
});
