import { describe, expect, it } from "vitest";
import { builtinRegistry, notSubscriptionCategories, textRules } from "../../core/index.js";
import { categorize, type EngineContext, ownerDecision, txnText } from "./engine.js";
import { ruleUpsert } from "./rules.js";
import { applySeedRules, applyTextRules, CATEGORIES, SEED_RULES } from "./taxonomy.js";
import { contextFrom, EMPTY_CONTEXT, MODULE_TEXT_RULES, titled } from "./testing/engineRows.js";

const cat = (
  t: ReturnType<typeof titled>,
  subs: string[] = [],
  ctx: EngineContext = EMPTY_CONTEXT,
) => {
  const r = categorize(t, ctx, new Set(subs));
  return [r.category, r.source];
};

// tests/test_upstream_bugs.py (B1)
describe("test_upstream_bugs.py B1", () => {
  // test_b1_salary_titled_wyplata_wynagrodzenia_is_salary
  it("a salary titled WYPŁATA WYNAGRODZENIA is salary", () => {
    expect(cat(titled("9000.00", "WYPŁATA WYNAGRODZENIA ZA 08/2026"))).toEqual([
      "income_salary",
      "keyword",
    ]);
  });

  // test_b1_atm_and_cash_withdrawals_stay_cash
  it("ATM and cash withdrawals stay cash", () => {
    expect(cat(titled("-300.00", "WYPŁATA W BANKOMACIE TEST"))).toEqual(["cash", "keyword"]);
    expect(cat(titled("-200.00", "WYPŁATA GOTÓWKI TEST"))).toEqual(["cash", "keyword"]);
  });

  // test_b1_no_seed_rule_is_unreachable
  it("no seed rule is shadowed by an earlier rule of another category", () => {
    const dead: string[] = [];
    SEED_RULES.forEach((r, j) => {
      const earlier = SEED_RULES.slice(0, j).find(
        (e) => r.needle.includes(e.needle) && e.category !== r.category,
      );
      if (earlier) dead.push(`${r.needle} shadowed by ${earlier.needle}`);
    });
    expect(dead).toEqual([]);
  });

  // test_b1_sephora_is_shopping
  it("SEPHORA is shopping", () => {
    expect(applySeedRules("SEPHORA TEST KRAKOW")).toBe("shopping");
  });

  // test_short_needles_do_not_match_inside_other_words
  it("short needles do not match inside other words", () => {
    for (const [key, wrong] of [
      ["SPECSAVERS TEST KRAKOW", "utilities"],
      ["LEONARDO TEST", "utilities"],
      ["CUPCAKE STUDIO TEST", "utilities"],
      ["LINEA VERDE TEST", "utilities"],
      ["GENEALOGIA TEST", "utilities"],
      ["CARD TRANSACTION FEE TEST", "shopping"],
      ["CERAMIC STUDIO TEST", "fuel"],
      ["AVIATION MUSEUM TEST", "fuel"],
      ["VIVALDI TEST", "groceries"],
      ["DINOZAUR TEST", "groceries"],
      ["SPADEK PO DZIADKU TEST", "personal_care"],
      ["TAXAMO TEST", "other"],
      ["MELODY TEST", "dining"],
      ["KALABRIA TEST", "health"],
    ] as const) {
      expect(applySeedRules(key), key).not.toBe(wrong);
    }
  });

  // test_short_needles_still_match_as_whole_words
  it("short needles still match as whole words", () => {
    for (const [key, want] of [
      ["PEC GLIWICE TEST", "utilities"],
      ["E.ON POLSKA TEST", "utilities"],
      ["EON POLSKA TEST", "utilities"],
      ["UPC POLSKA TEST", "utilities"],
      ["INEA S.A. TEST", "utilities"],
      ["ENEA OPERATOR TEST", "utilities"],
      ["ACTION 123 KRAKOW", "shopping"],
      ["AMIC ENERGY 45 TEST", "fuel"],
      ["AVIA STACJA TEST", "fuel"],
      ["ALDI SP. Z O.O. TEST", "groceries"],
      ["DINO POLSKA 1234 TEST", "groceries"],
      ["DAY SPA TEST", "personal_care"],
      ["AXA UBEZPIECZENIA TEST", "other"],
      ["LODY TRADYCYJNE TEST", "dining"],
      ["ALAB LABORATORIA TEST", "health"],
      ["GPEC SP. Z O.O. TEST", "utilities"],
      ["OPEC TEST", "utilities"],
      ["KPEC TEST", "utilities"],
      ["LPEC TEST", "utilities"],
      ["SPEC S.A. TEST", "utilities"],
      ["ALDI1234 KRAKOW", "groceries"],
      ["DINO1234 TEST", "groceries"],
      ["ACTION1234 TEST", "shopping"],
      ["PHO 24 TEST", "dining"],
    ] as const) {
      expect(applySeedRules(key), key).toBe(want);
    }
  });

  // test_word_needles_still_refuse_letters_around_them
  it("word needles refuse letters around them", () => {
    for (const key of [
      "PHOTO TEST",
      "IPHONE TEST",
      "SPECSAVERS TEST",
      "SPECJALISTA TEST",
      "1ALDI TEST",
    ]) {
      expect(["dining", "utilities", "groceries"], key).not.toContain(applySeedRules(key));
    }
  });
});

