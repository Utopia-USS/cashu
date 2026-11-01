/** Alert identities, catalog enums and pure evaluation inputs (Python alerts/catalog and evaluate). */
import type { UiLang } from "../../core/i18n.js";
import type { IsoDate } from "../../dates.js";
import type { Decimal } from "../../decimal.js";
import type { Instrument, InstrumentId, PriceBar, SignalSeverity } from "../domain/index.js";
import type { RuleContext, RuleOutcome, SignalPolarity } from "../rules/index.js";

export const AlertKind = Object.freeze({
  PRICE_ABOVE: "price_above",
  PRICE_BELOW: "price_below",
  CHANGE_PCT: "change_pct",
  DRAWDOWN_FROM_HIGH: "drawdown_from_high",
  NEW_HIGH: "new_high",
  SMA_CROSS: "sma_cross",
  WEIGHT_ABOVE: "weight_above",
  WEIGHT_BELOW: "weight_below",
  CUSTOM: "custom",
  RANGE_BREAKOUT: "range_breakout",
  VOLUME_SPIKE: "volume_spike",
} as const);
export type AlertKind = (typeof AlertKind)[keyof typeof AlertKind];
export const AlertScope = Object.freeze({
  INSTRUMENT: "instrument",
  PORTFOLIO: "portfolio",
  BUCKET: "bucket",
} as const);
export type AlertScope = (typeof AlertScope)[keyof typeof AlertScope];
export const AlertStatus = Object.freeze({
  ACTIVE: "active",
  TRIGGERED: "triggered",
  SNOOZED: "snoozed",
  MUTED: "muted",
  EXPIRED: "expired",
} as const);
export type AlertStatus = (typeof AlertStatus)[keyof typeof AlertStatus];
export const AlertSource = Object.freeze({ USER: "user", AGENT: "agent" } as const);
export type AlertSource = (typeof AlertSource)[keyof typeof AlertSource];
export const KINDS: readonly AlertKind[] = Object.freeze(Object.values(AlertKind));
export const EVALUATED_STATUSES = [AlertStatus.ACTIVE, AlertStatus.TRIGGERED] as const;
export const LIVE_STATUSES = [
  AlertStatus.ACTIVE,
  AlertStatus.TRIGGERED,
  AlertStatus.SNOOZED,
] as const;
export const PRICE_KINDS: readonly AlertKind[] = [
  AlertKind.PRICE_ABOVE,
  AlertKind.PRICE_BELOW,
  AlertKind.CHANGE_PCT,
  AlertKind.DRAWDOWN_FROM_HIGH,
  AlertKind.NEW_HIGH,
  AlertKind.SMA_CROSS,
  AlertKind.RANGE_BREAKOUT,
  AlertKind.VOLUME_SPIKE,
];
export const WEIGHT_KINDS: readonly AlertKind[] = [AlertKind.WEIGHT_ABOVE, AlertKind.WEIGHT_BELOW];
export const MAX_WINDOW_DAYS = 260;
export const MAX_CHANGE_THRESHOLD = 10;
export const MAX_TITLE_LENGTH = 120;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_TAG_LENGTH = 24;
export const MAX_EXPRESSION_LENGTH = 2000;
export const MAX_COOLDOWN_DAYS = 3650;
export const MAX_EXPIRY_DAYS = 3650;
export const BREAKOUT_WINDOW = [10, MAX_WINDOW_DAYS, 30] as const;
export const BREAKOUT_RANGE = [0.01, 0.3, 0.08] as const;
export const VOLUME_WINDOW = [5, MAX_WINDOW_DAYS, 20] as const;
export const VOLUME_MULTIPLE = [1.5, 20, 2.5] as const;

export interface ParamInfo {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly doc: string;
  readonly default: unknown;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly choices: readonly string[];
}
export interface KindInfo {
  readonly kind: AlertKind;
  readonly scopes: readonly AlertScope[];
  readonly doc: string;
  readonly unit: "price" | "ratio" | "none";
  readonly params: readonly ParamInfo[];
}
export interface AlertDefinition {
  readonly id: string;
  readonly kind: AlertKind;
  readonly scope: AlertScope;
  readonly params: Readonly<Record<string, unknown>>;
  readonly title: string;
  readonly polarity?: SignalPolarity;
  readonly severity?: SignalSeverity;
  readonly instrument?: Instrument | null;
}
export interface AlertData {
  readonly asOf: IsoDate;
  readonly bars: ReadonlyMap<InstrumentId, readonly PriceBar[]>;
  readonly maxPriceAgeDays?: number; // float-ok: a day count (Python int)
  readonly ctx?: RuleContext | null;
  readonly lang?: UiLang;
}
export interface AlertCheck {
  readonly outcome: RuleOutcome;
  readonly value: Decimal | null;
}
export const ALERT_PREFIX = "alert:";
export const alertRuleId = (id: string): string => `${ALERT_PREFIX}${id}`;
export const alertSignalKind = (kind: string): string => `${ALERT_PREFIX}${kind}`;
export const isAlertKey = (value: string | null): boolean =>
  Boolean(value?.startsWith(ALERT_PREFIX));
