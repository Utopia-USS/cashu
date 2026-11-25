import { afterEach, expect, it } from "vitest";
import {
  createTranslator,
  normalizeNumberInput,
  normalizeNumberInputForLanguage,
  setLanguageForTests,
} from "./index.js";

afterEach(() => setLanguageForTests("en"));

it.each(["pl", "en"] as const)("normalizes backend input independently of the %s UI", (ui) => {
  setLanguageForTests(ui);
  const pl = createTranslator("pl");
  const en = createTranslator("en");
  expect(normalizeNumberInputForLanguage("12,500", pl.language)).toBe("12.500");
  expect(normalizeNumberInputForLanguage("12,500", en.language)).toBe("12500");
  expect(normalizeNumberInput("12,500")).toBe(ui === "pl" ? "12.500" : "12500");
});

// frontend/tests/i18n.test.mjs: the existing UI entry keeps the exact original behaviour.
it("keeps decimal-comma and English thousands input compatible in the UI wrapper", () => {
  setLanguageForTests("pl");
  expect(normalizeNumberInput("1 234,5")).toBe("1234.5");
  setLanguageForTests("en");
  expect(["1,234.5", "12,500", "1,5", "545000"].map(normalizeNumberInput)).toEqual([
    "1234.5",
    "12500",
    "1.5",
    "545000",
  ]);
});
