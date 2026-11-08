// The `mcp` role: one native MCP server per session, for the one vault whose profile slug the
// client asked for. A tool is offered only when its authority is bound (a native host lists the
// tools it can serve from the store or from an injected authority); the running servers are
// tracked so a stopping host can flush them (handover) and close them.
import { existsSync } from "node:fs";
import type { McpOpenParams } from "@cashu/host-protocol";
import {
  budgetTools,
  connectorTools,
  coreTools,
  type InvestmentAsyncCapabilities,
  investmentImportAdapter,
  investmentSearchAdapter,
  investmentTools,
  investmentWatchAdapter,
  investmentWriteTools,
  loansTools,
  NativeMcpServer,
  researchTools,
} from "@cashu/mcp";
import type { HostSession, RunningHost } from "@cashu/node-host";
import { mcpProfile } from "@cashu/store/core";
import { mayObtainFetchAuthority, refreshFetchAuthority } from "../fetchAuthority.js";
import { appLanguage } from "../language.js";
import type { HostLog } from "../log.js";
import { nativeBackend } from "../mcp/backend.js";
import type { ConnectorProposalReceipts } from "../mcp/connectorReceipt.js";
import { connectorMcpPort } from "../mcp/connectors.js";
import { budgetFileReader, investmentFileReader } from "../mcp/files.js";
import { mcpFileHome, mcpNamedHome } from "../mcp/homes.js";
import { nativeMappingReader } from "../mcp/mapping.js";
import { nativeRuntime } from "../mcp/native.js";
import { type McpBackend, serveMcpSession } from "../mcp/session.js";
import { TOOL_INVENTORY } from "../mcp/tools.js";
import { type HostRuntime, shippedConnectorsSource } from "../runtime.js";
import type { HostStores, OpenVault } from "../stores.js";
import type { ExitReason } from "./lifecycle.js";
import type { MarketAuthorities } from "./market.js";
import type { LocalHostOptions } from "./options.js";

/** Native tools served from the vault store alone. */
const NATIVE_MCP_STORE_TOOLS = new Set([
  "setup_status",
  "mark_review_done",
  "spending_breakdown",
  "cashflow_summary",
  "recurring_payments",
  "uncategorized_merchants",
  "set_merchant_category",
  "loans_summary",
  "signals",
  "theses",
  "alerts",
  "add_alert",
  "mute_alert",
  "record_decision",
  "research_notes",
  "set_topic_market_view",
  "upsert_topic_thesis",
  "set_instrument_segment",
  "validate_budget_import",
  "inspect_export",
  "validate_import",
]);
/** Native tools that need the investment read authority. */
const NATIVE_MCP_INVESTMENT_READS = new Set([
  "portfolio_overview",
  "positions",
  "review_context",
  "strategy_status",
]);
/** Native tools that need the research authority. */
const NATIVE_MCP_RESEARCH = new Set([
  "research_context",
  "start_research_run",
  "add_research_note",
  "finish_research_run",
]);
/** Native tools that need the investment write authority. */
const NATIVE_MCP_INVESTMENT_WRITES = new Set([
  "set_recommendation",
  "set_recommendations",
  "upsert_thesis",
  "watchlist",
  "remove_from_watchlist",
  "add_to_watchlist",
  "propose_strategy",
  "propose_custom_rule",
]);
/**
 * Native tools whose authority is the fetch lease (market/mcpProduction.ts `isHolder`, the async
 * search and watch ports): a call refreshes stale lease pull evidence before it runs.
 */
const NATIVE_MCP_FETCH_LEASE = new Set([
  ...NATIVE_MCP_RESEARCH,
  ...NATIVE_MCP_INVESTMENT_WRITES,
  "search_instruments",
]);

interface McpDeps {
  readonly options: LocalHostOptions;
  readonly nativeMode: boolean;
  readonly server: RunningHost;
  readonly stores: HostStores;
  readonly runtime: HostRuntime;
  readonly market: MarketAuthorities;
  readonly connectorReceipts: ConnectorProposalReceipts | undefined;
  readonly bundleReplaced: () => boolean;
  readonly now: () => number;
  readonly log: HostLog;
}

