// Manual asset note and form bodies (F7 OB5, src/modules/assets/logic.ts). Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanNote, createBody, isAsset, monthlyLoss, NOTE_MAX, parseValue, patchBody, ratePct, sumByCurrency, valuationLabel, visibleRows,
} from "../src/modules/assets/logic.ts";

test("the note is one line (whitespace folded) and blank clears it", () => {
  assert.equal(cleanNote("  wierzytelność\n w toku \t do 03.2027 "), "wierzytelność w toku do 03.2027");
  assert.equal(cleanNote("a\n b\t c"), "a b c");
  assert.equal(cleanNote("   "), null);
  assert.equal(cleanNote(null), null);
  assert.equal(NOTE_MAX, 500);
});

test("add form: name and a value >= 0 are required, note and currency optional", () => {
  const ok = createBody({ name: " Działka  rekreacyjna ", type: "property", value: "120 000,50", currency: "pln", note: " " });
  assert.deepEqual(ok, { ok: true, body: { name: "Działka rekreacyjna", type: "property", value: 120000.5, currency: "PLN" } });
  assert.deepEqual(createBody({ name: "X", type: "other", value: "0", currency: "", note: "zwrot do 2027" }).body, { name: "X", type: "other", value: 0, note: "zwrot do 2027" });
  assert.equal(createBody({ name: "", type: "other", value: "1", currency: "PLN", note: "" }).ok, false);
  assert.equal(createBody({ name: "X", type: "other", value: "-5", currency: "PLN", note: "" }).ok, false);
  assert.equal(createBody({ name: "X", type: "other", value: "1", currency: "PLN", note: "x".repeat(501) }).ok, false);
  assert.equal(parseValue("545 000"), 545000);
  assert.equal(parseValue("abc"), null);
});

test("row edit sends only what changed: a note-only edit carries no value; blank note clears", () => {
  const row = { note: "stara", balance: 545000 };
  assert.deepEqual(patchBody(row, { note: "nowa", value: "545000" }), { ok: true, body: { note: "nowa" } });
  assert.deepEqual(patchBody(row, { note: "stara", value: "545 000,00" }), { ok: true, body: {} });
  assert.deepEqual(patchBody(row, { note: "", value: "550000" }), { ok: true, body: { note: null, value: 550000 } });
  assert.deepEqual(patchBody({ note: null, balance: 52600 }, { note: "auto", value: null }), { ok: true, body: { note: "auto" } }); // vehicle: no value
  assert.equal(patchBody(row, { note: "x".repeat(501), value: null }).ok, false);
});

// ---- the Majątek widget on Przegląd (F7 merge) ------------------------------------------------------------

test("monthly loss of a vehicle: declining balance at the yearly rate (a fraction, contract), the floor stops it", () => {
  const dep = { purchase_price: 89000, purchase_date: "2023-04-14", annual_rate: 0.15, floor: null };
  assert.ok(Math.abs(monthlyLoss(52600, dep) - 707.6) < 0.1);
  assert.equal(monthlyLoss(8000, { ...dep, floor: 8000 }), 0);
  assert.equal(monthlyLoss(7000, { ...dep, floor: 8000 }), 0);
  // just above the floor: never past it within the month
  assert.equal(monthlyLoss(8100, { ...dep, floor: 8000 }), 100);
  assert.equal(monthlyLoss(52600, null), null);
  assert.equal(monthlyLoss(52600, undefined), null);
  assert.equal(monthlyLoss(null, dep), null);
  assert.equal(ratePct(0.15), "15");
  assert.equal(ratePct(0.125), "12,5");
});

