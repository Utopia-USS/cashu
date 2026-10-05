// Instrument identity (design/v2/instrument-label/instrument-label.md) and the generic allocation interface
// (F7-generic), run with `npm test`: the tile monogram, the hover card's facts (Polish only, no bucket), the
// one-line summary, exchange names, the Aktywa sub line; generic bucket labels, hidden drift signals, the
// allocation gate, server texts with bucket ids, benchmark names.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alertConditionText, allocGeneric, benchmarkLabel, digestShown, instCardFacts, instMono, instSummary, isShownSignal, signalText, subLine,
  unnameBuckets,
} from "../src/modules/investments/v2/logic.ts";
import { bucketGenitive, bucketLabel, GENERIC_BUCKET_IDS, isGenericBucket, micName } from "../src/modules/investments/labels.ts";

const inst = (over) => ({ id: 1, label: "Intel Corp.", name: "Intel Corp.", symbol: "INTC", mic: "XNAS", isin: "US4581401001", asset_class: "equity", region: "us", status: "active", valuation_mode: "market", needs_classification: false, ...over });

test("instMono: the ticker in 2-5 characters, venue / quote suffixes stripped, bond codes keep the letters, else initials", () => {
  const m = (symbol, name = "X", label = name) => instMono({ symbol, name, label });
  assert.equal(m("INTC"), "INTC");
  assert.equal(m("vwce"), "VWCE");
  assert.equal(m("CDR.WA"), "CDR");
  assert.equal(m("BTC-USD"), "BTC");
  assert.equal(m("0241.HK"), "0241");
  assert.equal(m("00241"), "00241");
  assert.equal(m("EDO0535"), "EDO");
  assert.equal(m("COI1132"), "COI");
  assert.equal(m("GOOGL"), "GOOG");
  assert.equal(m("BRK-B"), "BRK-B"); // a share class keeps its letter (the one 5-character non-digit case)
  assert.equal(m("IUSQ"), "IUSQ");
  assert.equal(m("VWCE.DE"), "VWCE");
  assert.equal(m(null, "Obligacje EDO"), "OE");
  assert.equal(m(null, null, "Lokata"), "LO");
  assert.equal(m("", "", ""), "?");
  for (const s of ["INTC", "GOOGL", "00241", "123456", "ABCDEFG", "0241.HK", "BTC-USD", "BRK-B", "EDO0535"]) {
    const r = m(s);
    assert.ok(r.length >= 2 && r.length <= 5, `${s} -> ${r}`);
    if (r.length === 5) assert.ok(/^\d{5}$/.test(r) || /^[A-Z0-9]{1,3}-[A-Z]$/.test(r), `${s} -> ${r}`);
  }
});

test("instCardFacts: Polish facts only, klasa + region, rachunek / rachunki, ISIN, status tags only when not normal, no bucket", () => {
  const f = instCardFacts(inst({}), { accounts: ["XTB · IKE"] });
  assert.deepEqual(f.head, ["Intel Corp.", "INTC · Nasdaq"]);
  assert.deepEqual(f.rows, [["klasa", "akcje · USA"], ["rachunek", "XTB · IKE"], ["ISIN", "US4581401001"]]);
  assert.deepEqual(f.status, []);
  assert.ok(!f.rows.some(([k]) => k === "koszyk")); // F7-generic: no bucket row
  assert.deepEqual(instCardFacts(inst({ status: "frozen" })).status, ["zamrożony"]);
  assert.deepEqual(instCardFacts(inst({ status: "delisted" })).status, ["wycofany z giełdy"]);
  assert.deepEqual(instCardFacts(inst({ status: "weird" })).status, ["nieaktywny"]);
  assert.deepEqual(instCardFacts(inst({ needs_classification: true })).status, ["do sklasyfikowania"]);
  assert.deepEqual(instCardFacts(inst({ valuation_mode: "cost" })).status, ["koszt + odsetki"]);
  assert.deepEqual(instCardFacts(inst({ valuation_mode: "manual" })).status, ["wycena ręczna"]);
  assert.deepEqual(instCardFacts(inst({}), { stale: "2026-10-01" }).status, ["cena z 1.10"]);
  // watched (no accounts): no rachunek row; two accounts: `rachunki`, comma-joined; no region: no ` · `
  assert.ok(!instCardFacts(inst({})).rows.some(([k]) => k.startsWith("rachun")));
  assert.deepEqual(instCardFacts(inst({}), { accounts: ["XTB · IKE", "DIF · zwykłe"] }).rows[1], ["rachunki", "XTB · IKE, DIF · zwykłe"]);
  assert.deepEqual(instCardFacts(inst({ region: null })).rows[0], ["klasa", "akcje"]);
  assert.deepEqual(instCardFacts(inst({ region: "unknown" })).rows[0], ["klasa", "akcje"]);
  // never a raw backend word
  for (const o of [{}, { status: "frozen" }, { status: "delisted" }, { asset_class: "bond", region: "pl" }, { asset_class: "cash" }, { asset_class: "etf", region: "global" }, { asset_class: "weird_class", region: "mars" }]) {
    const facts = instCardFacts(inst(o), { accounts: ["XTB · IKE"] });
    assert.ok(!/\b(active|frozen|delisted|equity|etf|bond|cash|weird_class|mars)\b/.test(JSON.stringify(facts)), JSON.stringify(facts));
  }
});

