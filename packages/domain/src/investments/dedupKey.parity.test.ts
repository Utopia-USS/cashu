/// <reference types="node" />
// The re-import half of the investments content-hash parity gate (S26 LEAD DECISION): synthetic files
// imported through the real Python import service (parity/python/inv_hash_parity.py, fixture
// packages/store/src/genesis/testing/invHashParity.json). The v1 hash a TS re-import computes from the
// parsed rows with the stored local ids must equal every stored dedup_hash; this proves the parsed
// side of the fixture is faithful. The store half (genesis v2 from `stored` == v2 from `parsed`) is
// genesis's gate test.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { D, type Decimal } from "../decimal.js";
import {
  dedupInputFromParsed,
  dedupInputFromStored,
  hashPartsV1,
  hashPathOf,
  hashPathsOfFile,
  instrumentKeyOfParsed,
  US,
} from "./dedupKey.js";

interface ParsedRow {
  readonly rowIndex: number;
  readonly rank: number;
  readonly tradeDate: string;
  readonly type: string;
  readonly externalRef: string | null;
  readonly quantity: string | null;
  readonly price: string | null;
  readonly currency: string;
  readonly grossAmount: string;
  readonly cashAmount: string;
  readonly symbol: string | null;
  readonly isin: string | null;
  readonly name: string | null;
  readonly instrumentId: number | null;
  readonly instrumentKeyV2: string;
  readonly v1Hash: string;
  readonly storedTxnId: number | null;
}

interface Import {
  readonly name: string;
  readonly brokerId: string;
  readonly accountId: number;
  readonly parsed: readonly ParsedRow[];
}

type StoredRow = Readonly<Record<string, string | number | null>>;

interface StoredV1 {
  readonly txnId: number;
  readonly kind: "ref" | "content" | "reconciliation";
  readonly accountId: string;
  readonly brokerId: string | null;
  readonly instrumentKey: string;
  readonly occurrence: number | null;
  readonly message: string;
}

interface Fixture {
  readonly imports: readonly Import[];
  readonly stored: { readonly tables: Readonly<Record<string, readonly StoredRow[]>> };
  readonly storedV1: readonly StoredV1[];
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../store/src/genesis/testing/invHashParity.json", import.meta.url),
    ),
    "utf8",
  ),
) as Fixture;

const sha256 = (message: string): string =>
  createHash("sha256").update(message, "utf8").digest("hex");
const dec = (text: string | null): Decimal | null => (text === null ? null : D(text));
const txns = new Map(
  (fixture.stored.tables.inv_transactions ?? []).map((row) => [row.id as number, row]),
);

/** v1 hashes of one import's parsed rows (in file order), occurrences counted in `order`. */
function v1Hashes(entry: Import, order: "rank" | "file"): string[] {
  const rows = [...entry.parsed].sort((a, b) =>
    order === "rank" ? a.rank - b.rank : a.rowIndex - b.rowIndex,
  );
  const inputs = rows.map((p) =>
    dedupInputFromParsed(
      {
        tradeDate: p.tradeDate,
        type: p.type,
        currency: p.currency,
        grossAmount: D(p.grossAmount),
        cashAmount: D(p.cashAmount),
        externalRef: p.externalRef,
        quantity: dec(p.quantity),
        price: dec(p.price),
      },
      p.instrumentId === null ? "" : String(p.instrumentId),
    ),
  );
  const hashes = new Map<number, string>();
  hashPathsOfFile(inputs, entry.brokerId).forEach((path, i) => {
    hashes.set(
      (rows[i] as ParsedRow).rowIndex,
      sha256(hashPartsV1(path, String(entry.accountId)).join(US)),
    );
  });
  return entry.parsed.map((p) => hashes.get(p.rowIndex) as string);
}

describe("investments content-hash parity: re-import side", () => {
  it("covers ref, content, cash, legacy-broker and generic CSV imports", () => {
    expect(fixture.imports.map((i) => i.brokerId)).toEqual([
      "examplebroker",
      "examplebroker",
      "cashu",
      "generic_csv",
      "cashu",
      "renamebroker",
    ]);
    expect(fixture.imports.flatMap((i) => i.parsed).length).toBe(38);
  });

  it("v1 from the parsed rows reproduces every stored dedup_hash", () => {
    let stored = 0;
    for (const entry of fixture.imports) {
      const accountHashes = new Set(
        [...txns.values()].filter((t) => t.account_id === entry.accountId).map((t) => t.dedup_hash),
      );
      v1Hashes(entry, "rank").forEach((hash, i) => {
        const p = entry.parsed[i] as ParsedRow;
        expect(hash, `${entry.name} row ${p.rowIndex}`).toBe(p.v1Hash);
        if (p.storedTxnId === null) {
          expect(accountHashes.has(hash), `${entry.name} row ${p.rowIndex} duplicate`).toBe(true);
        } else {
          expect(hash).toBe(txns.get(p.storedTxnId)?.dedup_hash);
          stored++;
        }
      });
    }
    expect(stored).toBe(29);
  });

  it("occurrences follow the chronological rank, not the file order (newest-first file)", () => {
    const newestFirst = fixture.imports[1] as Import;
    const byRank = v1Hashes(newestFirst, "rank");
    const byFile = v1Hashes(newestFirst, "file");
    expect(new Set(byFile)).toEqual(new Set(byRank));
    // Three same-key pairs swap occurrences (the two XYZ buys with different notes, the two fee rows,
    // the two O-7 fills): same hash set, different row -> hash assignment.
    expect(byFile.filter((hash, i) => hash !== byRank[i]).length).toBe(6);
  });

  it("instrumentKeyOfParsed matches the Python reference of every parsed row", () => {
    for (const entry of fixture.imports) {
      for (const p of entry.parsed) {
        expect(instrumentKeyOfParsed(p, entry.brokerId), `${entry.name} row ${p.rowIndex}`).toBe(
          p.instrumentKeyV2,
        );
      }
    }
  });

  it("v1 rebuilt from the stored columns with the recovered occurrence (genesis inputs)", () => {
    for (const entry of fixture.storedV1) {
      const row = txns.get(entry.txnId) as StoredRow;
      const path =
        entry.kind === "reconciliation"
          ? {
              kind: "reconciliation" as const,
              instrumentKey: entry.instrumentKey,
              asOf: row.trade_date as string,
              type: row.type as string,
              quantity: D(row.quantity as string),
            }
          : hashPathOf(
              dedupInputFromStored(
                {
                  tradeDate: row.trade_date as string,
                  type: row.type as string,
                  currency: row.currency as string,
                  grossAmount: D(row.gross_amount as string),
                  cashAmount: D(row.cash_amount as string),
                  externalRef: row.external_ref as string | null,
                  quantity: dec(row.quantity as string | null),
                  price: dec(row.price as string | null),
                },
                entry.instrumentKey,
              ),
              entry.brokerId as string,
              entry.occurrence as number,
            );
      const message = hashPartsV1(path, entry.accountId).join(US);
      expect(message, `txn ${entry.txnId}`).toBe(entry.message);
      expect(sha256(message)).toBe(row.dedup_hash);
    }
  });
});
