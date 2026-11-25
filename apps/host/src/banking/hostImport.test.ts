import { D } from "@cashu/domain";
import { openAccount, runCommand } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import type { OpenVault } from "../stores.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import { createVaultBankingImportPort } from "./hostImport.js";

afterEach(cleanup);

it("refuses banking imports and account lookup for a synthetic vault", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()) });
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("synthetic vault missing");
    const port = createVaultBankingImportPort(vault, {
      profileId: vault.id,
      isCurrent: () => true,
      isHolder: () => true,
      isOwnerAction: () => true,
    });
    const input = {
      profileId: vault.id,
      externalId: "synthetic-eb-uid",
      accountType: "checking" as const,
      statement: {
        bank: "mbank",
        accountNumber: null,
        accountName: "Synthetic",
        currency: "PLN",
        balances: [] as const,
        closingBalances: [] as const,
        transactions: [
          {
            bookingDate: "2026-11-04",
            valueDate: null,
            amount: D("-12.340"),
            currency: "PLN",
            counterpartyName: "Synthetic merchant",
            counterpartyIban: null,
            description: "Synthetic",
            reference: "Synthetic",
            bankTransactionId: "synthetic-id",
            source: "open_banking" as const,
            raw: {},
          },
        ],
      },
      guard: () => true,
    };
    const first = await port.runImport(input);
    expect(first).toEqual({ ok: false, reason: "banking_authority_changed" });
    expect(await port.findAccount(vault.id, "mbank", "synthetic-eb-uid", null)).toBeNull();
    expect(await port.findAccount(vault.id, "pekao", "synthetic-eb-uid", null)).toBeNull();
  } finally {
    await host.stop();
  }
});

it("looks up a bank account by bank and excludes brokerage accounts", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()) });
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("synthetic vault missing");
    const checking = runCommand(
      vault.store,
      vault.writer,
      openAccount,
      {
        bank: "mbank",
        name: "Synthetic checking",
        type: "checking",
        currency: "PLN",
        externalId: "same-uid",
      },
      vault.env,
    );
    const brokerage = runCommand(
      vault.store,
      vault.writer,
      openAccount,
      {
        bank: "pekao",
        name: "Synthetic brokerage",
        type: "brokerage",
        currency: "EUR",
        externalId: "same-uid",
      },
      vault.env,
    );
    expect(checking.ok).toBe(true);
    expect(brokerage.ok).toBe(true);
    // This read-only lookup exercises the native gate without opening an OS keyring or native engine.
    const nativeShaped = {
      ...vault,
      mode: "native",
      native: { canRunSideEffects: () => true },
    } as unknown as OpenVault;
    const port = createVaultBankingImportPort(nativeShaped, {
      profileId: vault.id,
      isCurrent: () => true,
      isHolder: () => true,
      isOwnerAction: () => true,
    });
    expect(await port.findAccount(vault.id, "mbank", "same-uid", null)).toMatchObject({
      bank: "mbank",
    });
    expect(await port.findAccount(vault.id, "pekao", "same-uid", null)).toBeNull();
  } finally {
    await host.stop();
  }
});
