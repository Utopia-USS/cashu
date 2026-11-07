import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeEntityRef, encodeEntityRef } from "@cashu/mcp";
import { connectHost } from "@cashu/node-host";
import { investmentsCommands } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { cliCommandKey, runCliVaultCommand } from "../cli/commandOutcome.js";
import { startLocalHost } from "../host.js";
import { initializeMcp, mcpClient } from "../testing/mcp.js";
import { type NativeVaultFixture, nativeVaultFixture } from "../testing/nativeVaultFixture.js";

const fixtures: NativeVaultFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function clientFor(dataDir: string, profile: string) {
  const connection = await connectHost({ dataDir, role: "mcp", profile, build: "test" });
  const client = mcpClient(
    (line) => connection.send({ t: "mcp", line }),
    (handler) =>
      connection.onFrame((frame) => {
        if (frame.t === "mcp") handler(frame.line);
      }),
  );
  await connection.call("mcp.open", { cwd: dataDir, env: {} });
  await initializeMcp(client);
  return { connection, client };
}

it("writes through the encrypted native MCP host and reconciles the original key after restart", async () => {
  const fixture = await nativeVaultFixture({ modules: ["budget", "investments"] });
  fixtures.push(fixture);
  const options = {
    dataDir: fixture.dataDir,
    home: fixture.home,
    vaultSource: fixture.vaultSource,
    build: "test",
    launcher: false,
  } as const;
  let host = await startLocalHost(options);
  let connected: Awaited<ReturnType<typeof clientFor>> | undefined;
  const key = "01K9B2W000000000000000000G";
  try {
    connected = await clientFor(fixture.dataDir, fixture.profileSlug);
    const response = await connected.client.call("tools/call", {
      name: "mark_review_done",
      arguments: { module: "investments", notes: "Synthetic review" },
      _meta: { "cashu/idempotencyKey": key },
    });
    const body = response.result as Record<string, unknown>;
    expect(body.isError).toBe(false);
    expect(body._meta).toEqual({ "cashu/writeOutcome": { kind: "completed", key } });
    expect(
      host.stores.vaults.get(fixture.vaultId)?.store.read("SELECT gid FROM reviews"),
    ).toHaveLength(1);
    const changed = await connected.client.call("tools/call", {
      name: "mark_review_done",
      arguments: { module: "investments", notes: "Different synthetic review" },
      _meta: { "cashu/idempotencyKey": key },
    });
    const changedBody = changed.result as Record<string, unknown>;
    expect(changedBody.isError).toBe(true);
    expect(changedBody._meta).toEqual({
      "cashu/writeOutcome": { kind: "outcome_unknown", key },
    });
    expect(
      host.stores.vaults.get(fixture.vaultId)?.store.read("SELECT gid FROM reviews"),
    ).toHaveLength(1);
    const status = await connected.client.call("tools/call", {
      name: "cashu_write_status",
      arguments: { key },
    });
    expect((status.result as Record<string, unknown>).structuredContent).toEqual({
      kind: "completed",
    });
    const absent = await connected.client.call("tools/call", {
      name: "cashu_write_status",
      arguments: { key: "01K9B2W000000000000000000H" },
    });
    expect((absent.result as Record<string, unknown>).structuredContent).toEqual({
      kind: "outcome_unknown",
    });
    expect(
      host.stores.vaults.get(fixture.vaultId)?.store.read("SELECT gid FROM reviews"),
    ).toHaveLength(1);
    connected.connection.close();
    connected = undefined;
    await host.stop();
    host = await startLocalHost(options);
    connected = await clientFor(fixture.dataDir, fixture.profileSlug);
    const afterRestart = await connected.client.call("tools/call", {
      name: "cashu_write_status",
      arguments: { key },
    });
    expect((afterRestart.result as Record<string, unknown>).structuredContent).toEqual({
      kind: "completed",
    });
    expect(
      host.stores.vaults.get(fixture.vaultId)?.store.read("SELECT gid FROM reviews"),
    ).toHaveLength(1);
  } finally {
    connected?.connection.close();
    await host.stop();
  }
});

