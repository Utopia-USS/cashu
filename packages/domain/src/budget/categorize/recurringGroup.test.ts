// The per-group entry point of the recurring-payments detection (`detectRecurringGroup`, a store
// re-detects only the groups its changes touch) and the category a stored row is judged by
// (`storedRecurringCategory`: the stored effective category instead of an engine call per row). The
// per-group functions are checked against a frozen copy of the pre-refactor whole-book code on random
// groups in the store (`packages/store/src/budget/recurring-refactor.test.ts`). Synthetic rows only.

import { describe, expect, it } from "vitest";
import { type CategorizeRow, createCategorizer } from "./effective.js";
import { categorize, type EngineContext, txnMerchantKey } from "./engine.js";
import { detectRecurringGroup, storedRecurringCategory, TXN_DECIDED_SOURCES } from "./recurring.js";
import { contextFrom, type PatternVector, type RuleVector } from "./testing/engineRows.js";
import { row } from "./testing/rows.js";

const OWN = "PL61109010140000071219812874";
const NO_KEYS: ReadonlySet<string> = new Set();

describe("storedRecurringCategory", () => {
  it("reads decided rows as their category, the signal's answer as `other`, the rest verbatim", () => {
    expect(storedRecurringCategory("groceries", "manual_txn")).toBe("groceries");
    expect(storedRecurringCategory("cash_withdrawal", "cash_leg")).toBe("cash_withdrawal");
    expect(storedRecurringCategory("subscriptions", "subscription")).toBe("other");
    expect(storedRecurringCategory("fuel", "keyword")).toBe("fuel");
    expect(storedRecurringCategory("other", "default")).toBe("other");
    expect(storedRecurringCategory(null, null)).toBeNull();
    expect(storedRecurringCategory("", "llm_full")).toBeNull();
  });

  // Every combination of claim, merchant rule, payment pattern, own IBAN, cash account and
  // subscription flag: the stored effective category (written with the signal) read by
  // `storedRecurringCategory`, else the engine without the signal, equals what the book-based
  // detection judges the stored row by (`categorizedMember`: a decided stored source, else the engine).
  it("equals the book-based judgement of the stored effective category on every combination", () => {
    const merchants = ["ACME CLOUD", "BIEDRONKA 12", "SPOTIFY", "RATA KREDYTU 1/120"];
    const claims = [
      null,
      { category: "groceries", source: "manual_txn" },
      { category: "subscriptions", source: "llm_full" },
      { category: "cash_withdrawal", source: "llm_fallback" },
      { category: "entertainment", source: "cash_leg" },
    ] as const;
    const rules: readonly (RuleVector | null)[] = [
      null,
      ["ACME CLOUD", "entertainment", "llm", false],
      ["ACME CLOUD", "housing", "manual", true],
      ["SPOTIFY", "subscriptions", "manual", false],
    ];
    const patterns: readonly (readonly PatternVector[])[] = [[], [["loans", null, "RATA"]]];
    let checked = 0;
    for (const cp of merchants) {
      for (const claim of claims) {
        for (const rule of rules) {
          for (const pattern of patterns) {
            for (const iban of [null, OWN]) {
              for (const cash of [false, true]) {
                for (const amount of ["-23.99", "-0.00", "15.00"]) {
                  const ctx: EngineContext = contextFrom([OWN], rule ? [rule] : [], pattern);
                  const t: CategorizeRow = row({ amount, cp, iban, cash, claim });
                  for (const flagged of [false, true]) {
                    const subs = new Set(flagged ? [txnMerchantKey(t)] : []);
                    const stored = createCategorizer(ctx).effective(t, subs);
                    const engine = categorize(t, ctx, NO_KEYS).category;
                    const expected =
                      stored !== null && TXN_DECIDED_SOURCES.has(stored.source) && stored.category
                        ? stored.category
                        : engine;
                    const actual =
                      storedRecurringCategory(stored?.category ?? null, stored?.source ?? null) ??
                      engine;
                    expect(actual).toBe(expected);
                    checked++;
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(4 * 5 * 4 * 2 * 2 * 2 * 3 * 2);
  });
});

describe("detectRecurringGroup", () => {
  it("finds a drifting charge and its first-seen entry", () => {
    const found = detectRecurringGroup("ACME CLOUD", "PLN", [
      { date: "2026-07-04", amountKey: "103.00", category: "other" },
      { date: "2026-08-04", amountKey: "116.00", category: "other" },
      { date: "2026-09-04", amountKey: "116.00", category: "other" },
    ]);
    expect(found.map((f) => [f.candidate.typicalAmount.toString(), f.first])).toEqual([
      ["116.00", 0],
    ]);
  });
});
