import { describe, expect, it } from "vitest";
import { D } from "../../decimal.js";
import { ibanKey } from "../../iban.js";
import { normalizeText } from "../../text.js";
import { merchantKey } from "../ingestion/index.js";
import { createCategorizer } from "./effective.js";
import type { EngineContext } from "./engine.js";
import {
  applyReclassify,
  isOwnerDecided,
  isStructural,
  planReclassify,
  RECLASSIFY_PATTERNS,
  type ReclassifyRow,
  signCorrect,
  txnContext,
  txnSignature,
} from "./reclassify.js";
import { rulesByMerchant } from "./rules.js";
import { contextFrom, EMPTY_CONTEXT } from "./testing/engineRows.js";
import { rrow } from "./testing/reclassifyRows.js";
import { loadMatchingData } from "./testing/vectors.js";

const answerAll = (plan: ReturnType<typeof planReclassify>, pick: (context: string) => string) =>
  new Map(plan.groups.map((g) => [g.id, { category: pick(g.context) }]));
const byKey = (rows: readonly ReclassifyRow[]) => new Map(rows.map((r) => [r.key, r]));
/** The effective category after the claims (S24c emits them as `llm_full`) and the recompute. */
function after(ctx: EngineContext, claims: { key: string; category: string }[]) {
  const c = createCategorizer(ctx);
  const claimOf = new Map(claims.map((x) => [x.key, x.category]));
  return (r: ReclassifyRow) => {
    const claimed = claimOf.get(r.key);
    const own =
      r.source === "manual_txn" && r.category
        ? { category: r.category, source: "manual_txn" as const }
        : null;
    const claim = claimed !== undefined ? { category: claimed, source: "llm_full" as const } : own;
    return c.effective({ ...r, claim }, new Set());
  };
}

