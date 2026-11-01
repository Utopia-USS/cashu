/** Read-only S16 prerequisite: stored alert facts as stable message code and params. */

import { floatRepr } from "../../decimal.js";
import { pyReprStr } from "../../pyRepr.js";

const KEYS: Readonly<Record<string, readonly string[]>> = {
  price_above: ["close", "level", "currency", "price_date"],
  price_below: ["close", "level", "currency", "price_date"],
  change_pct: ["window_days", "from_close", "from_date", "close", "price_date", "threshold"],
  drawdown_from_high: [
    "drawdown",
    "threshold",
    "window_days",
    "close",
    "price_date",
    "high",
    "high_date",
  ],
  new_high: ["close", "price_date", "window_days", "previous_high"],
  sma_cross: ["close", "price_date", "direction", "window_days", "sma"],
  range_breakout: [
    "close",
    "price_date",
    "currency",
    "range_low",
    "range_high",
    "range_pct",
    "window_days",
    "max_range_pct",
    "direction",
    "breakout_pct",
  ],
  volume_spike: ["ratio", "multiple", "window_days", "close", "price_date", "currency"],
  weight_above: ["weight", "threshold", "bucket_id", "held"],
  weight_below: ["weight", "threshold", "bucket_id", "held"],
};

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return (
    value !== null &&
    value !== undefined &&
    value !== false &&
    value !== "" &&
    value !== 0 &&
    value !== 0n
  );
}

function pythonText(value: unknown, nested = false): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return nested ? pyReprStr(value) : value;
  if (typeof value === "number") return floatRepr(value);
  if (Array.isArray(value)) return `[${value.map((v) => pythonText(v, true)).join(", ")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value)
      .map(([k, v]) => `${pyReprStr(k)}: ${pythonText(v, true)}`)
      .join(", ")}}`;
  return String(value);
}

/** Mirrors alerts/messages.py; no evaluators, persistence or translated prose. */
export function alertMessage(
  signalKind: string,
  payload: Readonly<Record<string, unknown>> | null,
  message: string,
  label: string | null = null,
): readonly [string | null, Readonly<Record<string, unknown>> | null] {
  if (!signalKind.startsWith("alert:")) return [null, null];
  const kind = signalKind.slice(6);
  const data = payload ?? {};
  const title = data.title ?? null;
  const params: Record<string, unknown> = { title, label: label || (data.symbol ?? null) };
  for (const key of KEYS[kind] ?? []) {
    if (Object.hasOwn(data, key)) params[key === "price_date" ? "date" : key] = data[key];
  }
  const change = data.change;
  if (kind === "change_pct" && ["number", "bigint", "boolean"].includes(typeof change)) {
    const value = Number(change);
    params.direction = value > 0 ? "up" : "down";
    params.change = Math.abs(value);
  } else if (kind === "weight_above" || kind === "weight_below") {
    params.subject = truthy(data.bucket_id) ? "bucket" : "instrument";
  } else if (kind === "custom" || !Object.hasOwn(KEYS, kind)) {
    const prefix = truthy(title) ? `${pythonText(title)}: ` : "";
    params.detail = prefix && message.startsWith(prefix) ? message.slice(prefix.length) : message;
  }
  return [`alert.${kind}`, params];
}
