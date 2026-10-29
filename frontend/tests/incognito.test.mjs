// Incognito: absolute amounts are masked, percentages stay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { maskDigits, setIncognito } from "../src/incognito.ts";
import { cur, cur0, pctSigned, pln0 } from "../src/format.ts";
import { money, money0, pct, qty } from "../src/modules/investments/labels.ts";

test("maskDigits keeps sign and unit", () => {
  assert.equal(maskDigits("-11 600,00 zł"), "-••• zł");
  assert.equal(maskDigits("+3 240,15 €"), "+••• €");
  assert.equal(maskDigits("120 tys."), "••• tys.");
});

test("amount formatters mask while incognito is on, percentages do not", () => {
  setIncognito(true);
  try {
    for (const t of [cur(1234.5), cur0(400000, "EUR"), pln0.format(8600), money(3240.15, "PLN", true), money0(11600), qty(120)]) {
      assert.doesNotMatch(t, /\d/, t);
    }
    assert.equal(cur(null), "-");
    assert.match(pct(0.212), /21,2/);
    assert.match(pctSigned(0.012), /1,2/);
  } finally {
    setIncognito(false);
  }
  assert.match(cur(1234.5), /1\s234,50/);
});
