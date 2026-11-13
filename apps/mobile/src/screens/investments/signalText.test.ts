import { setLanguageForTests } from "@cashu/i18n";
import { type SignalSubject, signalText } from "./signalText";

const cdr: SignalSubject = { name: "CD Projekt", currency: "PLN" };
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
    expect(signalText(drop, cdr, "en-US")).toBe(
      "CD Projekt fell 9.4% in 5 sessions (PLN\u00a0236.87 → PLN\u00a0214.60)",
    );
    expect(
      signalText(
        { ...drop, payload: { ...drop.payload, change: 0.021, window_days: 1 } },
        cdr,
        "en-US",
      ),
    ).toBe("CD Projekt rose 2.1% in 1 session (PLN\u00a0236.87 → PLN\u00a0214.60)");
    expect(signalText(heavy, cdr, "en-US")).toBe(
      "CD Projekt is 7.5% of the portfolio (your limit 5%)",
    );
    expect(
      signalText({ ...heavy, payload: { weight: 0.12, max_weight: 0.125 } }, cdr, "en-US"),
    ).toBe("CD Projekt is 12.0% of the portfolio (your limit 12.5%)");
  });

  it("reads them in Polish", () => {
    setLanguageForTests("pl");
    expect(signalText(drop, cdr, "pl-PL")).toBe(
      "CD Projekt: spadek o 9,4% w ciągu 5 sesji (236,87\u00a0zł → 214,60\u00a0zł)",
    );
    expect(signalText(heavy, cdr, "pl-PL")).toBe("CD Projekt to 7,5% portfela (Twój limit: 5%)");
  });

  const cases = (
    kind: string,
    payload: Record<string, unknown>,
    en: string,
    pl: string,
    subject = cdr,
  ) => ({ row: { kind, message: "raw", payload }, en, pl, subject });
  const portfolio: SignalSubject = { name: "", currency: null };
  const kinds = [
    cases(
      "drawdown_from_high",
      { drawdown: 0.123, window_days: 60, high_close: "250", last_close: "219.25" },
      "CD Projekt is 12.3% below its 60-session high (PLN\u00a0250.00 → PLN\u00a0219.25)",
      "CD Projekt: 12,3% poniżej szczytu z 60 sesji (250,00\u00a0zł → 219,25\u00a0zł)",
    ),
    cases(
      "alert:drawdown_from_high",
      { drawdown: 0.2, window_days: 20, high: "100", close: "80" },
      "CD Projekt is 20.0% below its 20-session high (PLN\u00a0100.00 → PLN\u00a080.00)",
      "CD Projekt: 20,0% poniżej szczytu z 20 sesji (100,00\u00a0zł → 80,00\u00a0zł)",
    ),
    cases(
      "alert:price_above",
      { level: "200", close: "205.1", currency: "PLN" },
      "CD Projekt is above PLN\u00a0200.00 (now PLN\u00a0205.10)",
      "CD Projekt: kurs powyżej 200,00\u00a0zł (teraz 205,10\u00a0zł)",
    ),
    cases(
      "alert:price_below",
      { level: "200", close: "195.4" },
      "CD Projekt is below PLN\u00a0200.00 (now PLN\u00a0195.40)",
      "CD Projekt: kurs poniżej 200,00\u00a0zł (teraz 195,40\u00a0zł)",
    ),
    cases(
      "loss_from_cost",
      {
        unrealized_pct: -0.182,
        cost_basis_base: "1000",
        market_value_base: "818",
        currency: "PLN",
      },
      "CD Projekt is down 18.2% from cost (PLN\u00a01,000.00 → PLN\u00a0818.00)",
      "CD Projekt: strata 18,2% względem kosztu zakupu (1000,00\u00a0zł → 818,00\u00a0zł)",
    ),
    cases(
      "gain_from_cost",
      { unrealized_pct: 0.25, cost_basis_base: "800", market_value_base: "1000", currency: "PLN" },
      "CD Projekt is up 25.0% on cost (PLN\u00a0800.00 → PLN\u00a01,000.00)",
      "CD Projekt: zysk 25,0% względem kosztu zakupu (800,00\u00a0zł → 1000,00\u00a0zł)",
    ),
    cases(
      "allocation_drift",
      {
        bucket_id: "akcje",
        weight: 0.42,
        target: 0.35,
        drift_pp: 0.07,
        drift_value_base: "700",
        currency: "PLN",
      },
      "Bucket akcje is 42.0% of the portfolio against a 35% target (PLN\u00a0700.00 over)",
      "Koszyk akcje: 42,0% portfela przy celu 35% (700,00\u00a0zł ponad cel)",
      portfolio,
    ),
    cases(
      "allocation_drift",
      {
        bucket_id: "obligacje",
        weight: 0.2,
        target: 0.3,
        drift_pp: -0.1,
        drift_value_base: "-500",
        currency: "PLN",
      },
      "Bucket obligacje is 20.0% of the portfolio against a 30% target (PLN\u00a0500.00 short)",
      "Koszyk obligacje: 20,0% portfela przy celu 30% (do celu brakuje 500,00\u00a0zł)",
      portfolio,
    ),
    cases(
      "alert:weight_above",
      { bucket_id: "akcje", weight: 0.42, threshold: 0.4 },
      "Bucket akcje is 42.0% of the portfolio, above your 40% line",
      "Koszyk akcje: 42,0% portfela, powyżej progu 40%",
      portfolio,
    ),
    cases(
      "alert:weight_below",
      { weight: 0.03, threshold: 0.05, held: true },
      "CD Projekt is 3.0% of the portfolio, below your 5% line",
      "CD Projekt: 3,0% portfela, poniżej progu 5%",
    ),
    cases(
      "contribution_gap",
      { period_days: 30, days_since_last_deposit: 45, last_deposit: "2026-09-29" },
      "Last deposit 45 days ago (plan: every 30 days)",
      "Ostatnia wpłata: 45 dni temu (plan: co 30 dni)",
      portfolio,
    ),
    cases(
      "contribution_gap",
      { period_days: 30, days_since_last_deposit: null, last_deposit: null },
      "No deposits yet (plan: every 30 days)",
      "Brak wpłat (plan: co 30 dni)",
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
      "Cash is 2.0% of the portfolio (PLN\u00a01,000.00), below your 5% minimum",
      "Gotówka: 2,0% portfela (1000,00\u00a0zł), poniżej minimum 5%",
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
      "Cash is 30.0% of the portfolio (PLN\u00a015,000.00), above your 25% maximum",
      "Gotówka: 30,0% portfela (15\u00a0000,00\u00a0zł), powyżej maksimum 25%",
      portfolio,
    ),
  ];

  it.each(kinds)("reads $row.kind in English and Polish", ({ row, subject, en, pl }) => {
    setLanguageForTests("en");
    expect(signalText(row, subject, "en-US")).toBe(en);
    setLanguageForTests("pl");
    expect(signalText(row, subject, "pl-PL")).toBe(pl);
  });

  it("keeps the engine's text for a kind without facts to rebuild it from", () => {
    setLanguageForTests("en");
    const custom = { kind: "custom_expression", message: "Cash below plan.", payload: {} };
    expect(signalText(custom, cdr, "en-US")).toBe("Cash below plan.");
    expect(signalText({ ...heavy, payload: {} }, cdr, "en-US")).toBe(heavy.message);
    for (const kind of ["range_breakout", "alert:sma_cross", "tagged_weight", "cash_level"])
      expect(signalText({ kind, message: "raw", payload: {} }, cdr, "en-US")).toBe("raw");
  });
});
