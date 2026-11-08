// Owner approval of an agent's MCP propose_import (no connector) on a native vault, through the
// production approval provider main.ts wires (connectorRuntime proposals) and the drawer's action.
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { investmentsCommands as C, mintUlid } from "@cashu/store";
import { transactions } from "@cashu/store/investments/queries";
import {
  createInvestmentImportProposal,
  DailyPriceLock,
  publishCheckedImportBlob,
} from "@cashu/store/investments/services";
import { expect, it } from "vitest";
import { runHostVaultCommand } from "../commands.js";
import { createConnectorRuntime } from "../connectorRuntime.js";
import { startLocalHost } from "../host.js";
import { storeClient } from "../testing/harness.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";

const HEADER =
  "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source";
const FILE = new TextEncoder().encode(
  `${HEADER}\n1,txn,2026-01-01,,deposit,D,,,,,,,PLN,,,,1000,PLN,,,generic_csv\n`,
);

it("approves an agent's import proposal through the production approval provider", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  chmodSync(join(fixture.dataDir, "vaults", fixture.vaultId), 0o700);
  const connectorsDir = realpathSync(mkdtempSync(join(tmpdir(), "cashu-import-approval-")));
  let runtime: ReturnType<typeof createConnectorRuntime> | undefined;
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
    proposals: { bind: (vault, stores) => runtime?.proposals.bind(vault, stores) ?? null },
  });
  const client = await storeClient(fixture.dataDir);
  try {
    const vault = host.stores.vaults.get(fixture.vaultId);
    const publication = vault?.native?.blobPublication();
    if (vault === undefined || !publication) throw new Error("native publication absent");
    runtime = createConnectorRuntime({
      dataDir: connectorsDir,
      lock: { held: true } as never,
      stores: host.stores,
      device: host.stores.device.store,
      dailyLock: new DailyPriceLock(),
      current: (v) => host.stores.vaults.get(v.id) === v,
      // This fixture device stands in for the vault lease holder (production: canFetchPublicMarket).
      holder: () => true,
      now: Date.now,
    });
    const run = async <R>(
      command: Parameters<typeof runHostVaultCommand<unknown, R>>[1],
      input: unknown,
    ) => {
      const result = await runHostVaultCommand(vault, command, input, mintUlid(Date.now()));
      if (result.kind !== "completed") throw new Error(`command ${result.kind}`);
      return result.value;
    };
    const { account } = await run(C.addBrokerageAccount, {
      name: "Synthetic broker",
      broker: "dif",
    });
    // What MCP propose_import does: publish the checked file, then store the proposal.
    const request = { account, file: { name: "synthetic.csv", content: FILE }, importer: "cashu" };
    const published = await publishCheckedImportBlob(publication, vault.id, request.file);
    const saved = await run(
      createInvestmentImportProposal(publication, request, published.blob, "Synthetic broker"),
      { reason: null },
    );
    if (!saved.stored) throw new Error("import proposal not stored");
    expect(transactions(vault.store.read.bind(vault.store))).toHaveLength(0);
    const reviewed = await client.action(
      "core.desktopProposals.review",
      { gid: saved.proposalGid, decision: "approve" },
      fixture.vaultId,
    );
    expect(reviewed, JSON.stringify(reviewed)).toMatchObject({
      status: "completed",
      value: { status: "approved" },
    });
    expect(transactions(vault.store.read.bind(vault.store))).toHaveLength(1);
  } finally {
    client.close();
    await host.stop();
    runtime?.catalog.close();
    fixture.cleanup();
    rmSync(connectorsDir, { recursive: true, force: true });
  }
});
