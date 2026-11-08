import { parseDateTime } from "@cashu/domain";
import { performance as perf } from "@cashu/domain/investments";
import type { InvestmentSearchIo } from "@cashu/mcp";
import { enabledModuleIds, mcpProfile } from "@cashu/store/core";
import type { PerformanceService } from "@cashu/store/investments/performance";
import type { InvestmentScreenSources } from "@cashu/store/investments/screen";
import type { CurrentStrategySnapshot } from "@cashu/store/investments/screen-sources";
import type {
  StrategyFileSyncPorts,
  StrategyFilesPort,
  StrategyState,
} from "@cashu/store/investments/services";
import type { MarketInput } from "@cashu/store/investments/views";
import type { HostStores, OpenVault } from "../../stores.js";
import type { HostWorker } from "../../worker/service.js";
import { localDate } from "../budget/context.js";
import { S } from "../strings.js";
import type { CommandIo } from "../tree.js";

export interface InvestmentCliDeps {
  readonly stores: Pick<HostStores, "vaults">;
  readonly now: () => number;
  readonly sources: InvestmentScreenSources;
  readonly performance: PerformanceService;
  readonly strategyFiles?: (vault: OpenVault, slug: string) => StrategyCliFiles | null;
  /**
   * The vault's current strategy read straight through its file authority (a native host), so a
   * report needs no strategy image published by a UI session. Absent: `sources.strategy`.
   */
  readonly currentStrategy?: (vault: OpenVault) => CurrentStrategySnapshot;
  readonly worker?: () => HostWorker | null;
  readonly searchIo?: (vault: OpenVault) => InvestmentSearchIo | undefined;
}

export interface StrategyCliFiles extends StrategyFilesPort {
  /** A private, checked create-if-absent publication, never an exists-then-overwrite pair. */
  createAbsent?(name: "strategy.yaml" | "strategy.md", text: string): Promise<"created" | "exists">;
  /** Explicit --force replacement of one checked private file, atomically per file. */
  replaceForced?(name: "strategy.yaml" | "strategy.md", text: string): Promise<void>;
  /** The device's publication files and private journal: recording follows strategyFileSync.ts. */
  readonly sync?: StrategyFileSyncPorts;
}

export interface InvestmentContext {
  readonly vault: OpenVault;
  readonly slug: string;
  readonly asOf: string;
  readonly now: ReturnType<typeof parseDateTime>;
  readonly timeZone: string;
  readonly strategy: StrategyState;
  readonly market: MarketInput;
}

/** Exit code of an investments command that cannot run for the selected profile (reason on stderr). */
const REFUSED_EXIT = 1;

/** Why an investments command cannot run; printed by `refuse`. */
export type InvestmentRefusal =
  | { readonly kind: "profile_required" }
  | { readonly kind: "profile_unknown"; readonly slug: string }
  | { readonly kind: "profile_ambiguous"; readonly slug: string }
  | { readonly kind: "module_off"; readonly slug: string }
  | { readonly kind: "strategy_unavailable"; readonly slug: string; readonly reason: string }
  | { readonly kind: "market_unavailable" };

/** Prints why the command cannot run and returns its exit code. */
export function refuse(io: CommandIo, refusal: InvestmentRefusal): number {
  const text = (() => {
    switch (refusal.kind) {
      case "profile_required":
        return io.t.tr(S.investmentProfileRequired);
      case "profile_unknown":
        return io.t.tr(S.investmentProfileUnknown)(refusal.slug);
      case "profile_ambiguous":
        return io.t.tr(S.investmentProfileAmbiguous)(refusal.slug);
      case "module_off":
        return io.t.tr(S.investmentModuleOff)(refusal.slug);
      case "strategy_unavailable":
        return io.t.tr(S.investmentStrategyUnavailable)(refusal.slug, refusal.reason);
      case "market_unavailable":
        return io.t.tr(S.investmentMarketUnavailable);
    }
  })();
  io.stderr(`${text}\n`);
  return REFUSED_EXIT;
}

/** The one open vault of the selected profile with investments on, or why there is none. */
function selectVault(
  io: CommandIo,
  root: { readonly profile?: string },
  deps: Pick<InvestmentCliDeps, "stores">,
): { readonly vault: OpenVault; readonly slug: string } | InvestmentRefusal {
  const slug = root.profile || io.env.CASHU_PROFILE;
  if (!slug) return { kind: "profile_required" };
  const matches = [...deps.stores.vaults.values()].filter(
    (vault) => mcpProfile(vault.store.read.bind(vault.store))?.slug === slug,
  );
  if (matches.length > 1) return { kind: "profile_ambiguous", slug };
  const vault = matches[0];
  if (vault === undefined) return { kind: "profile_unknown", slug };
  if (!enabledModuleIds(vault.store.read.bind(vault.store)).has("investments"))
    return { kind: "module_off", slug };
  return { vault, slug };
}

/** Select one enabled native vault without requiring strategy or market data (silent: null). */
export function investmentVault(
  io: CommandIo,
  root: { readonly profile?: string },
  deps: Pick<InvestmentCliDeps, "stores">,
): OpenVault | null {
  const selected = selectVault(io, root, deps);
  return "kind" in selected ? null : selected.vault;
}

/** `investmentVault` for a command's start: when there is none it prints why and returns the exit code. */
export function investmentVaultOrRefuse(
  io: CommandIo,
  root: { readonly profile?: string },
  deps: Pick<InvestmentCliDeps, "stores">,
): OpenVault | number {
  const selected = selectVault(io, root, deps);
  return "kind" in selected ? refuse(io, selected) : selected.vault;
}

/**
 * The selected vault with its current strategy and market input, or why a report cannot run (an
 * ambiguous slug, an unbound or currently invalid file or market authority). The strategy is read
 * through the host's file authority when it provides one, so no UI session is needed.
 */
export function investmentContext(
  io: CommandIo,
  root: { readonly profile?: string },
  deps: InvestmentCliDeps,
): InvestmentContext | InvestmentRefusal {
  const selected = selectVault(io, root, deps);
  if ("kind" in selected) return selected;
  const { vault, slug } = selected;
  const read = vault.store.read.bind(vault.store);
  const strategy =
    deps.currentStrategy?.(vault) ??
    deps.sources.strategy?.current(read) ??
    ({ status: "unavailable", reason: "strategy_source_unbound" } as const);
  if (strategy.status !== "current")
    return { kind: "strategy_unavailable", slug, reason: strategy.reason };
  if (strategy.vault !== vault.id)
    return { kind: "strategy_unavailable", slug, reason: "invalid_identity" };
  const market = deps.sources.market?.current(read);
  if (!market) return { kind: "market_unavailable" };
  const clock = deps.sources.clock?.current();
  const now = clock?.now ?? parseDateTime(new Date(deps.now()).toISOString());
  const timeZone = clock?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    vault,
    slug,
    asOf: localDate(deps.now()),
    now,
    timeZone,
    strategy: strategy.state,
    market,
  };
}

export function performanceStrategy(context: InvestmentContext): perf.PerformanceStrategy {
  const config = context.strategy.config;
  return {
    state: context.strategy.state,
    benchmark: config?.benchmark ?? null,
    policy:
      config === null
        ? perf.DEFAULT_VALUATION_POLICY
        : {
            maxPriceAgeDays: config.data.maxPriceAgeDays,
            maxFxAgeDays: config.data.maxFxAgeDays,
          },
    strategy:
      config === null ? null : { baseCurrency: config.baseCurrency, allocation: config.allocation },
  };
}
