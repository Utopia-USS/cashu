import { setLanguageForTests } from "@cashu/i18n";
import { isShownSignal } from "@cashu/ui-logic/investments/buckets";
import type { DisplayEnv } from "../today/display";
import { type SignalSubject, safeText, signalText } from "./signalText";

const cdr: SignalSubject = { name: "CD Projekt", currency: "PLN", baseCurrency: "PLN" };
const enUS: DisplayEnv = { locale: "en-US", privacy: false };
const plPL: DisplayEnv = { locale: "pl-PL", privacy: false };
const drop = {
  kind: "alert:change_pct",
  message:
    "CDR -8% in 5 sessions: CDR: -9.4% in 5 sessions (236.87 2026-11-05 -> 214.6 2026-11-12).",
  payload: { change: -0.094, window_days: 5, from_close: "236.87", close: "214.6" },
};
const heavy = {
  kind: "position_concentration",
  message: "CDR: 7.5% of the portfolio (max 5.0%).",
  payload: { weight: 0.075, max_weight: 0.05 },
};

afterEach(() => setLanguageForTests("en"));

describe("signalText", () => {
  it("reads a price move and a concentration in English", () => {
    setLanguageForTests("en");
    expect(signalText(drop, cdr, enUS)).toBe(
      "CD Projekt fell 9.4% in 5 sessions (PLN 236.87 → PLN 214.60)",
    );
    expect(
      signalText(
        { ...drop, payload: { ...drop.payload, change: 0.021, window_days: 1 } },
        cdr,
        enUS,
      ),
    ).toBe("CD Projekt rose 2.1% in 1 session (PLN 236.87 → PLN 214.60)");
    expect(signalText(heavy, cdr, enUS)).toBe(
      "CD Projekt is 7.5% of the portfolio (your limit 5%)",
    );
    expect(signalText({ ...heavy, payload: { weight: 0.12, max_weight: 0.125 } }, cdr, enUS)).toBe(
      "CD Projekt is 12.0% of the portfolio (your limit 12.5%)",
    );
  });

  it("reads them in Polish", () => {
    setLanguageForTests("pl");
    expect(signalText(drop, cdr, plPL)).toBe(
      "CD Projekt: spadek o 9,4% w ciągu 5 sesji (236,87 zł → 214,60 zł)",
    );
    expect(signalText(heavy, cdr, plPL)).toBe("CD Projekt to 7,5% portfela (Twój limit: 5%)");
  });

  const cases = (
    kind: string,
    payload: Record<string, unknown>,
    en: string,
    pl: string,
    subject = cdr,
    message = "raw",
  ) => ({ row: { kind, message, payload }, en, pl, subject });
  const portfolio: SignalSubject = { name: "", currency: null, baseCurrency: "PLN" };
  const gap = {
    monthly_amount: "2500",
    day_of_month: 10,
    period_days: 31,
    grace_days: 10,
    last_deposit: "2026-10-02",
    days_since_last_deposit: 41,
  };
  const kinds = [
    cases(
      "drawdown_from_high",
      { drawdown: 0.123, window_days: 60, high_close: "250", last_close: "219.25" },
      "CD Projekt is 12.3% below its 60-session high (PLN 250.00 → PLN 219.25)",
      "CD Projekt: 12,3% poniżej szczytu z 60 sesji (250,00 zł → 219,25 zł)",
    ),
    cases(
      "alert:drawdown_from_high",
      { drawdown: 0.2, window_days: 20, high: "100", close: "80" },
      "CD Projekt is 20.0% below its 20-session high (PLN 100.00 → PLN 80.00)",
      "CD Projekt: 20,0% poniżej szczytu z 20 sesji (100,00 zł → 80,00 zł)",
    ),
    cases(
      "alert:price_above",
      { level: "200", close: "205.1", currency: "PLN" },
      "CD Projekt is above PLN 200.00 (now PLN 205.10)",
      "CD Projekt: kurs powyżej 200,00 zł (teraz 205,10 zł)",
    ),
    cases(
      "alert:price_below",
      { level: "200", close: "195.4" },
      "CD Projekt is below PLN 200.00 (now PLN 195.40)",
      "CD Projekt: kurs poniżej 200,00 zł (teraz 195,40 zł)",
    ),
    cases(
      "loss_from_cost",
      {
        unrealized_pct: -0.182,
        cost_basis_base: "1000",
        market_value_base: "818",
        currency: "PLN",
      },
      "CD Projekt is down 18.2% from cost (PLN 1,000.00 → PLN 818.00)",
      "CD Projekt: strata 18,2% względem kosztu zakupu (1000,00 zł → 818,00 zł)",
    ),
    cases(
      "gain_from_cost",
      { unrealized_pct: 0.25, cost_basis_base: "800", market_value_base: "1000", currency: "PLN" },
      "CD Projekt is up 25.0% on cost (PLN 800.00 → PLN 1,000.00)",
      "CD Projekt: zysk 25,0% względem kosztu zakupu (800,00 zł → 1000,00 zł)",
    ),
    cases(
      "allocation_drift",
      {
        bucket_id: "global_equity",
        bucket_generic: true,
        weight: 0.42,
        target: 0.35,
        drift_pp: 0.07,
        drift_value_base: "700",
        currency: "PLN",
      },
      "Global equities: 42.0% of the portfolio against a 35% target (PLN 700 over)",
      "Akcje globalne: 42,0% portfela przy celu 35% (700 zł ponad cel)",
      portfolio,
    ),
    cases(
      "allocation_drift",
      {
        bucket_id: "bonds",
        weight: 0.2,
        target: 0.3,
        drift_pp: -0.1,
        drift_value_base: "-500",
        currency: "PLN",
      },
      "Bonds: 20.0% of the portfolio against a 30% target (PLN 500 short)",
      "Obligacje: 20,0% portfela przy celu 30% (do celu brakuje 500 zł)",
      portfolio,
    ),
    // The owner's own bucket says "a bucket", never its id (F7).
    cases(
      "alert:weight_above",
      { bucket_id: "akcje", weight: 0.42, threshold: 0.4 },
      "Bucket: 42.0% of the portfolio, above your 40% threshold",
      "Koszyk: 42,0% portfela, powyżej progu 40%",
      portfolio,
    ),
    cases(
      "alert:weight_below",
      { bucket_id: "cash", weight: 0.02, threshold: 0.05 },
      "Cash: 2.0% of the portfolio, below your 5% threshold",
      "Gotówka: 2,0% portfela, poniżej progu 5%",
      portfolio,
    ),
    cases(
      "alert:weight_below",
      { weight: 0.03, threshold: 0.05, held: true },
      "CD Projekt is 3.0% of the portfolio, below your 5% threshold",
      "CD Projekt: 3,0% portfela, poniżej progu 5%",
    ),
    cases(
      "contribution_gap",
      gap,
      "No contribution for 41 days (last Oct 2). Your plan expects PLN 2,500 a month by the 10th.",
      "Brak wpłaty od 41 dni (ostatnia 2 paź). Plan zakłada wpłatę 2500 zł do 10. dnia każdego miesiąca.",
      portfolio,
    ),
    cases(
      "contribution_gap",
      { ...gap, day_of_month: 1, days_since_last_deposit: 1 },
      "No contribution for 1 day (last Oct 2). Your plan expects PLN 2,500 a month by the 1st.",
      "Brak wpłaty od 1 dnia (ostatnia 2 paź). Plan zakłada wpłatę 2500 zł do 1. dnia każdego miesiąca.",
      portfolio,
    ),
    cases(
      "contribution_gap",
      { ...gap, monthly_amount: "1250.5", last_deposit: null, days_since_last_deposit: null },
      "No contributions yet. Your plan expects PLN 1,250.50 a month by the 10th.",
      "Nie ma jeszcze żadnej wpłaty. Plan zakłada wpłatę 1250,50 zł do 10. dnia każdego miesiąca.",
      portfolio,
    ),
    cases(
      "contribution_gap",
      { ...gap, day_of_month: null, last_deposit: null, days_since_last_deposit: null },
      "No contributions yet. Your plan expects PLN 2,500 a month.",
      "Nie ma jeszcze żadnej wpłaty. Plan zakłada wpłatę 2500 zł co miesiąc.",
      portfolio,
    ),
    cases(
      "cash_level",
      {
        cash_weight: 0.02,
        cash_base: "1000",
        currency: "PLN",
        min_weight: 0.05,
        max_weight: null,
        direction: "below_min",
      },
      "Cash is 2.0% of the portfolio (PLN 1,000), below your 5% minimum",
      "Gotówka: 2,0% portfela (1000 zł), poniżej minimum 5%",
      portfolio,
    ),
    cases(
      "cash_level",
      {
        cash_weight: 0.3,
        cash_base: "15000",
        currency: "PLN",
        min_weight: null,
        max_weight: 0.25,
        direction: "above_max",
      },
      "Cash is 30.0% of the portfolio (PLN 15,000), above your 25% maximum",
      "Gotówka: 30,0% portfela (15 000 zł), powyżej maksimum 25%",
      portfolio,
    ),
    cases(
      "tagged_weight",
      { tags: ["satellite"], weight: 0.138, max_weight: 0.1, instruments: ["CDR", "VT"] },
      "Positions tagged satellite are 13.8% of the portfolio (your limit 10%): CDR, VT",
      "Pozycje z tagiem satellite to 13,8% portfela (Twój limit: 10%): CDR, VT",
      portfolio,
    ),
    cases(
      "tagged_weight",
      { tags: ["growth", "usa"], weight: 0.21, max_weight: 0.2, instruments: ["VT"] },
      "Positions tagged growth, usa are 21.0% of the portfolio (your limit 20%): VT",
      "Pozycje z tagami growth, usa to 21,0% portfela (Twój limit: 20%): VT",
      portfolio,
    ),
    cases(
      "alert:new_high",
      { close: "105.2", previous_high: "104.9", window_days: 20, price_date: "2026-11-12" },
      "CD Projekt set a new 20-session high at PLN 105.20 (previous PLN 104.90)",
      "CD Projekt: najwyższe zamknięcie od 20 sesji, 105,20 zł (poprzedni szczyt 104,90 zł)",
    ),
    cases(
      "alert:sma_cross",
      { close: "214.6", sma: "223.4512", direction: "below", window_days: 5 },
      "CD Projekt closed below its 5-session average (PLN 214.60 vs PLN 223.45)",
      "CD Projekt: zamknięcie poniżej średniej z 5 sesji (214,60 zł wobec 223,45 zł)",
    ),
    cases(
      "alert:sma_cross",
      { close: "231", sma: "224.5", direction: "above", window_days: 50 },
      "CD Projekt closed above its 50-session average (PLN 231.00 vs PLN 224.50)",
      "CD Projekt: zamknięcie powyżej średniej z 50 sesji (231,00 zł wobec 224,50 zł)",
    ),
    cases(
      "alert:range_breakout",
      {
        close: "102.3",
        currency: "PLN",
        window_days: 30,
        range_low: "92",
        range_high: "100",
        direction: "any",
        breakout_pct: 0.023,
      },
      "CD Projekt broke out of its 30-session range, 2.3% above PLN 100.00",
      "CD Projekt: wybicie z konsolidacji 30 sesji, 2,3% powyżej 100,00 zł",
    ),
    cases(
      "alert:range_breakout",
      {
        close: "90.62",
        currency: "PLN",
        window_days: 30,
        range_low: "92",
        range_high: "100",
        direction: "any",
        breakout_pct: -0.015,
      },
      "CD Projekt broke out of its 30-session range, 1.5% below PLN 92.00",
      "CD Projekt: wybicie z konsolidacji 30 sesji, 1,5% poniżej 92,00 zł",
    ),
    cases(
      "alert:volume_spike",
      { close: "214.6", currency: "PLN", window_days: 20, ratio: 3.412345, multiple: 2.5 },
      "CD Projekt traded 3.4x its 20-session average volume",
      "CD Projekt: wolumen 3,4x średniej z 20 sesji",
    ),
    // A custom rule without the owner's own message: the condition as written, the measures by unit.
    cases(
      "custom",
      {
        scope: "portfolio",
        when: 'bucket_drift_pp("global_equity") <= -3 and cash_value >= 5000',
        values: { 'bucket_drift_pp("global_equity")': -4.2, cash_value: "6200.00" },
      },
      'Condition met (bucket_drift_pp("global_equity") <= -3 and cash_value >= 5000), bucket_drift_pp("global_equity"): -4.2 pp, cash_value: PLN 6,200',
      'Warunek spełniony (bucket_drift_pp("global_equity") <= -3 and cash_value >= 5000), bucket_drift_pp("global_equity"): -4,2 pp, cash_value: 6200 zł',
      portfolio,
      "Condition met: ... (...)",
    ),
    cases(
      "custom",
      {
        instrument_id: "i1",
        scope: "instrument",
        when: "weight > 5% and unrealized_pct < 0",
        values: { weight: 0.075, unrealized_pct: -0.12, flagged: true, missing: null },
      },
      "CD Projekt: condition met (weight > 5% and unrealized_pct < 0), weight: 7.5%, unrealized_pct: -12.0%, flagged: yes, missing: unknown",
      "CD Projekt: warunek spełniony (weight > 5% and unrealized_pct < 0), weight: 7,5%, unrealized_pct: -12,0%, flagged: tak, missing: brak danych",
      cdr,
      "Warunek spełniony: ... (...)",
    ),
    // The owner's own bucket: no id in the subject, the condition or the measures (F7), the bucket
    // functions read as phrases as on the desktop.
    cases(
      "alert:custom",
      {
        title: "Core lagging",
        scope: "bucket",
        bucket_id: "core",
        when: 'bucket_drift_pp("core") <= -3 and cash_weight >= 5%',
        values: { 'bucket_drift_pp("core")': -4.2, cash_weight: 0.07 },
      },
      "Bucket: condition met (bucket drift <= -3 and cash_weight >= 5%), bucket drift: -4.2 pp, cash_weight: 7.0%",
      "Koszyk: warunek spełniony (dryf koszyka <= -3 and cash_weight >= 5%), dryf koszyka: -4,2 pp, cash_weight: 7,0%",
      portfolio,
      "Core lagging: Condition met (cash_weight 7.0%)",
    ),
    // A bucket-scope rule measures `bucket_id`: the evaluated bucket by its name, never its id (F7).
    cases(
      "custom",
      {
        scope: "bucket",
        bucket_id: "core",
        when: 'drift_pp < -3 and bucket_id != "cash"',
        values: { bucket_id: "core", drift_pp: -4.2 },
      },
      'Bucket: condition met (drift_pp < -3 and bucket_id != "cash"), bucket_id: Bucket, drift_pp: -4.2 pp',
      'Koszyk: warunek spełniony (drift_pp < -3 and bucket_id != "cash"), bucket_id: Koszyk, drift_pp: -4,2 pp',
      portfolio,
      "Condition met: ... (...)",
    ),
    // The same rule on a generic bucket names it by its label.
    cases(
      "custom",
      {
        scope: "bucket",
        bucket_id: "bonds",
        when: 'drift_pp < -3 and bucket_id == "bonds"',
        values: { bucket_id: "bonds", drift_pp: -4.2, drift_value: "-1200", value: "8000" },
      },
      'Bonds: condition met (drift_pp < -3 and bucket_id == "bonds"), bucket_id: Bonds, drift_pp: -4.2 pp, drift_value: -PLN\u00a01,200, value: PLN\u00a08,000',
      'Obligacje: warunek spełniony (drift_pp < -3 and bucket_id == "bonds"), bucket_id: Obligacje, drift_pp: -4,2 pp, drift_value: -1200\u00a0zł, value: 8000\u00a0zł',
      portfolio,
      "Condition met: ... (...)",
    ),
    // A signed amount keeps its sign: a loss reads as one.
    cases(
      "custom",
      {
        scope: "instrument",
        when: "unrealized_value < -1000",
        values: { unrealized_value: "-1200", market_value: "5400" },
      },
      "CD Projekt: condition met (unrealized_value < -1000), unrealized_value: -PLN\u00a01,200, market_value: PLN\u00a05,400",
      "CD Projekt: warunek spełniony (unrealized_value < -1000), unrealized_value: -1200\u00a0zł, market_value: 5400\u00a0zł",
      cdr,
      "Condition met: ... (...)",
    ),
    cases(
      "research:news",
      { title: "Q3 and the 2027 slate", relation: "weakens", strength: 2, sources: 4 },
      "Analysis: Q3 and the 2027 slate - weakens the thesis (strength 2/3, 4 sources)",
      "Analiza: Q3 and the 2027 slate - osłabia tezę (siła 2/3, 4 źródła)",
    ),
    cases(
      "research:earnings",
      { title: "Q3 report", relation: "invalidates", strength: 3, sources: 5 },
      "Analysis: Q3 report - invalidates the thesis (strength 3/3, 5 sources)",
      "Analiza: Q3 report - podważa tezę (siła 3/3, 5 źródeł)",
    ),
    cases(
      "research:macro",
      { title: "USD/PLN", relation: "none", strength: 1, sources: 1 },
      "Analysis: USD/PLN (strength 1/3, 1 source)",
      "Analiza: USD/PLN (siła 1/3, 1 źródło)",
    ),
    cases(
      "plan:plan_no_exit",
      { check: "plan_no_exit", unrealized: 1.12, symbol: "CDR", trigger: "gain", threshold: 1 },
      "CD Projekt: no exit plan while the position is 112% up",
      "CD Projekt: brak planu wyjścia przy zysku 112%",
    ),
    cases(
      "plan:plan_no_exit",
      { check: "plan_no_exit", unrealized: 0.4, symbol: "CDR", trigger: "fulfilled" },
      "CDR: the thesis is fulfilled and there is no exit plan",
      "CDR: teza spełniona, brak planu wyjścia",
      portfolio,
    ),
    cases(
      "plan:plan_vs_thesis",
      { check: "plan_vs_thesis", plan: "buy", health: "weakened", symbol: "CDR" },
      'CD Projekt: the plan says "buy more", but the thesis is weakened',
      "CD Projekt: plan „dokup”, a teza jest osłabiona",
    ),
    cases(
      "plan:plan_vs_thesis",
      { check: "plan_vs_thesis", plan: "buy_asap", health: "invalidated", symbol: "CDR" },
      'CD Projekt: the plan says "buy more asap", but the thesis is invalidated',
      "CD Projekt: plan „dokup asap”, a teza jest podważona",
    ),
  ];

  it.each(kinds)("reads $row.kind in English and Polish", ({ row, subject, en, pl }) => {
    setLanguageForTests("en");
    expect(signalText(row, subject, enUS)).toBe(en);
    setLanguageForTests("pl");
    expect(signalText(row, subject, plPL)).toBe(pl);
  });

  it("hides the owner's own amounts in incognito, never the prices or shares", () => {
    setLanguageForTests("en");
    const hidden: DisplayEnv = { locale: "en-US", privacy: true };
    expect(
      signalText({ kind: "contribution_gap", message: "raw", payload: gap }, portfolio, hidden),
    ).toBe("No contribution for 41 days (last Oct 2). Your plan expects ••• a month by the 10th.");
    expect(
      signalText(
        {
          kind: "loss_from_cost",
          message: "raw",
          payload: {
            unrealized_pct: -0.182,
            cost_basis_base: "1000",
            market_value_base: "818",
            currency: "PLN",
          },
        },
        cdr,
        hidden,
      ),
    ).toBe("CD Projekt is down 18.2% from cost (••• → •••)");
    expect(signalText(drop, cdr, hidden)).toBe(
      "CD Projekt fell 9.4% in 5 sessions (PLN 236.87 → PLN 214.60)",
    );
    // The owner's amounts in a custom rule's measures, and the plan without a base currency.
    expect(
      signalText(
        {
          kind: "custom",
          message: "Condition met: ...",
          payload: {
            scope: "portfolio",
            when: "cash_value >= 5000",
            values: { cash_value: "6200.00", cash_weight: 0.07 },
          },
        },
        portfolio,
        hidden,
      ),
    ).toBe("Condition met (cash_value >= 5000), cash_value: •••, cash_weight: 7.0%");
    expect(
      signalText(
        { kind: "contribution_gap", message: "raw", payload: gap },
        { ...portfolio, baseCurrency: null },
        hidden,
      ),
    ).toBe("No contribution for 41 days (last Oct 2). Your plan expects ••• a month by the 10th.");
  });

  it("makes the engine's own text safe: no owner's bucket id, amounts hidden in incognito", () => {
    setLanguageForTests("pl");
    const own = {
      kind: "custom",
      message: "Koszyk core: gotówka czeka (cash_value 6 200 PLN)",
      payload: { scope: "bucket", bucket_id: "core", when: "cash_value > 5000", values: {} },
    };
    expect(signalText(own, portfolio, plPL)).toBe("Koszyk: gotówka czeka (cash_value 6 200 PLN)");
    expect(signalText(own, portfolio, { ...plPL, privacy: true })).toBe(
      "Koszyk: gotówka czeka (cash_value ••• PLN)",
    );
    expect(safeText("Koszyk core powyżej 40%", plPL)).toBe("Koszyk powyżej 40%");
    expect(safeText('bucket_weight("core") > 40%', { ...plPL, privacy: true })).toBe(
      "waga koszyka > •••%",
    );
  });

  it("never names the owner's own bucket", () => {
    setLanguageForTests("pl");
    const drift = {
      kind: "allocation_drift",
      message: "raw",
      payload: {
        bucket_id: "akcje",
        weight: 0.42,
        target: 0.35,
        drift_pp: 0.07,
        drift_value_base: "700",
        currency: "PLN",
      },
    };
    expect(signalText(drift, portfolio, plPL)).toBe(
      "Koszyk: 42,0% portfela przy celu 35% (700\u00a0zł ponad cel)",
    );
    expect(signalText(drift, portfolio, plPL)).not.toContain("akcje");
  });

  it("keeps the engine's text for a kind without facts to rebuild it from", () => {
    setLanguageForTests("en");
    const unknown = { kind: "custom_expression", message: "Cash below plan.", payload: {} };
    expect(signalText(unknown, cdr, enUS)).toBe("Cash below plan.");
    expect(signalText({ ...heavy, payload: {} }, cdr, enUS)).toBe(heavy.message);
    for (const kind of [
      "alert:range_breakout",
      "alert:sma_cross",
      "alert:new_high",
      "alert:volume_spike",
      "tagged_weight",
      "cash_level",
      "custom",
      "research:news",
      "plan:plan_no_exit",
    ])
      expect(signalText({ kind, message: "raw", payload: {} }, cdr, enUS)).toBe("raw");
    // Without the portfolio's base currency the plan's amount reads as a plain number.
    expect(
      signalText(
        { kind: "contribution_gap", message: "raw", payload: gap },
        { ...portfolio, baseCurrency: null },
        enUS,
      ),
    ).toBe(
      "No contribution for 41 days (last Oct 2). Your plan expects 2,500 a month by the 10th.",
    );
    // A custom rule with the owner's own message keeps that message.
    const own = {
      kind: "custom",
      message: "Equities below target and cash waiting (cash_weight 7.0%).",
      payload: { scope: "portfolio", when: "cash_weight >= 5%", values: { cash_weight: 0.07 } },
    };
    expect(signalText(own, portfolio, enUS)).toBe(own.message);
    // A plan the app has no label for keeps the engine's text.
    expect(
      signalText(
        {
          kind: "plan:plan_vs_thesis",
          message: "raw",
          payload: { plan: "other", health: "weakened" },
        },
        cdr,
        enUS,
      ),
    ).toBe("raw");
  });
});

