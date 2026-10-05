// Which cached views a write makes stale (F7 FIX2 B1 / B2, src/modules/budget/logic.ts on src/swr.ts). Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ck, swr } from "../src/swr.ts";
import { cushionSaved, monthCloseStale, recategorized } from "../src/modules/budget/logic.ts";

const KEYS = {
  widgetClose: ck("jan", "budget", "monthclose", "2026-09"), // Przegląd budget widget + surplus card
  cardClose: ck("jan", "budget", "monthclose-card", "2026-08"), // Przepływy card, another month
  cashflow: ck("jan", "budget", "cashflow", 7, "PLN"),
  currencies: ck("jan", "budget", "currencies"),
  cash: ck("jan", "cash"),
  inv: ck("jan", "inv", "overview", ""),
  summary: ck("jan", "summary"),
};
const seed = () => {
  swr.setScope("jan");
  for (const k of Object.values(KEYS)) swr.put(k, { k }, swr.begin());
};
const left = () => Object.entries(KEYS).filter(([, k]) => swr.peek(k)).map(([n]) => n);

test("a cushion save drops every cached month close (widget, surplus card, the card's other months) and the budget views", () => {
  seed();
  cushionSaved("jan");
  assert.deepEqual(left(), ["cash", "inv", "summary"]);
});

test("a category change drops the budget views and the cash pool", () => {
  seed();
  recategorized("jan");
  assert.deepEqual(left(), ["inv", "summary"]);
});

test("a strategy / investments write (dropInv) drops both month close keys, nothing else of the budget", () => {
  seed();
  monthCloseStale("jan");
  assert.deepEqual(left(), ["cashflow", "currencies", "cash", "inv", "summary"]);
});

test("another profile's write touches nothing of this one", () => {
  seed();
  cushionSaved("ola");
  recategorized("ola");
  assert.equal(left().length, Object.keys(KEYS).length);
});
