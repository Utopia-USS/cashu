import { expect, it } from "vitest";
import { addMicroseconds, parseDateTime } from "../../dates.js";
import {
  asAccountId,
  asInstrumentId,
  asTxnId,
  Currencies,
  InvariantError,
  TxnType,
  transaction,
} from "../domain/index.js";
import type { ParsedTxn, TimeOfDay } from "./contract.js";
import {
  type DedupInput,
  type DedupScope,
  decimalKey,
  dedupHash,
  dedupHashes,
  dedupInput,
  dedupInputFromTransaction,
  HASH_VERSION_V2,
  parsedDedupInputs,
  reconciliationHash,
} from "./dedup.js";
import { chronologicalRanks, createdAtStamps, isNewestFirst } from "./ordering.js";
import { d, day, parsedTxnOf } from "./testing/support.js";

// R8 dedup hashes and R9 chronological ordering of imported rows (R5 amounts: cash.test.ts).
const ACCOUNT = "acc-1";
const scope = (brokerId: string, accountId: string = ACCOUNT): DedupScope => ({
  accountId,
  brokerId,
});

function buy(
  options: {
    ref?: string | null;
    quantity?: string;
    price?: string;
    gross?: string;
    cash?: string;
    tradeDate?: string;
    instrument?: string | null;
    currency?: string;
  } = {},
): DedupInput {
  return dedupInput({
    tradeDate: day(options.tradeDate ?? "2026-01-07"),
    type: TxnType.BUY,
    grossAmount: d(options.gross ?? "625"),
    cashAmount: d(options.cash ?? "-628.13"),
    externalRef: options.ref ?? null,
    instrumentKey: options.instrument === undefined ? "inst-1" : options.instrument,
    quantity: d(options.quantity ?? "10"),
    price: d(options.price ?? "62.5"),
    currency: options.currency ?? "PLN",
  });
}

// --- R8 dedup ------------------------------------------------------------------------------------

it("external ref hash uses ref and fill identity, not amounts or dates", () => {
  const xtb = scope("xtb");
  const base = dedupHash(buy({ ref: "R-1" }), xtb);
  expect(base).toHaveLength(64);
  expect(base).toBe(base.toLowerCase());
  const same = buy({ ref: " R-1 ", cash: "-628.10", gross: "625.01", tradeDate: "2026-01-08" });
  expect(dedupHash(same, xtb)).toBe(base); // re-export rounding
  expect(dedupHash(buy({ ref: "R-1" }), scope("xtb", "acc-2"))).not.toBe(base);
  expect(dedupHash(buy({ ref: "R-1" }), scope("mbank"))).not.toBe(base);
  expect(dedupHash(buy({ ref: "R-2" }), xtb)).not.toBe(base);
  expect(dedupHash(buy({ ref: "R-1", quantity: "5" }), xtb)).not.toBe(base);
  expect(dedupHash(buy({ ref: "R-1", price: "63" }), xtb)).not.toBe(base);
  expect(dedupHash(buy({ ref: "R-1", instrument: "other" }), xtb)).not.toBe(base);
  expect(dedupHash(buy({ ref: "R-1", currency: "USD" }), xtb)).not.toBe(base);
  const blankRef = dedupHash(buy({ ref: "  " }), xtb);
  expect(blankRef).toBe(dedupHash(buy(), xtb)); // blank ref = none
});

it("content hash: every field matters, decimals by value, broker does not", () => {
  const base = dedupHash(buy(), scope("generic_csv"));
  expect(dedupHash(buy(), scope("xtb"))).toBe(base);
  expect(dedupHash(buy({ price: "62.500", cash: "-628.130" }), scope("x"))).toBe(base);
  for (const changed of [
    buy({ tradeDate: "2026-01-08" }),
    buy({ quantity: "11" }),
    buy({ price: "62.6" }),
    buy({ gross: "626" }),
    buy({ cash: "-628.14" }),
    buy({ instrument: null }),
  ]) {
    expect(dedupHash(changed, scope("x"))).not.toBe(base);
  }
  const sell = dedupInput({
    tradeDate: day("2026-01-07"),
    type: TxnType.SELL,
    grossAmount: d("625"),
    cashAmount: d("-628.13"),
    instrumentKey: "inst-1",
    quantity: d("10"),
    price: d("62.5"),
  });
  expect(dedupHash(sell, scope("x"))).not.toBe(base);
});

