import { expect, it } from "vitest";
import { addMicroseconds, parseDateTime } from "../../dates.js";
import { Decimal } from "../../decimal.js";
import {
  AssetClass,
  aliasOf,
  asAccountId,
  asImportBatchId,
  asInstrumentId,
  asProfileId,
  asTxnId,
  Currencies,
  type Holding,
  holdingCostBasis,
  type Instrument,
  type InstrumentRename,
  InstrumentStatus,
  instrumentAlias,
  realizedProceeds,
  TxnType,
} from "../domain/index.js";
import { buildSnapshot } from "../portfolio/index.js";
import { CanonicalImporter } from "./canonical/index.js";
import {
  type BrokerImporter,
  effectiveBrokerId,
  type ImportFile,
  ImportWarningKind,
} from "./contract.js";
import { CsvField, type CsvMapping, csvMapping } from "./csvMapping.js";
import { GenericCsvImporter } from "./genericCsv.js";
import {
  type ImportPlan,
  planCanCommit,
  planDuplicateCount,
  planImport,
  planNewCount,
  transactionsToInsert,
} from "./plan.js";
import { PositionDiffKind, reconcile, reportIsClean } from "./reconciler.js";
import { InMemoryInstrumentLookup, type InstrumentLookup, InstrumentMatch } from "./resolver.js";
import {
  counterIds,
  counterInstrumentIds,
  csvFile,
  d,
  day,
  enc,
  instrumentOf,
  plExportCp1250,
  plExportUtf8Bom,
  plMapping,
  SIMPLE_HEADER,
  simpleMapping,
  specBlocks,
} from "./testing/support.js";

// Translation of tests/investments/importing/test_imp_pipeline.py: end to end without a database,
// importer -> planImport (in-memory resolver) -> buildSnapshot. Covers the pure ImportService.preview
// port (planImport) and the review fixes R5, R8, R9 and R10 on the real portfolio math. The spec
// example comes from docs/import-format.md (`specBlocks("csv")`).

// Python `Decimal ==` compares by value (`Decimal("100") == Decimal("100.00")`).
expect.addEqualityTesters([
  (a: unknown, b: unknown) => (a instanceof Decimal && b instanceof Decimal ? a.eq(b) : undefined),
]);

const ACCOUNT = asAccountId("acc-1");
const NOW = parseDateTime("2026-02-01T12:00:00+00:00");
const { PLN, USD, EUR } = Currencies;

function plan(
  importer: BrokerImporter,
  file: ImportFile,
  lookup: InstrumentLookup = new InMemoryInstrumentLookup(),
  existing: ReadonlySet<string> = new Set(),
): ImportPlan {
  const result = importer.parse(file);
  const txnIds = counterIds("t");
  return planImport(result, {
    accountId: ACCOUNT,
    brokerId: effectiveBrokerId(importer, result),
    lookup,
    existingHashes: (hashes) => hashes.filter((hash) => existing.has(hash)),
    batchId: asImportBatchId("batch-1"),
    now: NOW,
    txnIdFactory: () => asTxnId(txnIds()),
    instrumentIdFactory: counterInstrumentIds("i"),
  });
}

function instrumentIn(importPlan: ImportPlan, instrumentId: string): Instrument {
  const found = importPlan.instruments.get(asInstrumentId(instrumentId));
  if (found === undefined) throw new Error(`instrument ${instrumentId} is not in the plan`);
  return found;
}

function holdingsBySymbol(
  importPlan: ImportPlan,
  asOf: string,
  renames: readonly InstrumentRename[] = [],
) {
  const snapshot = buildSnapshot(asProfileId("p"), transactionsToInsert(importPlan), day(asOf), {
    renames,
  });
  const bySymbol = new Map<string | null, Holding>();
  for (const held of snapshot.holdings) {
    bySymbol.set(instrumentIn(importPlan, held.instrumentId).symbol, held);
  }
  const at = (symbol: string): Holding => {
    const found = bySymbol.get(symbol);
    if (found === undefined) throw new Error(`no holding of ${symbol}`);
    return found;
  };
  return { snapshot, bySymbol, at };
}

