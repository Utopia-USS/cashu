import { describe, expect, it } from "vitest";
import { addDays } from "../../dates.js";
import { D } from "../../decimal.js";
import { merchantKey } from "../ingestion/index.js";
import {
  type CategorizeRow,
  type ClaimSource,
  categorizeAll,
  createCategorizer,
  effectiveCategory,
} from "./effective.js";
import type { EngineContext } from "./engine.js";
import { detectRecurring, subscriptionPayees } from "./recurring.js";
import { rulesByMerchant } from "./rules.js";
import { contextFrom, EMPTY_CONTEXT } from "./testing/engineRows.js";
import { monthly, row } from "./testing/rows.js";
import { NOT_SUBSCRIPTION } from "./testing/scenarios.js";

const run = (rows: readonly CategorizeRow[], ctx: EngineContext = EMPTY_CONTEXT) =>
  categorizeAll(rows, ctx, NOT_SUBSCRIPTION);
const catOf = (rows: readonly CategorizeRow[], ctx: EngineContext = EMPTY_CONTEXT) => {
  const out = run(rows, ctx);
  return (r: CategorizeRow) => out.results.get(r.key)?.category ?? null;
};
const recurring = (rows: readonly CategorizeRow[], ctx: EngineContext = EMPTY_CONTEXT) =>
  detectRecurring(
    rows.map((r) => ({ ...r, decided: r.claim })),
    ctx,
    NOT_SUBSCRIPTION,
  );

// tests/test_ingestion.py
describe("test_ingestion.py", () => {
  // test_recurring_detects_monthly_subscription
  it("detects a monthly subscription, not variable spend at one merchant", () => {
    const rows = [0, 1, 2, 3].map((i) =>
      row({
        date: addDays("2026-01-05", 30 * i),
        amount: "-19.99",
        reference: "SPOTIFY P/WARSZAWA      DATA TRANSAKCJI: 2026-01-05",
        description: "ZAKUP PRZY UZYCIU KARTY",
      }),
    );
    const noise = ["-12.30", "-40.10", "-8.00"].map((amount, i) =>
      row({
        date: addDays("2026-01-05", 7 * i),
        amount,
        reference: "BIEDRONKA/KRAKOW        DATA TRANSAKCJI: 2026-01-05",
      }),
    );
    rows.push(...noise);
    const rec = recurring(rows);
    expect(
      rec.some((c) => c.counterparty.startsWith("SPOTIFY") && c.typicalAmount.eq(D("19.99"))),
    ).toBe(true);
    expect(rec.every((c) => !c.counterparty.includes("BIEDRONKA"))).toBe(true);
  });

  // test_categorization_and_spending (the spending sums are S10's)
  it("categorizes groceries, a subscription seed and an unknown; a merchant pin re-applies", () => {
    const rows = [
      row({
        date: "2026-05-02",
        amount: "-24.47",
        reference: "CARREFOUR EXPRESS K/KRAKOW  DATA TRANSAKCJI: 2026-05-02",
      }),
      row({ date: "2026-05-03", amount: "-19.99", reference: "NETFLIX.COM" }),
      row({ date: "2026-05-04", amount: "-50.00", reference: "JAKISTAM SKLEP XYZ" }),
    ];
    const [groceries, netflix, unknown] = rows as [CategorizeRow, CategorizeRow, CategorizeRow];
    const cat = catOf(rows);
    expect([cat(groceries), cat(netflix), cat(unknown)]).toEqual([
      "groceries",
      "subscriptions",
      "other",
    ]);
    const mk = merchantKey(null, "JAKISTAM SKLEP XYZ", null);
    const pinned = contextFrom([], [[mk, "shopping", "manual", true]], []);
    expect(catOf(rows, pinned)(unknown)).toBe("shopping");
  });

  // test_transaction_category_override_survives_recategorize
  it("a per-transaction override survives the recompute", () => {
    const plain = row({ date: "2026-05-02", amount: "-24.47", reference: "CARREFOUR EXPRESS" });
    expect(run([plain]).results.get(plain.key)).toEqual({
      category: "groceries",
      source: "keyword",
    });
    const chosen = { ...plain, claim: { category: "dining", source: "manual_txn" as const } };
    expect(run([chosen]).results.get(plain.key)).toEqual({
      category: "dining",
      source: "manual_txn",
    });
  });

  // test_spending_by_quarter_and_year (the categorization half; sums per period are S10's)
  it("both NETFLIX rows are subscriptions", () => {
    const rows = [
      row({ date: "2026-05-02", amount: "-100", reference: "NETFLIX.COM" }),
      row({ date: "2026-08-02", amount: "-50", reference: "NETFLIX.COM" }),
    ];
    const cat = catOf(rows);
    expect(rows.map(cat)).toEqual(["subscriptions", "subscriptions"]);
  });

  // test_fx_conversion_is_transfer
  it("an FX conversion is a transfer", () => {
    const fx = row({ amount: "-500", description: "OBCIĄŻ. NATYCH. TRANSAKCJA WALUT." });
    expect(run([fx]).results.get(fx.key)).toEqual({ category: "transfer", source: "transfer" });
  });
});

