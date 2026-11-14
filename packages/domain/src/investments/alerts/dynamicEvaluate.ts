/** One-session range breaks and volume comparisons; previous sessions exclude the latest bar. */
import { D, Decimal, floatRepr, roundFloat, ZERO } from "../../decimal.js";
import { decimalText, formatDecimal, formatPct, RATIO_EPSILON } from "../rules/index.js";
import { alertStrings as s } from "./evaluate.strings.js";
import {
  basePayload,
  currency,
  fired,
  label,
  language,
  notFired,
  series,
  skip,
} from "./evaluateSupport.js";
import {
  decimalParameter,
  floatParameter,
  integerParameter,
  parameter,
  parameterText,
} from "./parameters.js";
import type { AlertCheck, AlertData, AlertDefinition } from "./types.js";

export function dynamicEvaluate(alert: AlertDefinition, data: AlertData): AlertCheck {
  const lang = language(data),
    volume = alert.kind === "volume_spike",
    n = integerParameter(parameter(alert, "window_days", volume ? 20 : 30)),
    window = series(alert, data, n + 1);
  if (typeof window === "string") return skip(alert, window);
  const last = window.at(-1);
  if (last === undefined) throw new Error("empty validated alert window");
  const previous = window.slice(0, -1),
    cur = currency(alert, last),
    name = label(alert);
  const details = {
    ...basePayload(alert),
    close: decimalText(last.close),
    price_date: last.date,
    currency: cur,
    window_days: n,
  };
  if (volume) {
    if (window.some((b) => b.volume === null)) return skip(alert, s.noVolume[lang](name));
    const sum = previous.reduce((total, b) => total + BigInt(b.volume ?? 0), 0n);
    const average = Decimal.fromInt(sum)
      .div(D(String(previous.length)))
      .toFloat();
    if (average <= 0) return skip(alert, s.zeroVolume[lang](name));
    const ratio = (last.volume ?? 0) / average,
      multiple = floatParameter(parameter(alert, "multiple", 2.5));
    const payload = {
      ...details,
      volume: last.volume,
      average_volume: roundFloat(average, 2),
      ratio: roundFloat(ratio, 6),
      multiple,
      unit: "ratio",
    };
    const value = D(floatRepr(roundFloat(ratio, 6)));
    if (ratio < multiple - RATIO_EPSILON) return notFired(alert, payload, value);
    const raw = `${D(floatRepr(ratio)).quantize(-1, "ROUND_HALF_UP").toString()}x`;
    return fired(
      alert,
      s.volume[lang](
        name,
        lang === "pl" ? raw.replace(".", ",") : raw,
        n,
        formatDecimal(last.close, lang),
        cur,
        last.date,
      ),
      payload,
      value,
    );
  }
  const low = previous.reduce((a, b) => (b.close.lt(a) ? b.close : a), previous[0]?.close ?? ZERO),
    high = previous.reduce((a, b) => (b.close.gt(a) ? b.close : a), ZERO);
  const range = high.sub(low).div(low),
    maxRange = decimalParameter(parameter(alert, "max_range_pct", 0.08)),
    direction = parameterText(parameter(alert, "direction", "any"));
  const side = last.close.gt(high) ? "up" : last.close.lt(low) ? "down" : null,
    edge = side === "up" ? high : side === "down" ? low : null;
  const breakout = edge === null ? null : last.close.div(edge).sub(D("1"));
  const payload = {
    ...details,
    range_low: decimalText(low),
    range_high: decimalText(high),
    range_pct: range.toFloat(),
    max_range_pct: maxRange.toFloat(),
    direction,
    breakout_pct: breakout?.toFloat() ?? null,
    unit: "price",
  };
  if (
    range.gt(maxRange.add(D(String(RATIO_EPSILON)))) ||
    side === null ||
    !["any", side].includes(direction)
  )
    return notFired(alert, payload, last.close);
  if (breakout === null || edge === null) throw new Error("missing breakout edge");
  const size = breakout.abs().lt(D("0.0005"))
    ? s.just[lang]
    : `${breakout.gt(ZERO) ? "+" : "-"}${formatPct(breakout.abs().toFloat(), lang)}`;
  return fired(
    alert,
    s.breakout[lang](
      name,
      n,
      size,
      side === "up",
      formatDecimal(edge, lang),
      cur,
      formatDecimal(last.close, lang),
      last.date,
    ),
    payload,
    last.close,
  );
}
