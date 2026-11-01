import { describe, expect, it } from "vitest";
import { D } from "../../decimal.js";
import { acceptMerchantAnswer, codePointCompare, unknownMerchants } from "./llmPass.js";
import { AUTO_CATEGORY_KEYS } from "./taxonomy.js";

describe("llm pass of categorize_all", () => {
  it("unknown merchants: outflows with a default source, no empty key, code point order (Q16)", () => {
    const rows = [
      { amount: D("-1"), merchantKey: "\u{1F600}", source: "default" },
      { amount: D("-1"), merchantKey: "Ａ", source: "default" },
      { amount: D("-1"), merchantKey: "B", source: "default" },
      { amount: D("-1"), merchantKey: "B", source: "default" },
      { amount: D("-1"), merchantKey: "", source: "default" },
      { amount: D("0"), merchantKey: "ZERO", source: "default" },
      { amount: D("5"), merchantKey: "IN", source: "default" },
      { amount: D("-1"), merchantKey: "KW", source: "keyword" },
    ];
    // UTF-16 order would put the astral U+1F600 (D83D...) before U+FF21.
    expect(unknownMerchants(rows)).toEqual(["B", "Ａ", "\u{1F600}"]);
  });

  it("codePointCompare is Python str order", () => {
    expect(["b", "a", "\u{10000}", "￿", "ab"].sort(codePointCompare)).toEqual([
      "a",
      "ab",
      "b",
      "￿",
      "\u{10000}",
    ]);
  });

  // FIX(Q9): structural answers are never cached as merchant rules.
  it("accepts AUTO keys but other, transfer and cash_withdrawal (FIX Q9)", () => {
    const accepted = AUTO_CATEGORY_KEYS.filter((k) => acceptMerchantAnswer(k) !== null);
    expect(accepted).toEqual(
      AUTO_CATEGORY_KEYS.filter((k) => !["other", "transfer", "cash_withdrawal"].includes(k)),
    );
    expect(acceptMerchantAnswer("private")).toBeNull();
    expect(acceptMerchantAnswer("UNKNOWN")).toBeNull();
    expect(acceptMerchantAnswer(undefined)).toBeNull();
  });
});