// tests/test_upstream_bugs.py (B2, the DB-bound parts)
describe("test_upstream_bugs.py B2", () => {
  const mix = () => ({
    mortgage: monthly("RATA KREDYTU HIPOTECZNEGO", "-3000.00", {
      cp: "BANK HIPOTECZNY TEST",
      iban: "99160000000000000000000555",
      day: 5,
    }),
    carLoan: monthly("SPŁATA KREDYTU", "-1412.37", { day: 15 }),
    rent: monthly("CZYNSZ", "-650.00", { cp: "WSPOLNOTA MIESZKANIOWA TEST", day: 3 }),
    privateRent: monthly("CZYNSZ ZA MIESZKANIE", "-2500.00", { cp: "JAN TESTOWY", day: 1 }),
    atm: monthly("WYPŁATA W BANKOMACIE TEST", "-300.00", { day: 16 }),
    fee: monthly("OPŁATA ZA KARTĘ", "-7.00", { day: 28 }),
    zus: monthly("ZUS SKLADKA TEST", "-1600.00", { day: 20 }),
    netflix: monthly("NETFLIX.COM", "-43.00", { day: 7 }),
    club: monthly("KLUB SPORTOWY TEST", "-139.00", { day: 2 }),
    spotify: monthly("SPOTIFY TEST", "-9.99", { currency: "EUR", day: 14 }),
  });

  // test_b2_detect_recurring_only_lists_subscriptions
  it("detect_recurring lists only subscriptions, per currency", () => {
    const found = recurring(Object.values(mix()).flat()).map((c) => [
      c.counterparty,
      c.currency,
      c.typicalAmount.toString(),
    ]);
    expect(found.sort()).toEqual(
      [
        ["NETFLIX.COM", "PLN", "43.00"],
        ["KLUB SPORTOWY TEST", "PLN", "139.00"],
        ["SPOTIFY TEST", "EUR", "9.99"],
      ].sort(),
    );
  });

  // test_b2_categorize_all_keeps_installments_out_of_subscriptions
  it("categorize_all keeps installments, rent and fees out of subscriptions", () => {
    const m = mix();
    const cat = catOf(Object.values(m).flat());
    const first = (rows: CategorizeRow[]) => cat(rows[0] as CategorizeRow);
    expect(first(m.mortgage)).toBe("loans");
    expect(first(m.carLoan)).toBe("loans");
    expect(first(m.rent)).toBe("housing");
    expect(first(m.privateRent)).toBe("housing");
    expect(first(m.club)).toBe("subscriptions");
    expect(first(m.netflix)).toBe("subscriptions");
  });

  // test_b2_manual_category_excludes_from_subscriptions
  it("a manual category excludes the payee from subscriptions", () => {
    const m = mix();
    const club = m.club.map((r) => ({
      ...r,
      claim: { category: "housing", source: "manual_txn" as const },
    }));
    const payees = subscriptionPayees(
      recurring([...Object.values({ ...m, club: [] }).flat(), ...club]),
    );
    expect(payees.has("KLUB SPORTOWY TEST")).toBe(false);
  });
});

