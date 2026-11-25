import { D } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { merchantRuleOffer, ruleMerchants } from "./merchantRules.js";

// Oracle: the keys a bank prints for the operation itself (mBank / Pekao wording, written out by hand here,
// not read from the list under test) and real-looking merchant keys built from synthetic names.
const GENERIC = [
  "ZAKUP PRZY UZYCIU KARTY",
  "PRZELEW",
  "PRZELEW WYCHODZACY",
  "BLIK",
  "PLATNOSC KARTA",
];
const MERCHANTS = [
  "SKLEP TEST 0331/MIASTO TEST",
  "ZAKUP PRZY UZYCIU KARTY SKLEP TEST",
  "KAWIARNIA ZXQ",
];

describe("merchantRuleOffer (toast after a manual category)", () => {
  it.each(GENERIC)("offers no rule for the generic phrase %s", (merchantKey) => {
    expect(
      merchantRuleOffer({ merchantKey, counterparty: "", merchant: merchantKey }, "groceries"),
    ).toBeNull();
  });

  it("offers no rule for a generic phrase in another case or with Polish letters", () => {
    for (const merchantKey of ["Zakup przy użyciu karty", "przelew"])
      expect(
        merchantRuleOffer({ merchantKey, counterparty: "", merchant: "" }, "gifts"),
      ).toBeNull();
  });

  it.each(MERCHANTS)("offers the rule for the merchant %s, named by the row", (merchantKey) => {
    expect(
      merchantRuleOffer({ merchantKey, counterparty: "", merchant: "Sklep Test" }, "groceries"),
    ).toEqual({ merchantKey, name: "Sklep Test" });
    expect(
      merchantRuleOffer({ merchantKey, counterparty: "Jan Test", merchant: "x" }, "groceries"),
    ).toEqual({ merchantKey, name: "Jan Test" });
    expect(merchantRuleOffer({ merchantKey, counterparty: "", merchant: "" }, "groceries")).toEqual(
      {
        merchantKey,
        name: merchantKey,
      },
    );
  });

  it("offers nothing without a key or for a cash withdrawal", () => {
    expect(
      merchantRuleOffer({ merchantKey: null, counterparty: "A", merchant: "B" }, "x"),
    ).toBeNull();
    expect(
      merchantRuleOffer({ merchantKey: "", counterparty: "A", merchant: "B" }, "x"),
    ).toBeNull();
    expect(
      merchantRuleOffer(
        { merchantKey: "KAWIARNIA ZXQ", counterparty: "", merchant: "" },
        "cash_withdrawal",
      ),
    ).toBeNull();
  });
});

describe("ruleMerchants (uncategorized drawer and tile)", () => {
  it("drops the generic phrases and keeps the merchants in order", () => {
    const group = (merchantKey: string) => ({ merchantKey, total: D("1.00") });
    const rows = [
      group("PRZELEW"),
      group("KAWIARNIA ZXQ"),
      group("ZAKUP PRZY UZYCIU KARTY"),
      group("SKLEP TEST 0331/MIASTO TEST"),
    ];
    expect(ruleMerchants(rows).map((r) => r.merchantKey)).toEqual([
      "KAWIARNIA ZXQ",
      "SKLEP TEST 0331/MIASTO TEST",
    ]);
  });
});
