/**
 * `@cashu/domain/core/attention`: the ranked "needs your attention" list of the overview (budget,
 * investments and freshness signals in, at most a few rows and one banner out). Its own subpath, not
 * part of `@cashu/domain/core`, so a bundle pulls it in only where the list is shown. Module-agnostic:
 * the modules' results come in as plain shapes.
 */
export * from "./attention.js";
export * from "./thresholds.js";
