/** Native positions presentation over the existing snapshot and valuation results; no recomputation. */
import { addDays, type DateTime, type IsoDate, utcIso } from "../../dates.js";
import { type Decimal, roundFloat, ZERO } from "../../decimal.js";
import {
  type Currency,
  effectivePlan,
  holdingAverageCost,
  type Instrument,
  type InstrumentId,
  instrumentLabel,
  openedOn,
  type PriceBar,
  realizedPnlBase,
  TxnType,
  type ValuedHolding,
} from "../domain/index.js";
import { pySum } from "../performance/index.js";
import { segmentOf } from "../research/index.js";
import type { PortfolioProjectionInput, PortfolioViewState } from "./types.js";

export const ratioPct = (value: number | null): number | null =>
  value === null ? null : roundFloat(value, 6);
/** Only for explicitly declared timestamp fields, never for arbitrary user payload objects. */
export const viewTimestamp = (value: DateTime | null): string | null =>
  value === null ? null : utcIso(value);
export function sumNullable(values: Iterable<Decimal | null>): Decimal | null {
  let total = ZERO;
  for (const v of values) {
    if (v === null) return null;
    total = total.add(v);
  }
  return total;
}
export function instrumentView(
  inst: Instrument,
  held: boolean | null = null,
  opened: IsoDate | null = null,
) {
  const plan = effectivePlan(inst.plan, { held, planAt: inst.planAt, opened }),
    [segment, source] = segmentOf(inst, inst.segment, inst.segmentBy);
  return {
    id: inst.id,
    symbol: inst.symbol,
    name: inst.name,
    label: instrumentLabel(inst),
    isin: inst.isin,
    mic: inst.mic,
    currency: inst.currency,
    asset_class: inst.assetClass,
    region: inst.region,
    sector: inst.sector,
    tags: inst.tags,
    valuation_mode: inst.valuationMode,
    status: inst.status,
    needs_classification: inst.needsClassification,
    aliases: inst.aliases,
    plan,
    plan_at: viewTimestamp(plan === null ? null : inst.planAt),
    plan_reason: plan === null ? null : inst.planReason,
    strength: inst.positionStrength,
    strength_basis: inst.positionStrength === null ? null : inst.strengthBasis,
    strength_reason: inst.positionStrength === null ? null : inst.strengthReason,
    strength_at: viewTimestamp(inst.positionStrength === null ? null : inst.strengthAt),
    segment,
    segment_source: source,
  };
}
export function closes30d(bars: readonly PriceBar[], asOf: IsoDate) {
  const since = addDays(asOf, -30);
  return bars
    .filter((b) => b.date > since && b.date <= asOf)
    .map((b) => ({ date: b.date, close: b.close }));
}
export function cashRows(state: PortfolioViewState) {
  const names = new Map(state.accounts.map((a) => [a.id, a.name]));
  return state.valued.cash.map((c) => ({
    account_id: c.cash.accountId,
    account_name: names.get(c.cash.accountId) ?? null,
    currency: c.cash.currency,
    amount: c.cash.amount,
    amount_base: c.amountBase,
  }));
}
export function positionRows(input: PortfolioProjectionInput) {
  const { state, facts, annotations } = input,
    names = new Map(state.accounts.map((a) => [a.id, a.name]));
  const bucketOf = new Map<string, string>();
  for (const [bucket, held] of state.allocation?.holdingsByBucket ?? [])
    for (const h of held) bucketOf.set(`${h.holding.accountId}\u0000${h.instrument.id}`, bucket);
  const dividends = new Map<InstrumentId, Map<Currency, Decimal>>();
  for (const t of state.txns)
    if (
      t.type === TxnType.DIVIDEND &&
      t.instrumentId !== null &&
      (state.accountFilter === null || state.accountFilter.includes(t.accountId))
    ) {
      const byCurrency = dividends.get(t.instrumentId) ?? new Map<Currency, Decimal>();
      byCurrency.set(t.cashCurrency, (byCurrency.get(t.cashCurrency) ?? ZERO).add(t.cashAmount));
      dividends.set(t.instrumentId, byCurrency);
    }
  const realized = new Map<InstrumentId, (Decimal | null)[]>();
  for (const r of state.valued.realized) {
    const id = r.trade.instrumentId;
    const parts = realized.get(id) ?? [];
    parts.push(realizedPnlBase(r));
    realized.set(id, parts);
  }
  const grouped = new Map<InstrumentId, ValuedHolding[]>();
  for (const v of state.valued.valued) {
    const id = v.instrument.id;
    const rows = grouped.get(id) ?? [];
    rows.push(v);
    grouped.set(id, rows);
  }
  const openCounts = new Map<InstrumentId, number>();
  for (const s of facts.signals)
    if (s.instrumentId !== null)
      openCounts.set(s.instrumentId, (openCounts.get(s.instrumentId) ?? 0) + 1);
  const withThesis = new Set(facts.subjects.filter((s) => s.hasThesis).map((s) => s.instrument.id));
  const rows = [...grouped].map(([id, held]) => {
    const first = held[0];
    if (first === undefined) throw new Error("empty position group");
    const value = sumNullable(held.map((v) => v.marketValueBase)),
      cost = sumNullable(held.map((v) => v.costBasisBase)),
      weights = held.map((v) => v.weight),
      annotation = annotations.get(id);
    const buckets = new Set(
      held.map((v) => bucketOf.get(`${v.holding.accountId}\u0000${id}`) ?? null),
    );
    const lots = held.flatMap((v) =>
      v.holding.lots.map((lot) => ({
        account_id: lot.accountId,
        open_date: lot.openDate,
        quantity: lot.quantity,
        unit_cost: lot.unitCost,
        currency: lot.currency,
        open_txn_id: lot.openTxnId,
        result:
          first.price !== null && lot.unitCost !== null && first.priceCurrency === lot.currency
            ? first.price.sub(lot.unitCost).mul(lot.quantity)
            : null,
      })),
    );
    return {
      instrument: {
        ...instrumentView(
          first.instrument,
          true,
          openedOn(
            held.map((v) => v.holding),
            state.snapshot.realized,
          ),
        ),
        plan_freshness: annotation?.freshness ?? null,
      },
      bucket: buckets.size === 1 ? ([...buckets][0] ?? null) : null,
      quantity: sumNullable(held.map((v) => v.holding.quantity)) ?? ZERO,
      price: first.price,
      price_date: first.priceDate,
      price_currency: first.priceCurrency,
      is_stale: held.some((v) => v.isStale),
      valuation_mode: first.valuationMode,
      missing_fx_currency: first.missingFxCurrency,
      value,
      cost,
      unrealized: value !== null && cost !== null ? value.sub(cost) : null,
      unrealized_pct:
        value !== null && cost !== null && !cost.isZero()
          ? ratioPct(value.sub(cost).div(cost).toFloat())
          : null,
      weight: weights.every((v): v is number => v !== null) ? ratioPct(pySum(weights)) : null,
      realized: realized.has(id) ? sumNullable(realized.get(id) ?? []) : null,
      dividends: dividends.get(id) ?? new Map<Currency, Decimal>(),
      accounts: held.map((v) => ({
        account_id: v.holding.accountId,
        account_name: names.get(v.holding.accountId) ?? null,
        quantity: v.holding.quantity,
        average_cost: holdingAverageCost(v.holding),
        cost_currency: v.holding.currency,
        value: v.marketValueBase,
        cost: v.costBasisBase,
        unrealized_pct: ratioPct(v.unrealizedPct),
        weight: ratioPct(v.weight),
      })),
      lots,
      open_signals: openCounts.get(id) ?? 0,
      has_thesis: withThesis.has(id),
      research_unread: facts.unread.get(id) ?? 0,
      closes_30d: closes30d(state.market.bars.get(id) ?? [], state.asOf),
      hints: annotation?.hints ?? [],
    };
  });
  // Python sorts the presented float values; equal float keys preserve the canonical input order.
  return rows.sort((a, b) => {
    const left = a.value?.toFloat() ?? 0,
      right = b.value?.toFloat() ?? 0;
    return left > right ? -1 : left < right ? 1 : 0;
  });
}
export function positionsView(input: PortfolioProjectionInput) {
  return {
    as_of: input.state.asOf,
    base_currency: input.state.base,
    positions: positionRows(input),
    cash: cashRows(input.state),
    total: input.state.valued.totalBase,
  };
}
export type PositionRow = ReturnType<typeof positionRows>[number];
