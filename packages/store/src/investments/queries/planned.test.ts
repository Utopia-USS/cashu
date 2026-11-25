// Vault isolation of the planned deposits, manual transactions and brokerage accounts: another profile
// never sees the rows, and its commands refuse this vault's gids. Synthetic data only.
import { describe, expect, it } from "vitest";
import { addBrokerageAccount } from "../commands/accounts.js";
import { addManualTransaction } from "../commands/manual.js";
import { cancelPlannedDeposit, createPlannedDeposit } from "../commands/planned.js";
import { otherVault, type Vault, vault } from "../commands/testing/fixtures.js";
import {
  brokerageDeposits,
  PLANNED_DEPOSIT_STATUSES,
  plannedDeposit,
  plannedDeposits,
} from "./planned.js";
import { brokerageAccounts, transactions } from "./transactions.js";

function household(v: Vault) {
  const { account } = v.value(addBrokerageAccount, { name: "DIF", broker: "dif" });
  const deposit = v.value(addManualTransaction, {
    account,
    type: "deposit",
    tradeDate: "2026-10-30",
    cashAmount: "500",
  }).transaction;
  const booked = v.value(createPlannedDeposit, { amount: 500, plannedDate: "2026-10-30" }).plan;
  const open = v.value(createPlannedDeposit, {
    amount: 300,
    plannedDate: "2026-11-20",
    account,
  }).plan;
  return { account, deposit, booked, open };
}

const snapshot = (v: Vault) => {
  const read = v.store.read.bind(v.store);
  return JSON.stringify({
    plans: plannedDeposits(read, PLANNED_DEPOSIT_STATUSES),
    deposits: brokerageDeposits(read, "2000-01-01"),
    accounts: brokerageAccounts(read),
    txns: transactions(read),
  });
};

describe("planned deposits, manual transactions and accounts per vault", () => {
  it("another vault never sees the rows", () => {
    const a = vault();
    const b = otherVault();
    const ids = household(a);
    const readA = a.store.read.bind(a.store);
    const readB = b.store.read.bind(b.store);
    expect(plannedDeposit(readA, ids.booked)?.bookedTxn).toBe(ids.deposit);
    expect(plannedDeposits(readB, PLANNED_DEPOSIT_STATUSES)).toEqual([]);
    expect(plannedDeposit(readB, ids.open)).toBeUndefined();
    expect(brokerageDeposits(readB, "2000-01-01")).toEqual([]);
    expect(brokerageAccounts(readB)).toEqual([]);
  });

  it("writes through one vault never touch another, and its gids are refused there", () => {
    const a = vault();
    const b = otherVault();
    household(b);
    const reference = snapshot(b);
    const ids = household(a);
    const refused = (out: { ok: boolean; reason?: string }) => (out.ok ? "ok" : out.reason);
    expect(refused(b.run(cancelPlannedDeposit, { plan: ids.open }))).toBe("no_plan");
    expect(
      refused(
        b.run(createPlannedDeposit, { amount: 1, plannedDate: "2026-11-01", account: ids.account }),
      ),
    ).toBe("no_account");
    expect(
      refused(
        b.run(addManualTransaction, {
          account: ids.account,
          type: "deposit",
          tradeDate: "2026-10-30",
          cashAmount: "1",
        }),
      ),
    ).toBe("no_account");
    // the first vault's own writes after all that leave the second's view unchanged
    a.value(cancelPlannedDeposit, { plan: ids.open });
    expect(snapshot(b)).toBe(reference);
  });
});
