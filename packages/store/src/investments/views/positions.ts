/** Native position services assemble actual vault facts before invoking shared pure projectors. */
import { addDays, D } from "@cashu/domain";
import {
  asAccountId,
  asInstrumentId,
  type InstrumentId,
  toCurrency,
  views,
} from "@cashu/domain/investments";
import { loadInstrument } from "../queries/instruments.js";
import { decisionSignalGids, decisions, theses } from "../queries/journal.js";
import { instrumentGid, type Read, storedTime } from "../queries/shared.js";
import { manualValuations } from "../queries/transactions.js";
import { type PortfolioViewRequest, portfolioViewInputs } from "./portfolio.js";

export function readPositions(read: Read, request: PortfolioViewRequest) {
  const input = portfolioViewInputs(read, request);
  return input.ok ? { ok: true as const, value: views.positionsView(input.value) } : input;
}
export function readAllocation(read: Read, request: PortfolioViewRequest) {
  const input = portfolioViewInputs(read, request);
  return input.ok ? { ok: true as const, value: views.allocationView(input.value) } : input;
}

export function positionHistory(read: Read, instrument: InstrumentId): views.PositionHistory {
  const decisionRows = decisions(read, { instrument });
  const links = decisionSignalGids(
    read,
    decisionRows.map((row) => row.gid),
  );
  const manualIds = new Map(
    read<{ gid: string; asOf: string }>(
      `SELECT v.gid, v.as_of AS asOf FROM inv_manual_valuations v JOIN inv_instruments i ON i.id=v.instrument_id WHERE i.gid=?`,
      instrument,
    ).map((row) => [row.asOf, row.gid]),
  );
  return {
    theses: theses(read, instrument).map((row) => ({
      id: row.gid,
      instrumentId: asInstrumentId(row.instrument),
      entryType: row.entryType,
      thesis: row.thesis,
      invalidation: row.invalidation,
      exitPlan: row.exitPlan,
      sizePlan: row.sizePlan,
      reviewedAt: row.reviewedAt === null ? null : storedTime(row.reviewedAt),
      createdAt: storedTime(row.createdAt),
      updatedAt: storedTime(row.updatedAt),
      coreChangedAt: storedTime(row.coreChangedAt ?? row.updatedAt),
      exitPlanChangedAt: row.exitPlanChangedAt === null ? null : storedTime(row.exitPlanChangedAt),
    })),
    decisions: decisionRows.map((row) => ({
      id: row.gid,
      signalId: row.signal,
      signalIds: links.get(row.gid) ?? [],
      instrumentId: row.instrument === null ? null : asInstrumentId(row.instrument),
      accountId: row.account === null ? null : asAccountId(row.account),
      action: row.action,
      quantity: row.quantity === null ? null : D(row.quantity),
      price: row.price === null ? null : D(row.price),
      currency: row.currency === null ? null : toCurrency(row.currency),
      reason: row.reason,
      createdAt: storedTime(row.createdAt),
    })),
    manualValuations: manualValuations(read, [instrument]).map((row) => {
      const id = manualIds.get(row.asOf);
      if (id === undefined) throw new Error("missing canonical valuation identity");
      return { ...row, id };
    }),
  };
}
export function readPositionDetail(
  read: Read,
  request: PortfolioViewRequest & { readonly instrument: InstrumentId },
) {
  const canonical = instrumentGid(read, request.instrument);
  if (canonical === undefined) return { ok: false as const, reason: "unknown_instrument" as const };
  const id = asInstrumentId(canonical);
  const input = portfolioViewInputs(read, {
    ...request,
    instrumentIds: [...(request.instrumentIds ?? []), id],
  });
  if (!input.ok) return input;
  const instrument = loadInstrument(read, id);
  if (instrument === undefined)
    return { ok: false as const, reason: "unknown_instrument" as const };
  const chartBars = input.value.state.historyBars.get(id) ?? [];
  const detailBars = chartBars.filter((bar) => bar.date >= addDays(request.asOf, -730));
  return {
    ok: true as const,
    value: views.positionDetailView({
      ...input.value,
      instrument,
      detailBars,
      chartBars,
      history: positionHistory(read, id),
    }),
  };
}
export function readPositionChart(
  read: Read,
  request: PortfolioViewRequest & { readonly instrument: InstrumentId; readonly months?: number },
) {
  const canonical = instrumentGid(read, request.instrument);
  if (canonical === undefined) return { ok: false as const, reason: "unknown_instrument" as const };
  const id = asInstrumentId(canonical);
  const input = portfolioViewInputs(read, {
    ...request,
    instrumentIds: [...(request.instrumentIds ?? []), id],
  });
  if (!input.ok) return input;
  const instrument = loadInstrument(read, id);
  if (instrument === undefined)
    return { ok: false as const, reason: "unknown_instrument" as const };
  return {
    ok: true as const,
    value: views.positionChartView({
      ...input.value,
      instrument,
      bars: input.value.state.historyBars.get(id) ?? [],
      ...(request.months === undefined ? {} : { months: request.months }),
    }),
  };
}
