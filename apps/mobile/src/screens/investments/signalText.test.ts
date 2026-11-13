import { setLanguageForTests } from "@cashu/i18n";
import { signalText } from "./signalText";

const cdr = { name: "CD Projekt", currency: "PLN" };
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

  it("keeps the engine's text for a kind without facts to rebuild it from", () => {
    setLanguageForTests("en");
    const custom = { kind: "custom_expression", message: "Cash below plan.", payload: {} };
    expect(signalText(custom, cdr, "en-US")).toBe("Cash below plan.");
    expect(signalText({ ...heavy, payload: {} }, cdr, "en-US")).toBe(heavy.message);
  });
});
