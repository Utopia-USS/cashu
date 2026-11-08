// Brokerage reads: accounts, settings defaults,
// transactions as domain values in chronological order, existing hashes, renames, the newest broker
// snapshot. Synthetic data only.
import { describe, expect, it } from "vitest";
import { openAccount } from "../../core/commands.js";
import { applyRaw, brokerage, stock, type Vault, vault } from "../commands/testing/fixtures.js";
import {
  accountSettings,
  brokerageAccount,
  brokerageAccounts,
  existingHashes,
  latestPositionSnapshot,
  renames,
  transactions,
} from "./transactions.js";

const hash = (c: string) => c.repeat(64);

function txn(v: Vault, account: string, h: string, data: Record<string, unknown>) {
  return {
    type: "invTxn.imported",
    gid: v.det("inv_transactions", [account, h]),
    data: {
      account,
      batch: null,
      type: "buy",
      tradeDate: "2026-03-02",
      settleDate: null,
      instrument: null,
      quantity: "10",
      price: "12.50",
      currency: "PLN",
      grossAmount: "125.00",
      fee: "1.00",
      tax: "0",
      cashAmount: "-126.00",
      cashCurrency: "PLN",
      fxRate: null,
      splitRatio: null,
      note: null,
      source: "import",
      externalRef: null,
      dedupHash: h,
      createdAt: "2026-03-02T10:00:00.000Z",
      ...data,
    },
  };
}

describe("brokerage reads", () => {
  it("lists brokerage accounts only, oldest first, with settings defaults", () => {
    const v = vault();
    const read = v.store.read.bind(v.store);
    const a = brokerage(v, "XTB");
    v.value(openAccount, {
      bank: "manual",
      name: "Gotowka",
      type: "cash",
      currency: "PLN",
      externalId: "manual:G",
    });
    const b = brokerage(v, "DIF");
    expect(brokerageAccounts(read).map((x) => x.gid)).toEqual([a, b]);
    expect(brokerageAccount(read, a)?.name).toBe("XTB");
    expect(accountSettings(read, a)).toEqual({
      account: a,
      wrapper: "regular",
      importer: null,
      mappingYaml: null,
    });
    applyRaw(v, [
      {
        type: "invAccount.settingsSet",
        gid: v.det("inv_account_settings", [a]),
        data: { account: a, wrapper: "ike", importer: "xtb" },
      },
    ]);
    expect(accountSettings(read, a)).toMatchObject({ wrapper: "ike", importer: "xtb" });
  });

  it("returns transactions as domain values in chronological order", () => {
    const v = vault();
    const read = v.store.read.bind(v.store);
    const acc = brokerage(v);
    const other = brokerage(v, "Drugi");
    const i = stock(v, "AAA", "PL0000000AAA");
    applyRaw(v, [
      txn(v, acc, hash("b"), { tradeDate: "2026-03-03", instrument: i }),
      txn(v, acc, hash("a"), { createdAt: "2026-03-02T11:00:00.000Z", instrument: i }),
      txn(v, acc, hash("c"), {
        type: "deposit",
        quantity: null,
        price: null,
        grossAmount: "1000",
        fee: "0",
        cashAmount: "1000",
        createdAt: "2026-03-02T09:00:00.000Z",
      }),
      txn(v, other, hash("d"), {}),
    ]);
    const all = transactions(read, [acc]);
    expect(all.map((t) => t.dedupHash)).toEqual([hash("c"), hash("a"), hash("b")]);
    const buy = all[1];
    expect(buy).toMatchObject({
      accountId: acc,
      instrumentId: i,
      type: "buy",
      tradeDate: "2026-03-02",
    });
    expect([buy?.cashAmount.toString(), buy?.fee.toString(), buy?.quantity?.toString()]).toEqual([
      "-126.00",
      "1.00",
      "10",
    ]);
    expect(buy?.createdAt).toMatchObject({ date: "2026-03-02", hour: 11, offsetSeconds: 0 });
    expect(all[0]?.instrumentId).toBeNull();
    expect(transactions(read)).toHaveLength(4);
    expect(transactions(read, [])).toEqual([]);
    expect(existingHashes(read, acc, [hash("a"), hash("d"), hash("e")])).toEqual(
      new Set([hash("a")]),
    );
  });

  it("renames by date and the newest broker snapshot of an account", () => {
    const v = vault();
    const read = v.store.read.bind(v.store);
    const acc = brokerage(v);
    const a = stock(v, "AAA", "PL0000000AAA");
    const b = stock(v, "BBB", "PL0000000BBB");
    const snap = (inst: string, asOf: string, quantity: string) => ({
      type: "position.snapshotImported",
      gid: v.det("inv_position_snapshots", [acc, inst, asOf]),
      data: {
        account: acc,
        instrument: inst,
        asOf,
        quantity,
        currency: "PLN",
        avgPrice: null,
        marketValue: null,
        batch: null,
      },
    });
    applyRaw(v, [
      snap(a, "2026-03-01", "5"),
      snap(a, "2026-03-31", "6"),
      snap(b, "2026-03-31", "1"),
      {
        type: "instrumentRename.recorded",
        gid: v.det("inv_instrument_renames", ["2026-03-10", a, b]),
        data: { date: "2026-03-10", old: a, new: b, note: "zmiana tickera", batch: null },
      },
    ]);
    expect(latestPositionSnapshot(read, acc)).toMatchObject({
      asOf: "2026-03-31",
      rows: [
        { instrument: a, quantity: "6" },
        { instrument: b, quantity: "1" },
      ],
    });
    expect(latestPositionSnapshot(read, brokerage(v, "Pusty"))).toEqual({ asOf: null, rows: [] });
    expect(renames(read)).toEqual([
      { date: "2026-03-10", oldInstrumentId: a, newInstrumentId: b, note: "zmiana tickera" },
    ]);
  });
});
