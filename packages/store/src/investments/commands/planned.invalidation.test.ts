// Touched-table invalidation for the S22b accounts / manual transactions / planned deposits commands
// (testing.md): each batch touches a table the matching query reads, a subscriber to that read set is
// notified, and the query's answer changed. Synthetic data only.
import { describe, expect, it } from "vitest";
import { brokerageDeposits, plannedDeposits } from "../queries/planned.js";
import { accountSettings, brokerageAccounts, transactions } from "../queries/transactions.js";
import { addBrokerageAccount, rememberAccountImporter, setAccountSettings } from "./accounts.js";
import { addManualTransaction } from "./manual.js";
import { cancelPlannedDeposit, createPlannedDeposit } from "./planned.js";
import { vault } from "./testing/fixtures.js";
import { expectInvalidates } from "./testing/invalidation.js";

describe("S22b command batches invalidate the queries that read their tables", () => {
  it("account commands", () => {
    const v = vault();
    const added = expectInvalidates(v, addBrokerageAccount, { name: "DIF", broker: "dif" }, (r) =>
      brokerageAccounts(r),
    );
    const account = added.ok ? added.value.account : "";
    expectInvalidates(v, setAccountSettings, { account, wrapper: "ike" }, (r) =>
      accountSettings(r, account),
    );
    expectInvalidates(v, rememberAccountImporter, { account, importer: "xtb" }, (r) =>
      accountSettings(r, account),
    );
  });

  it("manual transactions and planned deposits", () => {
    const v = vault();
    const account = v.value(addBrokerageAccount, { name: "DIF", broker: "dif" }).account;
    const created = expectInvalidates(
      v,
      createPlannedDeposit,
      { amount: 500, plannedDate: "2026-11-02" },
      (r) => plannedDeposits(r),
    );
    const plan = created.ok ? created.value.plan : "";
    expectInvalidates(
      v,
      addManualTransaction,
      { account, type: "deposit", tradeDate: "2026-11-01", cashAmount: "100" },
      (r) => transactions(r),
    );
    // a matching manual deposit books the plan in the same batch
    expectInvalidates(
      v,
      addManualTransaction,
      { account, type: "deposit", tradeDate: "2026-11-02", cashAmount: "500" },
      (r) => plannedDeposits(r).map((p) => [p.status, p.bookedTxn]),
    );
    expectInvalidates(
      v,
      addManualTransaction,
      { account, type: "deposit", tradeDate: "2026-11-03", cashAmount: "7" },
      (r) => brokerageDeposits(r, "2026-11-01"),
    );
    const other = v.value(createPlannedDeposit, { amount: 5, plannedDate: "2026-12-01" }).plan;
    expectInvalidates(v, cancelPlannedDeposit, { plan: other }, (r) => plannedDeposits(r));
    expect(plan).not.toBe(other);
  });
});
