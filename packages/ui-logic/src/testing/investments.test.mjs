// Pure helpers of the investments workspace (labels.ts, logic.ts), Runs with the ui-logic Vitest suite.
import assert from "node:assert/strict";
import {
  accountLabel,
  bucketLabel,
  dm,
  money,
  parseNum,
  pct,
  pctTarget,
  pp,
  qty,
  wdm,
} from "@cashu/ui-logic/investments/labels";
import {
  decisionEffect,
  decisionTag,
  nextDeposit,
  runError,
  txnCash,
  validateTxn,
  warningItems,
} from "@cashu/ui-logic/investments/logic";
import { test } from "vitest";

const NB = " ";
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
});

test("dates: day.month in prose, weekday prefix", () => {
  assert.equal(dm("2026-10-03"), "3.10");
  assert.equal(dm("2026-09-27"), "27.09");
  assert.equal(wdm("2026-10-02"), "pt 2.10");
});

test("labels: accounts by broker and wrapper, generic buckets readable, other bucket ids never named, never the em dash", () => {
  const a = {
    id: 1,
    name: "DIF zwykłe",
    broker: "dif",
    broker_name: "DIF Broker",
    wrapper: "regular",
  };
  const b = { id: 2, name: "XTB IKE", broker: "xtb", broker_name: "XTB", wrapper: "ike" };
  const c = { id: 3, name: "XTB IKE 2", broker: "xtb", broker_name: "XTB", wrapper: "ike" };
  assert.equal(accountLabel(a, [a, b]), "DIF · zwykłe");
  assert.equal(accountLabel(b, [a, b, c]), "XTB · IKE (XTB IKE)");
  assert.equal(bucketLabel("global_equity"), "Akcje globalne");
  // F7-generic: only generic ids (templates + plain asset classes) have a label; the owner's own ids are not named
  assert.equal(bucketLabel("my_satellites"), null);
  assert.equal(bucketLabel("stocks"), "Akcje");
  assert.equal(bucketLabel("bonds"), "Obligacje");
  assert.equal(bucketLabel("bond_etfs"), "ETF-y obligacyjne");
  assert.equal(bucketLabel("Stocks"), null); // case-sensitive, as the backend's GENERIC_BUCKET_IDS
  assert.equal(bucketLabel("core"), null);
  assert.equal(bucketLabel("active"), null);
  assert.equal(bucketLabel(null), null);
  for (const text of [accountLabel(a), pct(null), money(null)]) assert.ok(!text.includes("\u2014"));
});

test("decision tags: the latest decision's short label", () => {
  assert.equal(decisionTag({ action: "bought", quantity: 20 }), "decyzja: dokupuję 20 szt.");
  assert.equal(decisionTag({ action: "held", quantity: null }), "decyzja: bez zmian");
});

test("decision effect: buying from the account's cash keeps the total, bucket share and drift move", () => {
  const bucket = {
    bucket_id: "stocks",
    weight: 0.212,
    target: 0.15,
    drift_pp: 6.2,
    value: 39517,
    to_target: -11600,
    out_of_band: true,
  };
  const line = decisionEffect({
    side: "buy",
    quantity: 20,
    price: 148.6,
    currency: "PLN",
    bucket,
    total: 186401.2,
    base: "PLN",
  });
  assert.match(line, /Akcje po transakcji: 22,8/);
  assert.match(line, /dryf rośnie do \+7,8/);
  // the owner's own bucket (non-generic id): only the amount, no bucket, target or drift (F7-generic)
  assert.equal(
    decisionEffect({
      side: "buy",
      quantity: 20,
      price: 148.6,
      currency: "PLN",
      bucket: { ...bucket, bucket_id: "core" },
      total: 186401.2,
      base: "PLN",
    }),
    `≈ 2${"\u00a0"}972,00${"\u00a0"}zł`,
  );
  assert.equal(
    decisionEffect({
      side: "buy",
      quantity: null,
      price: 1,
      currency: "PLN",
      bucket,
      total: 1,
      base: "PLN",
    }),
    null,
  );
});

test("manual transaction: per-type requirements and the cash sign", () => {
  const base = {
    type: "buy",
    hasInstrument: true,
    quantity: 10,
    price: 50,
    amount: null,
    fee: 1,
    split: null,
    date: "2026-10-01",
  };
  assert.deepEqual(validateTxn(base, "2026-10-04"), {});
  assert.ok(validateTxn({ ...base, hasInstrument: false }, "2026-10-04").instrument);
  assert.ok(validateTxn({ ...base, quantity: 0 }, "2026-10-04").quantity);
  assert.ok(validateTxn({ ...base, date: "2026-10-09" }, "2026-10-04").date);
  assert.ok(
    validateTxn({ ...base, type: "deposit", hasInstrument: false, amount: null }, "2026-10-04")
      .amount,
  );
  assert.ok(validateTxn({ ...base, type: "split", split: null }, "2026-10-04").split);
  assert.equal(txnCash(base), -501);
  assert.equal(txnCash({ ...base, type: "sell" }), 499);
  assert.equal(txnCash({ ...base, type: "deposit", amount: 1000, fee: null }), 1000);
  assert.equal(txnCash({ ...base, type: "transfer_in" }), 0);
});

test("deposit + data warnings copy", () => {
  assert.equal(nextDeposit("2026-10-04", 10), "2026-10-10");
  assert.equal(nextDeposit("2026-10-12", 10), "2026-11-10");
  const items = warningItems({
    warnings: [
      {
        kind: "missing_fx_rate",
        message: "No USD/PLN FX rate on or before 2026-10-03",
        account_id: null,
        instrument_id: null,
      },
      { kind: "unknown_cost_basis", message: "x", account_id: 1, instrument_id: 5 },
      { kind: "unknown_cost_basis", message: "y", account_id: 1, instrument_id: 5 },
    ],
    labels: new Map([["5", "KGHM"]]),
    accounts: [
      {
        id: 2,
        name: "XTB IKE",
        broker: "xtb",
        broker_name: "XTB",
        wrapper: "ike",
        snapshot_date: "2026-09-15",
        last_import: { at: "2026-09-15" },
      },
    ],
    stale: [{ instrument_id: 7, label: "EIMI", price_date: "2026-10-01" }],
    missingFx: [],
    today: "2026-10-04",
  });
  assert.deepEqual(
    items.map((w) => w.title),
    [
      "XTB · IKE: brak snapshotu od 15.09",
      "EIMI: nieaktualna cena",
      "Kurs NBP USD niedostępny",
      "Brak kosztu nabycia dla 2 lotów",
    ],
  );
});

test("rule run errors read in Polish", () => {
  assert.equal(
    runError("rule cash_floor inactive: cash_level needs min_weight"),
    "reguła nieaktywna (błąd w strategy.yaml)",
  ); // never the rule id (FE-A A6)
  assert.equal(runError("stooq: HTTP 503"), "źródło cen lub kursów nie odpowiedziało");
  assert.equal(runError(null), "");
});
