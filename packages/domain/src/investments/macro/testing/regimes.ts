/** The synthetic regime of the card text tests (`test_p7_texts.regime`). */

import type { IsoDate } from "../../../dates.js";
import { macroStrings, regimeMeanings } from "../macro.strings.js";
import {
  type Regime,
  type RegimeKey,
  regime,
  regimeLabel,
  STATE_TONES,
  stateLabel,
} from "../regimes.js";
import { type MetricRow, metricsOf } from "./fixtures.js";

const SINCE: IsoDate = "2025-05-12";

const METRICS: Readonly<Record<RegimeKey, readonly MetricRow[]>> = {
  risk: [
    ["ACWI wobec 200 sesji", 0.04, "pct"],
    ["od szczytu", -0.017, "pct"],
  ],
  dollar: [
    ["DXY", 98.4, "level"],
    ["6 mies.", 0.041, "pct"],
    ["USD/PLN 6 mies.", 0.02, "pct"],
  ],
  em: [
    ["EEM wobec ACWI 6 mies.", 6.2, "pp"],
    ["EEM 6 mies.", 0.081, "pct"],
  ],
  commodities: [
    ["DBC 12 mies.", 0.5, "pct"],
    ["wobec ACWI 12 mies.", 32.1, "pp"],
  ],
  rates: [
    ["USA 10 lat", 4.62, "level"],
    ["3 mies. zmiana", 45, "bp"],
    ["krzywa 10l-3m", 20, "bp"],
  ],
};

/** The Polish meaning of a state (`MEANINGS[key][state]`). */
function meaningPl(key: RegimeKey, state: string): string {
  const id = `${key}.${state}`;
  return Object.hasOwn(regimeMeanings, id)
    ? ((regimeMeanings as Record<string, { pl: string }>)[id]?.pl ?? "")
    : macroStrings.unknownMeaning.pl;
}

/** A regime in `state` since `SINCE` with the default metrics of its card, then `changes`. */
export function textRegime(
  key: RegimeKey,
  state: string,
  options: { readonly metrics?: readonly MetricRow[] } & Partial<Omit<Regime, "metrics">> = {},
): Regime {
  const { metrics, ...changes } = options;
  return regime({
    key,
    label: regimeLabel(key),
    state,
    stateLabel: stateLabel(key, state, "pl"),
    tone: STATE_TONES[key][state] ?? "",
    since: SINCE,
    metrics: metricsOf(metrics ?? METRICS[key]),
    asOf: "2026-10-09",
    stale: false,
    missing: false,
    meaning: meaningPl(key, state),
    ...changes,
  });
}

/** Every (regime, state) pair (`ALL`). */
export const ALL: readonly (readonly [RegimeKey, string])[] = (
  Object.entries(STATE_TONES) as [RegimeKey, Readonly<Record<string, string>>][]
).flatMap(([key, states]) => Object.keys(states).map((state) => [key, state] as const));