test("valuation line: day.month this year, the year otherwise; older than 365 days is stale", () => {
  assert.deepEqual(valuationLabel("2026-09-01", "2026-10-05"), { text: "wycena 1.09", stale: false });
  assert.deepEqual(valuationLabel("2025-03-03", "2026-10-05"), { text: "wycena 3.03.2025", stale: true });
  assert.equal(valuationLabel("2025-10-05", "2026-10-05").stale, false); // exactly 365 days
  assert.equal(valuationLabel("2025-10-04", "2026-10-05").stale, true); // 366
  assert.equal(valuationLabel(null, "2026-10-05"), null);
  assert.equal(valuationLabel("", "2026-10-05"), null);
});

test("totals per currency: base first, the rest alphabetical, null as 0, never summed across currencies", () => {
  const rows = [
    { balance: 545000, currency: "PLN" }, { balance: 1000, currency: "USD" }, { balance: null, currency: "PLN" },
    { balance: 2000, currency: "EUR" }, { balance: 52600, currency: "PLN" },
  ];
  assert.deepEqual(sumByCurrency(rows, "PLN"), [["PLN", 597600], ["EUR", 2000], ["USD", 1000]]);
  assert.deepEqual(sumByCurrency(rows, "USD"), [["USD", 1000], ["EUR", 2000], ["PLN", 597600]]);
  assert.deepEqual(sumByCurrency([], "PLN"), []);
});

test("rows: the first five unless all; assets of the net-worth fallback", () => {
  const r = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(visibleRows(r, false), [1, 2, 3, 4, 5]);
  assert.deepEqual(visibleRows(r, true), r);
  assert.deepEqual(visibleRows(r, false, 3), [1, 2, 3]);
  const acc = (type, bank = "manual", is_liability = false) => ({ type, bank, is_liability });
  assert.equal(isAsset(acc("property")), true);
  assert.equal(isAsset(acc("vehicle")), true);
  assert.equal(isAsset(acc("other")), true);
  assert.equal(isAsset(acc("other", "manual", true)), false);
  assert.equal(isAsset(acc("other", "mbank")), false);
  assert.equal(isAsset(acc("cash")), false);
});

test("valuation date: on_date with the add form; with an edit only together with a changed value; never in the future", () => {
  const d = { name: "Kaucja za najem", type: "other", value: "6000", currency: "PLN", note: "" };
  assert.equal(createBody({ ...d, onDate: "2026-09-30" }, "2026-10-05").body.on_date, "2026-09-30");
  assert.equal("on_date" in createBody(d, "2026-10-05").body, false);
  assert.equal("on_date" in createBody({ ...d, onDate: "" }, "2026-10-05").body, false);
  assert.deepEqual(createBody({ ...d, onDate: "2026-10-06" }, "2026-10-05"), { ok: false, error: "Data wyceny nie może być z przyszłości." });
  const row = { note: null, balance: 545000 };
  assert.deepEqual(patchBody(row, { note: "", value: "550 000", onDate: "2026-10-01" }, "2026-10-05"), { ok: true, body: { value: 550000, on_date: "2026-10-01" } });
  assert.deepEqual(patchBody(row, { note: "", value: "545 000", onDate: "2026-10-01" }, "2026-10-05"), { ok: true, body: {} });
  assert.deepEqual(patchBody(row, { note: "x", value: null, onDate: "2026-10-01" }, "2026-10-05"), { ok: true, body: { note: "x" } }); // vehicle
  assert.equal(patchBody(row, { note: "", value: "550000", onDate: "2027-01-01" }, "2026-10-05").ok, false);
});

// ---- first steps: vehicles and the steps (design/v3/first-steps sections 10, 11) ------------------------------
import { assetSteps, CREATE_TYPES, curveBody, curveDraft, curvePreview, vehicleValue } from "../src/modules/assets/logic.ts";