// tests/test_loans.py
describe("test_loans.py", () => {
  const LENDER = "99160000000000000000000999";
  const loanPatterns = [{ category: "loans", counterpartyIban: LENDER, text: null }] as const;

  // test_installments_are_loans_not_subscriptions
  it("installments to the lender account are loans, not subscriptions", () => {
    const rows: CategorizeRow[] = [];
    for (const m of [6, 7, 8, 9]) {
      rows.push(
        row({
          date: `2026-0${m}-10`,
          amount: "-1081.94",
          reference: `PRZELEW 0${m}/2026`,
          cp: "FINANSE TEST SA",
          iban: LENDER,
        }),
      );
      rows.push(row({ date: `2026-0${m}-07`, amount: "-43.00", reference: "NETFLIX.COM" }));
    }
    const withLoan = { ...EMPTY_CONTEXT, patterns: loanPatterns };
    const out = run(rows, withLoan);
    expect(out.results.get((rows[0] as CategorizeRow).key)?.category).toBe("loans");
    expect(out.results.get((rows[1] as CategorizeRow).key)?.category).toBe("subscriptions");
    expect(out.recurring.map((c) => c.counterparty)).toEqual(["NETFLIX.COM"]);
    // without the lender account the installment looks like a subscription
    expect(run(rows).results.get((rows[0] as CategorizeRow).key)?.category).toBe("subscriptions");
  });

  const installment = row({
    date: "2026-06-10",
    amount: "-1081.94",
    reference: "PRZELEW 06/2026",
    cp: "BANK TEST SA",
    iban: LENDER,
  });
  const mk = merchantKey("BANK TEST SA", "PRZELEW 06/2026", null);

  // test_a_cached_llm_rule_does_not_beat_the_loans_payment_account
  it("a cached LLM rule does not beat the loan's payment account or title phrase", () => {
    const rules = rulesByMerchant([
      { merchantKey: mk, category: "subscriptions", source: "llm", locked: false },
    ]);
    const ctx = { ...EMPTY_CONTEXT, rules, patterns: loanPatterns };
    expect(run([installment], ctx).results.get(installment.key)).toEqual({
      category: "loans",
      source: "keyword",
    });
    const byText = {
      ...ctx,
      patterns: [{ category: "loans", counterpartyIban: null, text: "PRZELEW 06/2026" }],
    };
    expect(run([installment], byText).results.get(installment.key)?.category).toBe("loans");
  });

  // test_a_manual_merchant_rule_still_wins_over_the_loans_payment_account
  it("a manual merchant rule still wins over the loan's payment account", () => {
    const rules = rulesByMerchant([
      { merchantKey: mk, category: "housing", source: "manual", locked: true },
    ]);
    const ctx = { ...EMPTY_CONTEXT, rules, patterns: loanPatterns };
    expect(run([installment], ctx).results.get(installment.key)).toEqual({
      category: "housing",
      source: "manual",
    });
  });
});

// tests/test_reclassify.py
describe("test_reclassify.py (Q22)", () => {
  // test_merchant_pin_leaves_rows_with_their_own_decision: S24c emits the locked rule only; the
  // recompute equals Python's recategorize_merchant + categorize_all (computed with the oracle).
  it("a merchant pin derives what Python stores after recategorize_merchant + categorize_all", () => {
    const base = { cp: "SKLEP PIN TEST", iban: null };
    const rows = [
      row({ ...base, amount: "-10" }),
      row({ ...base, amount: "-20", claim: { category: "gifts", source: "manual_txn" } }),
      row({ ...base, amount: "30", claim: { category: "cash_withdrawal", source: "cash_leg" } }),
      row({ ...base, amount: "-40", internal: true }),
    ];
    const ctx = contextFrom([], [["SKLEP PIN TEST", "shopping", "manual", true]], []);
    const out = run(rows, ctx);
    expect(rows.map((r) => out.results.get(r.key))).toEqual([
      { category: "shopping", source: "manual" },
      { category: "gifts", source: "manual_txn" },
      { category: "shopping", source: "manual" },
      { category: "transfer", source: "transfer" },
    ]);
  });
});

