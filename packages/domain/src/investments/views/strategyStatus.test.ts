import { describe, expect, it } from "vitest";
import { Currencies } from "../domain/index.js";
import { strategyStatus } from "../strategy/index.js";
import { strategyStatusView } from "./strategyStatus.js";

const files = { yaml: "strategy.yaml", md: "strategy.md", yamlExists: true, mdExists: false };
const status = strategyStatus(
  { yaml: "version: 1\nbase_currency: EUR\nrules: []\n", md: null, readError: null },
  null,
);

describe("strategy status read diagnostics", () => {
  it("uses the explicit caller language for a base mismatch and preserves the English contract", () => {
    const input = { status, profileBase: Currencies.PLN, files, versions: [] };
    expect(strategyStatusView({ ...input, lang: "en" }).base_currency_note).toBe(
      "strategy base_currency EUR differs from the profile's PLN",
    );
    expect(strategyStatusView({ ...input, lang: "pl" }).base_currency_note).toBe(
      "Waluta bazowa strategii EUR różni się od waluty profilu PLN",
    );
    expect(
      strategyStatusView({ ...input, profileBase: Currencies.EUR, lang: "pl" }).base_currency_note,
    ).toBeNull();
  });
  it("counts read errors and retains full version diagnostics without inventing a config", () => {
    const failure = strategyStatus(
      { yaml: null, md: null, readError: "Synthetic read failure" },
      null,
    );
    const result = strategyStatusView({
      status: failure,
      profileBase: Currencies.PLN,
      lang: "en",
      files,
      versions: [],
    });
    expect(result.errors).toBe(1);
    expect(result.read_error).toBe("Synthetic read failure");
    expect(result.facts).toBeNull();
    expect(result.base_currency_note).toBeNull();
  });
});
