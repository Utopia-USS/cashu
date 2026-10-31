/// <reference types="node" />
// The investments content-hash parity gate (S26 LEAD DECISION, gid.md 4.6, 7.2): synthetic broker
// files imported through the real Python import service (parity/python/inv_hash_parity.py, fixture
// testing/invHashParity.json). The `stored` tables are loaded into a synthetic Python database and run
// through genesis; every `invTxn.imported.dedupHash` must equal the dedupHashV2 a TS re-import of the
// same file's `parsed` rows computes with the domain `dedupKey` helpers (occurrences counted in
// chronological rank order, as the Python commit does) and the same account gid, for every row outside
// the three S17d classes (`differingClass`); each class is pinned by an expected-fail case asserting
// full equality. The re-import side's v1 half is dedupKey.parity.test.ts in the domain.
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
  readonly name: string;
  readonly brokerId: string;
  /** The broker the stored batch holds: `brokerId`, or the legacy name of a pre-rename batch. */
  readonly storedBroker: string;
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

/** Python `contract.equivalent_namespaces`: `cashu` and its legacy name are one. */
const namespacesOf = (broker: string) =>
  broker === "cashu" || broker === "finanse" ? ["cashu", "finanse"] : [broker]; // legacy name

/** The stored aliases of an instrument in the namespaces of one broker, ascending id. */
const brokerAliases = (instrumentId: number, broker: string) =>
  (tables.inv_instrument_aliases ?? [])
    .filter(
      (a) => a.instrument_id === instrumentId && namespacesOf(broker).includes(String(a.namespace)),
    )
    .sort((x, y) => Number(x.id) - Number(y.id));

/**
 * TRANSITIONAL(S17d): the three known classes where genesis (gid.md 7.2: the instrument's alias in
 * the batch's stored broker namespace, smallest alias id first) and a re-import (gid.md 4.6: the
 * row's own hints under the import's broker id) name the instrument differently, so a TS re-import of
 * the same file would compute another dedupHashV2 and import the row twice. Lead decision: the fix
 * lands in S17d's domain importing port (one shared rule over the resolved instrument), not in
 * genesis. Each class is pinned by an `it.fails` case below that asserts full equality; S17d makes
 * them pass, then turns them into plain cases and drops this classifier.
 */
type DifferingClass = "isinOnlyRowOfBrokerAliasedInstrument" | "legacyBatchBroker" | "secondAlias";

function differingClass(p: ParsedRow, entry: Import): DifferingClass | undefined {
  if (p.instrumentId === null) return undefined;
  if (entry.storedBroker !== entry.brokerId) return "legacyBatchBroker";
  const own = brokerAliases(p.instrumentId, entry.storedBroker);
  if (p.brokerSymbol === null) {
    return p.isinKey !== null && own.length > 0
      ? "isinOnlyRowOfBrokerAliasedInstrument"
      : undefined;
  }
  return own.length > 1 && String(own[0]?.value) !== p.brokerSymbol ? "secondAlias" : undefined;
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

  interface Compared {
    readonly txnId: number;
    readonly file: string;
    readonly genesis: unknown;
    readonly reimport: string;
    readonly differing: DifferingClass | undefined;
  }

  const compared: Compared[] = fixture.imports.flatMap((entry) =>
    [...reimportHashes(entry)].flatMap(([p, hash]) =>
      p.storedTxnId === null
        ? []
        : [
            {
              txnId: p.storedTxnId,
              file: entry.name,
              genesis: genesisHash.get(gidOf("inv_transactions", p.storedTxnId) ?? ""),
              reimport: hash,
              differing: differingClass(p, entry),
            },
          ],
    ),
  );
  const ofClass = (c: DifferingClass) => compared.filter((r) => r.differing === c);
  const hashes = (rows: readonly Compared[], side: "genesis" | "reimport") =>
    rows.map((r) => ({ txn: r.txnId, file: r.file, hash: r[side] }));

  it("genesis dedupHashV2 == re-import dedupHashV2 for every stored import row outside the S17d classes", () => {
    for (const r of compared) expect(r.genesis, `stored txn ${r.txnId}`).toMatch(/^[0-9a-f]{64}$/);
    const outside = compared.filter((r) => r.differing === undefined);
    expect(hashes(outside, "genesis")).toEqual(hashes(outside, "reimport"));
    // Every S17d class is present in the fixture, so its `it.fails` case below tests something.
    for (const c of [
      "isinOnlyRowOfBrokerAliasedInstrument",
      "legacyBatchBroker",
      "secondAlias",
    ] as const) {
      expect(ofClass(c).length, c).toBeGreaterThan(0);
    }
    expect(result.report.counters.vaults["0"]?.inv_transactions).toMatchObject({
      occ_v1_match: 29,
      recon_match: 1,
    });
  });

  // S17d: isinOnlyRowOfBrokerAliasedInstrument. Reproduction (fixture, inv_hash_parity.py): file
  // synthetic_1.csv (source examplebroker) has the dividend row `DV-1` naming ABC by ISIN only
  // (`isin=PLABC0000016`, no symbol, no name); ABC holds the alias `examplebroker:ABC`. Genesis
  // (7.2) keys it `examplebroker:ABC`, a re-import (4.6) `isin:PLABC0000016`.
  it.fails("S17d: genesis == re-import for an ISIN-only row of a broker-aliased instrument", () => {
    const rows = ofClass("isinOnlyRowOfBrokerAliasedInstrument");
    expect(hashes(rows, "genesis")).toEqual(hashes(rows, "reimport"));
  });

  // S17d: legacyBatchBroker. Reproduction: file synthetic_4.csv (no source: namespace `cashu`) buys
  // FNX (`symbol=FNX`, `exchange=XWAR`, refs F-1 and none); the generator then rewrites its batch
  // `broker` and FNX's `cashu` alias to the legacy name, as a pre-rename database holds them. Genesis
  // keys the rows under the stored broker, a re-import under `cashu:FNX`.
  it.fails("S17d: genesis == re-import for a batch stored under the legacy broker name", () => {
    const rows = ofClass("legacyBatchBroker");
    expect(hashes(rows, "genesis")).toEqual(hashes(rows, "reimport"));
  });

  // S17d: secondAlias. Reproduction: file synthetic_5.csv (source renamebroker) buys one ISIN
  // (`PLOLDX000018`) first as `OLDX` (ref R-1), then as `NEWX` (ref R-2); the resolver matches NEWX
  // by ISIN and learns a second alias, so the instrument holds `renamebroker:OLDX` (smaller id) and
  // `renamebroker:NEWX`. Genesis keys the R-2 row `renamebroker:OLDX`, a re-import
  // `renamebroker:NEWX`.
  it.fails("S17d: genesis == re-import for a row naming the second alias of one namespace", () => {
    const rows = ofClass("secondAlias");
    expect(hashes(rows, "genesis")).toEqual(hashes(rows, "reimport"));
  });
});
