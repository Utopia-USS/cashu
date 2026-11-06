import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand, investmentsCommands, ok } from "@cashu/store";
import type { ConnectorSettingsSnapshot } from "@cashu/store/core/desktop-settings";
import { watchQuery } from "@cashu/store/query";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { connectorSettingsServed } from "./connectorSettings.js";
import { ConnectorCatalog, resolveInterpreter } from "./connectors/catalog.js";
import { cleanup, tempDir } from "./testing/harness.js";
import { command, workerFixture } from "./testing/worker.js";

afterEach(cleanup);

/** A synthetic fetch connector source folder (never run here). */
function connectorSource(): string {
  const source = join(tempDir(), "source");
  mkdirSync(source, { mode: 0o700 });
  writeFileSync(
    join(source, "connector.yaml"),
    "api_version: 1\nid: synthetic-fetch\nname: Synthetic\nversion: '1'\nmodule: investments\nkind: fetch\nrun: [python3, connector.py]\nfetch:\n  hosts: [api.example.test]\n",
  );
  writeFileSync(join(source, "connector.py"), "print('{}')\n");
  return source;
}

it("re-pushes the connector list when the catalog or a binding changes, with no re-read", async () => {
  const f = await workerFixture();
  const vault = f.vaults[0];
  if (vault === undefined) throw new Error("synthetic vault absent");
  const catalog = new ConnectorCatalog(tempDir());
  let shown = true;
  const query = connectorSettingsServed({ catalog: () => catalog, shows: () => shown });
  const values: (ConnectorSettingsSnapshot | null)[] = [];
  const stop = watchQuery(vault.store, query, undefined, {
    onValue: (value) => values.push(value),
    onError: (error) => {
      throw error;
    },
  });
  try {
    expect(values).toEqual([{ connectors: [], accounts: [], bindings: [] }]);
    // An install (owner, CLI or an MCP propose_connector go through the same catalog) lands on the open list.
    const loaded = catalog.installPending(connectorSource());
    expect(values.at(-1)?.connectors.map((c) => [c.id, c.approval, c.hosts])).toEqual([
      ["synthetic-fetch", "pending", ["api.example.test"]],
    ]);
    catalog.approve("synthetic-fetch", loaded.contentSha256, resolveInterpreter(loaded), {
      ownerAction: true,
      isCurrent: () => true,
    });
    expect(values.at(-1)?.connectors[0]?.approval).toBe("approved");

    // A binding (any client's write to the vault) re-runs it through the tables it read.
    const account = await command(vault, investmentsCommands.addBrokerageAccount, {
      name: "Synthetic broker",
      broker: "dif",
    });
    const bind = defineCommand({
      id: "test.connectorBinding.set",
      input: z.object({}),
      run(ctx) {
        const gid = ctx.det("connector_bindings", [account.account, "synthetic-fetch"]);
        ctx.emit("connectorBinding.set", gid, {
          account: account.account,
          connectorId: "synthetic-fetch",
          params: {},
          autoCommit: false,
        });
        return ok({ binding: gid });
      },
    });
    const { binding } = await command(vault, bind, {});
    expect(values.at(-1)?.bindings.map((b) => [b.gid, b.account, b.connector_id])).toEqual([
      [binding, account.account, "synthetic-fetch"],
    ]);
    expect(values.at(-1)?.accounts.map((a) => a.gid)).toEqual([account.account]);

    // The old section's Refresh only asks the catalog to be read again: the same value comes back.
    const before = values.length;
    catalog.changed();
    expect(values.length).toBe(before + 1);
    expect(values.at(-1)).toEqual(values.at(-2));

    shown = false;
    catalog.changed();
    expect(values.at(-1)).toBeNull();
    stop();
    catalog.changed();
    expect(values.at(-1)).toBeNull();
    expect(values.length).toBe(before + 2);
  } finally {
    stop();
    await f.close();
  }
});
