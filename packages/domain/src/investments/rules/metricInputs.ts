/** Inputs shared by metric resolvers and the built-in rule evaluators. */
import type { UiLang } from "../../core/i18n.js";
import { type Decimal, ZERO } from "../../decimal.js";
import { AssetClass } from "../domain/enums.js";
import type { PriceBar } from "../domain/marketData.js";
import { viewLastBars } from "../domain/snapshot.js";
import { type CalendarDate, daysBetween } from "../domain/values.js";
import type { RuleContext } from "./context.js";
import { shortSeriesProblem, staleCloseProblem } from "./dataQuality.js";
import { hasAllTags, type InstrumentPosition, instrumentLabel, sortedLabels } from "./positions.js";
import { supportStrings as s } from "./support.strings.js";
export function cashValue(ctx: RuleContext): Decimal {
  let value = ctx.portfolio.cashBase;
  for (const h of ctx.portfolio.valued)
    if (h.instrument.assetClass === AssetClass.CASH && h.marketValueBase !== null)
      value = value.add(h.marketValueBase);
  return value;
}
export function lastDepositDate(ctx: RuleContext): CalendarDate | null {
  let last: CalendarDate | null = null;
  for (const deposit of ctx.portfolio.snapshot.deposits)
    if (last === null || deposit.date > last) last = deposit.date;
  return last;
}
export function noContributionsPlan(lang: UiLang): string {
  return s.noPlan[lang];
}
export function taggedWeight(
  ctx: RuleContext,
  tags: readonly string[],
): readonly [number, readonly string[]] {
  let total = 0;
  const labels = new Set<string>();
  for (const h of ctx.portfolio.valued)
    if (hasAllTags(h.instrument, tags)) {
      total += h.weight ?? 0;
      labels.add(instrumentLabel(h.instrument));
    }
  return [total, sortedLabels(labels)];
}
export class WindowBars {
  readonly bars: readonly PriceBar[];
  constructor(bars: readonly PriceBar[]) {
    if (!bars.length) throw new Error("empty validated window");
    this.bars = [...bars];
  }
  get last(): PriceBar {
    return this.bars[this.bars.length - 1] as PriceBar;
  }
  get high(): PriceBar {
    return this.bars.reduce((best, bar) => (bar.close.gt(best.close) ? bar : best));
  }
}
export function windowBars(
  ctx: RuleContext,
  position: InstrumentPosition,
  count: number,
): WindowBars | string {
  const problem = position.seriesProblem ?? position.fxProblem;
  if (problem !== null) return problem;
  const bars = viewLastBars(ctx.market, position.id, count);
  if (!bars.length) return s.noSeries[ctx.lang](position.label);
  const last = bars[bars.length - 1] as PriceBar;
  const age = daysBetween(last.date, ctx.asOf);
  if (age > ctx.data.maxPriceAgeDays)
    return staleCloseProblem(position.label, last.date, age, ctx.lang);
  if (bars.length < count) return shortSeriesProblem(position.label, bars.length, count, ctx.lang);
  if (bars.some((bar) => bar.close.lte(ZERO))) return s.invalidPrices[ctx.lang](position.label);
  return new WindowBars(bars);
}