export function createMcpSessions(deps: McpDeps) {
  const servers = new Set<McpBackend>();
  return {
    serve(session: HostSession) {
      serveMcpSession(session, {
        log: deps.log,
        start: (profile, open) => startMcpBackend(deps, profile, open),
        track: (backend) => {
          servers.add(backend);
          return () => servers.delete(backend);
        },
      });
    },
    /** Flushes queued work on a handover, then closes every running server. */
    async stop(reason: ExitReason) {
      if (reason === "handover") await Promise.all([...servers].map((b) => b.prepareHandover?.()));
      await Promise.all([...servers].map((b) => b.close()));
    },
  };
}

/** The native server for `profile`'s vault; undefined when there is no single current vault. */
function startMcpBackend(
  deps: McpDeps,
  profile: string,
  open: McpOpenParams,
): McpBackend | undefined {
  const { options, nativeMode, server, stores, runtime, market, bundleReplaced, now, log } = deps;
  const matchingVaults = [...stores.vaults.values()].filter(
    (v) => mcpProfile(v.store.read.bind(v.store))?.slug === profile,
  );
  if (matchingVaults.length > 1) {
    log.warn("mcp.profile.ambiguous");
    return undefined;
  }
  const vault = matchingVaults[0];
  if (nativeMode && (vault?.native === undefined || !vault.native.isCurrent())) return undefined;
  if (vault === undefined) return undefined;
  const fileScope = {
    cwd: existsSync(open.cwd) ? open.cwd : server.paths.dataDir,
    home: mcpFileHome(runtime.env),
    namedHome: (name: string) => mcpNamedHome(name, runtime.env),
    dataDir: server.paths.dataDir,
  };
  const fileReader = budgetFileReader(fileScope);
  const readInvestmentFile = investmentFileReader(fileScope);
  const readInvestmentMapping = nativeMappingReader({
    workspace: options.workspace,
    stores,
    vault,
    replaced: bundleReplaced,
    fileScope,
  });
  const catalog = nativeMode ? options.connectorCatalog?.() : undefined;
  const connectorPort =
    nativeMode && catalog && deps.connectorReceipts
      ? connectorMcpPort({
          catalog,
          vault,
          device: stores.device,
          receipts: deps.connectorReceipts,
          shippedCatalog: shippedConnectorsSource(runtime),
          workspace: options.workspace,
          now,
          isCurrent: () =>
            !bundleReplaced() &&
            stores.vaults.get(vault.id) === vault &&
            vault.native?.isCurrent() === true &&
            options.connectorCatalog?.() === catalog,
        })
      : undefined;
  const { tools, investmentAsync } = selectTools({
    nativeMode,
    vault,
    market,
    connectors: connectorPort !== undefined,
    workspace: options.workspace !== undefined,
  });
  const inventory = TOOL_INVENTORY.filter((entry) =>
    tools.some((tool) => tool.name === entry.name),
  );
  const native = new NativeMcpServer(
    nativeRuntime({
      stores,
      vault,
      dataDir: server.paths.dataDir,
      now,
      replaced: bundleReplaced,
      log,
      inventory,
      prices: market.prices,
      marketData: market.marketData,
      fxNewest: market.fxNewest,
      readBudgetImportFile: fileReader,
      investmentReads: market.investmentReads,
      investmentHistory: market.investmentHistory,
      research: market.research,
      investmentWrites: market.investmentWrites,
      investmentAsync,
      connectors: connectorPort,
      readInvestmentImportFile: readInvestmentFile,
      readInvestmentMappingFile: readInvestmentMapping,
    }),
    tools,
    [
      ...(tools.some((tool) => tool.name === "search_instruments")
        ? [investmentSearchAdapter]
        : []),
      ...(tools.some((tool) => tool.name === "add_to_watchlist") ? [investmentWatchAdapter] : []),
      ...(tools.some((tool) => tool.name === "propose_import") ? [investmentImportAdapter] : []),
    ],
  );
  return nativeBackend({
    native,
    inventory,
    profile,
    language: () => appLanguage(stores),
    // Only the tools that act as the fetch leader refresh the lease pull first: a pure read needs
    // no lease, and public reads pause while a pass runs.
    beforeCall: (name) =>
      nativeMode && NATIVE_MCP_FETCH_LEASE.has(name) ? refreshFetchAuthority(vault) : undefined,
  });
}