test("instSummary, micName, the Aktywa sub line", () => {
  assert.equal(instSummary(inst({ isin: null }), { accounts: ["XTB · IKE"] }), "INTC · Nasdaq · akcje · USA · XTB · IKE");
  assert.equal(instSummary(inst({ isin: null, mic: null, region: null })), "INTC · akcje");
  assert.equal(micName("XNAS"), "Nasdaq");
  assert.equal(micName("xwar"), "GPW");
  assert.equal(micName("XXXX"), "XXXX");
  assert.equal(micName(null), null);
  const accLabel = (id) => (id === 1 ? "XTB · IKE" : "DIF · zwykłe");
  assert.equal(subLine({ cost: true, split: "total", accounts: [{ account_id: 1 }], accLabel }), "koszt + odsetki");
  assert.equal(subLine({ cost: false, split: "account", accounts: [{ account_id: 1 }], accLabel }), "XTB · IKE");
  assert.equal(subLine({ cost: true, split: "account", accounts: [{ account_id: 2 }], accLabel }), "koszt + odsetki · DIF · zwykłe");
  assert.equal(subLine({ cost: false, split: "account", accounts: [{ account_id: 1 }, { account_id: 2 }], accLabel }), undefined);
  assert.equal(subLine({ cost: false, split: "total", accounts: [{ account_id: 1 }], accLabel }), undefined);
});

test("generic buckets: the contract's 14 ids have Polish labels, any other id has none (never rendered raw)", () => {
  assert.deepEqual([...GENERIC_BUCKET_IDS].sort(), ["bond_etfs", "bonds", "cash", "commodities", "crypto", "equities", "equity", "fixed_income", "global_equity", "gold", "real_estate", "reits", "stocks", "treasury_bonds"]);
  for (const id of GENERIC_BUCKET_IDS) assert.ok(bucketLabel(id) && !/[_]/.test(bucketLabel(id)), id);
  assert.equal(bucketLabel("global_equity"), "Akcje globalne");
  assert.equal(bucketLabel("bond_etfs"), "ETF-y obligacyjne");
  assert.equal(bucketLabel("treasury_bonds"), "Obligacje skarbowe");
  for (const id of ["core", "active", "satellite", "speculative", "developed", "pl_equity", "my_picks", "Stocks", "", null]) {
    assert.equal(bucketLabel(id), null, String(id));
    assert.equal(isGenericBucket(id), false, String(id));
  }
  assert.equal(bucketGenitive("global_equity"), "Akcji globalnych");
  assert.equal(bucketGenitive("core"), null);
});

test("GF4: an allocation drift of a non-generic bucket never shows; everything else does (missing flag = generic)", () => {
  const drift = (payload) => ({ kind: "allocation_drift", payload });
  assert.equal(isShownSignal(drift({ bucket_id: "global_equity", bucket_generic: true })), true);
  assert.equal(isShownSignal(drift({ bucket_id: "global_equity" })), true); // older server: no flag
  assert.equal(isShownSignal(drift({ bucket_id: "global_equity", bucket_generic: false })), false);
  assert.equal(isShownSignal(drift({ bucket_id: "core", bucket_generic: false })), false);
  assert.equal(isShownSignal(drift({ bucket_id: "core" })), false); // no label: never named, so not shown
  assert.equal(isShownSignal(drift({})), false);
  assert.equal(isShownSignal({ kind: "position_concentration", payload: { bucket_generic: false } }), true);
  assert.equal(isShownSignal({ kind: "custom", payload: {} }), true);
  const d = digestShown({
    signals: { new: [drift({ bucket_id: "core", bucket_generic: false }), { kind: "custom", payload: {} }], escalated: [], resolved: [drift({ bucket_id: "cash", bucket_generic: true })], open: 3, undecided: 2 },
    events: [{ kind: "allocation_drift", bucket_id: "core" }, { kind: "allocation_drift", bucket_id: "cash" }, { kind: "custom" }, { type: "import" }],
  });
  assert.equal(d.signals.new.length, 1);
  assert.equal(d.signals.resolved.length, 1);
  assert.equal(d.signals.open, 3);
  assert.deepEqual(d.events.map((e) => e.bucket_id ?? e.kind ?? e.type), ["cash", "custom", "import"]);
});

