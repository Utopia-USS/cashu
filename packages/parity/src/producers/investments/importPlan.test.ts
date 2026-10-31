// investments.import_plan over a synthetic dataset (invented values): an archived canonical file
// re-planned against the stored instruments and hashes, a generic CSV batch rebuilt from the
// account's mapping, and the reasons a batch cannot be re-planned.

/// <reference types="node" />
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withPythonDb } from "../../sources/index.ts";
import { INVESTMENTS, type SyntheticDataset, syntheticDataset } from "../../sources/testing.ts";
import { dumps } from "../output.ts";
import { produceImportPlan } from "./importPlan.ts";

let ds: SyntheticDataset;
afterEach(() => ds.dispose());

type Tree = Record<string, unknown>;

const CANONICAL =
  "format_version,record,date,type,symbol,isin,quantity,price,currency,cash_amount\n" +
  "1,txn,2026-01-05,buy,TETF,PL0000000001,10,100,PLN,-1000\n" +
  "1,txn,2026-01-06,deposit,,,,,PLN,50\n";

const GENERIC = "Data;Typ;Kwota\n2026-01-07;deposit;12,50\n";
const MAPPING = `version: 1
broker_id: dif
delimiter: ";"
decimal_separator: ","
default_currency: PLN
columns:
  trade_date: Data
  type: Typ
  cash_amount: Kwota
`;

function archive(dir: string, slug: string, content: string, ext: string): [string, string] {
  const sha = createHash("sha256").update(content, "utf8").digest("hex");
  const rel = join("imports", slug, `${sha}.${ext}`);
  mkdirSync(join(dir, "imports", slug), { recursive: true });
  writeFileSync(join(dir, rel), content, "utf8");
  return [sha, rel];
}

function run(): { tree: Tree; p1: string; p2: string; batch: (id: number) => string; etf: string } {
  return withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => ({
    tree: JSON.parse(dumps(produceImportPlan(db))) as Tree,
    p1: db.keys.key("profiles", 1),
    p2: db.keys.key("profiles", 2),
    batch: (id: number) => db.keys.key("inv_import_batches", id),
    etf: db.keys.key("inv_instruments", 1),
  }));
}

describe("investments.import_plan producer", () => {
  it("re-plans an archived canonical file against the stored instruments and hashes", () => {
    ds = syntheticDataset(INVESTMENTS);
    const [sha, rel] = archive(ds.dir, "test-b", CANONICAL, "csv");
    const [gsha, grel] = archive(ds.dir, "test-a", GENERIC, "csv");
    ds.exec(`
      INSERT INTO inv_import_batches VALUES
        -- legacy name: batch 1 holds the pre-rename importer id
        (1, 1, 1, 'finanse', 'cashu', 'export.csv', '${sha}', '${rel}', '2026-02-01 10:00:00'),
        (2, 1, 1, 'cashu', 'cashu', 'gone.csv', '${"0".repeat(64)}', 'imports/test-b/gone.csv',
         '2026-02-02 10:00:00'),
        (3, 2, 3, 'dif', 'dif', 'dif.csv', '${gsha}', '${grel}', '2026-02-03 10:00:00'),
        (4, 2, 3, 'other', 'other', 'dif.csv', '${gsha}', '${grel}', '2026-02-04 10:00:00');
      INSERT INTO inv_account_settings (account_id, mapping_yaml) VALUES (3, '${MAPPING}');
    `);
    const first = run();
    const batch = (first.tree[first.p1] as Tree)[first.batch(1)] as Tree;
    expect(batch.sha256_matches).toBe(true);
    expect(batch.broker_id).toBe("cashu");
    expect(batch.broker_matches).toBe(true);
    const rows = batch.rows as Tree[];
    expect(rows.map((r) => r.match)).toEqual(["isin", null]);
    expect(((rows[0] as Tree).txn as Tree).instrument_id).toBe(first.etf);
    expect(rows.map((r) => r.is_duplicate)).toEqual([false, false]);
    expect(batch.new_instruments).toEqual([]);
    expect(batch.new_aliases).toEqual([
      {
        instrument_id: first.etf,
        aliases: [{ namespace: "cashu", value: "TETF", guessed: false }],
      },
    ]);
    expect((first.tree[first.p1] as Tree)[first.batch(2)]).toEqual({ archive: "missing" });
    const generic = (first.tree[first.p2] as Tree)[first.batch(3)] as Tree;
    expect((generic.rows as Tree[]).map((r) => (r.txn as Tree).cash_amount)).toEqual(["12.50"]);
    expect((first.tree[first.p2] as Tree)[first.batch(4)]).toEqual({
      archive: "ok",
      importer: "mapping_of_another_importer",
    });

    // store the file's rows under the batch: a re-import is all duplicates with the same hashes
    const hashes = rows.map((r) => (r.txn as Tree).dedup_hash as string);
    ds.exec(`
      INSERT INTO inv_transactions (id, account_id, type, trade_date, currency, gross_amount,
        cash_amount, cash_currency, source, import_batch_id, dedup_hash, created_at) VALUES
        (101, 1, 'buy', '2026-01-05', 'PLN', '1000', '-1000', 'PLN', 'import', 1, '${hashes[0]}', NULL),
        (102, 1, 'deposit', '2026-01-06', 'PLN', '50', '50', 'PLN', 'import', 1, '${hashes[1]}', NULL),
        (103, 1, 'adjustment', '2026-01-06', 'PLN', '0', '0', 'PLN', 'reconciliation', 1, 'r1', NULL);
    `);
    const second = run();
    const again = (second.tree[second.p1] as Tree)[second.batch(1)] as Tree;
    expect((again.rows as Tree[]).map((r) => r.is_duplicate)).toEqual([true, true]);
    expect(again.dedup).toEqual({
      rows: 2,
      distinct_hashes: 2,
      stored_for_batch: 2,
      corrections_for_batch: 1,
      all_rows_stored: true,
      batch_hashes_in_plan: true,
    });
  });
});