// tests/test_upstream_bugs.py (B2, the pure parts)
describe("test_upstream_bugs.py B2", () => {
  // test_b2_loan_installment_is_not_a_subscription_category
  it("a loan installment is not a subscription", () => {
    const mortgage = titled("-3000.00", "RATA KREDYTU HIPOTECZNEGO", {
      cp: "BANK HIPOTECZNY TEST",
    });
    expect(cat(mortgage, ["BANK HIPOTECZNY TEST"])).toEqual(["loans", "keyword"]);
    expect(cat(titled("-1412.37", "SPŁATA KREDYTU"), ["SPLATA KREDYTU"])).toEqual([
      "loans",
      "keyword",
    ]);
    const rent = titled("-2500.00", "CZYNSZ ZA MIESZKANIE", { cp: "JAN TESTOWY" });
    expect(cat(rent, ["JAN TESTOWY"])).toEqual(["housing", "keyword"]);
    expect(cat(titled("-139.00", "KLUB SPORTOWY TEST"), ["KLUB SPORTOWY TEST"])).toEqual([
      "subscriptions",
      "subscription",
    ]);
  });

  // test_b2_loans_category_exists
  it("the loans category exists", () => {
    const loans = CATEGORIES.find((c) => c.key === "loans");
    expect([loans?.label, loans?.kind]).toEqual(["Raty kredytów", "expense"]);
  });
});

// tests/test_registries.py
describe("test_registries.py", () => {
  // test_categorization_hooks_come_from_modules
  it("categorization hooks come from modules", () => {
    expect(textRules(builtinRegistry())).toContainEqual(["RATA KREDYTU", "loans"]);
    expect(notSubscriptionCategories(builtinRegistry()).has("loans")).toBe(true);
    expect(applyTextRules("SPLATA RATY 05/2026", MODULE_TEXT_RULES)).toBe("loans");
    expect(applyTextRules("CZYNSZ ZA WRZESIEN", MODULE_TEXT_RULES)).toBe("housing");
  });
});