test("first steps: a vehicle's value follows the declining-balance curve (depreciation.py)", () => {
  // 523 days at 15 % a year: 80 000 * 0.85 ** (523 / 365.25)
  assert.ok(Math.abs(vehicleValue(80000, "2025-05-01", 15, null, "2026-10-06") - 63391) < 1);
  assert.equal(vehicleValue(80000, "2025-05-01", 15, 70000, "2026-10-06"), 70000);
  assert.equal(vehicleValue(80000, "2026-11-01", 15, null, "2026-10-06"), 0);
  const p = curvePreview({ price: "80 000", purchaseDate: "2025-05-01", ratePct: "15", floor: "" }, "2026-10-06");
  assert.equal(Math.round(p.loss), 853);
  const atFloor = curvePreview({ price: "80000", purchaseDate: "2025-05-01", ratePct: "15", floor: "70000" }, "2026-10-06");
  assert.equal(atFloor.value, 70000);
  assert.equal(atFloor.loss, 0);
});

test("first steps: the vehicle body carries the curve (rate a fraction), no value", () => {
  assert.ok(CREATE_TYPES.includes("vehicle"));
  const r = createBody({ name: "Auto", type: "vehicle", value: "", currency: "pln", note: "", curve: { price: "80 000", purchaseDate: "2025-05-01", ratePct: "15", floor: "" } }, "2026-10-06");
  assert.deepEqual(r, { ok: true, body: { name: "Auto", type: "vehicle", currency: "PLN", depreciation: { purchase_price: 80000, purchase_date: "2025-05-01", annual_rate: 0.15, floor: null } } });
  assert.ok(!("value" in r.body) && !("on_date" in r.body));
  const c = (o) => curveBody({ price: "80000", purchaseDate: "2025-05-01", ratePct: "15", floor: "", ...o }, "2026-10-06");
  assert.equal(c({ price: "0" }).error, "Podaj cenę zakupu (liczba większa od 0).");
  assert.equal(c({ purchaseDate: "" }).error, "Podaj datę zakupu.");
  assert.equal(c({ purchaseDate: "2026-12-01" }).error, "Data zakupu nie może być z przyszłości.");
  assert.equal(c({ ratePct: "101" }).error, "Roczny spadek od 0 do 100 %.");
  assert.equal(c({ floor: "90000" }).error, "Wartość minimalna nie może przekraczać ceny zakupu.");
  assert.equal(c({ ratePct: "12,5" }).body.annual_rate, 0.125);
});

test("first steps: a vehicle edit sends the curve only when a curve field changed", () => {
  const dep = { purchase_price: 80000, purchase_date: "2025-05-01", annual_rate: 0.15, floor: null };
  const row = { note: null, balance: 63391, depreciation: dep };
  const draft = curveDraft(dep, "2026-10-06");
  assert.deepEqual(draft, { price: "80000", purchaseDate: "2025-05-01", ratePct: "15", floor: "" });
  assert.deepEqual(patchBody(row, { note: "", value: null, curve: draft }, "2026-10-06"), { ok: true, body: {} });
  assert.deepEqual(patchBody(row, { note: "x", value: null, curve: draft }, "2026-10-06"), { ok: true, body: { note: "x" } });
  assert.deepEqual(patchBody(row, { note: "", value: null, curve: { ...draft, ratePct: "20" } }, "2026-10-06").body,
    { depreciation: { purchase_price: 80000, purchase_date: "2025-05-01", annual_rate: 0.2, floor: null } });
  assert.equal(patchBody(row, { note: "", value: null, curve: { ...draft, price: "" } }, "2026-10-06").ok, false);
});

test("first steps: the assets steps come from the rows", () => {
  assert.deepEqual(assetSteps([]), { position: "on", vehicle: "todo" });
  assert.deepEqual(assetSteps([{ kind: "manual", type: "property" }]), { position: "done", vehicle: "todo" });
  assert.deepEqual(assetSteps([{ kind: "vehicle", type: "vehicle", depreciation: { purchase_price: 1, purchase_date: "2025-01-01", annual_rate: 0.1, floor: null } }]),
    { position: "done", vehicle: "done" });
  // a car without a curve is not the step done
  assert.deepEqual(assetSteps([{ kind: "vehicle", type: "vehicle", depreciation: null }]), { position: "done", vehicle: "todo" });
});
