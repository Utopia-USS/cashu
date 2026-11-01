/** Synthetic builders ported from tests/investments/rules/rules_fixtures.py. */
import type { UiLang } from "../../../core/i18n.js";
import { addDays, fromIsoFormat } from "../../../dates.js";
import { D, formatFloat, ZERO } from "../../../decimal.js";
import { Money } from "../../../money.js";
import { AssetClass, ValuationMode } from "../../domain/enums.js";
import { type Instrument, instrument as makeInstrument } from "../../domain/instrument.js";
import { type PriceBar, priceBar } from "../../domain/marketData.js";
import {
  type BucketAllocation,
  bucketAllocation,
  cashBalance,
  datedAmount,
  holding,
  marketView,
  portfolioSnapshot,
  type ValuedCash,
  type ValuedHolding,
  type ValuedPortfolio,
  valuedCash,
  valuedHolding,
  valuedPortfolio,
} from "../../domain/snapshot.js";
import {
  asAccountId,
  asInstrumentId,
  asProfileId,
  type CalendarDate,
  Currencies,
  type Currency,
} from "../../domain/values.js";
import type { PortfolioWarning } from "../../domain/warnings.js";
import type { RuleContext } from "../context.js";
import { type ContributionPlan, type DataQualityPolicy, DEFAULT_DATA_QUALITY } from "../kind.js";

