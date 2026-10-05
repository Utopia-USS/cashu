// Pure helpers of the investments workspace (labels.ts, logic.ts), run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountLabel, bucketLabel, dm, money, parseNum, pct, pctTarget, pp, plural, qty, wdm,
} from "../src/modules/investments/labels.ts";
import {
  allocScale, bandFor, changeCount, changeRows, commitLabel, decisionEffect, decisionTag, nextDeposit, orderSignals, reviewDue,
  runError, signalFacts, signalTitle, txnCash, validateTxn, warningItems,
} from "../src/modules/investments/logic.ts";

const NB = " ";
const sig = (over) => ({ id: 1, rule_id: "r", kind: "custom", severity: "info", status: "active", message: "m", instrument_label: null, payload: {}, first_seen_at: "2026-10-01T07:00:00Z", decisions: [], ...over });

test("numbers: one decimal with a space before %, pp, signed money, Polish input", () => {
  assert.equal(pct(0.2123), `21,2${NB}%`);
  assert.equal(pct(0.018, true), `+1,8${NB}%`);
  assert.equal(pct(-0.184), `-18,4${NB}%`);
  assert.equal(pct(null), "-");
  assert.equal(pctTarget(0.6), `60${NB}%`);
  assert.equal(pctTarget(0.125), `12,5${NB}%`);
  assert.equal(pp(6.2), `+6,2${NB}pp`);
  assert.equal(pp(-3), `-3,0${NB}pp`);
  assert.ok(money(3240.15, "PLN", true).startsWith("+3"));
  assert.ok(!money(-11600, "PLN", true).startsWith("+"));
  assert.equal(parseNum("1 234,56"), 1234.56);
  assert.equal(parseNum("148.60"), 148.6);
  assert.equal(parseNum("abc"), null);
  assert.equal(qty(0.5), "0,5");
  assert.equal(plural(22, "sygnał", "sygnały", "sygnałów"), "22 sygnały");
  assert.equal(plural(12, "sygnał", "sygnały", "sygnałów"), "12 sygnałów");
});

test("dates: day.month in prose, weekday prefix", () => {
  assert.equal(dm("2026-10-03"), "3.10");
  assert.equal(dm("2026-09-27"), "27.09");
  assert.equal(wdm("2026-10-02"), "pt 2.10");
});

test("labels: accounts by broker and wrapper, buckets readable, never the em dash", () => {
  const a = { id: 1, name: "DIF zwykłe", broker: "dif", broker_name: "DIF Broker", wrapper: "regular" };
  const b = { id: 2, name: "XTB IKE", broker: "xtb", broker_name: "XTB", wrapper: "ike" };
  const c = { id: 3, name: "XTB IKE 2", broker: "xtb", broker_name: "XTB", wrapper: "ike" };
  assert.equal(accountLabel(a, [a, b]), "DIF · zwykłe");
  assert.equal(accountLabel(b, [a, b, c]), "XTB · IKE (XTB IKE)");
  assert.equal(bucketLabel("global_equity"), "Akcje globalne");
  assert.equal(bucketLabel("my_satellites"), "My satellites");
  for (const text of [accountLabel(a), bucketLabel(null), pct(null), money(null)]) assert.ok(!text.includes("\u2014"));
});

