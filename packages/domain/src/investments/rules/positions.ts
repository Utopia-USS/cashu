/** Aggregated instrument scopes and filters from Python rules/kinds/support.py. */
import type { UiLang } from "../../core/i18n.js";
import { type Decimal, ZERO } from "../../decimal.js";
import { pyLower, pyStrip } from "../../text.js";
import { AssetClass } from "../domain/enums.js";
import { type Instrument, instrumentLabel } from "../domain/instrument.js";
import { type ValuedHolding, valuedAtCost, valuedManually } from "../domain/snapshot.js";
import { type Currency, dividedBy, type InstrumentId } from "../domain/values.js";
import type { RuleContext } from "./context.js";
import type { InstrumentFilter } from "./instrumentFilter.js";
import { supportStrings as s } from "./support.strings.js";

export { instrumentLabel } from "../domain/instrument.js";
export function hasAllTags(instrument: Instrument, tags: Iterable<string>): boolean {
  const carried = new Set(instrument.tags.map((tag) => pyLower(pyStrip(tag))));
  return [...tags].every((tag) => carried.has(pyLower(pyStrip(tag))));
}
export function filterAccepts(
  filter: InstrumentFilter | undefined,
  instrument: Instrument,
): boolean {
  if (filter && filter.assetClasses.size > 0) {
    if (!filter.assetClasses.has(instrument.assetClass)) return false;
  } else if (instrument.assetClass === AssetClass.CASH) return false;
  if (filter && !hasAllTags(instrument, filter.tags)) return false;
  return !filter || filter.instrumentIds.size === 0 || filter.instrumentIds.has(instrument.id);
}
export function sortedLabels(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => {
    const left = Array.from(a);
    const right = Array.from(b);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const diff = (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0);
      if (diff) return diff;
    }
    return left.length - right.length;
  });
}
export function filterPayload(filter: InstrumentFilter): Readonly<Record<string, unknown>> {
  return {
    ...(filter.assetClasses.size ? { filter_asset_class: sortedLabels(filter.assetClasses) } : {}),
    ...(filter.tags.length ? { filter_tags: [...filter.tags] } : {}),
    ...(filter.instrumentIds.size
      ? { filter_instrument_ids: sortedLabels(filter.instrumentIds) }
      : {}),
  };
}
function sum(values: Iterable<Decimal | null>): Decimal | null {
  let total = ZERO;
  for (const value of values) {
    if (value === null) return null;
    total = total.add(value);
  }
  return total;
}
export class InstrumentPosition {
  readonly instrument: Instrument;
  readonly holdings: readonly ValuedHolding[];
  readonly missingFxCurrencies: ReadonlySet<Currency>;
  readonly lang: UiLang;
  constructor(
    instrument: Instrument,
    holdings: readonly ValuedHolding[],
    missingFxCurrencies: ReadonlySet<Currency> = new Set(),
    lang: UiLang = "en",
  ) {
    this.instrument = instrument;
    this.holdings = [...holdings];
    this.missingFxCurrencies = missingFxCurrencies;
    this.lang = lang;
  }
  get id(): InstrumentId {
    return this.instrument.id;
  }
  get label(): string {
    return instrumentLabel(this.instrument);
  }
  get valuedManually(): boolean {
    return this.holdings.some(valuedManually);
  }
  get valuedAtCost(): boolean {
    return this.holdings.some(valuedAtCost);
  }
  get seriesProblem(): string | null {
    return this.valuedManually
      ? s.manualSeries[this.lang](this.label)
      : this.valuedAtCost
        ? s.costSeries[this.lang](this.label)
        : null;
  }
  get manualProblem(): string | null {
    return this.valuedManually ? s.manualResult[this.lang](this.label) : null;
  }
  get fxProblem(): string | null {
    for (const h of this.holdings)
      if (h.missingFxCurrency !== null) return s.noRate[this.lang](h.missingFxCurrency, this.label);
    return this.missingFxCurrencies.has(this.instrument.currency)
      ? s.noRate[this.lang](this.instrument.currency, this.label)
      : null;
  }
  get priceProblem(): string | null {
    if (this.fxProblem !== null) return this.fxProblem;
    if (this.holdings.some((h) => h.price === null || h.marketValueBase === null))
      return s.noPrice[this.lang](this.label);
    for (const h of this.holdings)
      if (h.isStale)
        return h.priceDate === null
          ? s.stalePrice[this.lang](this.label)
          : s.staleDated[this.lang](this.label, h.priceDate);
    return null;
  }
  get weight(): number | null {
    let total = 0;
    for (const h of this.holdings) {
      if (h.weight === null) return null;
      total += h.weight;
    }
    return total;
  }
  get marketValueBase(): Decimal | null {
    return sum(this.holdings.map((h) => h.marketValueBase));
  }
  get costBasisBase(): Decimal | null {
    return sum(this.holdings.map((h) => h.costBasisBase));
  }
  get costProblem(): string | null {
    const cost = this.costBasisBase;
    return cost === null
      ? unknownCostProblem(this.label, this.lang)
      : cost.lte(ZERO)
        ? s.zeroCost[this.lang](this.label)
        : null;
  }
  get unrealizedPct(): number | null {
    const value = this.marketValueBase;
    const cost = this.costBasisBase;
    return value === null || cost === null || cost.lte(ZERO)
      ? null
      : dividedBy(value.sub(cost), cost).toFloat();
  }
  payload(): Readonly<Record<string, unknown>> {
    return {
      instrument_id: this.id,
      symbol: this.instrument.symbol,
      name: this.instrument.name,
      asset_class: this.instrument.assetClass,
      accounts: this.holdings.length,
    };
  }
}
export function positionsByInstrument(
  ctx: RuleContext,
  filter?: InstrumentFilter,
): InstrumentPosition[] {
  const grouped = new Map<InstrumentId, ValuedHolding[]>();
  const instruments = new Map<InstrumentId, Instrument>();
  for (const h of ctx.portfolio.valued) {
    if (!filterAccepts(filter, h.instrument)) continue;
    const list = grouped.get(h.holding.instrumentId) ?? [];
    list.push(h);
    grouped.set(h.holding.instrumentId, list);
    instruments.set(h.holding.instrumentId, h.instrument);
  }
  return [...grouped].map(
    ([id, holdings]) =>
      new InstrumentPosition(
        instruments.get(id) as Instrument,
        holdings,
        ctx.portfolio.missingFxCurrencies,
        ctx.lang,
      ),
  );
}
export function unknownCostProblem(label: string, lang: UiLang): string {
  return s.unknownCost[lang](label);
}
