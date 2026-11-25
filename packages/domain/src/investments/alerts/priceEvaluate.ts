/** Six close/window alert kinds with exact Decimal measurement. */
import { D, ZERO } from "../../decimal.js";
import type { PriceBar } from "../domain/index.js";
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
import { decimalParameter, integerParameter, parameter, parameterText } from "./parameters.js";
import type { AlertCheck, AlertData, AlertDefinition } from "./types.js";
export function priceEvaluate(alert: AlertDefinition, data: AlertData): AlertCheck {
  const lang = language(data),
    kind = alert.kind,
    n =
      kind === "price_above" || kind === "price_below"
        ? 0
        : integerParameter(parameter(alert, "window_days"));
  const needed =
    kind === "price_above" || kind === "price_below" ? 1 : kind === "change_pct" ? n + 1 : n;
  const bars = series(alert, data, needed);
  if (typeof bars === "string") return skip(alert, bars);
  const last = bars.at(-1);
  if (last === undefined) throw new Error("empty validated alert window");
  const payload = { ...basePayload(alert), close: decimalText(last.close), price_date: last.date };
  const shown = (v: typeof last.close) => formatDecimal(v, lang),
    name = label(alert);
  switch (kind) {
    case "price_above":
    case "price_below": {
      const level = decimalParameter(parameter(alert, "level")),
        above = kind === "price_above",
        cur = currency(alert, last);
      const details = { ...payload, level: decimalText(level), currency: cur, unit: "price" };
      if (!(above ? last.close.gt(level) : last.close.lt(level)))
        return notFired(alert, details, last.close);
      return fired(
        alert,
        s.price[lang](name, shown(last.close), cur, last.date, above, shown(level)),
        details,
        last.close,
      );
    }
    case "change_pct": {
      const first = bars[0] as PriceBar,
        change = last.close.div(first.close).sub(D("1")),
        threshold = decimalParameter(parameter(alert, "threshold")),
        direction = parameterText(parameter(alert, "direction", "any")),
        eps = D(String(RATIO_EPSILON));
      const hit =
        direction === "up"
          ? change.gte(threshold.sub(eps))
          : direction === "down"
            ? change.lte(threshold.neg().add(eps))
            : change.abs().gte(threshold.sub(eps));
      const details = {
        ...payload,
        change: change.toFloat(),
        threshold: threshold.toFloat(),
        direction,
        window_days: n,
        from_close: decimalText(first.close),
        from_date: first.date,
        unit: "ratio",
      };
      if (!hit) return notFired(alert, details, change);
      const size = `${change.gt(ZERO) ? "+" : "-"}${formatPct(change.abs().toFloat(), lang)}`;
      return fired(
        alert,
        s.change[lang](name, size, n, shown(first.close), first.date, shown(last.close), last.date),
        details,
        change,
      );
    }
    case "drawdown_from_high": {
      const high = bars.reduce((a, b) => (b.close.gt(a.close) ? b : a)),
        drawdown = high.close.sub(last.close).div(high.close),
        threshold = decimalParameter(parameter(alert, "threshold"));
      const details = {
        ...payload,
        drawdown: drawdown.toFloat(),
        threshold: threshold.toFloat(),
        window_days: n,
        high: decimalText(high.close),
        high_date: high.date,
        unit: "ratio",
      };
      if (drawdown.lt(threshold.sub(D(String(RATIO_EPSILON)))))
        return notFired(alert, details, drawdown);
      return fired(
        alert,
        s.drawdown[lang](
          name,
          formatPct(drawdown.toFloat(), lang),
          n,
          shown(last.close),
          last.date,
          shown(high.close),
          high.date,
        ),
        details,
        drawdown,
      );
    }
    case "new_high": {
      const previous = bars.slice(0, -1).reduce((a, b) => (b.close.gt(a) ? b.close : a), ZERO);
      const details = {
        ...payload,
        previous_high: decimalText(previous),
        window_days: n,
        unit: "price",
      };
      if (last.close.lte(previous)) return notFired(alert, details, last.close);
      return fired(
        alert,
        s.high[lang](name, n, shown(last.close), last.date, shown(previous)),
        details,
        last.close,
      );
    }
    case "sma_cross": {
      const sma = bars.reduce((a, b) => a.add(b.close), ZERO).div(D(String(bars.length))),
        above = alert.params.direction === "above",
        rounded = sma.quantize(-4);
      const details = {
        ...payload,
        sma: decimalText(rounded),
        direction: above ? "above" : "below",
        window_days: n,
        unit: "price",
      };
      if (!(above ? last.close.gt(sma) : last.close.lt(sma)))
        return notFired(alert, details, last.close);
      return fired(
        alert,
        s.sma[lang](name, shown(last.close), last.date, above, n, shown(rounded)),
        details,
        last.close,
      );
    }
    default:
      throw new Error("not a close/window alert kind");
  }
}