test("signals: Polish titles and measured vs threshold per rule kind", () => {
  const dd = sig({ kind: "drawdown_from_high", severity: "action", payload: { drawdown: 0.184, threshold: 0.15, name: "CD Projekt", symbol: "CDR" } });
  assert.equal(signalTitle(dd), `Spadek od szczytu ≥ 15${NB}%`);
  assert.deepEqual(signalFacts(dd), { measured: `-18,4${NB}%`, limit: `próg 15${NB}%` });
  const drift = sig({ kind: "allocation_drift", payload: { bucket_id: "pl_equity", drift_pp: 6.2, drift_value_base: "11600", currency: "PLN", absolute_band_pp: 5 } });
  assert.equal(signalTitle(drift), "Dryf alokacji: Akcje PL");
  assert.match(signalFacts(drift).extra, /nad celem$/);
  assert.equal(signalFacts(drift).limit, `pasmo ±5,0${NB}pp`);
  const cashDrift = sig({ kind: "allocation_drift", payload: { bucket_id: "cash", drift_pp: -2.9, target: 0.1, absolute_band_pp: 5, relative_band: 0.25 } });
  assert.equal(signalFacts(cashDrift).limit, `pasmo ±2,5${NB}pp`); // the relative band is the narrower one
  assert.equal(signalTitle(sig({ kind: "position_concentration", payload: { name: "PKN Orlen", weight: 0.111, max_weight: 0.1 } })), "Koncentracja: PKN Orlen");
  assert.equal(signalTitle(sig({ kind: "cash_level", payload: { direction: "above_max" } })), "Za dużo gotówki");
  assert.equal(signalTitle(sig({ kind: "custom", message: "Cash is waiting" })), "Cash is waiting");
  assert.equal(signalFacts(sig({ kind: "contribution_gap", payload: { last_deposit: "2026-08-10", day_of_month: 10, grace_days: 10 } })).measured, "ostatnia wpłata 10.08");
});

test("signals: undecided first (action before review), decided move to the bottom", () => {
  const list = [
    sig({ id: 1, severity: "info" }),
    sig({ id: 2, severity: "action", decisions: [{ action: "bought", quantity: 20, created_at: null }] }),
    sig({ id: 3, severity: "action" }),
  ];
  assert.deepEqual(orderSignals(list).map((s) => s.id), [3, 1, 2]);
  assert.equal(decisionTag({ action: "bought", quantity: 20 }), "decyzja: dokupuję 20 szt.");
  assert.equal(decisionTag({ action: "held", quantity: null }), "decyzja: bez zmian");
});

test("allocation: band is the narrower of absolute pp and relative, scale covers target + band", () => {
  const policy = { absolute_band_pp: 5, relative_band: 0.25, min_trade_value: 500 };
  assert.deepEqual(bandFor(0.6, policy).map((x) => Math.round(x * 1000) / 1000), [0.55, 0.65]);
  assert.deepEqual(bandFor(0.15, policy).map((x) => Math.round(x * 10000) / 10000), [0.1125, 0.1875]);
  assert.equal(bandFor(0.2, null), null);
  assert.equal(allocScale([{ weight: 0.57, target: 0.6 }, { weight: 0.21, target: 0.15 }], policy), 0.7);
  assert.equal(allocScale([{ weight: 0.3 }], null), 0.3);
});

test("decision effect: buying from the account's cash keeps the total, bucket share and drift move", () => {
  const bucket = { bucket_id: "pl_equity", weight: 0.212, target: 0.15, drift_pp: 6.2, value: 39517, to_target: -11600, out_of_band: true };
  const line = decisionEffect({ side: "buy", quantity: 20, price: 148.6, currency: "PLN", bucket, total: 186401.2, base: "PLN" });
  assert.match(line, /Akcje PL po transakcji: 22,8/);
  assert.match(line, /dryf rośnie do \+7,8/);
  assert.equal(decisionEffect({ side: "buy", quantity: null, price: 1, currency: "PLN", bucket, total: 1, base: "PLN" }), null);
});

