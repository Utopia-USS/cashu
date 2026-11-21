/** Held/watched/saved detail with full histories and a deliberately separate clipped detail series. */
import { type Instrument, openedOn, type PriceBar, type Transaction } from "../domain/index.js";
import { instrumentView, positionRows, viewTimestamp } from "./positions.js";
import type { PortfolioProjectionInput, PortfolioViewState, PositionHistory } from "./types.js";
export interface PositionDetailInput extends PortfolioProjectionInput {
  readonly instrument: Instrument;
  readonly detailBars: readonly PriceBar[];
  readonly chartBars: readonly PriceBar[];
  readonly history: PositionHistory;
}
export function transactionView(t: Transaction, state: PortfolioViewState) {
  return {
    id: t.id,
    account_id: t.accountId,
    account_name: state.accounts.find((a) => a.id === t.accountId)?.name ?? null,
    type: t.type,
    trade_date: t.tradeDate,
    instrument_id: t.instrumentId,
    quantity: t.quantity,
    price: t.price,
    currency: t.currency,
    gross_amount: t.grossAmount,
    fee: t.fee,
    tax: t.tax,
    cash_amount: t.cashAmount,
    cash_currency: t.cashCurrency,
    fx_rate: t.fxRate,
    split_ratio: t.splitRatio === null ? null : t.splitRatio.toString(),
    source: t.source,
    note: t.note,
    external_ref: t.externalRef,
  };
}
export function positionDetailView(input: PositionDetailInput) {
  const { state, instrument: inst, facts, annotations, history } = input,
    position = positionRows(input).find((r) => r.instrument.id === inst.id) ?? null,
    watch = facts.watched.find((w) => w.instrumentId === inst.id),
    annotation = annotations.get(inst.id);
  const held = state.valued.valued.filter((v) => v.instrument.id === inst.id),
    series = input.detailBars.filter((b) => b.date <= state.asOf),
    window = series.slice(-252);
  return {
    instrument: {
      ...instrumentView(
        inst,
        position !== null,
        openedOn(
          held.map((v) => v.holding),
          state.snapshot.realized,
        ),
      ),
      plan_freshness: annotation?.freshness ?? null,
    },
    entry: {
      state: position !== null ? "held" : watch === undefined ? "saved" : "watched",
      watch_item_id: watch?.id ?? null,
    },
    position,
    hints: annotation?.hints ?? [],
    series: series.map((b) => ({ date: b.date, close: b.close })),
    high_52w: window.length ? window.map((b) => b.close).reduce((a, b) => (a.gt(b) ? a : b)) : null,
    transactions: state.txns
      .filter((t) => t.instrumentId === inst.id)
      .map((t) => transactionView(t, state)),
    theses: history.theses.map((t) => ({
      id: t.id,
      instrument_id: t.instrumentId,
      entry_type: t.entryType,
      thesis: t.thesis,
      invalidation: t.invalidation,
      exit_plan: t.exitPlan,
      size_plan: t.sizePlan,
      reviewed_at: viewTimestamp(t.reviewedAt),
      created_at: viewTimestamp(t.createdAt),
      updated_at: viewTimestamp(t.updatedAt),
      core_changed_at: viewTimestamp(t.coreChangedAt),
      exit_plan_changed_at: viewTimestamp(t.exitPlanChangedAt),
    })),
    decisions: history.decisions.map((d) => ({
      id: d.id,
      signal_id: d.signalId,
      signal_ids: d.signalIds,
      instrument_id: d.instrumentId,
      account_id: d.accountId,
      action: d.action,
      quantity: d.quantity,
      price: d.price,
      currency: d.currency,
      reason: d.reason,
      created_at: viewTimestamp(d.createdAt),
    })),
    manual_valuations: history.manualValuations.map((v) => ({
      id: v.id,
      instrument_id: v.instrumentId,
      as_of: v.asOf,
      unit_value: v.unitValue,
      currency: v.currency,
      note: v.note,
    })),
  };
}
export type PositionDetailView = ReturnType<typeof positionDetailView>;