// tests/test_reclassify.py
describe("test_reclassify.py", () => {
  // test_signature_groups_by_full_detail_not_merchant
  it("signatures group by full detail, not merchant", () => {
    expect(txnSignature(rrow("-10", { ref: "PayU*Allegro /Poznan" }))).not.toBe(
      txnSignature(rrow("-10", { ref: "PayU*Steam /Lux" })),
    );
    expect(
      txnSignature(rrow("-82.54", { ref: "PŁATNOŚĆ KARTĄ 82.54 PLN LIDL KOBIERZYNSKA" })),
    ).toBe(txnSignature(rrow("-19.99", { ref: "PŁATNOŚĆ KARTĄ 19.99 PLN LIDL KOBIERZYNSKA" })));
  });

  // test_structural_transactions_excluded
  it("structural transactions are excluded", () => {
    const own = new Set([ibanKey("PL11 1400 0000 0000 0000 1234")]);
    expect(isStructural(rrow("-100", { internal: true }), own)).toBe(true);
    expect(isStructural(rrow("-100", { cpIban: "PL11 1400 0000 0000 0000 1234" }), own)).toBe(true);
    expect(isStructural(rrow("-100", { cat: "transfer" }), own)).toBe(true);
    expect(isStructural(rrow("-100", { cat: "cash_withdrawal" }), own)).toBe(true);
    expect(isStructural(rrow("-50", { cat: "dining", cash: true }), own)).toBe(true);
    expect(isStructural(rrow("-30", { ref: "LIDL" }), own)).toBe(false);
  });

  // test_reclassify_applies_and_sign_guardrail
  it("applies the answers with the sign guardrail; internal transfers untouched", () => {
    const spend = rrow("-30", { ref: "LIDL", cat: "other" });
    const inflow = rrow("1500", { ref: "Jan Kowalski przelew", cat: "other" });
    const internal = rrow("-500", { ref: "own move", cat: "transfer", internal: true });
    const rows = [spend, inflow, internal];
    const plan = planReclassify(rows, EMPTY_CONTEXT);
    const { claims, fallback } = applyReclassify(
      plan,
      byKey(rows),
      answerAll(plan, (c) => (c.includes("LIDL") ? "income_salary" : "groceries")),
    );
    expect(claims).toEqual([
      { key: spend.key, category: "other" },
      { key: inflow.key, category: "income_other" },
    ]);
    expect(fallback).toEqual([]);
    expect(plan.targets).toBe(2);
  });

  // test_manual_only_categories_are_never_offered_to_the_llm
  it("owner-only and structural categories are never offered", () => {
    const plan = planReclassify(
      [rrow("-40", { ref: "PRZELEW NA TELEFON ASIA", cat: "other" })],
      EMPTY_CONTEXT,
    );
    expect(plan.allowedKeys).not.toContain("private");
    expect([...plan.allowedLabels.keys()]).not.toContain("private");
    expect(plan.allowedKeys).not.toContain("transfer");
  });

  // test_reclassify_never_overwrites_owner_decisions
  it("never overwrites owner decisions", () => {
    const manual = rrow("-25", { ref: "KWIACIARNIA ROZA", cat: "gifts", source: "manual_txn" });
    const ruled = rrow("-60", { cp: "SKLEP ZOOLOGICZNY BUREK", cat: "shopping", source: "manual" });
    const priv = rrow("-200", { ref: "ZA BILETY", cat: "private" });
    const loanRow = rrow("-700", { ref: "UMOWA 123 AUTO", cat: "loans" });
    const loanLlm = rrow("-700", {
      ref: "UMOWA 123 AUTO LUTY",
      cat: "subscriptions",
      source: "llm_full",
    });
    const phrase = rrow("-1500", { ref: "SPLATA RATY 05/2026", cat: "loans" });
    const free = rrow("-30", { ref: "LIDL", cat: "other" });
    const rows = [manual, ruled, priv, loanRow, loanLlm, phrase, free];
    const ctx = {
      ...EMPTY_CONTEXT,
      rules: rulesByMerchant([
        {
          merchantKey: "SKLEP ZOOLOGICZNY BUREK",
          category: "shopping",
          source: "manual",
          locked: true,
        },
      ]),
      patterns: [
        { category: "loans", counterpartyIban: null, text: normalizeText("UMOWA 123 AUTO") },
      ],
    };
    const plan = planReclassify(rows, ctx);
    const { claims } = applyReclassify(
      plan,
      byKey(rows),
      answerAll(plan, () => "entertainment"),
    );
    const eff = after(ctx, claims);
    expect([eff(manual), eff(ruled)]).toEqual([
      { category: "gifts", source: "manual_txn" },
      { category: "shopping", source: "manual" },
    ]);
    expect(priv.category).toBe("private"); // owner-decided: never planned, no claim
    expect(claims.map((c) => c.key)).not.toContain(priv.key);
    expect([eff(loanRow)?.category, eff(loanLlm)?.category]).toEqual(["loans", "loans"]);
    expect([eff(phrase)?.category, eff(free)?.category]).toEqual([
      "entertainment",
      "entertainment",
    ]);
    expect([plan.targets, plan.configured.length]).toEqual([2, 2]);
  });

  // test_fallback_rows_stay_open_to_a_later_loan_pattern
  it("an unanswered group gets no claim, so a later loan pattern applies", () => {
    const row = rrow("-900", { ref: "PRZELEW BANK XYZ 4711", cat: "other" });
    const plan = planReclassify([row], EMPTY_CONTEXT);
    const { claims, fallback } = applyReclassify(plan, byKey([row]), new Map());
    expect([claims, fallback]).toEqual([[], [row.key]]);
    const withLoan = {
      ...EMPTY_CONTEXT,
      patterns: [
        { category: "loans", counterpartyIban: null, text: normalizeText("BANK XYZ 4711") },
      ],
    };
    expect(after(withLoan, claims)(row)?.category).toBe("loans");
  });

  // test_categorize_all_applies_a_loan_pattern_to_llm_rows
  it("a loan pattern applies to llm rows; other llm rows keep their answer", () => {
    const leasing = rrow("-900", { ref: "UMOWA 9 LEASING AUTA" });
    const keep = rrow("-40", { ref: "NETFLIX" });
    const ctx = {
      ...EMPTY_CONTEXT,
      patterns: [
        { category: "loans", counterpartyIban: null, text: normalizeText("UMOWA 9 LEASING") },
      ],
    };
    const eff = after(ctx, [
      { key: leasing.key, category: "subscriptions" },
      { key: keep.key, category: "entertainment" },
    ]);
    expect([eff(leasing)?.category, eff(keep)?.category]).toEqual(["loans", "entertainment"]);
  });

  // test_categorize_all_keeps_llm_answers_over_global_installment_phrases
  it("llm answers beat global installment phrases", () => {
    const row = rrow("-300", { ref: "RATA KREDYTU RATALNEGO SKLEP TEST" });
    expect(after(EMPTY_CONTEXT, [{ key: row.key, category: "shopping" }])(row)?.category).toBe(
      "shopping",
    );
  });

  // test_structural_answer_beats_owner_configuration_on_llm_rows
  it("a structural answer beats owner configuration on llm rows", () => {
    const internal = rrow("-700", { ref: "UMOWA 77 AUTO", internal: true });
    const toOwn = rrow("-50", { cp: "SKLEP RULE TEST", cpIban: "PL99 1240 0000 0000 0000 3334" });
    const fx = rrow("-100", { ref: "TRANSAKCJA WALUTOWA UMOWA 77 AUTO" });
    const ctx = {
      ...contextFrom(
        ["PL99 1140 0000 0000 0000 3333", "PL99 1240 0000 0000 0000 3334"],
        [[merchantKey("SKLEP RULE TEST"), "gifts", "manual", true]],
        [],
      ),
      patterns: [
        { category: "loans", counterpartyIban: null, text: normalizeText("UMOWA 77 AUTO") },
      ],
    };
    const c = createCategorizer(ctx);
    expect(
      c.effective(
        { ...internal, claim: { category: "subscriptions", source: "llm_full" } },
        new Set(),
      )?.category,
    ).toBe("transfer");
    expect(
      c.effective({ ...toOwn, claim: { category: "shopping", source: "llm_full" } }, new Set())
        ?.category,
    ).toBe("transfer");
    expect(
      c.effective({ ...fx, claim: { category: "other", source: "llm_fallback" } }, new Set())
        ?.category,
    ).toBe("transfer");
  });
});

