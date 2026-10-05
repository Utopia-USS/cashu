// Budget module pure helpers (src/modules/budget/logic.ts), run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeFor, cushionDraft, cushionPayload, monthLabel, pickCurrency, planState, shiftMonth,
} from "../src/modules/budget/logic.ts";

const info = (base, def, codes) => ({
  base, default: def, currencies: codes.map((c) => ({ currency: c, transactions: 1, first: "2026-01-01", last: "2026-09-30" })),
});

test("months: labels and shifting across years", () => {
  assert.equal(monthLabel("2026-09"), "wrz 2026");
  assert.equal(monthLabel("2026-01"), "sty 2026");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-09", 0), "2026-09");
});

test("currency: remembered when still present, else the server default, never PLN by assumption", () => {
  assert.equal(pickCurrency(null, null), null);
  assert.equal(pickCurrency(null, info("EUR", "EUR", ["EUR"])), "EUR");
  assert.equal(pickCurrency("EUR", info("PLN", "PLN", ["PLN", "EUR"])), "EUR");
  assert.equal(pickCurrency("NOK", info("PLN", "PLN", ["PLN", "EUR"])), "PLN"); // stale choice
  assert.equal(pickCurrency(null, info("PLN", "EUR", ["EUR"])), "EUR"); // base has no data
  assert.equal(pickCurrency("EUR", info("EUR", "EUR", [])), "EUR"); // empty profile: the base
});

const close = {
  month: "2026-09", complete: true, base_currency: "PLN", first_month: "2026-06", last_month: "2026-09",
  currencies: [
    { currency: "PLN", income: 9000, spending: 4275.75, surplus: 4724.25, cushion_top_up: 1000, suggested_transfer: 3724.25,
      transactions: 12, income_by_category: [], spending_by_category: [] },
    { currency: "EUR", income: 0, spending: 9.99, surplus: -9.99, cushion_top_up: 0, suggested_transfer: 0,
      transactions: 1, income_by_category: [], spending_by_category: [] },
  ],
  cushion: null, investing: null,
};

test("month close: the chosen currency and the others (never summed)", () => {
  const { main, others } = closeFor(close, "EUR");
  assert.equal(main.currency, "EUR");
  assert.deepEqual(others.map((o) => o.currency), ["PLN"]);
  assert.equal(closeFor(close, "USD").main, null);
});

test("plan state: off, no plan, covered, short", () => {
  assert.deepEqual(planState(null), { kind: "off" });
  assert.deepEqual(planState({ enabled: true, strategy_state: "missing", planned: null, comparison: null }),
    { kind: "no_plan", strategy: "missing" });
  const inv = (status, suggested, difference) => ({
    enabled: true, strategy_state: "valid", planned: { amount: 2000, currency: "PLN", day_of_month: 10 },
    comparison: { currency: "PLN", has_data: true, surplus: 4724.25, suggested_transfer: suggested, difference, status },
  });
  assert.deepEqual(planState(inv("covered", 3724.25, 1724.25)),
    { kind: "covered", planned: 2000, currency: "PLN", suggested: 3724.25, difference: 1724.25, hasData: true });
  assert.equal(planState(inv("short", 1724.25, -275.75)).kind, "short");
});

test("cushion form: draft from settings and back, with Polish validation", () => {
  const off = { enabled: false, currency: null, target_amount: null, target_months: null, account_ids: [], monthly_max: null };
  const d = cushionDraft(off, "EUR");
  assert.deepEqual(d, { enabled: false, mode: "amount", amount: "", months: "6", currency: "EUR", accountIds: [], monthlyMax: "" });
  // turning it on without a target is refused before the request
  assert.deepEqual(cushionPayload({ ...d, enabled: true }, "EUR"),
    { ok: false, error: "Podaj kwotę większą od zera." });
  assert.deepEqual(cushionPayload({ ...d, enabled: true, amount: "30 000,50", monthlyMax: "1000" }, "EUR"), {
    ok: true,
    value: { enabled: true, currency: null, target_amount: 30000.5, target_months: null, account_ids: [], monthly_max: 1000 },
  });
  assert.equal(cushionPayload({ ...d, enabled: true, mode: "months", months: "40" }, "EUR").ok, false);
  assert.deepEqual(cushionPayload({ ...d, enabled: true, mode: "months", months: "6", currency: "PLN", accountIds: [3] }, "EUR").value,
    { enabled: true, currency: "PLN", target_amount: null, target_months: 6, account_ids: [3], monthly_max: null });
  assert.equal(cushionPayload({ ...d, monthlyMax: "-5" }, "EUR").ok, false);
  // a months-based setting reopens in the months mode
  assert.equal(cushionDraft({ ...off, enabled: true, target_months: 4 }, "PLN").mode, "months");
  // switching it off keeps a valid payload (the server needs no target then)
  assert.deepEqual(cushionPayload(d, "EUR"),
    { ok: true, value: { enabled: false, currency: null, target_amount: null, target_months: null, account_ids: [], monthly_max: null } });
});
