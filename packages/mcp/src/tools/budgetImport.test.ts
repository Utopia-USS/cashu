import { afterEach, expect, it } from "vitest";
import { callTool } from "../testing/budget.js";
import { nativeFixture } from "../testing/native.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
const fixture = () => {
  const f = nativeFixture();
  fixtures.push(f);
  return f;
};
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function document() {
  return {
    format: "cashu-budget-import",
    format_version: 1,
    source: "synthetic",
    account: {
      institution: "xtb",
      iban: "PL99114000000000000000000001",
      name: "Synthetic account",
      currency: "PLN",
    },
    transactions: [
      {
        booking_date: "2026-10-04",
        amount: "-42.10",
        currency: "PLN",
        transaction_id: "synthetic-first",
      },
    ],
    balances: [{ date: "2026-10-05", amount: "100" }],
  };
}
function validate(
  f: ReturnType<typeof fixture>,
  text: string,
  name = "input.json",
  privacy = "strict",
) {
  const ctx = f.context(privacy);
  let calls = 0;
  const store = {
    ...ctx.store,
    readBudgetImportFile: (path: string) => {
      expect(path).toBe("authorized-file");
      calls += 1;
      return { name, bytes: new TextEncoder().encode(text) };
    },
  };
  const result = callTool({ ...ctx, store }, "validate_budget_import", { path: "authorized-file" });
  expect(calls).toBe(1);
  expect(f.committed()).toBe(0);
  return result;
}
it("reports the MCP shape and accepts institutions registered by modules", () => {
  const f = fixture();
  const result = validate(f, JSON.stringify(document()));
  expect(result).toMatchObject({
    ok: true,
    variant: "json",
    transactions: 1,
    balances: 1,
    date_from: "2026-10-04",
    date_to: "2026-10-04",
    currencies: ["PLN"],
  });
  expect(result.issues_by_kind).not.toHaveProperty("unknown_institution");
  expect(result).not.toHaveProperty("format");
  expect(result).not.toHaveProperty("date_range");
  expect(JSON.stringify(result)).not.toContain("42.10");
  expect(JSON.stringify(result)).not.toContain("Synthetic account");
});
it("counts every issue while returning at most fifty value-free details", () => {
  const f = fixture();
  const doc = document();
  const invalid = {
    ...doc,
    transactions: Array.from({ length: 60 }, () => ({
      booking_date: "bad",
      amount: "bad",
      currency: "PLN",
    })),
  };
  const result = validate(f, JSON.stringify(invalid));
  expect(result.ok).toBe(false);
  expect(result.issues).toHaveLength(50);
  expect(
    Object.values(result.issues_by_kind).reduce((sum: number, n) => sum + Number(n), 0),
  ).toBeGreaterThan(50);
  expect(result.issues[0]).toMatchObject({
    kind: expect.any(String),
    blocking: true,
    row: expect.any(Number),
    field: expect.any(String),
    message: expect.any(String),
  });
  expect(result.issues[0]).not.toHaveProperty("code");
});
it("reports malformed input and CSV through the same pure parser", () => {
  const f = fixture();
  expect(validate(f, "{")).toMatchObject({ ok: false, transactions: 0, date_from: null });
  const csv =
    "format_version,account_iban,account_currency,booking_date,amount,currency\n1,PL99114000000000000000000001,PLN,2026-10-04,-5.00,PLN\n";
  const result = validate(f, csv, "input.csv", "amounts");
  expect(result).toHaveProperty("issues_by_kind");
  expect(result.transactions).toBe(1);
});
it("refuses missing filesystem capability instead of reading paths inside the service", () => {
  const f = fixture();
  expect(() => callTool(f.context(), "validate_budget_import", { path: "unavailable" })).toThrow(
    "local file validation is unavailable",
  );
});
