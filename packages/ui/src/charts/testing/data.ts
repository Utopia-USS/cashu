// Synthetic chart data for stories and tests (never real data): deterministic, no randomness.

/** n monthly points rising from `start` by `step` with a seasonal wobble. */
export function rising(n: number, start: number, step: number, wobble = step * 2): number[] {
  return Array.from({ length: n }, (_, i) =>
    Math.round(start + i * step + Math.sin(i / 2) * wobble),
  );
}

/** "01/25"-style month labels for n months starting at January 2025, at the given indices. */
export function monthLabels(n: number, at: number[]): { i: number; text: string }[] {
  return at
    .filter((i) => i < n)
    .map((i) => ({
      i,
      text: `${String((i % 12) + 1).padStart(2, "0")}/${25 + Math.floor(i / 12)}`,
    }));
}

/** A whole-thousands axis label ("125k"). */
export const thousands = (v: number): string => `${Math.round(v / 1000)}k`;

/** A one-decimal percentage label ("-4.2%"). */
export const pct = (v: number): string => `${v.toFixed(1)}%`;
