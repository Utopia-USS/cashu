// The three sources the investments screen queries read on the phone (the Mac binds them in its host):
// the strategy is the synced latest `inv_strategy_versions` row (no files on the phone), the market is
// this device's price cache (prices and NBP rates, device-local, never synced) and the clock is the
// device's, re-read at the shell's day boundaries. One object satisfies the portfolio, asset, signals,
// review and research query factories; every source finds the vault through `read`, so the same
// queries serve every vault on the device (rule 7: a read never spans two vaults).
import { parseDateTime } from "@cashu/domain";
import type { SqlPriceCache } from "@cashu/store/investments/local";
import {
  type CurrentStrategySource,
  type InvestmentMarketSource,
  type InvestmentScreenClock,
  latestStrategyVersion,
  strategySnapshot,
} from "@cashu/store/investments/screen-sources";
import type { ChangeSource, Read } from "@cashu/store/query";
import { nowTicks } from "./nowTicks";

export interface PhoneInvestmentSources {
  readonly strategy: CurrentStrategySource;
  readonly market: InvestmentMarketSource;
  readonly clock: InvestmentScreenClock & { readonly changes: ChangeSource };
}

/** The table is synced: `watchQuery` re-runs on `inv_strategy_versions` without a process-local signal. */
const NO_CHANGES: ChangeSource = { subscribe: () => () => {} };

/** The device's IANA time zone; "UTC" when the platform does not name one. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

function profileGid(read: Read): string | null {
  return read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid ?? null;
}

export function phoneInvestmentSources(deps: {
  readonly prices: SqlPriceCache;
  /** The current instant, ISO. */
  now(): string;
  /** Defaults to the shell's day boundaries. */
  readonly ticks?: ChangeSource;
}): PhoneInvestmentSources {
  const { prices } = deps;
  return {
    strategy: {
      changes: NO_CHANGES,
      current(read) {
        const vault = profileGid(read);
        if (vault === null) return { status: "unavailable", reason: "invalid_identity" };
        const latest = latestStrategyVersion(read);
        // No strategy saved on the Mac yet: no files, so the strategy reads as missing and the
        // portfolio is still ready, as on the Mac (`nativeCurrentStrategy` with absent files).
        return strategySnapshot(read, {
          vault,
          generation: "synced",
          revision: latest?.gid ?? "none",
          files: {
            yaml: latest?.yamlText ?? null,
            md: latest?.mdText ?? null,
            readError: null,
          },
        });
      },
    },
    market: {
      changes: { subscribe: (listener) => prices.subscribe(listener) },
      current: () => ({ prices }),
      newestRateDate: () => prices.newestFxDate(),
    },
    clock: {
      current: () => ({ now: parseDateTime(deps.now()), timeZone: deviceTimeZone() }),
      changes: deps.ticks ?? nowTicks,
    },
  };
}