const only = <T>(items: readonly T[]): T => {
  expect(items).toHaveLength(1);
  return items[0] as T;
};

it("generic CSV to snapshot numbers", () => {
  const importPlan = plan(new GenericCsvImporter(plMapping()), {
    name: "pl.csv",
    content: plExportUtf8Bom(),
  });
  expect(planCanCommit(importPlan)).toBe(true);
  expect([planNewCount(importPlan), planDuplicateCount(importPlan)]).toEqual([7, 0]);
  expect(importPlan.warnings.map((w) => w.kind)).toEqual([ImportWarningKind.IGNORED_ROW]);
  expect(importPlan.newInstruments).toHaveLength(2);
  const [zgj, etf] = importPlan.newInstruments as [Instrument, Instrument];
  expect([zgj.symbol, zgj.mic, zgj.assetClass, zgj.currency]).toEqual([
    "ZGJ",
    "XWAR",
    AssetClass.EQUITY,
    PLN,
  ]);
  expect(etf.assetClass).toBe(AssetClass.ETF);
  expect(etf.needsClassification).toBe(true);
  expect(aliasOf(zgj, "yahoo")).toBe("ZGJ.WA");

  const { snapshot, at } = holdingsBySymbol(importPlan, "2026-01-31");
  expect(at("ZGJ").quantity).toEqual(d("15")); // two identical buys of 10, then a sale of 5
  expect(holdingCostBasis(at("ZGJ"))).toEqual(d("942.195"));
  expect(at("ETFW").quantity).toEqual(d("3"));
  // OpenLot exposes a unit cost rounded to 10 places, so the derived basis can be off in the 10th.
  expect(holdingCostBasis(at("ETFW"))?.quantize(d("0.01"))).toEqual(d("3708.50"));
  const cash = only(snapshot.cash);
  expect([cash.currency, cash.amount]).toEqual([PLN, d("5385.65")]);
  const trade = only(snapshot.realized);
  expect(realizedProceeds(trade)).toEqual(d("348.25"));
  expect(trade.pnl).toEqual(d("34.185"));
  expect(snapshot.warnings).toEqual([]);

  const rows = importPlan.rows;
  const rowAt = (i: number) => rows[i] as (typeof rows)[number];
  expect(rows.every((row) => row.txn.importBatchId === "batch-1")).toBe(true);
  // same hint, cached
  expect([rowAt(1).match, rowAt(2).match]).toEqual([
    InstrumentMatch.CREATED,
    InstrumentMatch.CREATED,
  ]);
  expect(rowAt(2).txn.instrumentId).toBe(rowAt(1).txn.instrumentId);
  // the dividend row finds the planned instrument
  expect(rowAt(5).match).toBe(InstrumentMatch.ISIN);
  expect(rowAt(0).match).toBeNull();
  expect(new Set(rows.map((row) => row.txn.dedupHash)).size).toBe(7);
  expect(transactionsToInsert(importPlan).map((t) => t.createdAt)).toEqual(
    Array.from({ length: 7 }, (_, i) => addMicroseconds(NOW, i * 1000)),
  );
});

it("re-import and other encoding are all duplicates (R8)", () => {
  const first = plan(new GenericCsvImporter(plMapping()), {
    name: "pl.csv",
    content: plExportUtf8Bom(),
  });
  const stored = new Set(first.rows.map((row) => row.txn.dedupHash));
  const lookup = new InMemoryInstrumentLookup(first.newInstruments);
  const again = plan(
    new GenericCsvImporter(plMapping()),
    { name: "pl.csv", content: plExportUtf8Bom() },
    lookup,
    stored,
  );
  expect([planDuplicateCount(again), planNewCount(again)]).toEqual([7, 0]);
  expect(again.newInstruments).toEqual([]);
  const cp1250 = plan(
    new GenericCsvImporter(plMapping("windows-1250")),
    { name: "pl_cp1250.csv", content: plExportCp1250() },
    lookup,
    stored,
  );
  expect(planDuplicateCount(cp1250)).toBe(7);
});

