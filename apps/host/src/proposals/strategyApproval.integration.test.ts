// Owner approval of agent strategy and custom-rule proposals on a native vault, through the same
// `core.desktopProposals.review` action and provider the production host wires (main.ts). The custom
// rule comes from the real MCP `propose_custom_rule` with a fractional parameter: event data holds no
// floats (events.md 4.3), so it travels as decimal text and must reach strategy.yaml as `0.5`.
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { strategyDigest } from "@cashu/domain/investments/strategy";
import { connectHost } from "@cashu/node-host";
import { mintUlid } from "@cashu/store";
import { createInvestmentProposal, DailyPriceLock } from "@cashu/store/investments/services";
import { expect, it } from "vitest";
import { runHostVaultCommand } from "../commands.js";
import { startLocalHost } from "../host.js";
import { createProductionMarket } from "../market/production.js";
import { storeClient } from "../testing/harness.js";
import { initializeMcp, mcpClient } from "../testing/mcp.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import { nativeStrategyApprovals } from "./strategyApproval.js";
import { strategyPublicationPorts } from "./strategyFiles.js";

it("approves strategy and custom-rule proposals into the native strategy files", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  chmodSync(join(fixture.dataDir, "vaults"), 0o700);
  chmodSync(join(fixture.dataDir, "vaults", fixture.vaultId), 0o700);
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
    strategyProposals: nativeStrategyApprovals({ dailyLock: new DailyPriceLock() }),
    // The MCP investment writes need the native market context; nothing here fetches.
    marketFactory: (stores, isCurrent, now) =>
      createProductionMarket({
        stores,
        isCurrent,
        now,
        language: () => "en",
        fetch: async () => {
          throw new Error("no network in this test");
        },
      }),
  });
  const client = await storeClient(fixture.dataDir);
  let connection: Awaited<ReturnType<typeof connectHost>> | undefined;
  try {
    const vault = host.stores.vaults.get(fixture.vaultId);
    const authority = vault?.native?.strategyDirectoryAuthority();
    if (vault === undefined || !authority) throw new Error("native strategy authority absent");
    // The owner's template strategy (Strategie "Z szablonu").
    const refreshed = await client.action("investments.strategies.refresh", {}, fixture.vaultId);
    const revision = (refreshed as { value?: { revision?: string } }).value?.revision;
    if (revision === undefined) throw new Error("strategy revision absent");
    expect(
      await client.action("investments.strategies.init", { revision }, fixture.vaultId),
    ).toMatchObject({ status: "completed" });
    const files = strategyPublicationPorts(authority).files;
    const directory = join(fixture.dataDir, "vaults", fixture.vaultId, "strategy");
    const onDisk = () => readFileSync(join(directory, "strategy.yaml"), "utf8");

    /** What MCP propose_strategy / propose_custom_rule store, then the owner's approve click. */
    const propose = async (
      kind: "strategy" | "custom_rule",
      payload: (base: ReturnType<typeof files.readSync>) => Record<string, unknown>,
    ) => {
      const base = files.readSync();
      const created = await runHostVaultCommand(
        vault,
        createInvestmentProposal({ ...files, read: files.readSync }, base),
        {
          kind,
          summary: `Synthetic ${kind}`,
          summaryParams: {},
          reason: null,
          payload: { ...payload(base), base_sha256: strategyDigest(base.yaml ?? "", base.md) },
        },
        mintUlid(Date.now()),
      );
      if (created.kind !== "completed") throw new Error(`proposal not created: ${created.kind}`);
      const gid = (created.value as { proposalGid: string }).proposalGid;
      return client.action(
        "core.desktopProposals.review",
        { gid, decision: "approve" },
        fixture.vaultId,
      );
    };

    const before = onDisk();
    const yaml = `${before}\n# synthetic owner-approved revision\n`;
    expect(await propose("strategy", (base) => ({ yaml, md: base.md }))).toMatchObject({
      status: "completed",
      value: { status: "approved" },
    });
    expect(onDisk()).toBe(yaml);

    // The agent's MCP call, as Claude would make it (it obtains its own pull evidence).
    connection = await connectHost({
      dataDir: fixture.dataDir,
      role: "mcp",
      profile: fixture.profileSlug,
      build: "test",
    });
    const channel = connection;
    const mcp = mcpClient(
      (line) => channel.send({ t: "mcp", line }),
      (callback) =>
        channel.onFrame((frame) => {
          if (frame.t === "mcp") callback(frame.line);
        }),
    );
    await connection.call("mcp.open", { cwd: fixture.dataDir, env: {} });
    await initializeMcp(mcp);
    const answer = await mcp.call("tools/call", {
      name: "propose_custom_rule",
      arguments: {
        kind_or_expression: "cash_level",
        params: { id: "agent_cash_half", max_weight: 0.5 },
        reason: "synthetic fractional parameter",
      },
    });
    const proposed = answer.result as {
      isError: boolean;
      structuredContent?: { stored?: boolean };
    };
    expect(proposed.isError, JSON.stringify(answer.result)).toBe(false);
    expect(proposed.structuredContent?.stored).toBe(true);
    const [row] = vault.store.read<{ gid: string; payload: string }>(
      "SELECT gid, payload FROM proposals WHERE kind = 'custom_rule' AND status = 'pending'",
    );
    if (row === undefined) throw new Error("custom-rule proposal not stored");
    // The view keeps the JSON number the agent sent.
    expect(JSON.parse(row.payload)).toMatchObject({
      rule: { id: "agent_cash_half", kind: "cash_level", params: { max_weight: 0.5 } },
    });
    expect(
      await client.action(
        "core.desktopProposals.review",
        { gid: row.gid, decision: "approve" },
        fixture.vaultId,
      ),
    ).toMatchObject({ status: "completed", value: { status: "approved" } });
    expect(onDisk()).toMatch(
      /- id: agent_cash_half\n\s+kind: cash_level\n\s+params:\n\s+max_weight: 0\.5\n/,
    );
  } finally {
    connection?.close();
    client.close();
    await host.stop();
    fixture.cleanup();
  }
});
