// What `startLocalHost` (host.ts) takes: the production entry (main.ts) binds the native authorities,
// test harnesses inject synthetic ones. Every capability is explicit; an absent one is unavailable.
import type { market } from "@cashu/domain/investments";
import type {
  InvestmentAsyncCapabilities,
  InvestmentHistoryReads,
  InvestmentReads,
  InvestmentWriteServices,
  NativeToolStore,
  ResearchServices,
  ToolContext,
} from "@cashu/mcp";
import type { HostLock, HostPathEnv } from "@cashu/node-host";
import type { ClassifierSettingsSource } from "@cashu/store/core/classifier-settings";
import type { NotificationQueue } from "@cashu/store/investments/local";
import type { ResearchScreenSources } from "@cashu/store/investments/research-screen";
import type { ReviewScreenSources } from "@cashu/store/investments/review-screen";
import type { InvestmentScreenSources } from "@cashu/store/investments/screen";
import type { BankingRuntime } from "../banking/runtime.js";
import type {
  CategorizeProvider,
  CloudCategorizeProvider,
} from "../cli/budget/categorizeOllama.js";
import type { PortedCommand } from "../cli/tree.js";
import type { ConnectorCatalog } from "../connectors/catalog.js";
import type { currentStrategyImages } from "../investmentScreenSources.js";
import type { HostLog } from "../log.js";
import type { ProductionMarket } from "../market/production.js";
import type { NativeVaultSource } from "../nativeVault.js";
import type { HostNotificationCapability } from "../notificationCapability.js";
import type { ProductionVaultSourceFactory } from "../productionVaultSource.js";
import type { ProposalApprovalProvider } from "../proposalsScreen.js";
import type { servedQueries } from "../registry.js";
import type { HostRuntime } from "../runtime.js";
import type { SignalsMarketPorts } from "../signalsScreen.js";
import type { StoreChannelOptions } from "../storeChannel.js";
import type { HostStores, OpenVault } from "../stores.js";
import type { StrategyScreenCapability } from "../strategiesScreen.js";
import type { UpdateProvider } from "../updateScreen.js";
import type { WorkerBindings, WorkerHostContext } from "../worker/contracts.js";
import type { WorkspaceProvider } from "../workspace/index.js";

/** Local LAN serving: off, loopback (tests, port 0 by default) or one private IPv4 (8517 by default). */
type LanOption =
  | { readonly kind: "off" }
  | { readonly kind: "loopback" | "local"; readonly port?: number };

/** Where the host's vaults come from. */
type VaultSourceOption =
  /** An isolated test harness (synthetic stores, refuses the real cashU locations). */
  | { readonly kind: "synthetic-harness" }
  /** An injected exact-vault native authority. */
  | { readonly kind: "native"; readonly provider: NativeVaultSource }
  /** The production authority: opened after the creation journal says the inventory is ready. */
  | { readonly kind: "native-production"; readonly factory: ProductionVaultSourceFactory };

/** A per-vault capability; null when that vault has none. */
export interface VaultBinder<T> {
  bind(vault: string): T | null;
}

type MarketFactory = (
  stores: HostStores,
  isCurrent: (vault: OpenVault) => boolean,
  now: () => number,
) => ProductionMarket;

type WorkerFactory = (
  context: WorkerHostContext,
  notifications?: HostNotificationCapability,
  queue?: NotificationQueue,
  lock?: HostLock,
) => WorkerBindings | undefined;

/** One MCP tool authority, resolved per tool call for its vault. */
type McpAuthority<T> = (context: ToolContext<NativeToolStore>) => T;