it("overlapping export with partial fills inserts only the new fill (R8)", () => {
  const importer = new GenericCsvImporter(simpleMapping());
  const first = plan(
    importer,
    csvFile(`${SIMPLE_HEADER}\nO-1,2026-01-05,buy,PKN,,GPW,5,60,PLN,0,-300\n`),
  );
  const stored = new Set(first.rows.map((row) => row.txn.dedupHash));
  const lookup = new InMemoryInstrumentLookup(first.newInstruments);
  const second = plan(
    importer,
    csvFile(
      `${SIMPLE_HEADER}\n` +
        "O-1,2026-01-05,buy,PKN,,GPW,7,61,PLN,0,-427\n" +
        "O-1,2026-01-05,buy,PKN,,GPW,5,60,PLN,0,-300.00\n",
    ),
    lookup,
    stored,
  );
  expect(second.rows.map((row) => row.isDuplicate)).toEqual([false, true]);
  const combined = [...transactionsToInsert(first), ...transactionsToInsert(second)];
  const snapshot = buildSnapshot(asProfileId("p"), combined, day("2026-01-31"));
  expect(snapshot.holdings[0]?.quantity).toEqual(d("12"));
});

it("cross-currency trade books cash in PLN and cost in USD (R5)", () => {
  const mapping: CsvMapping = csvMapping({
    defaultCurrency: PLN,
    columns: new Map([
      [CsvField.TRADE_DATE, "date"],
      [CsvField.TYPE, "type"],
      [CsvField.SYMBOL, "symbol"],
      [CsvField.EXCHANGE, "exchange"],
      [CsvField.QUANTITY, "qty"],
      [CsvField.PRICE, "price"],
      [CsvField.CURRENCY, "ccy"],
      [CsvField.FEE, "fee"],
      [CsvField.CASH_AMOUNT, "cash"],
      [CsvField.CASH_CURRENCY, "cash_ccy"],
      [CsvField.FX_RATE, "fx"],
    ]),
  });
  const content =
    "date,type,symbol,exchange,qty,price,ccy,fee,cash,cash_ccy,fx\n" +
    "2026-01-02,deposit,,,,,PLN,,10000,,\n" +
    "2026-01-05,buy,AAPL,NASDAQ,10,100,USD,1,,PLN,4.0\n";
  const importPlan = plan(new GenericCsvImporter(mapping), csvFile(content));
  const { snapshot, at } = holdingsBySymbol(importPlan, "2026-01-31");
  expect(at("AAPL").currency).toBe(USD);
  expect(holdingCostBasis(at("AAPL"))).toEqual(d("1001"));
  const cash = only(snapshot.cash);
  expect([cash.currency, cash.amount]).toEqual([PLN, d("5996")]);
  const withoutRate = plan(
    new GenericCsvImporter(mapping),
    csvFile(content.replace(",PLN,4.0", ",PLN,")),
  );
  expect(planCanCommit(withoutRate)).toBe(false);
  expect(withoutRate.blockingErrors[0]?.kind).toBe(ImportWarningKind.FX_MISSING);
});

it("single-day newest-first file is ordered by time (R9)", () => {
  const importPlan = plan(
    new GenericCsvImporter(simpleMapping()),
    csvFile(
      `${SIMPLE_HEADER}\n` +
        "r2,2026-09-02 15:00,sell,PKN,,GPW,10,71,PLN,0,710\n" +
        "r1,2026-09-02 10:00,buy,PKN,,GPW,10,60,PLN,0,-600\n",
    ),
  );
  expect(transactionsToInsert(importPlan).map((t) => t.externalRef)).toEqual(["r1", "r2"]);
  const snapshot = buildSnapshot(
    asProfileId("p"),
    transactionsToInsert(importPlan),
    day("2026-09-02"),
  );
  expect(snapshot.holdings).toEqual([]); // bought, then sold
  expect(snapshot.warnings.some((w) => w.kind === "history_gap")).toBe(false);
  expect(only(snapshot.realized).pnl).toEqual(d("110"));
});