it("identical rows of one file get distinct hashes, stable on re-import", () => {
  const generic = scope("generic_csv");
  const rows = [buy(), buy({ quantity: "5" }), buy()];
  const first = dedupHashes(rows, generic);
  expect(new Set(first).size).toBe(3); // both identical buys import
  expect(first[0]).toBe(dedupHash(buy(), generic));
  expect(first[2]).toBe(dedupHash(buy(), generic, 1));
  expect(dedupHashes(rows, generic)).toEqual(first);
});

it("partial fills sharing a ref dedup independently of order and overlap (R8)", () => {
  const xtb = scope("xtb");
  const fillA = buy({ ref: "ORDER-1", quantity: "5" });
  const fillB = buy({ ref: "ORDER-1", quantity: "7" });
  const export1 = dedupHashes([fillA], xtb);
  const export2 = dedupHashes([fillB, fillA], xtb); // newest first
  expect(export2[1]).toBe(export1[0]); // fill A is recognized as already imported
  expect(export2[0]).not.toBe(export1[0]); // fill B is new
  const twice = dedupHashes([fillA, fillB, fillA], xtb);
  expect(new Set(twice).size).toBe(3);
  expect(new Set(dedupHashes([fillA, fillA, fillB], xtb))).toEqual(new Set(twice));
});

it("FX legs sharing a ref stay apart by currency", () => {
  const leg = (currency: string, cash: string) =>
    dedupInput({
      tradeDate: day("2026-02-02"),
      type: TxnType.FX_CONVERSION,
      grossAmount: d(cash).abs(),
      cashAmount: d(cash),
      externalRef: "FX-1",
      currency,
    });
  const plnOnly = dedupHashes([leg("PLN", "-400")], scope("x"));
  const both = dedupHashes([leg("USD", "100"), leg("PLN", "-400")], scope("x"));
  expect(both[1]).toBe(plnOnly[0]);
  expect(both[0]).not.toBe(both[1]);
});

it("inputs from transactions and parsed rows", () => {
  const txn = transaction({
    id: asTxnId("t1"),
    accountId: asAccountId(ACCOUNT),
    type: TxnType.BUY,
    tradeDate: day("2026-01-07"),
    currency: Currencies.PLN,
    grossAmount: d("625"),
    cashAmount: d("-628.13"),
    cashCurrency: Currencies.PLN,
    instrumentId: asInstrumentId("inst-1"),
    quantity: d("10"),
    price: d("62.5"),
    externalRef: "R",
  });
  const fromTxn = dedupInputFromTransaction(txn);
  expect([fromTxn.instrumentKey, fromTxn.externalRef]).toEqual(["inst-1", "R"]);
  const parsed = parsedTxnOf(TxnType.BUY, {
    quantity: "10",
    price: "62.5",
    gross: "625",
    cash: "-628.13",
  });
  const fromParsed = parsedDedupInputs([parsed], ["inst-1"]);
  expect(fromParsed).toHaveLength(1);
  expect(fromParsed[0]?.instrumentKey).toBe("inst-1");
  expect(() => parsedDedupInputs([parsed], [])).toThrow(InvariantError);
});

it("decimal key and reconciliation hash", () => {
  expect(decimalKey(d("10.50"))).toBe("10.5");
  expect(decimalKey(d("1E+1"))).toBe("10");
  expect(decimalKey(d("-0.00"))).toBe("0");
  // no context rounding
  expect(decimalKey(d("123456789012345678901234567890.123456789"))).toBe(
    "123456789012345678901234567890.123456789",
  );
  expect(decimalKey(null)).toBe("");
  const first = reconciliationHash(ACCOUNT, "i", day("2026-01-31"), TxnType.ADJUSTMENT, d("2.0"));
  expect(first).toBe(
    reconciliationHash(ACCOUNT, "i", day("2026-01-31"), TxnType.ADJUSTMENT, d("2")),
  );
  expect(first).not.toBe(
    reconciliationHash(ACCOUNT, "i", day("2026-01-31"), TxnType.TRANSFER_OUT, d("2")),
  );
});

