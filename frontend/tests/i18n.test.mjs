// UI language and text catalogs (src/i18n.ts), run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LANGS, catalog, enCount, intlLocale, lang, matchLang, plCount, plForm, setLanguageForTests, tr,
} from "../src/i18n.ts";

test("node tests default to Polish", () => {
  assert.equal(lang(), "pl");
  assert.deepEqual([...LANGS], ["pl", "en"]);
});

test("matchLang takes the first supported language of the OS list", () => {
  assert.equal(matchLang(["de-DE", "en-GB", "pl-PL"]), "en");
  assert.equal(matchLang(["pl_PL"]), "pl");
  assert.equal(matchLang(["de", "fr"]), null);
  assert.equal(matchLang([]), null);
});

test("a catalog reads the language on access", () => {
  const S = catalog({
    save: { pl: "Zapisz", en: "Save" },
    rules: { pl: (n) => plCount(n, "reguła", "reguły", "reguł"), en: (n) => enCount(n, "rule", "rules") },
  });
  try {
    setLanguageForTests("pl");
    assert.equal(S.save, "Zapisz");
    assert.equal(S.rules(5), "5 reguł");
    assert.equal(tr({ pl: "tak", en: "yes" }), "tak");
    assert.equal(intlLocale(), "pl-PL");
    setLanguageForTests("en");
    assert.equal(S.save, "Save");
    assert.equal(S.rules(1), "1 rule");
    assert.equal(S.rules(5), "5 rules");
    assert.equal(tr({ pl: "tak", en: "yes" }), "yes");
    assert.match(intlLocale(), /^en-/);
  } finally {
    setLanguageForTests("pl");
  }
});

test("Polish plural forms", () => {
  const f = (n) => plForm(n, "sygnał", "sygnały", "sygnałów");
  assert.deepEqual([0, 1, 2, 4, 5, 12, 14, 22, 25, 112].map(f),
    ["sygnałów", "sygnał", "sygnały", "sygnały", "sygnałów", "sygnałów", "sygnałów", "sygnały", "sygnałów", "sygnałów"]);
});

test("number input: decimal comma in Polish, thousands comma in English when unambiguous", async () => {
  const { normalizeNumberInput: n } = await import("../src/i18n.ts");
  try {
    setLanguageForTests("pl");
    assert.equal(n("1 234,5"), "1234.5");
    setLanguageForTests("en");
    assert.equal(n("1,234.5"), "1234.5");
    assert.equal(n("12,500"), "12500");
    assert.equal(n("1,5"), "1.5");
    assert.equal(n("545000"), "545000");
  } finally {
    setLanguageForTests("pl");
  }
});
