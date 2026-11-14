import { describe, expect, it } from "vitest";
import { D } from "../../decimal.js";
import { type ImportPlan, planImport, type StoredTxn } from "./dedup.js";
import type { NewTransaction } from "./newTransaction.js";
import type { RawTransaction, TxnSource } from "./types.js";

const stored = (plan: ImportPlan): StoredTxn[] => plan.toInsert.map(asStored);

function asStored(t: NewTransaction): StoredTxn {
  return {
    dedupHash: t.dedupHash,
    bankTransactionId: t.bankTransactionId,
    bookingDate: t.bookingDate,
    amount: t.amount,
  };
}

/** tests/test_ingestion.py `_raw`. */
function raw(
  amount: string,
  opts: {
    d?: string;
    cp?: string;
    source?: TxnSource;
    btid?: string | null;
    iban?: string | null;
  } = {},
): RawTransaction {
  return {
    bookingDate: opts.d ?? "2024-01-05",
    valueDate: null,
    amount: D(amount),
    currency: "PLN",
    counterpartyName: opts.cp ?? "Sklep ABC",
    counterpartyIban: opts.iban ?? null,
    description: "test",
    reference: null,
    bankTransactionId: opts.btid ?? null,
    source: opts.source ?? "csv",
    raw: {},
  };
}

// tests/test_ingestion.py (the dedup parts; the stored state is the previous plan's rows)
describe("test_ingestion.py", () => {
  // test_cross_source_dedup
  it("a CSV row and the same payment from Open Banking are one row", () => {
    const first = planImport([], [raw("-49.99", { source: "csv" })]);
    expect(first.toInsert.length).toBe(1);
    const second = planImport(stored(first), [
      raw("-49.99", { source: "open_banking", btid: "X1" }),
    ]);
    expect(second.toInsert.length).toBe(0);
    expect(second.numDuplicates).toBe(1);
  });

  // test_btid_idempotency
  it("the same bank transaction id re-synced is a duplicate", () => {
    const first = planImport([], [raw("-20.00", { source: "open_banking", btid: "ABC123" })]);
    expect(first.toInsert.length).toBe(1);
    const again = planImport(stored(first), [
      raw("-20.00", { source: "open_banking", btid: "ABC123" }),
    ]);
    expect(again.toInsert.length).toBe(0);
  });

  // test_identical_same_day_preserved
  it("two identical same-day payments are both kept, occurrences 0 and 1", () => {
    const plan = planImport([], [raw("-12.50"), raw("-12.50")]);
    expect(plan.toInsert.map((t) => t.occurrence)).toEqual([0, 1]);
  });
});

/** Deterministic PRNG (mulberry32): tests never use Math.random. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The store's row key (account, hash, occurrence) as a string; a union of two views is a set union. */
const rowKey = (t: StoredTxn & { occurrence: number }) => `${t.dedupHash}#${t.occurrence}`;

describe("R4: occurrences converge across devices (events.md 8.3, content path)", () => {
  it("any two devices importing sub-multisets give a gap-free union that a third device sees as duplicates", () => {
    const rnd = prng(20261031);
    const pick = (n: number) => Math.floor(rnd() * n);
    const kinds = [
      raw("-12.50"),
      raw("-12.50", { cp: "Kawiarnia" }),
      raw("5.00", { d: "2024-01-06" }),
    ];
    for (let trial = 0; trial < 500; trial++) {
      const truth = kinds.map(() => 1 + pick(4)); // how many identical rows of each kind really exist
      const sub = () =>
        kinds.flatMap((k, i) => Array<RawTransaction>(pick((truth[i] as number) + 1)).fill(k));
      const prefix = planImport([], sub());
      const shared = prefix.toInsert.map((t) => ({ ...asStored(t), occurrence: t.occurrence }));
      const device = () => {
        const plan = planImport(shared, sub());
        return [
          ...shared,
          ...plan.toInsert.map((t) => ({ ...asStored(t), occurrence: t.occurrence })),
        ];
      };
      const union = new Map([...device(), ...device()].map((t) => [rowKey(t), t]));
      for (const k of kinds) {
        const h = planImport([], [k]).toInsert[0]?.dedupHash;
        const occ = [...union.values()].filter((t) => t.dedupHash === h).map((t) => t.occurrence);
        occ.sort((a, b) => a - b);
        expect(occ).toEqual(occ.map((_, i) => i)); // 0..n-1, no gap, no duplicate key
      }
      const incoming = kinds.flatMap((k, i) => Array<RawTransaction>(truth[i] as number).fill(k));
      const kindOf = kinds.flatMap((_, i) => Array<number>(truth[i] as number).fill(i));
      const third = planImport([...union.values()], incoming);
      kinds.forEach((k, i) => {
        const h = planImport([], [k]).toInsert[0]?.dedupHash as string;
        const have = [...union.values()].filter((u) => u.dedupHash === h).length;
        const dup = third.statuses.filter((s, j) => s === "duplicate" && kindOf[j] === i).length;
        expect(dup).toBe(Math.min(truth[i] as number, have));
        const occ = third.toInsert.filter((t) => t.dedupHash === h).map((t) => t.occurrence);
        expect(occ).toEqual(occ.map((_, n) => have + n)); // the surplus continues the numbering
      });
    }
  });

  it("the newest-day rule depends on the view, so it must run on the lease holder only", () => {
    const older = {
      ...asStored(
        planImport([], [raw("-1.00", { d: "2024-01-01" })]).toInsert[0] as NewTransaction,
      ),
    };
    const newer = {
      ...asStored(
        planImport([], [raw("-2.00", { d: "2024-01-09" })]).toInsert[0] as NewTransaction,
      ),
    };
    const incoming = [raw("-3.00", { d: "2024-01-05", cp: "INNY OPIS" })];
    const a = planImport([older, newer], incoming, { newestDayRule: true });
    const b = planImport([older], incoming, { newestDayRule: true });
    expect(a.statuses).toEqual(["overlap"]);
    expect(b.statuses).toEqual(["new"]);
  });
});