it("new instrument currency from priced trades in a newest-first file (R10)", () => {
  const mapping = csvMapping({
    columns: new Map([
      [CsvField.TRADE_DATE, "date"],
      [CsvField.TYPE, "type"],
      [CsvField.SYMBOL, "symbol"],
      [CsvField.QUANTITY, "qty"],
      [CsvField.PRICE, "price"],
      [CsvField.CURRENCY, "ccy"],
      [CsvField.CASH_AMOUNT, "cash"],
      [CsvField.CASH_CURRENCY, "cash_ccy"],
      [CsvField.FX_RATE, "fx"],
    ]),
  });
  const importPlan = plan(
    new GenericCsvImporter(mapping),
    csvFile(
      "date,type,symbol,qty,price,ccy,cash,cash_ccy,fx\n" +
        "2026-03-10,tax,AAPL.US,,,PLN,-1.5,,\n" +
        "2026-03-10,dividend,AAPL.US,,,PLN,10,,\n" +
        "2026-01-05,buy,AAPL.US,10,150,USD,-6000,PLN,4.0\n" +
        "2026-01-02,deposit,,,,PLN,6000,,\n",
    ),
  );
  const aapl = only(importPlan.newInstruments);
  expect(aapl.currency).toBe(USD);
  expect(aliasOf(aapl, "yahoo")).toBe("AAPL");
  expect(aliasOf(aapl, "generic_csv")).toBe("AAPL.US");
  const { at } = holdingsBySymbol(importPlan, "2026-03-31");
  expect(at("AAPL").currency).toBe(USD);
  expect(holdingCostBasis(at("AAPL"))).toEqual(d("1500"));
});

it("existing instruments are matched and learn aliases", () => {
  const orlen = instrumentOf("orlen", {
    isin: null,
    aliases: [instrumentAlias("yahoo", "PKN.WA")],
  });
  const importPlan = plan(
    new GenericCsvImporter(simpleMapping()),
    csvFile(`${SIMPLE_HEADER}\na,2026-01-05,buy,PKN.PL,PLPKN0000018,,5,60,PLN,0,-300\n`),
    new InMemoryInstrumentLookup([orlen]),
  );
  expect(importPlan.rows[0]?.match).toBe(InstrumentMatch.SYMBOL_EXCHANGE);
  expect(importPlan.rows[0]?.txn.instrumentId).toBe("orlen");
  expect(importPlan.newInstruments).toEqual([]);
  expect(importPlan.newAliases).toEqual(
    new Map([
      [
        asInstrumentId("orlen"),
        [instrumentAlias("isin", "PLPKN0000018"), instrumentAlias("generic_csv", "PKN.PL")],
      ],
    ]),
  );
});

it("semantic errors block the plan", () => {
  const importPlan = plan(
    new GenericCsvImporter(simpleMapping()),
    csvFile(
      `${SIMPLE_HEADER}\na,2026-01-05,buy,,,,5,60,PLN,0,-300\nb,2026-01-05,sell,PKN,,GPW,,60,PLN,0,300\n`,
    ),
  );
  expect(planCanCommit(importPlan)).toBe(false);
  expect(new Set(importPlan.blockingErrors.map((e) => e.kind))).toEqual(
    new Set([ImportWarningKind.MISSING_INSTRUMENT, ImportWarningKind.MISSING_QUANTITY]),
  );
});

