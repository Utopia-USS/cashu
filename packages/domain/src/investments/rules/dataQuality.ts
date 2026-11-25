/** Shared data-quality refusal precedence from Python rules/kinds/support.py. */
import type { UiLang } from "../../core/i18n.js";
import { ZERO } from "../../decimal.js";
import { isGenericBucket } from "../domain/buckets.js";
import { pySum } from "../performance/index.js";
import type { RuleContext } from "./context.js";
import { daysPhrase, formatDecimal, formatPct } from "./format.js";
import { instrumentLabel, sortedLabels } from "./positions.js";
import { supportStrings as s } from "./support.strings.js";
export const RATIO_EPSILON = 1e-9;
export function portfolioDataProblem(ctx: RuleContext): string | null {
  return (
    portfolioValueProblem(ctx) ?? (ctx.portfolio.totalBase.lte(ZERO) ? s.noValue[ctx.lang] : null)
  );
}
export function portfolioValueProblem(ctx: RuleContext): string | null {
  const fx = missingFxProblem(ctx);
  if (fx !== null) return fx;
  const unpriced = ctx.portfolio.valued.filter((h) => h.marketValueBase === null);
  if (unpriced.length)
    return s.missingPrices[ctx.lang](
      unpriced.length,
      sortedLabels(new Set(unpriced.map((h) => instrumentLabel(h.instrument)))).join(", "),
    );
  if (ctx.portfolio.staleWeight > ctx.data.maxStaleWeight + RATIO_EPSILON)
    return s.staleShare[ctx.lang](
      formatPct(ctx.portfolio.staleWeight, ctx.lang),
      formatPct(ctx.data.maxStaleWeight, ctx.lang),
    );
  return null;
}
export function missingFxProblem(ctx: RuleContext): string | null {
  const p = ctx.portfolio;
  if (!p.missingFxCurrencies.size) return null;
  const holdings = sortedLabels(
    new Set(
      p.valued
        .filter((h) => h.missingFxCurrency !== null)
        .map((h) => instrumentLabel(h.instrument)),
    ),
  );
  const cash = p.cash.filter((c) => c.amountBase === null).length;
  const affected: string[] = [];
  if (holdings.length)
    affected.push(s.affectedHoldings[ctx.lang](holdings.length, holdings.join(", ")));
  if (cash) affected.push(s.affectedCash[ctx.lang](cash));
  return s.missingFx[ctx.lang](
    sortedLabels(p.missingFxCurrencies).join(", "),
    p.baseCurrency,
    p.snapshot.asOf,
    daysPhrase(ctx.data.maxFxAgeDays, ctx.lang),
    affected.join(s.conjunction[ctx.lang]),
  );
}
export function unclassifiedProblem(ctx: RuleContext): string | null {
  if (!ctx.unclassified.length) return null;
  const share = pySum(ctx.unclassified.map((h) => h.weight ?? 0));
  if (share <= ctx.data.maxUnclassifiedWeight + RATIO_EPSILON) return null;
  const names = sortedLabels(
    new Set(ctx.unclassified.map((h) => instrumentLabel(h.instrument))),
  ).join(", ");
  return s.unclassified[ctx.lang](
    formatPct(share, ctx.lang),
    formatPct(ctx.data.maxUnclassifiedWeight, ctx.lang),
    names,
  );
}
export function bucketNamed(word: string, bucketId: string): string {
  return isGenericBucket(bucketId) ? `${word} ${bucketId}` : word;
}
export function bucketWord(lang: UiLang): string {
  return s.bucket[lang];
}
export function noAllocations(lang: UiLang): string {
  return s.noAllocations[lang];
}
export function noAllocationProblem(bucketId: string, lang: UiLang): string {
  return s.noAllocation[lang](bucketNamed(s.ofBucket[lang], bucketId));
}
export function bucketCashGapProblem(bucketId: string, lang: UiLang): string {
  return s.bucketCashGap[lang](bucketNamed(bucketWord(lang), bucketId));
}
export function cashHistoryProblem(ctx: RuleContext): string | null {
  const gaps = ctx.portfolio.snapshot.warnings.filter((w) => w.kind === "cash_history_gap");
  if (!gaps.length) return null;
  const listed = gaps
    .map(
      (g) =>
        `${formatDecimal(g.amount, ctx.lang)} ${g.currency} ${s.onAccount[ctx.lang]} ${g.accountId}`,
    )
    .join(", ");
  return s.cashHistory[ctx.lang](listed);
}
export function staleCloseProblem(label: string, date: string, age: number, lang: UiLang): string {
  return s.staleClose[lang](label, date, daysPhrase(age, lang));
}
export function shortSeriesProblem(
  label: string,
  stored: number,
  needed: number,
  lang: UiLang,
): string {
  return s.shortSeries[lang](label, stored, needed);
}
