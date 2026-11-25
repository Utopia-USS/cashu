/** Display-only strategy levels from full through-asOf bars; evaluator freshness guards do not apply. */
import { monthsBack } from "../../dates.js";
import { D, type Decimal, ZERO } from "../../decimal.js";
import {
  dividedBy,
  holdingCostBasis,
  type Instrument,
  instrumentLabel,
  type PriceBar,
  TxnType,
} from "../domain/index.js";
import { effectiveValuationMode } from "../portfolio/index.js";
import {
  DrawdownFromHighParams,
  filterAccepts,
  UnrealizedThresholdParams,
} from "../rules/index.js";
import type { PortfolioProjectionInput } from "./types.js";
export interface PositionChartInput extends PortfolioProjectionInput {
  readonly instrument: Instrument;
  readonly bars: readonly PriceBar[];
  readonly months?: number;
}
export function positionChartView(input: PositionChartInput) {
  const { state, instrument: inst } = input,
    asOf = state.asOf,
    since = monthsBack(asOf, input.months ?? 24),
    bars = input.bars.filter((b) => b.date <= asOf),
    held = state.valued.valued.filter((v) => v.instrument.id === inst.id);
  const reported = bars.flatMap((b) => (b.currency === null ? [] : [b.currency])),
    currency = reported.at(-1) ?? inst.currency;
  let cost = ZERO,
    quantity = ZERO,
    average: Decimal | null = null;
  if (held.length) {
    let known = true;
    for (const v of held) {
      const basis = holdingCostBasis(v.holding);
      if (basis === null || v.holding.currency !== currency) {
        known = false;
        break;
      }
      cost = cost.add(basis);
      quantity = quantity.add(v.holding.quantity);
    }
    if (known && !quantity.isZero()) average = dividedBy(cost, quantity);
  }
  const thresholds = (state.config?.rules ?? []).flatMap((rule) => {
    if (!["drawdown_from_high", "loss_from_cost", "gain_from_cost"].includes(rule.kind)) return [];
    const p = rule.params;
    if (!(p instanceof DrawdownFromHighParams) && !(p instanceof UnrealizedThresholdParams))
      throw new Error("invalid native chart rule parameters");
    if (!filterAccepts(p.filter, inst)) return [];
    const fraction = D(String(p.threshold));
    let basis: "high" | "cost", window: number | null, level: Decimal;
    if (rule.kind === "drawdown_from_high") {
      if (!(p instanceof DrawdownFromHighParams))
        throw new Error("invalid drawdown chart parameters");
      const closes = bars.slice(-p.windowDays).map((b) => b.close);
      if (!closes.length) return [];
      const high = closes.reduce((a, b) => (a.gt(b) ? a : b));
      basis = "high";
      window = p.windowDays;
      level = high.mul(D("1").sub(fraction));
    } else {
      if (average === null) return [];
      basis = "cost";
      window = null;
      level = average.mul(
        rule.kind === "loss_from_cost" ? D("1").sub(fraction) : D("1").add(fraction),
      );
    }
    return [
      {
        rule_id: rule.id,
        kind: rule.kind,
        threshold: p.threshold,
        basis,
        window_days: window,
        y: level,
      },
    ];
  });
  const year = bars.slice(-252),
    last = bars.at(-1);
  return {
    instrument_id: inst.id,
    label: instrumentLabel(inst),
    currency,
    valuation_mode: effectiveValuationMode(inst),
    as_of: asOf,
    series: bars.filter((b) => b.date >= since).map((b) => ({ date: b.date, close: b.close })),
    high_52w: year.length ? year.map((b) => b.close).reduce((a, b) => (a.gt(b) ? a : b)) : null,
    last: last === undefined ? null : { date: last.date, close: last.close },
    cost: held.length ? { average, currency } : null,
    thresholds,
    markers: state.txns
      .filter(
        (t) =>
          t.instrumentId === inst.id &&
          (t.type === TxnType.BUY || t.type === TxnType.SELL) &&
          t.tradeDate >= since &&
          t.tradeDate <= asOf,
      )
      .map((t) => ({
        date: t.tradeDate,
        type: t.type,
        quantity: t.quantity,
        price: t.price,
        currency: t.currency,
        account_id: t.accountId,
      })),
  };
}
export type PositionChartView = ReturnType<typeof positionChartView>;