// The hashes live in the event log (the store's unique column): a change to any byte of the input
// string re-imports every stored row. The v1 values were captured from the retired Python app.
it("persisted hashes stay byte-stable", () => {
  const sell = dedupInput({
    tradeDate: day("2026-04-01"),
    type: TxnType.SELL,
    grossAmount: d("-30"),
    cashAmount: d("29.5"),
    instrumentKey: "5",
    quantity: d("-3"),
    price: d("10"),
  });
  expect(dedupHash(sell, scope("xtb", "9"))).toBe(
    "bf60b9eb8e4324cee84cb85e880ccc2df7f82fd1e7ee1adb787afe4647e5040a",
  );
  const refBuy = dedupInput({
    tradeDate: day("2026-04-01"),
    type: TxnType.BUY,
    grossAmount: d("30"),
    cashAmount: d("-30"),
    externalRef: " T-1 ",
    instrumentKey: "5",
    quantity: d("3"),
  });
  // the cashu broker hashes under its legacy name, occurrence 7
  expect(dedupHash(refBuy, scope("cashu", "9"), 7)).toBe(
    "4853d76a350cfa18ac13508c643e6bb360d9f4ae7b2db24c7ce35ea94f96b4f5",
  );
  expect(
    dedupHash(refBuy, { accountId: "acct-9", brokerId: "xtb", version: HASH_VERSION_V2 }),
  ).toBe("4daa7fe337c41071bb9241a862f3521de616a956320ded27f0790b361c4837b0");
  expect(reconciliationHash("4", "11", day("2026-02-27"), TxnType.TRANSFER_OUT, d("2.500"))).toBe(
    "1e618b12ff8724efb74d6a7668946fb4f51fc7780d19fcfea57d7032ca3f1551",
  );
});

// --- R9 ordering ---------------------------------------------------------------------------------

const time = (hour: number): TimeOfDay => ({ hour, minute: 0, second: 0 });

const row = (ref: string, tradeDate: string, at: TimeOfDay | null = null): ParsedTxn =>
  parsedTxnOf(TxnType.BUY, { tradeDate, tradeTime: at, externalRef: ref });

/** External refs in chronological rank order. */
function ordered(rows: readonly ParsedTxn[]): (string | null)[] {
  const ranks = chronologicalRanks(rows);
  return rows
    .map((r, i) => ({ rank: ranks[i] ?? 0, ref: r.externalRef }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.ref);
}

it("newest-first file keeps same-day order via reversal", () => {
  const rows = [row("r3", "2026-01-08"), row("r2", "2026-01-07"), row("r1", "2026-01-07")];
  expect(isNewestFirst(rows)).toBe(true);
  expect(ordered(rows)).toEqual(["r1", "r2", "r3"]);
});

it("single-day newest-first file is ordered by time of day (R9)", () => {
  const rows = [row("r2", "2026-09-02", time(15)), row("r1", "2026-09-02", time(10))];
  expect(isNewestFirst(rows)).toBe(true);
  expect(ordered(rows)).toEqual(["r1", "r2"]);
});

it("times order rows of a date; untimed dates keep direction-aware file order", () => {
  const rows = [
    row("b2", "2026-09-03", time(9)),
    row("a1", "2026-09-01"),
    row("a2", "2026-09-01"),
    row("b1", "2026-09-03", time(8)),
    row("c1", "2026-09-04"),
  ];
  expect(isNewestFirst(rows)).toBe(false);
  expect(ordered(rows)).toEqual(["a1", "a2", "b1", "b2", "c1"]);
});

it("a date mixing timed and untimed rows uses file order", () => {
  const rows = [
    row("x1", "2026-09-01", time(15)),
    row("x2", "2026-09-01"),
    row("x3", "2026-09-02"),
  ];
  expect(ordered(rows)).toEqual(["x1", "x2", "x3"]);
});

it("createdAt stamps are strictly increasing in chronological order", () => {
  const rows = [row("r2", "2026-09-02", time(15)), row("r1", "2026-09-02", time(10))];
  const base = parseDateTime("2026-09-03T00:00:00+00:00");
  const stamps = createdAtStamps(rows, base);
  expect(stamps).toEqual([addMicroseconds(base, 1000), base]);
  expect(chronologicalRanks([])).toEqual([]);
  expect(isNewestFirst([row("a", "2026-01-01")])).toBe(false);
});
