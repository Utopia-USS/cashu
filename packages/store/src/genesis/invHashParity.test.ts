/// <reference types="node" />
// The investments content-hash parity gate (S26 LEAD DECISION, gid.md 4.6, 7.2): synthetic broker
// files imported through the real Python import service (parity/python/inv_hash_parity.py, fixture
// testing/invHashParity.json). The `stored` tables are loaded into a synthetic Python database and run
// through genesis; every `invTxn.imported.dedupHash` must equal the dedupHashV2 a TS re-import of the
// same file's `parsed` rows computes with the domain `dedupKey` helpers (occurrences counted in
// chronological rank order, as the Python commit does) and the same account gid. The re-import side's
// v1 half is dedupKey.parity.test.ts in the domain.
import { readFileSync } from "node:fs";
import { D, type Decimal, investments } from "@cashu/domain";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import type { SqlValue } from "../sql/driver.js";
import { TEST_SALT, TEST_VAULT } from "../testing/store.js";
import { genesis } from "./index.js";
import { NOW } from "./testing/genesisData.js";
import { NO_FILES } from "./testing/phase1.js";
import { pythonDb } from "./testing/pythonSchema.js";

interface ParsedRow {
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
  readonly brokerSymbol: string | null;
  readonly isinKey: string | null;
  readonly instrumentId: number | null;
  readonly instrumentKeyV2: string;
  readonly storedTxnId: number | null;
}

interface Import {
  readonly brokerId: string;
  readonly accountId: number;
  readonly parsed: readonly ParsedRow[];
}

type StoredRow = Readonly<Record<string, SqlValue>>;

interface Fixture {
  readonly imports: readonly Import[];
  readonly stored: { readonly tables: Readonly<Record<string, readonly StoredRow[]>> };
}

const fixture = JSON.parse(
  readFileSync(new URL("./testing/invHashParity.json", import.meta.url), "utf8"),
) as Fixture;
const tables = fixture.stored.tables;
const utf8 = new TextEncoder();
const dec = (text: string | null): Decimal | null => (text === null ? null : D(text));

/** Python `contract.equivalent_namespaces`: `cashu` and its legacy name `finanse` are one. */
const namespacesOf = (broker: string) =>
  broker === "cashu" || broker === "finanse" ? ["cashu", "finanse"] : [broker];

/**
 * TRANSITIONAL(R-G4 lead decision): the one known class where genesis (gid.md 7.2: the instrument's
 * alias in the batch's broker namespace first) and a re-import (gid.md 4.6: the row's own hints) name
 * the instrument differently: a row the broker exported with an ISIN only (no symbol, no name), of an
 * instrument that also holds an alias in that broker's namespace. Open decision R-G4 (S26 progress);
 * 7.2 stays as written until the lead decides, and this gate pins the class instead of hiding it.
 */
function isIsinOnlyRowOfBrokerAliasedInstrument(p: ParsedRow, entry: Import): boolean {
  if (p.instrumentId === null || p.brokerSymbol !== null || p.isinKey === null) return false;
  const namespaces = namespacesOf(entry.brokerId);
  return (tables.inv_instrument_aliases ?? []).some(
    (a) => a.instrument_id === p.instrumentId && namespaces.includes(String(a.namespace)),
  );
}

/** Loads the fixture's stored tables (values exactly as SQLite held them) into a Python-schema DB. */
function storedDb() {
  const driver = pythonDb("0028");
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) {
      const columns = Object.keys(row);
      const sql = `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
      driver.prepare(sql).run(...Object.values(row));
    }
  }
  return driver;
}

describe("investments content-hash parity gate", () => {
  const slug = String(tables.profiles?.[0]?.slug);
  const keys = new Map([[slug, { vault: TEST_VAULT, salt: TEST_SALT }]]);
  const result = genesis({ driver: storedDb(), files: NO_FILES }, keys, { strict: true, now: NOW });
  const vault = result.vaults[0];
  const gidOf = (table: string, id: number) =>
    vault?.ids.find((e) => e.table === table && e.localId === String(id))?.gid;
  const genesisHash = new Map(
    (vault?.events ?? []).filter((e) => e.t === "invTxn.imported").map((e) => [e.g, e.d.dedupHash]),
  );

  /** The v2 hash a TS re-import computes for each parsed row of one import, in file order. */
  function reimportHashes(entry: Import): Map<ParsedRow, string> {
    const accountGid = gidOf("accounts", entry.accountId) ?? "";
    const rows = [...entry.parsed].sort((a, b) => a.rank - b.rank);
    const inputs = rows.map((p) =>
      investments.dedupInputFromParsed(
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
        investments.instrumentKeyOfParsed(p, entry.brokerId),
      ),
    );
    const paths = investments.hashPathsOfFile(inputs, entry.brokerId);
    const parts = paths.map((path) =>
      investments.hashPartsV2(path, accountGid).join(investments.US),
    );
    return new Map(rows.map((p, i) => [p, bytesToHex(sha256(utf8.encode(parts[i] ?? "")))]));
  }

  it("re-import instrument keys match the Python reference (gid.md 4.6)", () => {
    for (const entry of fixture.imports) {
      for (const p of entry.parsed) {
        expect(investments.instrumentKeyOfParsed(p, entry.brokerId)).toBe(p.instrumentKeyV2);
      }
    }
  });

  it("genesis dedupHashV2 == re-import dedupHashV2 for every stored import row outside R-G4", () => {
    const equal: number[] = [];
    const differing: number[] = [];
    const predicted: number[] = [];
    for (const entry of fixture.imports) {
      for (const [p, hash] of reimportHashes(entry)) {
        if (p.storedTxnId === null) continue;
        const stored = genesisHash.get(gidOf("inv_transactions", p.storedTxnId) ?? "");
        expect(stored, `stored txn ${p.storedTxnId}`).toMatch(/^[0-9a-f]{64}$/);
        (stored === hash ? equal : differing).push(p.storedTxnId);
        if (isIsinOnlyRowOfBrokerAliasedInstrument(p, entry)) predicted.push(p.storedTxnId);
      }
    }
    // TRANSITIONAL(R-G4 lead decision): the differing rows are exactly the predicted class (1 of 24).
    expect(differing).toEqual(predicted);
    expect([equal.length, differing.length]).toEqual([23, 1]);
    expect(result.report.counters.vaults["0"]?.inv_transactions).toMatchObject({
      occ_v1_match: 24,
      recon_match: 1,
    });
  });
});
