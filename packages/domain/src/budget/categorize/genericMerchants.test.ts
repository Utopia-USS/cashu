import { describe, expect, it } from "vitest";
import { merchantKey, merchantName } from "../ingestion/contentKey.js";
import { GENERIC_MERCHANT_KEYS, isMerchantRuleKey } from "./genericMerchants.js";
import { SEED_RULE_DATA } from "./seedRules.js";

describe("isMerchantRuleKey", () => {
  it("refuses an empty key and a bank's generic phrase, in any case or accent form", () => {
    for (const key of [
      null,
      undefined,
      "",
      "   ",
      "ZAKUP PRZY UŻYCIU KARTY",
      "zakup przy użyciu karty",
    ])
      expect(isMerchantRuleKey(key)).toBe(false);
    for (const key of ["PRZELEW", "Przelew wychodzący", "PRZELEW NA TELEFON BLIK", "BLIK"])
      expect(isMerchantRuleKey(key)).toBe(false);
  });

  it("takes a key that names someone, even when it starts with a generic phrase", () => {
    for (const key of [
      "KAWIARNIA TEST/WARSZAWA",
      "ZAKUP PRZY UZYCIU KARTY SKLEP TEST",
      "PRZELEW DLA WSPOLNOTY TEST",
      "WYPLATA GOTOWKI",
      "OPLATA ZA KARTE",
    ])
      expect(isMerchantRuleKey(key)).toBe(true);
  });

  it("lists normalized keys only (upper case, no diacritics), each once", () => {
    for (const key of GENERIC_MERCHANT_KEYS) expect(merchantKey(key)).toBe(key);
    expect(new Set(GENERIC_MERCHANT_KEYS).size).toBe(GENERIC_MERCHANT_KEYS.length);
  });

  it("blocks no seed rule's own key (a seed rule names a merchant or a one-category kind)", () => {
    for (const [pattern] of SEED_RULE_DATA)
      if (merchantKey(pattern) !== "")
        expect(GENERIC_MERCHANT_KEYS).not.toContain(merchantKey(pattern));
  });
});

describe("merchantName", () => {
  it("names the field merchantKey keys on, mBank's date suffix and padding cut", () => {
    const card = [
      "KAWIARNIA TEST/WARSZAWA        DATA TRANSAKCJI: 2026-09-01",
      "ZAKUP PRZY UŻYCIU KARTY",
    ];
    expect(merchantName(null, ...card)).toBe("KAWIARNIA TEST/WARSZAWA");
    expect(merchantName("  ", "SKLEP TEST   /KRAKÓW   DATA TRANSAKCJI: 2026-09-06", "X")).toBe(
      "SKLEP TEST",
    );
    expect(merchantName("Żabka Polska", "ref", "desc")).toBe("Żabka Polska");
    expect(merchantName(null, null, "ZAKUP PRZY UŻYCIU KARTY")).toBe("ZAKUP PRZY UŻYCIU KARTY");
    expect(merchantName(null, "", null)).toBe("");
  });

  it("normalizes to merchantKey for any input (seeded random strings)", () => {
    const alphabet = [
      "A",
      "ż",
      "Ł",
      "ó",
      " ",
      "  ",
      " ",
      "\t",
      "\n",
      "/",
      "1",
      "-",
      "¨",
      "﻿",
      "DATA TRANSAKCJI: 2026-01-01",
      "data transakcji:",
      "ZAKUP",
      "́",
    ];
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    const word = () =>
      Array.from({ length: next() % 8 }, () => alphabet[next() % alphabet.length]).join("");
    for (let i = 0; i < 5000; i++) {
      const fields = [word(), word(), word()].map((w) => (next() % 5 === 0 ? null : w));
      expect(merchantKey(merchantName(...fields))).toBe(merchantKey(...fields));
    }
  });
});
