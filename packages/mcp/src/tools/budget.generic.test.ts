// set_merchant_category on a bank's generic phrase: a value-free refusal the agent can read, no rule.
import { afterEach, expect, it } from "vitest";
import { ToolError } from "../registry.js";
import { bankAccount, bankTxn } from "../testing/budget.js";
import { nativeFixture } from "../testing/native.js";
import { budgetTools } from "./budget.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

it("refuses a learned rule on a generic bank phrase and writes nothing", async () => {
  const f = nativeFixture();
  fixtures.push(f);
  const a = bankAccount(f);
  // Payments whose only text is the operation type: the merchant key is the bank's phrase itself.
  bankTxn(f, a, { amount: "-10", merchant: "ZAKUP PRZY UŻYCIU KARTY" });
  bankTxn(f, a, { amount: "-20", merchant: "ZAKUP PRZY UŻYCIU KARTY" });
  const ctx = f.context("strict");
  const spec = budgetTools().find((tool) => tool.name === "set_merchant_category");
  if (!spec) throw new Error("missing setter");
  const token = ctx.guard.payeeRef("ZAKUP PRZY UZYCIU KARTY");
  const before = f.committed();
  const error = await Promise.resolve()
    .then(() => spec.handler(ctx, { merchant: token, category: "groceries" }))
    .then(
      () => null,
      (e: unknown) => e,
    );
  expect(error).toBeInstanceOf(ToolError);
  expect((error as ToolError).kind).toBe("generic_merchant");
  expect((error as ToolError).message).toBe(
    "no rule saved: this merchant is a generic bank phrase covering payments to different payees; the owner can categorize those payments one by one in the app",
  );
  expect((error as ToolError).message).not.toMatch(/ZAKUP|KARTY/);
  expect(f.committed()).toBe(before);
  expect(f.store.read("SELECT * FROM category_rules")).toHaveLength(0);
});