it("canonical spec example end to end with rename, split and reconciliation", () => {
  const content = specBlocks("csv").find((block) => block.includes("position"));
  if (content === undefined) throw new Error("docs/import-format.md has no CSV example");
  const importPlan = plan(new CanonicalImporter(), {
    name: "converted.csv",
    content: enc(content),
  });
  expect(planCanCommit(importPlan)).toBe(true);
  // the file source is the alias namespace
  expect(importPlan.brokerId).toBe("examplebroker");
  expect(importPlan.accountHint).toBe("Account 12-3456");
  expect(importPlan.warnings.map((w) => w.kind)).toEqual([ImportWarningKind.UNKNOWN_INSTRUMENT]);
  const rename = only(importPlan.renames).rename;
  const old = instrumentIn(importPlan, rename.oldInstrumentId);
  const renamed = instrumentIn(importPlan, rename.newInstrumentId);
  expect([old.symbol, renamed.symbol, renamed.isin, renamed.currency]).toEqual([
    "ABC",
    "ABCN",
    "PLABCN000012",
    "PLN",
  ]);
  expect(aliasOf(old, "examplebroker")).toBe("ABC");
  expect(importPlan.statusChanges).toEqual([]);

  const { snapshot, bySymbol, at } = holdingsBySymbol(importPlan, "2026-02-28", [rename]);
  expect(at("ABCN").quantity).toEqual(d("5"));
  expect(bySymbol.has("ABC")).toBe(false);
  expect(at("XMPL").quantity).toEqual(d("40")); // 10 units split 4-for-1
  expect(holdingCostBasis(at("XMPL"))).toEqual(d("1001"));
  expect(at("WRLD").currency).toBe(EUR);
  const cash = new Map(snapshot.cash.map((balance) => [balance.currency, balance.amount]));
  expect(cash).toEqual(
    new Map([
      [
        PLN,
        d("20000.00")
          .sub(d("628.13"))
          .sub(d("1281.00"))
          .sub(d("4004.000"))
          .add(d("209.00"))
          .add(d("139.45"))
          .sub(d("9.99"))
          .sub(d("400.00")),
      ],
      [USD, d("8.50").add(d("100.00"))],
    ]),
  );

  const txnIds = counterIds("rec");
  const report = reconcile(
    ACCOUNT,
    importPlan.positions.map((p) => p.position),
    snapshot,
    { txnIdFactory: () => asTxnId(txnIds()) },
  );
  expect(new Set(report.diffs.map((diff) => diff.kind))).toEqual(new Set([PositionDiffKind.MATCH]));
  expect(reportIsClean(report)).toBe(true);
  expect(report.warnings).toEqual([]);
});

it("delisting of a known instrument becomes a status change", () => {
  const stored = instrumentOf("zzz", {
    name: "Frozen ADR",
    symbol: "ZZZ",
    mic: null,
    currency: USD,
  });
  const content =
    "format_version,record,date,symbol,frozen\n" +
    "1,delisting,2026-02-20,ZZZ,true\n" +
    "1,delisting,2026-02-21,ZZZ,false\n";
  // Python `replace_aliases`: dataclasses.replace(inst, aliases=(InstrumentAlias("cashu", "ZZZ"),))
  const lookup = new InMemoryInstrumentLookup([
    { ...stored, aliases: [instrumentAlias("cashu", "ZZZ")] },
  ]);
  const importPlan = plan(
    new CanonicalImporter(),
    { name: "x.csv", content: enc(content) },
    lookup,
  );
  expect(importPlan.statusChanges.map((s) => [s.instrumentId, s.status])).toEqual([
    ["zzz", InstrumentStatus.FROZEN],
    ["zzz", InstrumentStatus.DELISTED],
  ]);
});

it("transactions carry every parsed field", () => {
  const content =
    "format_version,record,date,time,settle_date,type,external_ref,symbol,quantity,price," +
    "currency,fee,tax,cash_amount,cash_currency,fx_rate,note\n" +
    "1,txn,2026-01-05,10:00,2026-01-07,buy,X-1,ABC,2,10,USD,1,0.5,-86,PLN,4,hello\n";
  const importPlan = plan(new CanonicalImporter(), { name: "x.csv", content: enc(content) });
  const row = only(importPlan.rows);
  const txn = row.txn;
  expect([txn.id, txn.accountId, txn.type]).toEqual(["t-1", ACCOUNT, TxnType.BUY]);
  expect([txn.settleDate, txn.externalRef, txn.note]).toEqual([day("2026-01-07"), "X-1", "hello"]);
  expect([txn.quantity, txn.price, txn.fee, txn.tax]).toEqual([d("2"), d("10"), d("1"), d("0.5")]);
  expect([txn.grossAmount, txn.cashAmount, txn.cashCurrency, txn.fxRate]).toEqual([
    d("20"),
    d("-86"),
    PLN,
    d("4"),
  ]);
  expect(txn.dedupHash).toBe(row.txn.dedupHash);
  expect(txn.dedupHash).toHaveLength(64);
});
