/** Actual socket dispatch with native fact providers, checked files and no Python backend. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDateTime } from "@cashu/domain";
import { asProfileId, market, performance as perf, toCurrency } from "@cashu/domain/investments";
import { investmentReads, type NativeToolStore, type ToolContext } from "@cashu/mcp";
import { connectHost } from "@cashu/node-host";
import {
  investmentsCommands,
  investmentsPerformance,
  investmentsServices,
  investmentsViews,
  runCommand,
  setModules,
} from "@cashu/store";
import { afterEach, expect, it, vi } from "vitest";
import { startLocalHost } from "../host.js";
import { currentRuntime } from "../runtime.js";
import type { OpenVault } from "../stores.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import { initializeMcp, mcpClient } from "../testing/mcp.js";
import * as pythonMcp from "./python.js";

const INVESTMENT_TOOLS = [
  "portfolio_overview",
  "positions",
  "signals",
  "review_context",
  "strategy_status",
  "theses",
  "validate_import",
  "inspect_export",
  "history_metrics",
];
type Json = Record<string, unknown>;
afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());
it.each([false, true])(
  "dispatches available native investment tools with coherent authority: %s",
  async (authority) => {
    const spy = vi.spyOn(pythonMcp, "startPythonMcp");
    const dataDir = tempDir(),
      cwd = tempDir(),
      prices = new market.InMemoryPriceCache();
    const performance = new investmentsPerformance.PerformanceService();
    let now = Date.parse("2026-11-01T12:00:00Z");
    let vault: OpenVault | undefined;
    let strategy: investmentsServices.StrategyState | undefined;
    const contexts: string[] = [];
    const currentVault = () => {
      if (vault === undefined || strategy === undefined) throw new Error("fixture not initialized");
      return { vault, strategy };
    };
    const request = (ctx: ToolContext<NativeToolStore>) => {
      const bound = currentVault();
      contexts.push(ctx.today);
      return {
        vault: asProfileId(bound.vault.id),
        asOf: ctx.today,
        clock: {
          today: ctx.today,
          now: parseDateTime(new Date(ctx.store.now()).toISOString()),
          timeZone: "UTC",
        },
        strategy: bound.strategy,
        lang: "pl" as const,
        forOwner: false,
        prices,
        newestRateDate: null,
      };
    };
    const host = await startLocalHost({
      ...testHostOptions(dataDir),
      now: () => now,
      launcher: false,
      python: null,
      runtime: { ...currentRuntime(), checkout: undefined },
      ...(authority
        ? {
            mcpPrices: prices,
            mcpLegacyDataDir: join(tempDir(), "legacy"),
            mcpInvestmentReads: (ctx: ToolContext<NativeToolStore>) => {
              const portfolio = request(ctx);
              return investmentReads(ctx, {
                portfolio,
                review: {
                  clock: investmentsViews.makeReviewClock(portfolio.clock),
                  lang: "pl",
                  config: portfolio.strategy.config,
                  calendar: null,
                },
                strategy: {
                  state: portfolio.strategy,
                  profileBase: toCurrency("PLN"),
                  lang: "pl",
                  files: {
                    yaml: "synthetic.yaml",
                    md: "synthetic.md",
                    yamlExists: false,
                    mdExists: false,
                  },
                },
              });
            },
            mcpInvestmentHistory: (ctx: ToolContext<NativeToolStore>) => {
              const portfolio = request(ctx),
                bound = currentVault();
              return {
                portfolio: (asOf: string) => {
                  const result = investmentsViews.portfolioAt(
                    bound.vault.store.read.bind(bound.vault.store),
                    { ...portfolio, asOf },
                  );
                  if (!result.ok) throw new Error("invalid synthetic history context");
                  return result.value;
                },
                performance: () =>
                  performance.historyMetrics(bound.vault.store, {
                    asOf: ctx.today,
                    prices,
                    strategy: {
                      state: "missing",
                      benchmark: null,
                      policy: perf.DEFAULT_VALUATION_POLICY,
                      strategy: null,
                    },
                  }),
              };
            },
          }
        : {}),
    });
    let conn: Awaited<ReturnType<typeof connectHost>> | undefined;
    try {
      vault = [...host.stores.vaults.values()][0];
      if (vault === undefined) throw new Error("fixture vault missing");
      const bound = vault;
      await bound.queue.run(() => {
        const enabled = runCommand(
          bound.store,
          bound.writer,
          setModules,
          { moduleIds: ["investments"] },
          bound.env,
        );
        if (!enabled.ok) throw new Error(enabled.reason);
        const account = runCommand(
          bound.store,
          bound.writer,
          investmentsCommands.addBrokerageAccount,
          { name: "Synthetic account", broker: "dif" },
          bound.env,
        );
        if (!account.ok) throw new Error(account.reason);
        const transaction = runCommand(
          bound.store,
          bound.writer,
          investmentsCommands.addManualTransaction,
          {
            account: account.value.account,
            type: "deposit",
            tradeDate: "2026-11-01",
            cashAmount: "50",
            currency: "PLN",
          },
          bound.env,
        );
        if (!transaction.ok) throw new Error(transaction.reason);
      });
      strategy = await investmentsServices.loadStrategy(bound.store, {
        read: async () => null,
        write: async () => {},
        exists: async () => false,
      });
      writeFileSync(
        join(cwd, "export.csv"),
        "format_version,record,date,type,currency,cash_amount\n1,txn,2026-11-01,deposit,PLN,50\n",
      );
      writeFileSync(join(cwd, ".private.csv"), "synthetic private file");
      conn = await connectHost({ dataDir, role: "mcp", profile: "demo", build: "test" });
      const connection = conn;
      const client = mcpClient(
        (line) => connection.send({ t: "mcp", line }),
        (cb) =>
          connection.onFrame((frame) => {
            if (frame.t === "mcp") cb(frame.line);
          }),
      );
      await conn.call("mcp.open", { cwd, env: {} });
      await initializeMcp(client);
      const list = (await client.call("tools/list")).result as Json;
      const listed = (list.tools as { name: string }[]).map((tool) => tool.name);
      const available = authority ? INVESTMENT_TOOLS : ["signals", "theses"];
      expect(listed.filter((name) => INVESTMENT_TOOLS.includes(name)).sort()).toEqual(
        [...available].sort(),
      );
      const call = async (name: string, args: Json = {}) => {
        const response = await client.call("tools/call", { name, arguments: args });
        const result = response.result as { isError?: boolean; structuredContent?: Json };
        expect(result.isError, name).not.toBe(true);
        if (result.structuredContent === undefined) throw new Error("missing native content");
        return result.structuredContent;
      };
      for (const name of available) {
        const data = await call(
          name,
          ["inspect_export", "validate_import"].includes(name) ? { path: "export.csv" } : {},
        );
        if (name === "history_metrics")
          expect(data.performance).toMatchObject({ as_of: "2026-11-01", base_currency: "PLN" });
        if (name === "validate_import") expect(data).toMatchObject({ ok: true, transactions: 1 });
        if (name === "inspect_export") {
          expect(data.file).toMatchObject({ extension: "csv" });
          expect(JSON.stringify(data)).not.toContain('"50"');
        }
      }
      if (authority) {
        const refused = await client.call("tools/call", {
          name: "inspect_export",
          arguments: { path: ".private.csv" },
        });
        expect((refused.result as Json).isError).toBe(true);
        now += 86_400_000;
        expect(await call("positions")).toMatchObject({ as_of: "2026-11-02" });
        expect((await call("history_metrics")).performance).toMatchObject({ as_of: "2026-11-02" });
        expect(contexts).toContain("2026-11-02");
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      conn?.close();
      await host.stop();
    }
  },
);
