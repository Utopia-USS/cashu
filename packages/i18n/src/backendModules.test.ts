// Pure parts of tests/test_i18n_core_modules.py and tests/test_message_codes.py, using existing
// domain producers. HTTP / DB / notification / boot-page producers remain in their module scopes.
import {
  builtinRegistry,
  componentLabels,
  getModule,
  moduleDescription,
  moduleName,
  profileDisplayName,
} from "@cashu/domain/core";
import * as importing from "@cashu/domain/investments/importing";
import { expect, it } from "vitest";
import { createTranslator } from "./tr.js";

// test_labels_follow_the_language_and_polish_stays_for_mcp (core registry / institutions subset)
it("resolves existing domain labels in the request language and preserves Polish identity fields", () => {
  const registry = builtinRegistry();
  const pl = createTranslator("pl");
  const en = createTranslator("en");
  expect(registry.accountTypes.bucket("money").label).toBe("Pieniądze");
  expect(componentLabels(registry.accountTypes, pl.language).get("property")).toBe("Nieruchomości");
  expect(registry.institutions.displayName("manual", pl.language)).toBe("Ręcznie");
  const labels = componentLabels(registry.accountTypes, en.language);
  expect(labels.get("money")).toBe("Money");
  expect(labels.get("mortgage")).toBe("Mortgage");
  expect(labels.get("property")).toBe("Property");
  expect(labels.get("vehicle")).toBe("Car");
  expect(labels.get("loan")).toBe("Loan");
  expect(registry.institutions.displayName("manual", en.language)).toBe("Manual");
  expect(registry.institutions.displayName("mbank", en.language)).toBe("mBank");
  expect(moduleName(getModule(registry, "loans"), en.language)).toBe("Loans");
  expect(registry.accountTypes.bucket("money").label).toBe("Pieniądze");
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

// test_import_warning_code_follows_its_kind
it("keeps warning codes stable independently of the rendering language", () => {
  const { ImportWarningKind, importWarning, warningCode } = importing;
  for (const language of ["pl", "en"] as const) {
    const context = createTranslator(language);
    const message = context.tr({ pl: "Błąd", en: "Error" });
    expect(warningCode(importWarning({ message, kind: ImportWarningKind.INVALID_VALUE }))).toBe(
      "import.invalid_value",
    );
    expect(warningCode(importWarning({ message }))).toBe("import.other");
  }
});
