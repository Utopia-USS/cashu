import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectHost } from "@cashu/node-host";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import { initializeMcp, mcpClient } from "../testing/mcp.js";
import { type NativeVaultFixture, nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import { createProductionMarket, type ProductionMarket } from "./production.js";

const fixtures: NativeVaultFixture[] = [];
const YAML = "version: 1\nbase_currency: PLN\ndata: {max_stale_weight: 1}\n";
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

it("registers native public search and import publication through actual host startup", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  fixtures.push(fixture);
  chmodSync(join(fixture.dataDir, "vaults"), 0o700);
  chmodSync(join(fixture.dataDir, "vaults", fixture.vaultId), 0o700);
  let market: ProductionMarket | undefined;
  let requests = 0;
  let changeStrategyAfterPrepare: "file" | "version" | null = null;
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    vaultSource: fixture.vaultSource,
    build: "test",
    launcher: false,
    marketFactory: (stores, isCurrent, now) => {
      market = createProductionMarket({
        stores,
        isCurrent,
        now,
        language: () => "pl",
        fetch: async (url) => {
          requests++;
          expect(url).toContain("/v1/finance/search");
          return {
            status: 200,
            headers: { get: () => null },
            text: async () =>
              JSON.stringify({
                quotes: [
                  {
                    symbol: "TEST.WA",
                    shortname: "Synthetic Public",
                    quoteType: "EQUITY",
                    exchange: "WSE",
                  },
                ],
              }),
          };
        },
      });
      return {
        ...market,
        mcpInvestmentWrites(context) {
          const service = market?.mcpInvestmentWrites?.(context);
          if (!service) throw new Error("native investment writes unavailable");
          if (changeStrategyAfterPrepare === "file") {
            changeStrategyAfterPrepare = null;
            writeFileSync(
              join(fixture.dataDir, "vaults", fixture.vaultId, "strategy", "strategy.yaml"),
              YAML,
              { mode: 0o600 },
            );
          } else if (changeStrategyAfterPrepare === "version") {
            changeStrategyAfterPrepare = null;
            const profileId = context.store.read<{ id: number }>("SELECT id FROM profiles")[0]?.id;
            const vault = stores.vaults.get(fixture.vaultId);
            if (profileId === undefined || !vault) throw new Error("synthetic view unavailable");
            vault.driver
              .prepare(`INSERT INTO inv_strategy_versions
              (profile_id,version,sha256,yaml_text,md_text,state,issues,created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
              .run(
                profileId,
                1,
                "synthetic-version",
                YAML,
                null,
                "valid",
                "[]",
                new Date().toISOString(),
              );
          }
          return service;
        },
      };
    },
  });
  let connection: Awaited<ReturnType<typeof connectHost>> | undefined;
  try {
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (vault?.mode !== "native" || !market) throw new Error("native market was not bound");
    // Before any pull the leader holds no fetch authority. Nothing below syncs by hand: each MCP
    // call and each public request obtains the pull evidence itself.
    expect(() => market?.sources([fixture.vaultId])).toThrow("market_fetch_authority_unavailable");
    connection = await connectHost({
      dataDir: fixture.dataDir,
      role: "mcp",
      profile: fixture.profileSlug,
      build: "test",
    });
    const channel = connection;
    const client = mcpClient(
      (line) => channel.send({ t: "mcp", line }),
      (callback) =>
        channel.onFrame((frame) => {
          if (frame.t === "mcp") callback(frame.line);
        }),
    );
    await connection.call("mcp.open", { cwd: fixture.dataDir, env: {} });
    await initializeMcp(client);
    const listed = await client.call("tools/list");
    const names = (listed.result as { tools: readonly { name: string }[] }).tools.map(
      (tool) => tool.name,
    );
    expect(names).toContain("search_instruments");
    expect(names).toContain("propose_import");
    expect(names).toContain("research_context");
    expect(names).toContain("watchlist");
    expect(names).toContain("propose_strategy");
    expect(names).toContain("propose_custom_rule");
    for (const name of [
      "portfolio_overview",
      "positions",
      "review_context",
      "strategy_status",
      "history_metrics",
    ])
      expect(names).toContain(name);
    for (const name of [
      "portfolio_overview",
      "positions",
      "review_context",
      "strategy_status",
      "history_metrics",
    ]) {
      const answer = await client.call("tools/call", { name, arguments: {} });
      expect(
        (answer.result as { isError: boolean }).isError,
        `${name}: ${JSON.stringify(answer.result)}`,
      ).toBe(false);
    }
    const searched = await client.call("tools/call", {
      name: "search_instruments",
      arguments: { query: "synthetic" },
    });
    expect((searched.result as { isError: boolean }).isError).toBe(false);
    expect(requests).toBe(1);
    expect(vault.native.canFetchPublicMarket()).toBe(true);
    expect(market.sources([fixture.vaultId]).priceSource).toBeDefined();
    const research = await client.call("tools/call", {
      name: "research_context",
      arguments: {},
    });
    expect((research.result as { isError: boolean }).isError).toBe(false);
    const watchlist = await client.call("tools/call", {
      name: "watchlist",
      arguments: {},
    });
    expect((watchlist.result as { isError: boolean }).isError).toBe(false);
    const started = await client.call("tools/call", {
      name: "start_research_run",
      arguments: {},
    });
    expect((started.result as { isError: boolean }).isError).toBe(false);
    const proposed = await client.call("tools/call", {
      name: "propose_strategy",
      arguments: { yaml: YAML },
    });
    const proposal = proposed.result as {
      isError: boolean;
      structuredContent?: { stored?: boolean; proposal_id?: string };
    };
    expect(proposal.isError, JSON.stringify(proposed.result)).toBe(false);
    expect(proposal.structuredContent?.stored).toBe(true);
    expect(proposal.structuredContent?.proposal_id).toBeTruthy();
    const before = vault.store.read<{ gid: string }>("SELECT gid FROM proposals").length;
    changeStrategyAfterPrepare = "file";
    const stale = await client.call("tools/call", {
      name: "propose_strategy",
      arguments: { yaml: YAML },
    });
    expect((stale.result as { isError: boolean }).isError).toBe(true);
    expect(vault.store.read<{ gid: string }>("SELECT gid FROM proposals")).toHaveLength(before);
    changeStrategyAfterPrepare = "version";
    const versionChanged = await client.call("tools/call", {
      name: "propose_strategy",
      arguments: { yaml: YAML },
    });
    expect((versionChanged.result as { isError: boolean }).isError).toBe(true);
    expect(vault.store.read<{ gid: string }>("SELECT gid FROM proposals")).toHaveLength(before);
  } finally {
    connection?.close();
    await host.stop();
  }
});
