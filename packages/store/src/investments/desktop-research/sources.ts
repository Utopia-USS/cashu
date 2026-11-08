import { type market, performance as perf } from "@cashu/domain/investments";
import type * as macro from "@cashu/domain/investments/macro";
import type { ChangeSource, Read } from "../../query.js";
import type { StrategyState } from "../services/strategy.js";

/** A source is current only when its identity belongs to the tracked vault. */
export type ResearchSourceResult<T> =
  | { readonly status: "current"; readonly value: T }
  | { readonly status: "unavailable" | "error"; readonly reason: string };
export type ResearchSourceStatus =
  | Exclude<ResearchSourceResult<never>, { status: "current" }>
  | { readonly status: "current" };

export interface ResearchSourceImage<T> {
  readonly vault: string;
  readonly generation: string;
  readonly revision: string;
  readonly value: T;
}

export interface ResearchImageSource<T> {
  readonly changes: ChangeSource;
  current(read: Read): ResearchSourceResult<ResearchSourceImage<T>>;
}

export interface ResearchWorkspaceInfo {
  readonly path: string | null;
  readonly exists: boolean;
  readonly skillInstalled: boolean;
  readonly command: string | null;
  readonly routine: string | null;
}

export interface ResearchScreenExtraSources {
  readonly macro?: ResearchImageSource<macro.MacroCloses>;
  readonly calendar?: ResearchImageSource<market.CalendarFeeds>;
  readonly workspace?: ResearchImageSource<ResearchWorkspaceInfo>;
}

/** Exactly the existing Review and Portfolio policy projection. */
export function performanceStrategy(state: StrategyState): perf.PerformanceStrategy {
  const config = state.config;
  return {
    state: state.state,
    benchmark: config?.benchmark ?? null,
    policy:
      config === null
        ? perf.DEFAULT_VALUATION_POLICY
        : { maxPriceAgeDays: config.data.maxPriceAgeDays, maxFxAgeDays: config.data.maxFxAgeDays },
    strategy:
      config === null ? null : { baseCurrency: config.baseCurrency, allocation: config.allocation },
  };
}

export function sourceForVault<T>(
  read: Read,
  result: ResearchSourceResult<ResearchSourceImage<T>> | undefined,
): ResearchSourceResult<T> {
  if (result === undefined) return { status: "unavailable", reason: "source_unbound" };
  if (result.status !== "current") return result;
  const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
  if (!vault || vault !== result.value.vault || !result.value.generation || !result.value.revision)
    return { status: "unavailable", reason: "invalid_identity" };
  return { status: "current", value: result.value.value };
}

export function sourceStatus<T>(result: ResearchSourceResult<T>): ResearchSourceStatus {
  return result.status === "current" ? { status: "current" } : result;
}
