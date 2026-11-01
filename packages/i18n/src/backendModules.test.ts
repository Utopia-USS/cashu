// Pure parts of tests/test_i18n_core_modules.py, using existing
// domain producers. HTTP / DB / notification / boot-page producers remain in their module scopes.

import { CATEGORIES, categoryLabel } from "@cashu/domain/budget";
import {
  builtinRegistry,
  componentLabels,
  getModule,
  moduleDescription,
  moduleName,
  profileDisplayName,
} from "@cashu/domain/core";
import { expect, it } from "vitest";
import { createTranslator } from "./tr.js";

// test_labels_follow_the_language_and_polish_stays_for_mcp (except unported budget import service)
it("resolves existing domain labels in the request language and preserves Polish identity fields", () => {
  const registry = builtinRegistry();
  const pl = createTranslator("pl");
  const en = createTranslator("en");
  expect(registry.accountTypes.bucket("money").label).toBe("Pieniądze");
  expect(componentLabels(registry.accountTypes, pl.language).get("property")).toBe("Nieruchomości");
  expect(registry.institutions.displayName("manual", pl.language)).toBe("Ręcznie");
  expect(categoryLabel("groceries", pl.language)).toBe("Spożywcze");
  expect(CATEGORIES.find((category) => category.key === "groceries")?.label).toBe("Spożywcze");
  const labels = componentLabels(registry.accountTypes, en.language);
  expect(labels.get("money")).toBe("Money");
  expect(labels.get("mortgage")).toBe("Mortgage");
  expect(labels.get("property")).toBe("Property");
  expect(labels.get("vehicle")).toBe("Car");
  expect(labels.get("loan")).toBe("Loan");
  expect(registry.institutions.displayName("manual", en.language)).toBe("Manual");
  expect(registry.institutions.displayName("mbank", en.language)).toBe("mBank");
  expect(categoryLabel("cash_withdrawal", en.language)).toBe("Cash withdrawal");
  expect(categoryLabel("unknown_key", en.language)).toBe("unknown_key");
  expect(
    new Set(CATEGORIES.filter((category) => category.labelEn.length > 0).map((c) => c.key)),
  ).toEqual(new Set(CATEGORIES.map((category) => category.key)));
  expect(moduleName(getModule(registry, "loans"), en.language)).toBe("Loans");
  expect(registry.accountTypes.bucket("money").label).toBe("Pieniądze");
  // The Polish identity field and default LLM/MCP lookup are never changed by display rendering.
  expect(CATEGORIES.find((category) => category.key === "groceries")?.label).toBe("Spożywcze");
  expect(categoryLabel("groceries")).toBe("Spożywcze");
});

// test_categories_and_networth_labels_over_the_api (renderers only; HTTP / spending await S36).
it("renders the oracle's category and net-worth labels with an explicit language", () => {
  const context = createTranslator("en");
  expect(categoryLabel("groceries", context.language)).toBe("Groceries");
  expect(categoryLabel("transfer", context.language)).toBe("Own transfer");
  expect(categoryLabel(CATEGORIES[0]?.key ?? "", "pl")).toBe("Spożywcze");
  expect(componentLabels(builtinRegistry().accountTypes, context.language).get("money")).toBe(
    "Money",
  );
});

// test_modules_and_setup_steps_in_english (pure module names / descriptions subset)
it("resolves existing module manifests at read time without changing the registry", () => {
  const registry = builtinRegistry();
  const budget = getModule(registry, "budget");
  expect(moduleName(budget, "pl")).toBe("Budżet domowy");
  expect(moduleName(budget, "en")).toBe("Home budget");
  expect(moduleDescription(getModule(registry, "assets"), "en")).toBe(
    "Property, cars and other manually valued assets",
  );
  expect(moduleName(getModule(registry, "loans"), "en")).toBe("Loans");
  expect(moduleName(budget, "pl")).toBe("Budżet domowy");
});

// test_default_profile_name_is_shown_in_the_language (pure display part; no DB writes)
it("translates only the untouched default profile name and preserves user data", () => {
  const profile = { slug: "default", name: "Domyślny" };
  expect(profileDisplayName(profile, "pl")).toBe("Domyślny");
  expect(profileDisplayName(profile, "en")).toBe("Default");
  expect(profile.name).toBe("Domyślny");
  expect(profileDisplayName({ ...profile, name: "Dom" }, "en")).toBe("Dom");
});
