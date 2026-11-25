/** Shared evaluation mechanics; no policy is persisted here. */
import type { UiLang } from "../../core/i18n.js";
import { daysBetween } from "../../dates.js";
import { type Decimal, ZERO } from "../../decimal.js";
import { fetchesMarketData, type PriceBar } from "../domain/index.js";
import { Fired, NotFired, Skipped, shortSeriesProblem, staleCloseProblem } from "../rules/index.js";
import { alertStrings as s } from "./evaluate.strings.js";
import {
  type AlertCheck,
  type AlertData,
  type AlertDefinition,
  alertRuleId,
  alertSignalKind,
} from "./types.js";
export const language = (data: AlertData): UiLang => data.lang ?? data.ctx?.lang ?? "pl";
export const label = (alert: AlertDefinition): string =>
  alert.instrument?.symbol || alert.instrument?.name || "";
export const currency = (alert: AlertDefinition, bar: PriceBar): string =>
  bar.currency ?? alert.instrument?.currency ?? "";
export const skip = (alert: AlertDefinition, reason: string): AlertCheck => ({
  outcome: new Skipped(alertRuleId(alert.id), reason),
  value: null,
});
export const notFired = (
  alert: AlertDefinition,
  details: Readonly<Record<string, unknown>>,
  value: Decimal | null,
): AlertCheck => ({
  outcome: new NotFired(alertRuleId(alert.id), alertRuleId(alert.id), details),
  value,
});
export function fired(
  alert: AlertDefinition,
  detail: string,
  payload: Readonly<Record<string, unknown>>,
  value: Decimal | null,
): AlertCheck {
  const key = alertRuleId(alert.id);
  return {
    outcome: new Fired({
      ruleId: key,
      kind: alertSignalKind(alert.kind),
      dedupKey: key,
      severity: alert.severity ?? "info",
      message: `${alert.title}: ${detail}`,
      instrumentId: alert.instrument?.id ?? null,
      accountId: null,
      payload,
      polarity: alert.polarity ?? "neutral",
    }),
    value,
  };
}
export function basePayload(alert: AlertDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {
    alert_id: alert.id,
    alert_kind: alert.kind,
    title: alert.title,
    scope: alert.scope,
  };
  if (alert.instrument != null) {
    out.instrument_id = alert.instrument.id;
    out.symbol = alert.instrument.symbol;
  }
  return out;
}
export function series(
  alert: AlertDefinition,
  data: AlertData,
  needed: number,
): readonly PriceBar[] | string {
  const inst = alert.instrument,
    lang = language(data),
    name = label(alert);
  if (inst == null) return s.noInstrument[lang];
  if (!fetchesMarketData(inst)) return s.status[lang](name, inst.status);
  const bars = (data.bars.get(inst.id) ?? []).filter((b) => b.date <= data.asOf);
  const last = bars.at(-1);
  if (last === undefined) return s.noPrices[lang](name);
  const age = daysBetween(last.date, data.asOf);
  if (age > (data.maxPriceAgeDays ?? 5)) return staleCloseProblem(name, last.date, age, lang);
  if (bars.length < needed) return shortSeriesProblem(name, bars.length, needed, lang);
  const window = bars.slice(-needed);
  if (window.some((b) => b.close.lte(ZERO))) return s.invalidPrices[lang](name);
  return window;
}
