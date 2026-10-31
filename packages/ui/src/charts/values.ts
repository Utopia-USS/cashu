// Value text of the charts: privacy masking, the default number format and the accessible summaries.
// Pure (the language and locale come from @cashu/i18n, privacy is a parameter).
import { intlLocale } from "@cashu/i18n";
import { S } from "./charts.strings.js";
import type { ValueKind } from "./types.js";

/** Shown in place of an amount in privacy mode. */
export const MASK = "•••";

/** True when values of this kind are hidden. */
export const hides = (kind: ValueKind | undefined, privacy: boolean): boolean =>
  privacy && (kind ?? "amount") === "amount";

/** A whole number in the UI locale ("12 500" in Polish). */
export function wholeNumber(v: number): string {
  return new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 0 }).format(v);
}

/** A share of a total as a whole percentage in the UI locale. */
export function percent(part: number, total: number): string {
  const f = new Intl.NumberFormat(intlLocale(), { style: "percent", maximumFractionDigits: 0 });
  return f.format(total > 0 ? part / total : 0);
}

/** "name: latest X, low Y, high Z" for the finite values, or null when there are none. Hidden values are
 * spoken as "hidden", never as digits. */
export function seriesSummary(
  name: string,
  values: readonly (number | null | undefined)[],
  format: (v: number) => string,
  hidden: boolean,
): string | null {
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  const last = finite[finite.length - 1];
  if (last == null) return null;
  const say = (v: number) => (hidden ? S.hidden : format(v));
  return S.seriesSummary(name, say(last), say(Math.min(...finite)), say(Math.max(...finite)));
}

/** The accessible name of a chart: its label, the x range and one part per series. */
export function chartSummary(
  label: string,
  parts: readonly (string | null)[],
  xLabels?: readonly { text: string }[],
): string {
  const first = xLabels?.[0]?.text;
  const lastX = xLabels?.[xLabels.length - 1]?.text;
  const range = first != null && lastX != null && first !== lastX ? S.range(first, lastX) : null;
  const body = parts.filter((p): p is string => p != null);
  if (!body.length) return `${label}: ${S.noData}`;
  return [label, range, ...body].filter((p) => p != null).join(". ");
}

/** A tooltip with its amount values masked in privacy mode. */
export function maskTip<T extends { rows: { value: string; amount?: boolean }[] }>(
  tip: T,
  privacy: boolean,
): T {
  return privacy
    ? { ...tip, rows: tip.rows.map((r) => (r.amount ? { ...r, value: MASK } : r)) }
    : tip;
}