export interface LocalHostOptions {
  /** Explicit local LAN serving. Tests use loopback and port 0; production binds one private IPv4. */
  readonly lan?: LanOption;
  /** Explicit isolated test harness or an injected exact-vault native authority. */
  readonly vaultSource?: VaultSourceOption;
  /** Checked S60 preparation authority, bound to the exact open vault. Absent by default. */
  readonly proposals?: ProposalApprovalProvider;
  /** Owner approval of strategy and custom-rule proposals (production: the native strategy files). */
  readonly strategyProposals?: ProposalApprovalProvider;
  readonly connectorCatalog?: () => ConnectorCatalog | undefined;
  readonly banking?: () => BankingRuntime | undefined;
  /** Exact-vault checked workspace provider. Unbound means unavailable, never absent. */
  readonly workspace?: WorkspaceProvider;
  /** Verified packaged updater, absent in unbound native builds. */
  readonly updates?: UpdateProvider;
  readonly strategies?: VaultBinder<StrategyScreenCapability>;
  readonly strategyImages?: ReturnType<typeof currentStrategyImages>;
  readonly investments?: InvestmentScreenSources;
  readonly marketFactory?: MarketFactory;
  /** Optional public-market ports (online instrument search); local Signals actions need none. The
   * binder returns the same object while a vault's ports stay current. */
  readonly signals?: VaultBinder<SignalsMarketPorts>;
  readonly research?: ResearchScreenSources;
  readonly review?: ReviewScreenSources;
  readonly mcpInvestmentAsync?: (vault: string) => InvestmentAsyncCapabilities | undefined;
  readonly uiActions?: StoreChannelOptions["actions"];
  readonly prepareUiQuery?: StoreChannelOptions["prepareQuery"];
  readonly privateUiQuery?: StoreChannelOptions["privateQuery"];
  /** Explicit per-vault capabilities only. Production authority/consent/credential binding is separate. */
  readonly budgetClassifiers?: {
    readonly local?: CategorizeProvider;
    readonly cloud?: CloudCategorizeProvider;
  };
  /** The live classifier settings Settings shows (production: the classifier binding's checked state). */
  readonly classifierSettings?: ClassifierSettingsSource;
  /** Injected only after genuine per-job ownership and per-vault authority are available. */
  readonly worker?: WorkerFactory;
  /** Injected overview sources (tests, the synthetic harness). Production prices come from the
   * market runtime's persistent SqlPriceCache (`marketFactory`); without a cache, overview uses last
   * trades. */
  readonly overview?: Parameters<typeof servedQueries>[0];
  readonly dataDir: string;
  readonly build?: string;
  /** How long an idle host (no session, nothing queued) stays before it exits 0. */
  readonly lingerMs?: number;
  /** Verified .app bundle path; its replacement triggers a handover (exit 75). */
  readonly bundlePath?: string;
  readonly bundleCheckMs?: number;
  readonly pathEnv?: HostPathEnv;
  /** Defaults to `<data dir>/logs/host.log`. */
  readonly log?: HostLog;
  readonly now?: () => number;
  /** The home whose real cashU locations the synthetic store source refuses (tests: a temp dir). */
  readonly home?: string;
  readonly maxInFlight?: number;
  /** Fault tests only: runs after a command committed, before its reply. */
  readonly afterCommit?: () => void;
  /** Where this host runs from (default: this process); picks the shim and the Python CLI. */
  readonly runtime?: HostRuntime;
  /** The commands run in the host (default: `portedCommands()`). */
  readonly ported?: readonly PortedCommand[];
  /** Write `<data dir>/bin/cashu` at start (default true). */
  readonly launcher?: boolean;
  /** Device cache dependency, also used by synthetic oracle fixtures. */
  readonly mcpPrices?: market.PriceCache;
  readonly mcpFxNewest?: () => string | null;
  /** Explicit coherent read authorities; native investment views are unavailable without them. */
  readonly mcpInvestmentReads?: McpAuthority<InvestmentReads>;
  readonly mcpInvestmentHistory?: McpAuthority<InvestmentHistoryReads>;
  /** Explicit vault-scoped strategy, portfolio and plan authority for native research tools. */
  readonly mcpResearch?: McpAuthority<ResearchServices>;
  /** Explicit per-call vault/plan/file authority for optional investment write services. */
  readonly mcpInvestmentWrites?: McpAuthority<InvestmentWriteServices>;
}