describe("isShownSignal", () => {
  const drift = (payload: Record<string, unknown>) => ({ kind: "allocation_drift", payload });
  it("hides an allocation drift of the owner's own bucket, as the desktop does", () => {
    expect(isShownSignal(drift({ bucket_id: "global_equity", bucket_generic: true }))).toBe(true);
    expect(isShownSignal(drift({ bucket_id: "cash" }))).toBe(true);
    expect(isShownSignal(drift({ bucket_id: "core", bucket_generic: false }))).toBe(false);
    expect(isShownSignal(drift({ bucket_id: "core" }))).toBe(false);
    expect(isShownSignal(drift({ bucket_id: "core", bucket_generic: true }))).toBe(false);
    expect(isShownSignal(drift({ bucket_id: "cash", bucket_generic: false }))).toBe(false);
    expect(isShownSignal(drift({}))).toBe(false);
  });
  it("shows every other kind, also on the owner's own bucket", () => {
    expect(isShownSignal({ kind: "alert:weight_above", payload: { bucket_id: "core" } })).toBe(
      true,
    );
    expect(isShownSignal({ kind: "custom", payload: { bucket_id: "core" } })).toBe(true);
    expect(isShownSignal({ kind: "position_concentration", payload: {} })).toBe(true);
  });
});
