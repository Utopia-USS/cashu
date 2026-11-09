// MCP propose_account_removal on synthetic accounts: a proposal by generated label, nothing removed.
import { openAccount, removeAccount } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { pyDumps } from "../privacy/pyJson.js";
import { Redactor } from "../privacy/redactor.js";
import { decodeEntityRef } from "../runtime/refs.js";
import { bankAccount, bankTxn, callTool } from "../testing/budget.js";
import { nativeFixture } from "../testing/native.js";
import { budgetTools } from "./budget.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
const fixture = () => {
  const f = nativeFixture();
  fixtures.push(f);
  return f;
};
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

async function propose(f: ReturnType<typeof nativeFixture>, args: Record<string, unknown>) {
  const ctx = f.context("strict");
  const spec = budgetTools().find((tool) => tool.name === "propose_account_removal");
  if (!spec) throw new Error("missing tool");
  const output = new Redactor({ privacy: ctx.privacy, guard: ctx.guard }).apply(
    await spec.handler(ctx, args),
  );
  return JSON.parse(pyDumps(output)) as Record<string, unknown>;
}

function labelOf(f: ReturnType<typeof nativeFixture>, gid: string): string {
  const id = f.store.read<{ id: number }>("SELECT id FROM accounts WHERE gid = ?", gid)[0]?.id;
  const label = id === undefined ? undefined : f.context("strict").accountLabels.get(id);
  if (!label) throw new Error("label missing");
  return label;
}

const proposals = (f: ReturnType<typeof nativeFixture>) =>
  f.store.read<{ gid: string; kind: string; status: string; payload: string }>(
    "SELECT gid, kind, status, payload FROM proposals",
  );

it("stores a pending proposal for a bank account named by its generated label", async () => {
  const f = fixture();
  const account = bankAccount(f);
  const label = labelOf(f, account);
  const out = await propose(f, { account: label.toUpperCase(), reason: "Closed account." });
  expect(out).toMatchObject({ account: label, stored: true });
  const [row] = proposals(f);
  expect(row).toMatchObject({ kind: "account_removal", status: "pending" });
  expect(decodeEntityRef("proposal", out.proposal_id as string)).toBe(row?.gid);
  expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({ account });
  expect(f.store.read("SELECT removed_at FROM accounts WHERE gid = ?", account)).toEqual([
    { removed_at: null },
  ]);
  await expect(propose(f, { account: label })).rejects.toThrow("already waits");
  expect(proposals(f)).toHaveLength(1);
});

it("refuses unknown, removed and non-bank accounts without writing", async () => {
  const f = fixture();
  const bank = bankAccount(f);
  const cash = f.run(openAccount, {
    bank: "manual",
    name: "Wallet",
    type: "cash",
    currency: "PLN",
  });
  if (!cash.ok) throw new Error(cash.reason);
  await expect(propose(f, { account: "Nonexistent bank checking 9" })).rejects.toThrow(
    "no such visible account",
  );
  await expect(propose(f, { account: labelOf(f, cash.value.account) })).rejects.toThrow(
    "only bank accounts",
  );
  const label = labelOf(f, bank);
  expect(f.run(removeAccount, { account: bank }).ok).toBe(true);
  await expect(propose(f, { account: label })).rejects.toThrow("no such visible account");
  expect(proposals(f)).toHaveLength(0);
});

it("leaves a removed account's rows out of the budget read tools", () => {
  const f = fixture();
  const live = bankAccount(f);
  const closed = bankAccount(f, "PLN", {
    name: "Closed bank account",
    externalId: "synthetic-closed",
  });
  bankTxn(f, live, { amount: "-10", merchant: "ZXQ LIVE TEST" });
  bankTxn(f, closed, { amount: "-20", merchant: "ZXQ CLOSED TEST" });
  const merchants = () =>
    (callTool(f.context(), "uncategorized_merchants").merchants as { merchant: string }[]).map(
      (m) => m.merchant,
    );
  expect(merchants().sort()).toEqual(["ZXQ CLOSED TEST", "ZXQ LIVE TEST"]);
  expect(f.run(removeAccount, { account: closed }).ok).toBe(true);
  expect(merchants()).toEqual(["ZXQ LIVE TEST"]);
  expect(callTool(f.context(), "spending_breakdown")).toMatchObject({ total: 10 });
});
