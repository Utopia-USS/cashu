import { setLanguageForTests } from "@cashu/i18n";
import { expect, it } from "vitest";
import { initialLoanForm, loanInput } from "./loanForm.js";

it("normalizes localized loan fields without changing percent or term units", () => {
  setLanguageForTests("pl");
  const draft = {
    ...initialLoanForm("2026-10-01", "PLN"),
    name: "Synthetic loan",
    principal: "12 000,50",
    annualRate: "0,85",
    term: "1,0",
  };
  expect(loanInput(draft)).toMatchObject({
    principal: "12000.50",
    annualRate: "0.85",
    termMonths: 12,
    startDate: "2026-10-01",
  });
  expect(() => loanInput({ ...draft, term: "1,5" })).toThrow();
  expect(() => loanInput({ ...draft, term: "1e1" })).toThrow();
  expect(() => loanInput({ ...draft, principal: "1e4" })).toThrow();
});
