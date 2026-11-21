// The cash drawer names the store's `cash_currency_mismatch` refusal (a cash wallet kept in another
// currency than the booked one) in the UI language; every other refusal keeps the generic message.
import { setLanguageForTests } from "@cashu/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { cashFailure } from "./useCashDrawer.js";

afterEach(() => setLanguageForTests("en"));

describe("cashFailure", () => {
  it("names a wallet kept in another currency, in English and Polish", () => {
    const mismatch = { kind: "refused", reason: "cash_currency_mismatch" } as const;
    setLanguageForTests("en");
    expect(cashFailure(mismatch)).toBe(
      "The cash wallet is kept in another currency, so the expense was not saved.",
    );
    setLanguageForTests("pl");
    expect(cashFailure(mismatch)).toBe(
      "Portfel gotówkowy jest prowadzony w innej walucie, więc wydatku nie zapisano.",
    );
  });

  it("keeps the generic message for any other refusal", () => {
    setLanguageForTests("en");
    expect(cashFailure({ kind: "refused", reason: "empty_title" })).toBe(
      "The cash wallet could not be changed.",
    );
    expect(cashFailure({ kind: "not_started", reason: "cash_currency_mismatch" })).not.toBe(
      "The cash wallet is kept in another currency, so the expense was not saved.",
    );
  });
});