const PROFILE_ID = asProfileId("profile-1");
export const ACCOUNT_A = asAccountId("account-a");
export const ACCOUNT_B = asAccountId("account-b");
export const PLN = Currencies.PLN;
export const USD = Currencies.USD;
export const AS_OF = fromIsoFormat("2026-10-02");
export const day = fromIsoFormat;
export const d = D;
export function instrument(
  symbol: string,
  options: {
    assetClass?: AssetClass;
    tags?: readonly string[];
    mic?: string | null;
    currency?: Currency;
  } = {},
): Instrument {
  return makeInstrument({
    id: asInstrumentId(`i-${symbol}`),
    name: `${symbol} name`,
    symbol,
    assetClass: options.assetClass ?? AssetClass.EQUITY,
    tags: options.tags ?? [],
    mic: options.mic === undefined ? "XWAR" : options.mic,
    currency: options.currency ?? PLN,
  });
}
export interface HoldingSpec {
  readonly instrument: Instrument;
  readonly account: string;
  readonly value: string | null;
  readonly cost: string | null;
  readonly stale: boolean;
  readonly mode: ValuationMode;
}
export function h(
  inst: Instrument,
  options: {
    value?: string | null;
    cost?: string | null;
    stale?: boolean;
    atCost?: boolean;
    manual?: boolean;
    account?: string;
  } = {},
): HoldingSpec {
  return {
    instrument: inst,
    account: options.account ?? ACCOUNT_A,
    value: options.value === undefined ? "1000" : options.value,
    cost: options.cost === undefined ? "800" : options.cost,
    stale: options.stale ?? false,
    mode: options.atCost
      ? ValuationMode.COST
      : options.manual
        ? ValuationMode.MANUAL
        : ValuationMode.MARKET,
  };
}
export function portfolio(
  holdings: readonly HoldingSpec[] = [],
  options: {
    cash?: string;
    staleWeight?: number;
    deposits?: readonly CalendarDate[];
    missingFxCurrencies?: ReadonlySet<Currency>;
    snapshotWarnings?: readonly PortfolioWarning[];
    cashBalances?: readonly ValuedCash[];
  } = {},
): ValuedPortfolio {
  const cash = D(options.cash ?? "0");
  let total = cash;
  let staleValue = ZERO;
  for (const spec of holdings)
    if (spec.value !== null) {
      total = total.add(D(spec.value));
      if (spec.stale) staleValue = staleValue.add(D(spec.value));
    }
  // The Python synthetic fixture explicitly uses float(value)/float(total) for derived weights.
  const totalFloat = total.toFloat();
  const missing = options.missingFxCurrencies ?? new Set<Currency>();
  const valued = holdings.map((spec): ValuedHolding => {
    const value = spec.value === null ? null : D(spec.value);
    const cost = spec.cost === null ? null : D(spec.cost);
    return valuedHolding({
      holding: holding({
        accountId: asAccountId(spec.account),
        instrumentId: spec.instrument.id,
        currency: PLN,
        quantity: D("10"),
      }),
      instrument: spec.instrument,
      isStale: spec.stale,
      price: value === null ? null : value.div(D("10")),
      priceDate: value === null ? null : spec.stale ? addDays(AS_OF, -10) : AS_OF,
      marketValueBase: value,
      costBasisBase: cost,
      unrealizedPct:
        value === null || cost === null || cost.isZero()
          ? null
          : value.sub(cost).div(cost).toFloat(),
      weight: value === null || totalFloat === 0 ? null : value.toFloat() / totalFloat,
      valuationMode: spec.mode,
      priceCurrency: value === null ? null : spec.instrument.currency,
      missingFxCurrency: missing.has(spec.instrument.currency) ? spec.instrument.currency : null,
    });
  });
  const balances =
    options.cashBalances ??
    (cash.isZero()
      ? []
      : [
          valuedCash({
            cash: cashBalance({ accountId: ACCOUNT_A, currency: PLN, amount: cash }),
            amountBase: cash,
          }),
        ]);
  return valuedPortfolio({
    snapshot: portfolioSnapshot({
      profileId: PROFILE_ID,
      asOf: AS_OF,
      deposits: (options.deposits ?? []).map((date) =>
        datedAmount({ accountId: ACCOUNT_A, date, amount: new Money(D("1000"), PLN) }),
      ),
      warnings: options.snapshotWarnings ?? [],
    }),
    baseCurrency: PLN,
    cashBase: cash,
    totalBase: total,
    staleWeight: options.staleWeight ?? (totalFloat === 0 ? 0 : staleValue.toFloat() / totalFloat),
    valued,
    cash: balances,
    missingFxCurrencies: missing,
  });
}
export function alloc(
  bucketId: string,
  options: { weight: number; target: number; total?: number; cashHistoryGap?: boolean },
): BucketAllocation {
  const { weight, target } = options;
  const total = options.total ?? 100000;
  const drift = weight - target;
  return bucketAllocation({
    bucketId,
    weight,
    target,
    driftPp: drift * 100,
    driftRel: target === 0 ? (weight > 0 ? Number.POSITIVE_INFINITY : 0) : drift / target,
    valueBase: D(formatFloat(weight * total, ".2f")),
    driftValueBase: D(formatFloat(drift * total, ".2f")),
    cashHistoryGap: options.cashHistoryGap ?? false,
  });
}
export function bars(
  inst: Instrument,
  closes: readonly string[],
  lastDate: CalendarDate = AS_OF,
): readonly PriceBar[] {
  return closes.map((close, i) =>
    priceBar({
      instrumentId: inst.id,
      date: addDays(lastDate, -(closes.length - 1 - i)),
      close: D(close),
      source: "test",
    }),
  );
}
/** Fixture defaults to Polish to match Python tests; production builder defaults to English. */
export function context(
  options: {
    portfolioValue?: ValuedPortfolio;
    allocations?: readonly BucketAllocation[];
    unclassified?: readonly ValuedHolding[];
    series?: ReadonlyMap<Instrument, readonly PriceBar[]>;
    data?: DataQualityPolicy;
    contributions?: ContributionPlan | null;
    lang?: UiLang;
  } = {},
): RuleContext {
  const series = options.series ?? new Map<Instrument, readonly PriceBar[]>();
  return {
    profileId: PROFILE_ID,
    asOf: AS_OF,
    portfolio: options.portfolioValue ?? portfolio(),
    market: marketView({
      asOf: AS_OF,
      instruments: new Map([...series].map(([inst]) => [inst.id, inst])),
      bars: new Map([...series].map(([inst, rows]) => [inst.id, rows])),
    }),
    allocations: options.allocations ?? [],
    unclassified: options.unclassified ?? [],
    data: options.data ?? DEFAULT_DATA_QUALITY,
    contributions: options.contributions ?? null,
    lang: options.lang ?? "pl",
  };
}
