import { type budget, D } from "@cashu/domain";
import { decodeValue, type JsonValue } from "@cashu/host-protocol/store";
import { importStatement, runCommand } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "./host.js";
import { cleanup, storeClient, tempDir, testHostOptions } from "./testing/harness.js";

afterEach(cleanup);
it("serves budget queries and bounded native commands over the actual vault channel", async () => {
  const dir = tempDir();
  const host = await startLocalHost({ ...testHostOptions(dir), python: null });
  const client = await storeClient(dir);
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("synthetic vault missing");
    const rows = await client.subscribe("budget.screenSpending", vault.id, {
      today: "2026-10-01",
      currency: "PLN",
      period: {},
      lang: "en",
    });
    await vault.queue.run(() => {
      const result = runCommand(
        vault.store,
        vault.writer,
        importStatement,
        {
          statement: {
            bank: "mbank",
            accountNumber: null,
            accountName: "Synthetic",
            currency: "PLN",
            balances: [],
            closingBalances: [],
            transactions: [
              {
                bookingDate: "2026-02-01",
                valueDate: null,
                amount: D("-12.34"),
                currency: "PLN",
                counterpartyName: "Synthetic shop",
                counterpartyIban: null,
                description: "Synthetic",
                reference: "Synthetic",
                bankTransactionId: null,
                source: "csv",
                raw: {},
              },
            ],
          },
          newestDayRule: false,
        },
        vault.env,
      );
      expect(result.ok).toBe(true);
    });
    const latest = () =>
      decodeValue(rows.values.at(-1) as JsonValue) as { total: ReturnType<typeof D> };
    await expect.poll(() => latest().total.toString()).toBe("12.34");
    const drill = await client.subscribe("budget.desktopDrill", vault.id, {
      currency: "PLN",
      category: "other",
      period: {},
      sort: "date",
      order: "desc",
    });
    const txn = (decodeValue(drill.first as JsonValue) as budget.CategoryTxnRow[])[0];
    if (!txn) throw new Error("synthetic drill row missing");
    expect(
      (
        await client.run(
          "budget.setTransactionCategory",
          { txn: txn.key, category: "groceries" },
          { vault: vault.id },
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await client.run(
          "budget.setDesktopMerchantCategory",
          { merchantKey: txn.merchantKey, category: "transport" },
          { vault: vault.id },
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await client.run(
          "budget.setCushion",
          { enabled: true, targetAmount: "100", currency: "PLN", accounts: [] },
          { vault: vault.id },
        )
      ).ok,
    ).toBe(true);
    const close = await client.subscribe("budget.desktopMonthClose", vault.id, {
      today: "2026-10-01",
      month: null,
      lang: "en",
    });
    expect(decodeValue(close.first as JsonValue)).toMatchObject({
      close: { month: "2026-02" },
      settingsUnavailable: false,
    });
    for (const id of ["budget.importStatement", "budget.resync", "budget.cacheLlmRules"])
      await expect(client.run(id, {}, { vault: vault.id })).rejects.toThrow("UnknownCommand");
    const refused = await client.run(
      "budget.setTransactionCategory",
      { txn: "0".repeat(32), category: "groceries" },
      { vault: vault.id },
    );
    expect(refused.ok).toBe(false);
  } finally {
    client.close();
    await host.stop();
  }
});
