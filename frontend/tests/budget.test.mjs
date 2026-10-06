// Budget module pure helpers (src/modules/budget/logic.ts), run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeFor, cushionDraft, cushionPayload, monthLabel, pickCurrency, planState, resyncBankText, shiftMonth,
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

// ---- first steps: statement import (design/v3/first-steps sections 3, 4) -------------------------------------
import { bankAccounts, bankName, bankOptions, BANKS, cliPrefix, dmShort, importDoneLine, previewRows, statementDone, statementErrorKey } from "../src/modules/budget/logic.ts";

test("first steps: bank accounts and the statement step's done line", () => {
  const acc = [
    { bank: "mbank", type: "checking", name: "eKonto", iban_tail: "1234", currency: "PLN", as_of: "2026-09-30" },
    { bank: "manual", type: "property", name: "Mieszkanie", iban_tail: "", currency: "PLN", as_of: null },
    { bank: "cash", type: "cash", name: "Gotówka", iban_tail: "", currency: "PLN", as_of: null },
    { bank: "pekao", type: "savings", name: "Oszczędności", iban_tail: "", currency: "EUR", as_of: "2026-10-03" },
  ];
  const b = bankAccounts(acc);
  assert.deepEqual(b.map((a) => a.name), ["eKonto", "Oszczędności"]);
  assert.equal(statementDone(b), "mBank · eKonto · …1234 · PLN · Bank Pekao · Oszczędności · EUR · ostatni import 3.10");
  assert.equal(statementDone([]), "");
  assert.deepEqual(BANKS.map(([k]) => k), ["auto", "mbank", "pekao", "erste"]);
  assert.equal(bankName("erste"), "Erste Bank Polska");
  assert.equal(bankName("ing"), "ing");
  assert.equal(bankName("mbank", [{ id: "mbank", name: "mBank S.A." }]), "mBank S.A.");
  // GET /budget/import/importers: auto, banks, the finanse format; connectors are sources of their own
  const choices = [
    { id: "auto", name: "rozpoznaj automatycznie", kind: "auto", available: true },
    { id: "mbank", name: "mBank", kind: "bank", available: true },
    { id: "finanse-budget", name: "Format finanse", kind: "format", available: true },
    { id: "connector:ing", name: "ING", kind: "connector", available: true },
    { id: "pekao", name: "Bank Pekao", kind: "bank", available: false },
  ];
  assert.deepEqual(bankOptions(choices), [["auto", "rozpoznaj automatycznie"], ["mbank", "mBank"], ["finanse-budget", "Format finanse"]]);
  assert.deepEqual(bankOptions(null), BANKS);
  assert.deepEqual(bankOptions([{ id: "mbank", name: "mBank", kind: "bank", available: true }])[0], ["auto", "rozpoznaj automatycznie"]);
  assert.equal(dmShort("2026-01-05"), "5.01");
});

test("first steps: preview rows (only new, the first 8, show all)", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ row: i + 1, status: i % 3 === 0 ? "duplicate" : "new" }));
  assert.deepEqual(previewRows(rows, false, false).rest, 4);
  assert.equal(previewRows(rows, false, false).shown.length, 8);
  assert.equal(previewRows(rows, false, true).shown.length, 12);
  const onlyNew = previewRows(rows, true, false);
  assert.ok(onlyNew.shown.every((r) => r.status === "new"));
  assert.equal(onlyNew.shown.length + onlyNew.rest, 8);
});

test("first steps: the import done line", () => {
  const d = { batch_id: 1, account: { id: 3, name: "eKonto", currency: "PLN", iban_tail: "1234", created: true }, inserted: 308, duplicates: 4, skipped: 0, categorized: 241, transfer_pairs: 2 };
  assert.equal(importDoneLine(d), "4 duplikaty pominięte · konto eKonto …1234 (nowe) · 241 skategoryzowanych automatycznie · 2 pary przelewów");
  assert.equal(importDoneLine({ ...d, duplicates: 0, transfer_pairs: 0, account: { ...d.account, created: false, iban_tail: null } }),
    "konto eKonto · 241 skategoryzowanych automatycznie");
});

test("first steps: upload errors map to labels, the bank error to the bank select", () => {
  assert.deepEqual(statementErrorKey({ status: 422, code: "import.bank_unknown" }), { key: "error.import_bank_unknown", field: "bank" });
  assert.deepEqual(statementErrorKey({ status: 422, code: "import_bank_unknown" }), { key: "error.import_bank_unknown", field: "bank" });
  assert.deepEqual(statementErrorKey({ status: 422, code: "import.header_missing" }), { key: "error.import_header_missing", field: null });
  assert.deepEqual(statementErrorKey({ status: 413, code: null }), { key: "error.file_too_large", field: "file" });
  assert.deepEqual(statementErrorKey({ status: 500 }), { key: null, field: null });
  assert.deepEqual(statementErrorKey({ status: 413, code: "file_too_large" }), { key: "error.file_too_large", field: "file" });
});

test("first steps: the CLI prefix from the setup response, an action, or the default", () => {
  assert.equal(cliPrefix({ cli_prefix: "finanse --profile jan", steps: [] }, "jan"), "finanse --profile jan");
  assert.equal(cliPrefix({ steps: [{ actions: [{ kind: "cli", target: "uv run finanse --profile ola import-csv WYCIAG.csv" }] }] }, "ola"), "uv run finanse --profile ola");
  assert.equal(cliPrefix(null, "jan"), "finanse --profile jan");
});

test("FE-4 bankAccounts: bank statement types only (no brokerage, property, cash, manual deposits)", () => {
  const acc = (id, bank, type) => ({ id, bank, type });
  const list = [
    acc(1, "mbank", "checking"), acc(2, "pekao", "savings"), acc(3, "mbank", "credit"),
    acc(4, "xtb", "brokerage"), acc(5, "manual", "cash"), acc(6, "manual", "property"), acc(7, "manual", "savings"), acc(8, "bank", "mortgage"),
  ];
  assert.deepEqual(bankAccounts(list).map((a) => a.id), [1, 2, 3]);
});

test("FE-3 resyncBankText: banks line, connectors-only answer, failure", () => {
  assert.equal(resyncBankText({ ok: true, inserted: 3, banks: [{}], pairs: 1, errors: [] }), "Wgrano 3 nowych transakcji, 1 przelewów wewn.");
  assert.equal(resyncBankText({ ok: true, inserted: 0, banks: [{}], errors: ["x"] }), "Wgrano 0 nowych transakcji · 1 konto/a pominięte (limit banku)");
  // bindings but no Enable Banking session: only the connector lines speak
  assert.equal(resyncBankText({ ok: true, inserted: 2, banks: [], pairs: 0, errors: [], connectors: [{}] }), null);
  assert.equal(resyncBankText({ ok: false, error: "Brak sesji" }), "Brak sesji");
  assert.equal(resyncBankText({ ok: false }), "Synchronizacja nieudana");
});