describe("engine cascade", () => {
  const LENDER = "99 1600 0000 0000 0000 0000 0555";
  const ctx = contextFrom(
    ["PL99 1140 0000 0000 0000 0000 0001"],
    [
      ["SKLEP LOCKED", "housing", "manual", true],
      ["SKLEP LLM", "subscriptions", "llm", false],
      ["", "travel", "llm", false],
    ],
    [
      ["loans", LENDER, null],
      ["loans", null, "RATA 7"],
    ],
  );

  it("structural: internal, own counterparty, FX phrases", () => {
    expect(cat(titled("-5", "X", { internal: true }), [], ctx)).toEqual(["transfer", "transfer"]);
    expect(cat(titled("-5", "X", { iban: "99114000000000000000000001" }), [], ctx)).toEqual([
      "transfer",
      "transfer",
    ]);
    expect(cat(titled("5", "TRANSAKCJA WALUTOWA"), [], ctx)).toEqual(["transfer", "transfer"]);
    expect(cat(titled("-5", "przewalutowanie"), [], ctx)).toEqual(["transfer", "transfer"]);
  });

  it("locked rule beats a pattern; a pattern beats an unlocked rule", () => {
    expect(cat(titled("-5", "SKLEP LOCKED", { iban: LENDER }), [], ctx)).toEqual([
      "housing",
      "manual",
    ]);
    expect(cat(titled("-5", "SKLEP LLM", { iban: LENDER }), [], ctx)).toEqual(["loans", "keyword"]);
    expect(cat(titled("-5", "SKLEP LLM"), [], ctx)).toEqual(["subscriptions", "llm"]);
    expect(cat(titled("5", "SKLEP LLM"), [], ctx)).toEqual(["subscriptions", "llm"]);
  });

  // PARITY(Q3): zero is an outflow; patterns apply to it.
  it("zero amounts are outflows (PARITY Q3)", () => {
    expect(cat(titled("0", "rata 7"), [], ctx)).toEqual(["loans", "keyword"]);
    expect(cat(titled("-0", "NIC"))).toEqual(["other", "default"]);
    expect(cat(titled("0.01", "NIC"))).toEqual(["income_other", "default"]);
  });

  // PARITY(Q17): an empty merchant key matches the "" rule.
  it("the empty merchant key finds the empty-key rule (PARITY Q17)", () => {
    const empty = { ...titled("-5", ""), reference: null, description: null };
    expect(cat(empty, [], ctx)).toEqual(["travel", "llm"]);
  });

  it("ownerDecision stops before unlocked rules and seeds", () => {
    expect(ownerDecision(titled("-5", "SKLEP LLM"), ctx)).toBeNull();
    expect(ownerDecision(titled("-5", "ZABKA"), ctx)).toBeNull();
    expect(ownerDecision(titled("-5", "x", { iban: LENDER }), ctx)).toEqual({
      category: "loans",
      source: "keyword",
    });
  });

  it("txnText joins reference, description and counterparty, empty ones dropped", () => {
    expect(
      txnText({ ...titled("-1", ""), reference: "a", description: "", counterpartyName: "ł b" }),
    ).toBe("A L B");
  });
});

describe("ruleUpsert (rules.py upsert_rule)", () => {
  const locked = { merchantKey: "K", category: "housing", source: "manual", locked: true } as const;
  const llm = { merchantKey: "K", category: "travel", source: "llm", locked: false } as const;
  it.each([
    [
      "new manual is locked",
      undefined,
      { category: "fuel", source: "manual" },
      { ...locked, category: "fuel" },
    ],
    [
      "new llm is unlocked",
      undefined,
      { category: "fuel", source: "llm" },
      { ...llm, category: "fuel" },
    ],
    ["llm never replaces a locked rule", locked, { category: "fuel", source: "llm" }, "keep"],
    [
      "manual replaces a locked rule",
      locked,
      { category: "fuel", source: "manual" },
      { ...locked, category: "fuel" },
    ],
    [
      "llm replaces an llm rule",
      llm,
      { category: "fuel", source: "llm" },
      { ...llm, category: "fuel" },
    ],
    [
      "explicit locked flag",
      llm,
      { category: "fuel", source: "llm", locked: true },
      { ...llm, category: "fuel", locked: true },
    ],
    [
      "manual unlocked on request",
      undefined,
      { category: "fuel", source: "manual", locked: false },
      { ...locked, category: "fuel", locked: false },
    ],
  ] as const)("%s", (_name, existing, next, want) => {
    expect(ruleUpsert(existing, "K", next)).toEqual(want);
  });
});