/** The tools this session offers, and the vault's async investment capabilities. */
function selectTools(input: {
  readonly nativeMode: boolean;
  readonly vault: OpenVault;
  readonly market: MarketAuthorities;
  readonly connectors: boolean;
  readonly workspace: boolean;
}) {
  const { vault, market } = input;
  const tools = coreTools().filter((tool) =>
    tool.name === "profile_overview"
      ? market.prices !== null && market.fxNewest !== undefined
      : tool.name !== "networth_breakdown" || market.prices !== null,
  );
  tools.push(...budgetTools());
  tools.push(...loansTools());
  tools.push(
    ...investmentTools().filter((tool) =>
      tool.name === "inspect_export" || tool.name === "validate_import"
        ? true
        : tool.name === "signals" ||
          tool.name === "theses" ||
          (tool.name === "history_metrics"
            ? market.investmentHistory !== undefined
            : market.investmentReads !== undefined),
    ),
  );
  tools.push(
    ...researchTools().filter((tool) =>
      tool.name === "research_context" ? market.research !== undefined : true,
    ),
  );
  tools.push(
    ...investmentWriteTools().filter(
      (tool) => tool.name !== "watchlist" || market.investmentWrites !== undefined,
    ),
  );
  const investmentAsync = market.investmentAsync?.(vault.id);
  if (input.nativeMode) {
    const enabled = nativeToolEnabled(vault, market, investmentAsync);
    tools.splice(0, tools.length, ...tools.filter((tool) => enabled(tool.name)));
  }
  if (input.connectors)
    tools.push(
      ...connectorTools().filter((tool) => tool.name !== "test_connector" || input.workspace),
    );
  return { tools, investmentAsync };
}

/** Whether a native host can serve `name` for `vault` with the authorities it has. */
function nativeToolEnabled(
  vault: OpenVault,
  market: MarketAuthorities,
  investmentAsync: InvestmentAsyncCapabilities | undefined,
) {
  const asyncCurrent = (capability: { vault: string; isCurrent(): boolean } | undefined) =>
    investmentAsync?.vault === vault.id && capability?.vault === vault.id && capability.isCurrent();
  // Public search and watch need the fetch lease; a leader whose pull is only stale still lists
  // them, and each call obtains the pull first (mcp/native.ts).
  const fetchCurrent = (capability: { vault: string; isCurrent(): boolean } | undefined) =>
    investmentAsync?.vault === vault.id &&
    capability?.vault === vault.id &&
    (capability.isCurrent() || mayObtainFetchAuthority(vault));
  return (name: string): boolean => {
    if (NATIVE_MCP_STORE_TOOLS.has(name)) return true;
    if (name === "profile_overview") return market.prices !== null && market.fxNewest !== undefined;
    if (name === "networth_breakdown") return market.prices !== null;
    if (NATIVE_MCP_INVESTMENT_READS.has(name)) return market.investmentReads !== undefined;
    if (name === "history_metrics") return market.investmentHistory !== undefined;
    if (NATIVE_MCP_RESEARCH.has(name)) return market.research !== undefined;
    if (name === "propose_import") return asyncCurrent(investmentAsync?.imports);
    if (NATIVE_MCP_INVESTMENT_WRITES.has(name)) {
      if (market.investmentWrites === undefined) return false;
      if (name === "add_to_watchlist") return fetchCurrent(investmentAsync?.watch);
      return true;
    }
    if (name === "search_instruments") return fetchCurrent(investmentAsync?.search);
    return false;
  };
}