describe("precedence (events.md 8.3)", () => {
  const OWN = "99 1000 0000 0000 0000 0000 0001";
  const LENDER = "99 5000 0000 0000 0000 0000 0005";
  const ctx = contextFrom(
    [OWN],
    [
      ["LOCKED TEST", "housing", "manual", true],
      ["UNLOCKED TEST", "travel", "llm", false],
    ],
    [["loans", LENDER, null]],
  );
  const triggers = {
    internal: [{ cp: "NIC TEST", internal: true }, ["transfer", "transfer"], true],
    ownCounterparty: [{ cp: "NIC TEST", iban: OWN }, ["transfer", "transfer"], true],
    fx: [{ cp: "PRZEWALUTOWANIE" }, ["transfer", "transfer"], true],
    lockedRule: [{ cp: "LOCKED TEST", iban: LENDER }, ["housing", "manual"], true],
    pattern: [{ cp: "UNLOCKED TEST", iban: LENDER }, ["loans", "keyword"], true],
    unlockedRule: [{ cp: "UNLOCKED TEST" }, ["travel", "llm"], false],
    seed: [{ cp: "ZABKA Z1" }, ["groceries", "keyword"], false],
    textRule: [{ cp: "NIC TEST", reference: "CZYNSZ 01" }, ["housing", "keyword"], false],
    subscription: [{ cp: "SUB TEST" }, ["subscriptions", "subscription"], false],
    none: [{ cp: "NIC TEST" }, ["other", "default"], false],
  } as const;
  const claims: (ClaimSource | null)[] = [
    null,
    "manual_txn",
    "llm_full",
    "llm_fallback",
    "cash_leg",
  ];
  const subs = new Set(["SUB TEST"]);

  for (const cash of [false, true]) {
    for (const source of claims) {
      for (const [name, [spec, engine, owner]] of Object.entries(triggers)) {
        const claim = source === null ? null : { category: "gifts", source };
        let want: readonly [string, string] | null;
        if (cash) want = claim ? ["gifts", source as string] : null;
        else if (source === "manual_txn") want = ["gifts", "manual_txn"];
        else if (source === "llm_full" || source === "llm_fallback")
          want = owner ? engine : ["gifts", source];
        else want = engine;
        it(`cash=${cash} claim=${source} ${name}`, () => {
          const r = row({ amount: "-12.00", ...spec, cash, claim });
          const got = effectiveCategory(r, ctx, subs);
          expect(got && [got.category, got.source]).toEqual(want);
        });
      }
    }
  }
});

describe("determinism and the memoized categorizer", () => {
  const rows = [
    ...monthly("NETFLIX.COM", "-43.00"),
    ...monthly("SKLEP TEST", "-20.00", { day: 9 }),
    ...monthly("CZYNSZ", "-650.00", { cp: "WSPOLNOTA TEST", day: 3 }),
    row({ amount: "100", reference: "WYNAGRODZENIE" }),
    row({ amount: "-5", reference: "ZABKA", claim: { category: "travel", source: "llm_full" } }),
  ];

  it("permuting rows changes no result", () => {
    const a = run(rows).results;
    const b = run([...rows].reverse()).results;
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
  });

  it("feeding results back as non-claims is a fixed point (claims never come from results)", () => {
    const first = run(rows).results;
    const again = run(rows.map((r) => ({ ...r, claim: r.claim }))).results;
    expect(again).toEqual(first);
  });

  it("createCategorizer equals the plain functions", () => {
    const c = createCategorizer(EMPTY_CONTEXT);
    const payees = run(rows).subscriptionPayees;
    for (const r of rows) {
      expect(c.effective(r, payees)).toEqual(effectiveCategory(r, EMPTY_CONTEXT, payees));
      expect(c.effective(r, payees)).toEqual(c.effective(r, payees));
    }
  });
});
