import { connectHost } from "@cashu/node-host";
import { afterEach, expect, it } from "vitest";
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
    python: null,
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
