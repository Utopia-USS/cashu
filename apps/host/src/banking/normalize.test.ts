import { expect, it } from "vitest";
import { pickBalance } from "./normalize.js";

it("selects a closing balance only in the account currency", () => {
  const balances = [
    { balance_type: "CLBD", balance_amount: { amount: "999.001", currency: "PLN" } },
    { balance_type: "ITAV", balance_amount: { amount: "12.345", currency: "EUR" } },
  ];
  expect(pickBalance(balances, "2026-11-04", "EUR")?.amount.toString()).toBe("12.345");
  expect(pickBalance(balances, "2026-11-04", "USD")).toBeNull();
});