test("weekly review: due after the digest weekday until done, change rows and count", () => {
  assert.equal(reviewDue("2026-10-04", "sunday", "2026-09-27T11:00:00Z"), true); // Sunday, last review a week ago
  assert.equal(reviewDue("2026-10-04", "sunday", "2026-10-04T09:00:00Z"), false); // done today
  assert.equal(reviewDue("2026-10-06", "sunday", "2026-10-04T09:00:00Z"), false); // Tuesday after a done Sunday
  assert.equal(reviewDue("2026-10-06", "sunday", null), true);
  const dg = {
    since: "2026-09-27", as_of: "2026-10-04",
    value: { currency: "PLN", then: 183161.05, now: 186401.2, change: 3240.15, change_pct: 0.0177 },
    signals: { new: [sig({ kind: "contribution_gap" })], escalated: [], resolved: [sig({ kind: "gain_from_cost", payload: { threshold: 0.5 } })], open: 4, undecided: 3 },
    imports: [{ inserted: 6, account_id: 1, created_at: "2026-10-01T19:00:00Z", new_instruments: 1, file_name: "x.csv" }],
    transactions: { count: 6, by_type: { buy: 2, fee: 3, dividend: 1 }, manual: 0 },
    decisions: [], dividends: { PLN: 1344 }, price_moves: [], warnings: [], stale_count: 2,
    strategy: { version: 7, state: "valid", changed_since: false },
  };
  const rows = changeRows(dg, [{ id: 1, name: "DIF", broker: "dif", broker_name: "DIF Broker", wrapper: "regular" }]);
  assert.deepEqual(rows.map((r) => r.key), ["value", "import", "signals", "dividends", "prices", "strategy"]);
  assert.match(rows[1].main, /^6 transakcji z DIF · zwykłe/);
  assert.match(rows[2].main, /1 nowy, 1 wygasł/);
  assert.equal(rows[5].main, "bez zmian");
  assert.equal(changeCount(dg), 4); // 1 new + 1 resolved + 1 import + dividends
});

test("manual transaction: per-type requirements and the cash sign", () => {
  const base = { type: "buy", hasInstrument: true, quantity: 10, price: 50, amount: null, fee: 1, split: null, date: "2026-10-01" };
  assert.deepEqual(validateTxn(base, "2026-10-04"), {});
  assert.ok(validateTxn({ ...base, hasInstrument: false }, "2026-10-04").instrument);
  assert.ok(validateTxn({ ...base, quantity: 0 }, "2026-10-04").quantity);
  assert.ok(validateTxn({ ...base, date: "2026-10-09" }, "2026-10-04").date);
  assert.ok(validateTxn({ ...base, type: "deposit", hasInstrument: false, amount: null }, "2026-10-04").amount);
  assert.ok(validateTxn({ ...base, type: "split", split: null }, "2026-10-04").split);
  assert.equal(txnCash(base), -501);
  assert.equal(txnCash({ ...base, type: "sell" }), 499);
  assert.equal(txnCash({ ...base, type: "deposit", amount: 1000, fee: null }), 1000);
  assert.equal(txnCash({ ...base, type: "transfer_in" }), 0);
});

test("import + data warnings copy", () => {
  assert.equal(commitLabel(14, 1), "Zaimportuj 14 transakcji i 1 korektę");
  assert.equal(commitLabel(2, 0), "Zaimportuj 2 transakcje");
  assert.equal(nextDeposit("2026-10-04", 10), "2026-10-10");
  assert.equal(nextDeposit("2026-10-12", 10), "2026-11-10");
  const items = warningItems({
    warnings: [
      { kind: "missing_fx_rate", message: "No USD/PLN FX rate on or before 2026-10-03", account_id: null, instrument_id: null },
      { kind: "unknown_cost_basis", message: "x", account_id: 1, instrument_id: 5 },
      { kind: "unknown_cost_basis", message: "y", account_id: 1, instrument_id: 5 },
    ],
    labels: new Map([["5", "KGHM"]]),
    accounts: [{ id: 2, name: "XTB IKE", broker: "xtb", broker_name: "XTB", wrapper: "ike", snapshot_date: "2026-09-15", last_import: { at: "2026-09-15" } }],
    stale: [{ instrument_id: 7, label: "EIMI", price_date: "2026-10-01" }],
    missingFx: [],
    today: "2026-10-04",
  });
  assert.deepEqual(items.map((w) => w.title), [
    "XTB · IKE: brak snapshotu od 15.09", "EIMI: nieaktualna cena", "Kurs NBP USD niedostępny", "Brak kosztu nabycia dla 2 lotów",
  ]);
});

test("rule run errors read in Polish", () => {
  assert.equal(runError("rule cash_floor inactive: cash_level needs min_weight"), "reguła cash_floor nieaktywna (błąd w strategy.yaml)");
  assert.equal(runError("stooq: HTTP 503"), "źródło cen lub kursów nie odpowiedziało");
  assert.equal(runError(null), "");
});
