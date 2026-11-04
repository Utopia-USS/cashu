import type { views } from "@cashu/domain/investments";
/** Neutral current-file authority shared by investment screens, independently of document UI. */

import type { DateTime } from "@cashu/domain";
import { strategyStatus, usableConfig } from "@cashu/domain/investments/strategy";
import type { ChangeSource, Read } from "../../query.js";
import type { MarketInput } from "../marketInput.js";

export type { MarketInput } from "../marketInput.js";

import { latestStrategyVersion } from "../queries/strategy.js";
import type { StrategyState } from "../services/strategy.js";

export { gid as investmentEntityIdSchema } from "../../events/v1/primitives.js";

export interface CurrentStrategyImage {
  readonly vault: string;
  readonly generation: string;
  readonly revision: string;
  readonly files: {
    readonly yaml: string | null;
    readonly md: string | null;
    readonly readError: string | null;
  };
}

export type CurrentStrategySnapshot =
  | { readonly status: "unavailable"; readonly reason: string }
  | {
      readonly status: "current";
      readonly vault: string;
      readonly generation: string;
      readonly revision: string;
      readonly state: StrategyState;
    };

export interface CurrentStrategySource {
  readonly changes: ChangeSource;
  current(read: Read): CurrentStrategySnapshot;
}

export interface InvestmentMarketSource {
  readonly changes: ChangeSource;
  current(read: Read): MarketInput | null;
  newestRateDate(): string | null;
}

/** Re-evaluated when a query runs; time alone does not manufacture a change notification. */
export interface InvestmentScreenClock {
  current(): { readonly now: DateTime; readonly timeZone: string };
}

/** SQL history stays live even when the completed file image has not changed. */
export function strategySnapshot(read: Read, image: CurrentStrategyImage): CurrentStrategySnapshot {
  if (read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid !== image.vault)
    return { status: "unavailable", reason: "invalid_identity" };
  const version = latestStrategyVersion(read) ?? null;
  const status = strategyStatus(image.files, version);
  return {
    status: "current",
    vault: image.vault,
    generation: image.generation,
    revision: image.revision,
    state: {
      state: status.state,
      result: status.result,
      config: usableConfig(status),
      issues: status.result?.issues ?? [],
      inactiveRules: status.result?.inactiveRules ?? [],
      sha256: status.sha256,
      version,
      changed: status.changed,
      readError: status.readError,
    },
  };
}

export function combinedChanges(...sources: readonly ChangeSource[]): ChangeSource {
  return {
    subscribe(listener) {
      const stops = sources.map((source) => source.subscribe(listener));
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}

/** Preserve native facts while exposing only supported wire values. */
export const investmentPositionDto = (row: views.PositionRow) => ({
  ...row,
  instrument: investmentInstrumentDto(row.instrument),
  dividends: Object.fromEntries(row.dividends),
});
export function investmentInstrumentDto<
  T extends { readonly plan_freshness: views.PositionRow["instrument"]["plan_freshness"] },
>(row: T) {
  const { plan_freshness, ...instrument } = row;
  return {
    ...instrument,
    plan_freshness:
      plan_freshness === null
        ? null
        : { state: plan_freshness.state, reasons: plan_freshness.reasons },
  };
}