it("advertises native budget setter and checked-file tools without a Python backend", async () => {
  const fixture = await nativeVaultFixture({ modules: ["budget", "investments"] });
  fixtures.push(fixture);
  const fileRoot = mkdtempSync(join(tmpdir(), "cashu-mcp-input-"));
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    vaultSource: fixture.vaultSource,
    build: "test",
    launcher: false,
  });
  let connected: Awaited<ReturnType<typeof clientFor>> | undefined;
  try {
    connected = await clientFor(fixture.dataDir, fixture.profileSlug);
    const result = await connected.client.call("tools/list", {});
    const tools = ((result.result as { tools: { name: string }[] }).tools ?? []).map(
      (tool) => tool.name,
    );
    expect(tools).toEqual(
      expect.arrayContaining([
        "set_merchant_category",
        "validate_budget_import",
        "inspect_export",
        "validate_import",
      ]),
    );
    const approved = join(fileRoot, "synthetic.csv");
    writeFileSync(approved, "date,amount,currency,title\n2026-11-01,-5,PLN,Coffee\n");
    for (const name of ["validate_budget_import", "inspect_export", "validate_import"]) {
      const response = await connected.client.call("tools/call", {
        name,
        arguments: { path: approved },
      });
      expect((response.result as { isError: boolean }).isError).toBe(false);
    }
    const blocked = join(fixture.dataDir, "blocked.csv");
    writeFileSync(blocked, "date,amount\n2026-11-01,-5\n");
    for (const name of ["validate_budget_import", "inspect_export", "validate_import"]) {
      const response = await connected.client.call("tools/call", {
        name,
        arguments: { path: blocked },
      });
      expect((response.result as { isError: boolean }).isError).toBe(true);
      expect(JSON.stringify(response.result)).not.toContain(blocked);
    }
  } finally {
    connected?.connection.close();
    await host.stop();
    rmSync(fileRoot, { recursive: true, force: true });
  }
});

it("publishes a checked import through the native MCP socket and records its pending proposal", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  fixtures.push(fixture);
  const fileRoot = mkdtempSync(join(tmpdir(), "cashu-mcp-import-"));
  let host: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  let connected: Awaited<ReturnType<typeof clientFor>> | undefined;
  try {
    host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      vaultSource: fixture.vaultSource,
      build: "test",
      launcher: false,
      mcpInvestmentAsync: (vaultId) => {
        const publication = host?.stores.vaults.get(vaultId)?.native?.blobPublication();
        return publication ? { vault: vaultId, imports: publication } : undefined;
      },
    });
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (!vault) throw new Error("missing native vault");
    const opened = await runCliVaultCommand(
      vault,
      investmentsCommands.addBrokerageAccount,
      { name: "Synthetic broker", broker: "dif" },
      cliCommandKey(),
    );
    if (opened.kind !== "completed") throw new Error("synthetic brokerage account refused");
    const file = join(fileRoot, "synthetic.csv");
    writeFileSync(
      file,
      "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source\n1,txn,2026-01-01,,deposit,D,,,,,,,PLN,,,,1000,PLN,,,generic_csv\n",
    );
    connected = await clientFor(fixture.dataDir, fixture.profileSlug);
    const listed = await connected.client.call("tools/list", {});
    expect(
      (listed.result as { tools: { name: string }[] }).tools.some(
        (tool) => tool.name === "propose_import",
      ),
    ).toBe(true);
    const key = cliCommandKey();
    const request = {
      name: "propose_import",
      arguments: {
        path: file,
        account: encodeEntityRef("account", opened.value.account),
        importer: "cashu",
      },
      _meta: { "cashu/idempotencyKey": key },
    };
    const response = await connected.client.call("tools/call", request);
    const result = response.result as {
      isError: boolean;
      structuredContent?: { proposal_id?: string };
      _meta?: { "cashu/writeOutcome"?: { kind: string; key: string } };
    };
    expect(result.isError, JSON.stringify(result)).toBe(false);
    expect(result._meta?.["cashu/writeOutcome"]).toEqual({ kind: "completed", key });
    const proposalGid = decodeEntityRef("proposal", result.structuredContent?.proposal_id ?? "");
    expect(vault.store.read("SELECT gid, kind, status FROM proposals")).toEqual([
      { gid: proposalGid, kind: "import", status: "pending" },
    ]);
    const retried = await connected.client.call("tools/call", request);
    const retryResult = retried.result as typeof result;
    expect(retryResult.isError, JSON.stringify(retryResult)).toBe(false);
    expect(retryResult._meta?.["cashu/writeOutcome"]).toEqual({ kind: "completed", key });
    expect(retryResult.structuredContent?.proposal_id).toBe(result.structuredContent?.proposal_id);
    expect(vault.store.read("SELECT gid, status FROM proposals")).toEqual([
      { gid: proposalGid, status: "pending" },
    ]);
  } finally {
    connected?.connection.close();
    await host?.stop();
    rmSync(fileRoot, { recursive: true, force: true });
  }
});
