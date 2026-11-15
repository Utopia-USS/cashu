// uncategorized_merchants never lists a bank's generic phrase (no rule fits it) and says, value-free,
// that such payments are categorized one by one.
import { afterEach, expect, it } from "vitest";
import { bankAccount, bankTxn, callTool } from "../testing/budget.js";
import { nativeFixture } from "../testing/native.js";
import { budgetTools } from "./budget.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

const NOTE =
  "payments without a named merchant (only a generic bank phrase) are not listed: no rule fits them; the owner categorizes them one by one in the app";

it.each(["default", "strict"] as const)(
  "%s: lists only named merchants, generic phrases stay in the share base",
  (mode) => {
    const f = nativeFixture();
    fixtures.push(f);
    const a = bankAccount(f);
    // Generic phrases outnumber the one merchant, so they would come first by count.
    const generic = ["ZAKUP PRZY UŻYCIU KARTY", "ZAKUP PRZY UŻYCIU KARTY", "PRZELEW", "PRZELEW"];
    generic.push("BLIK", "BLIK");
    generic.forEach((merchant, i) => {
      bankTxn(f, a, { amount: "-10", merchant, date: `2026-09-0${i + 1}` });
    });
    bankTxn(f, a, { amount: "-20", merchant: "ZXQ NAMED SHOP" });
    const result = callTool(
      f.context(mode === "strict" ? "strict" : undefined),
      "uncategorized_merchants",
      {
        limit: 1,
      },
    );
    // 20 of 80 uncategorized spending: the generic payments still count in "of all uncategorized".
    expect(result.merchants).toEqual([
      {
        merchant: "ZXQ NAMED SHOP",
        currency: "PLN",
        count: 1,
        share: 0.25,
        ...(mode === "strict" ? {} : { total: 20 }),
      },
    ]);
    expect(result.one_by_one).toBe(NOTE);
    expect(JSON.stringify(result)).not.toMatch(/ZAKUP|KARTY|BLIK|"PRZELEW/u);
  },
);

it("says in the description that payments without a merchant are categorized one by one", () => {
  const spec = budgetTools().find((tool) => tool.name === "uncategorized_merchants");
  expect(spec?.description).toContain(
    "Payments without a named merchant are not listed: the owner categorizes them one by one in the app.",
  );
});