describe("reclassify pieces", () => {
  it("signCorrect (reclassify.py:204-216)", () => {
    expect(signCorrect("cash_withdrawal", D("-5"))).toBe("cash");
    expect(signCorrect("transfer", D("-5"))).toBe("other");
    expect(signCorrect("transfer", D("5"))).toBe("income_other");
    expect(signCorrect("groceries", D("0"))).toBe("groceries");
    expect(signCorrect("income_refund", D("0"))).toBe("income_refund");
    expect(signCorrect("income_refund", D("-1"))).toBe("other");
  });

  it("isOwnerDecided: owner sources and owner-only categories", () => {
    expect(isOwnerDecided({ category: "x", source: "cash_leg" })).toBe(true);
    expect(isOwnerDecided({ category: "private", source: "keyword" })).toBe(true);
    expect(isOwnerDecided({ category: "other", source: "llm_full" })).toBe(false);
  });

  it("context: no text at all is surfaced; -0 vs 0 keeps the first (Q14)", () => {
    const empty = rrow("-0");
    expect(txnContext(empty, [D("-0"), D("0")])).toBe(
      "Odbiorca/nadawca: (brak danych)\nKwota: -0.00 PLN (wydatek)",
    );
    expect(txnContext(empty, [D("0"), D("-0")])).toBe(
      "Odbiorca/nadawca: (brak danych)\nKwota: 0.00 PLN (wydatek)",
    );
  });

  it("limit, date range and the representative (longest text, first wins)", () => {
    const rows = [
      rrow("-1", { ref: "A", date: "2026-01-01" }),
      rrow("-2", { ref: "B", date: "2026-02-01" }),
      rrow("-3", { ref: "B 1234567", date: "2026-02-02" }),
      rrow("-4", { ref: "C", date: "2026-03-01" }),
    ];
    const plan = planReclassify(rows, EMPTY_CONTEXT, {
      dateFrom: "2026-02-01",
      dateTo: "2026-03-01",
      limit: 1,
    });
    expect(plan.targets).toBe(3);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.id).toBe("t0");
    expect(plan.groups[0]?.context).toBe(
      "Tytuł: B 1234567\nKwoty (2× wyst.): od -3.00 do -2.00 PLN (wydatki)",
    );
  });

  it("the regex sources and flags are Python's (matching data)", () => {
    const { data } = loadMatchingData();
    const re = data.reclassifyRegexes;
    const IGNORECASE = 2 | 32; // re.IGNORECASE | re.UNICODE
    expect(re._DATES).toEqual([RECLASSIFY_PATTERNS.dates, IGNORECASE]);
    expect(re._CARD).toEqual([RECLASSIFY_PATTERNS.card, 32]);
    expect(re._AMOUNT).toEqual([RECLASSIFY_PATTERNS.amount, IGNORECASE]);
    expect(re._LONGNUM).toEqual([RECLASSIFY_PATTERNS.longNum, 32]);
    expect(re._WS).toEqual([RECLASSIFY_PATTERNS.ws, 32]);
    for (const lit of [
      "Odbiorca/nadawca: ",
      "Tytuł: ",
      "Opis: ",
      "wpływ",
      "wydatek",
      "wpływy",
      "wydatki",
      "mieszane",
      "Odbiorca/nadawca: (brak danych)",
    ]) {
      expect(
        data.contextLiterals.some((l) => l.includes(lit)),
        lit,
      ).toBe(true);
    }
  });
});