test("GF3: targets and drift only for a generic allocation", () => {
  const b = (bucket_id, generic) => ({ bucket_id, ...(generic === undefined ? {} : { generic }) });
  assert.equal(allocGeneric({ buckets: [b("global_equity", true), b("cash", true)], buckets_generic: true }), true);
  assert.equal(allocGeneric({ buckets: [b("global_equity"), b("cash")] }), true); // older server
  assert.equal(allocGeneric({ buckets: [b("global_equity", true), b("core", false)], buckets_generic: false }), false);
  assert.equal(allocGeneric({ buckets: [b("global_equity"), b("core")] }), false); // no label for `core`
  assert.equal(allocGeneric({ buckets: [b("global_equity", true)], buckets_generic: false }), false);
  assert.equal(allocGeneric({ buckets: [], buckets_generic: false }), false);
});

test("server texts with a bucket id: generic -> label, other id dropped", () => {
  assert.equal(unnameBuckets("Koszyk core: gotówka 12 % > 10 %"), "Koszyk: gotówka 12 % > 10 %");
  assert.equal(unnameBuckets("Koszyk bonds: waga 18 %"), "Koszyk Obligacje: waga 18 %");
  assert.equal(unnameBuckets("Koszyk active powyżej 25 %"), "Koszyk powyżej 25 %");
  assert.equal(unnameBuckets("Akcje PL powyżej 25 %"), "Akcje PL powyżej 25 %");
});

test("FE-A A3: ids in any case, ids inside expressions, owner words and labels kept, idempotent", () => {
  const cases = [
    ["Koszyk Active: Warunek spełniony", "Koszyk: Warunek spełniony"], // any case; generic ids stay case-sensitive
    ["Koszyk Stocks: x", "Koszyk: x"],
    ["koszyk my_picks: x", "koszyk: x"],
    ["Koszyk cash", "Koszyk Gotówka"],
    ["Koszyk Obligacje skarbowe: x", "Koszyk Obligacje skarbowe: x"], // already a label
    ["Koszyk ETF-y obligacyjne: x", "Koszyk ETF-y obligacyjne: x"],
    ["Koszyk akcji powyżej 30 %", "Koszyk akcji powyżej 30 %"], // the owner's own words
    ["Koszyk powyżej 25 %", "Koszyk powyżej 25 %"],
    ['Warunek spełniony: bucket_drift_pp("core") > 5', "Warunek spełniony: dryf koszyka > 5"],
    ["bucket_weight('active') > 0.3 and bucket_value(\"x1\") > 100", "waga koszyka > 0.3 and wartość koszyka > 100"],
    ['bucket_target("global_equity") > 0.5', 'bucket_target("global_equity") > 0.5'], // generic id stays
    ['bucket_id == "core" and bucket_drift_pp("cash") > 2', 'bucket_id == "…" and bucket_drift_pp("cash") > 2'],
    ['"active" != bucket_id', '"…" != bucket_id'],
  ];
  for (const [input, want] of cases) {
    assert.equal(unnameBuckets(input), want, input);
    assert.equal(unnameBuckets(want), want, `idempotent: ${want}`);
  }
  // where the owner sees them: a custom rule's default message (rail / dialog title), a custom alert's expression
  assert.equal(signalText({ id: 1, rule_id: "r", kind: "custom", severity: "info", status: "active", message: 'Warunek spełniony: bucket_drift_pp("core") > 5', instrument_id: null, instrument_label: null, payload: {}, first_seen_at: null, decisions: [] }).title,
    "Warunek spełniony: dryf koszyka > 5");
  assert.equal(alertConditionText({ kind: "custom", scope: "portfolio", params: { expression: 'bucket_weight("active") > 0.3' } }), "wyrażenie: waga koszyka > 0.3");
});

test("GF7: a benchmark is named, never its strategy id", () => {
  assert.equal(benchmarkLabel({ id: "msci_acwi" }), "MSCI ACWI");
  assert.equal(benchmarkLabel({ id: "MSCI_World" }), "MSCI World");
  assert.equal(benchmarkLabel({ id: "ftse_all_world" }), "FTSE All-World");
  assert.equal(benchmarkLabel({ id: "sp500" }), "S&P 500");
  assert.equal(benchmarkLabel({ id: "msci_em" }), "MSCI EM");
  assert.equal(benchmarkLabel({ id: "wig20" }), "WIG20");
  assert.equal(benchmarkLabel({ id: "wig" }), "WIG");
  assert.equal(benchmarkLabel({ id: "stoxx600" }), "STOXX 600");
  assert.equal(benchmarkLabel({ id: "my_mix_70_30" }), "benchmark");
  assert.equal(benchmarkLabel({ id: "my_mix_70_30", proxy_label: "Vanguard FTSE All-World" }), "Vanguard FTSE All-World");
  assert.equal(benchmarkLabel({ id: null }), "benchmark");
  assert.equal(benchmarkLabel(null), "benchmark");
});
