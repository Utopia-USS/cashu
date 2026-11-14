// `networth_breakdown` with a cash pool's rows in another currency (data-safety rule 5): the part
// counts in its own currency, under its pool's account label, and the privacy labels still apply
// (the owner-given name never leaves in either mode). Synthetic data only.
import { budget } from "@cashu/domain";
import { addCashExpense } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import type { LabelledTree } from "../privacy/labels.js";
import { pyDumps } from "../privacy/pyJson.js";
import { leakCheck, Redactor } from "../privacy/redactor.js";
import type { ToolContext } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";
import { nativeFixture } from "../testing/native.js";
import { coreTools } from "./core.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

function breakdown(ctx: ToolContext<NativeToolStore>) {
  const spec = coreTools().find((tool) => tool.name === "networth_breakdown");
  if (!spec) throw new Error("networth_breakdown missing");
  const redactor = new Redactor({ privacy: ctx.privacy, guard: ctx.guard });
  const output = redactor.apply(spec.handler(ctx, {}) as LabelledTree);
  leakCheck(output, { strict: ctx.strict, isins: redactor.isins, nonMoney: redactor.nonMoney });
  return JSON.parse(pyDumps(output));
}

it("lists a pool's part in another currency under the pool's label, redacted like any account", () => {
  const f = nativeFixture({ modules: ["budget"] });
  fixtures.push(f);
  // PLN pool: -12.00 PLN; two EUR rows addressed to it: -3.00 - 5.00 = -8.00 EUR.
  const added = f.run(addCashExpense, {
    amount: "12.00",
    title: "Synthetic coffee",
    category: "dining",
    onDate: "2026-10-20",
  });
  if (!added.ok) throw new Error(added.reason);
  const pool = f.store.read<{ gid: string; name: string }>(
    "SELECT gid, name FROM accounts WHERE type = 'cash'",
  )[0];
  if (pool === undefined) throw new Error("missing the synthetic cash pool");
  for (const [date, amount] of [
    ["2026-10-10", "-3.00"],
    ["2026-10-25", "-5.00"],
  ])
    f.seed("txn.cashExpenseAdded", {
      account: pool.gid,
      bookingDate: date,
      amount,
      currency: "EUR",
      title: "Synthetic euro coffee",
      category: "dining",
    });
  expect(budget.cashPoolPartOf(budget.cashPoolPartId(pool.gid, "EUR"))?.pool).toBe(pool.gid);

  const amounts = breakdown(f.context());
  const rows = (currency: string) =>
    amounts.currencies.find((c: { currency: string }) => c.currency === currency);
  expect(amounts.currencies.map((c: { currency: string }) => c.currency)).toEqual(["EUR", "PLN"]);
  expect(rows("EUR")).toMatchObject({ net: -8, liabilities: 8 });
  expect(rows("PLN")).toMatchObject({ net: -12, liabilities: 12 });
  const poolLabel = rows("PLN").accounts[0].account;
  expect(typeof poolLabel).toBe("string");
  expect(rows("EUR").accounts).toHaveLength(1);
  expect(rows("EUR").accounts[0]).toMatchObject({ account: poolLabel, balance: -8 });
  expect(JSON.stringify(amounts)).not.toContain(pool.name);

  const strict = breakdown(f.context("strict"));
  const strictRow = (currency: string) =>
    strict.currencies.find((c: { currency: string }) => c.currency === currency).accounts[0];
  const eur = strictRow("EUR");
  expect(eur.account).toBe(strictRow("PLN").account);
  expect(eur).not.toHaveProperty("balance");
  expect(JSON.stringify(strict)).not.toContain(pool.name);
});
