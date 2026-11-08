/// <reference types="node" />
/**
 * Re-import identity (S17d, S26 review F2): synthetic broker files committed through the real Python
 * import service, then re-imported (the retired Python vectors_inv_reimport.py). Three classes duplicated
 * rows when the v2 instrument key came from the row's hints: ISIN-only rows of a broker-aliased
 * instrument, batches stored under the legacy broker name, instruments with two aliases in one broker
 * namespace.
 *
 * - Python truth: the TS plan (v1) resolves every row to the instrument Python resolved, with Python's
 *   hash, and finds it stored.
 * - Genesis side: `instrumentKeyV2` over the stored row's instrument (alias rows by ascending id) equals
 *   the Python reference of gid.md 7.2; its v2 hash uses the occurrence recovered from the stored v1
 *   hash (what genesis does).
 * - Re-import side: the TS plan with `dedupV2` computes, for every row, the v2 hash genesis derived for
 *   the stored row Python matched, so the whole file is a duplicate.
 */

import { describe, expect, it } from "vitest";
import { Decimal } from "../../decimal.js";
import { expectAll, loadVectors, Mismatches } from "../../testing/vectors.js";
import {
  type AssetClass,
  asAccountId,
  asInstrumentId,
  asTxnId,
  type Currency,
  type InstrumentAlias,
  type InstrumentStatus,
  instrument,
  instrumentAlias,
  type TxnType,
  type ValuationMode,
} from "../domain/index.js";
import { CanonicalImporter } from "./canonical/index.js";
import { effectiveBrokerId } from "./contract.js";
import { dedupHash, dedupInput, HASH_VERSION_V2 } from "./dedup.js";
import { instrumentKeyV2 } from "./instrumentKey.js";
import { type ImportPlan, planImport } from "./plan.js";
import { InMemoryInstrumentLookup } from "./resolver.js";

interface AliasRow {
  readonly id: number;
  readonly instrument_id: number;
  readonly namespace: string;
  readonly value: string;
  readonly guessed: number;
}

interface TxnRow {
  readonly id: number;
  readonly account_id: number;
  readonly import_batch_id: number;
  readonly instrument_id: number | null;
  readonly source: string;
  readonly type: string;
  readonly trade_date: string;
  readonly currency: string;
  readonly gross_amount: string;
  readonly cash_amount: string;
  readonly quantity: string | null;
  readonly price: string | null;
  readonly external_ref: string | null;
  readonly dedup_hash: string;
}

interface DomainInstrument {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly assetClass: string;
  readonly symbol: string | null;
  readonly isin: string | null;
  readonly mic: string | null;
  readonly needsClassification: boolean;
  readonly valuationMode: string | null;
  readonly status: string;
  readonly aliases: readonly [string, string, boolean][];
}

interface Stored {
  readonly inv_import_batches: readonly { id: number; broker: string }[];
  readonly inv_instruments: readonly { id: number; isin: string | null }[];
  readonly inv_instrument_aliases: readonly AliasRow[];
  readonly inv_transactions: readonly TxnRow[];
  readonly instruments: readonly DomainInstrument[];
  readonly txnKeys: readonly {
    txnId: number;
    occurrence: number | null;
    ikey: string;
    oldGenesisKey: string;
  }[];
}

interface ReimportRow {
  readonly rowIndex: number;
  readonly instrumentId: number | null;
  readonly v1Hash: string;
  readonly isDuplicate: boolean;
  readonly hintKey: string;
  readonly storedTxnId: number | null;
}

interface Import {
  readonly scenario: string;
  readonly name: string;
  readonly accountId: number;
  readonly content: string;
  readonly reimport: {
    readonly brokerId: string;
    readonly rows: readonly ReimportRow[];
  };
}

const vectors = loadVectors("inv-reimport");
const meta = vectors.meta as unknown as {
  readonly findings: Readonly<Record<string, Readonly<Record<string, number>>>>;
};
const stored = vectors.rows.find((r) => r[0] === "stored")?.[1] as Stored;
const imports = vectors.rows.filter((r) => r[0] === "import").map((r) => r[1] as Import);

const accountGid = (accountId: number) => `acct-${accountId}`;
const instrumentGid = (instrumentId: string | number) => `gid-${instrumentId}`;
/** The Python reference writes the instrument gid as `gid:@<local id>`. */
const pythonKey = (key: string) =>
  key.replace(/^gid:@(\d+)$/u, (_, id: string) => `gid:${instrumentGid(id)}`);
const dec = (text: string | null) => (text === null ? null : Decimal.parse(text));

const lookup = () =>
  new InMemoryInstrumentLookup(
    stored.instruments.map((i) =>
      instrument({
        id: asInstrumentId(i.id),
        name: i.name,
        currency: i.currency as Currency,
        assetClass: i.assetClass as AssetClass,
        symbol: i.symbol,
        isin: i.isin,
        mic: i.mic,
        needsClassification: i.needsClassification,
        valuationMode: (i.valuationMode ?? undefined) as ValuationMode | undefined,
        status: i.status as InstrumentStatus,
        aliases: i.aliases.map(([namespace, value, guessed]) =>
          instrumentAlias(namespace, value, guessed),
        ),
      }),
    ),
  );

/** Genesis over the stored rows: the 7.2 key and the v2 hash of every imported row, by txn id. */
function genesisSide(): { keys: Map<number, string>; hashes: Map<number, string> } {
  const brokers = new Map(stored.inv_import_batches.map((b) => [b.id, b.broker]));
  const isin = new Map(stored.inv_instruments.map((i) => [i.id, i.isin]));
  const aliases = new Map<number, InstrumentAlias[]>();
  for (const a of stored.inv_instrument_aliases) {
    const list = aliases.get(a.instrument_id) ?? [];
    list.push(instrumentAlias(a.namespace, a.value, a.guessed === 1));
    aliases.set(a.instrument_id, list);
  }
  const occurrences = new Map(stored.txnKeys.map((k) => [k.txnId, k.occurrence]));
  const keys = new Map<number, string>();
  const hashes = new Map<number, string>();
  for (const row of stored.inv_transactions) {
    if (row.source !== "import") continue;
    const broker = brokers.get(row.import_batch_id) ?? null;
    const id = row.instrument_id;
    const key =
      id === null
        ? ""
        : instrumentKeyV2(
            { aliases: aliases.get(id) ?? [], isin: isin.get(id) ?? null },
            broker,
            () => instrumentGid(id),
          );
    keys.set(row.id, key);
    const input = dedupInput({
      tradeDate: row.trade_date,
      type: row.type as TxnType,
      grossAmount: Decimal.parse(row.gross_amount),
      cashAmount: Decimal.parse(row.cash_amount),
      externalRef: row.external_ref,
      instrumentKey: key === "" ? null : key,
      quantity: dec(row.quantity),
      price: dec(row.price),
      currency: row.currency,
    });
    const scope = {
      accountId: accountGid(row.account_id),
      brokerId: broker ?? "",
      version: HASH_VERSION_V2,
    };
    hashes.set(row.id, dedupHash(input, scope, occurrences.get(row.id) ?? 0));
  }
  return { keys, hashes };
}

function replan(entry: Import, existing: ReadonlySet<string>, v2: boolean): ImportPlan {
  const importer = new CanonicalImporter();
  const parsed = importer.parse({
    name: entry.name,
    content: new TextEncoder().encode(entry.content),
  });
  let planned = 0;
  let txns = 0;
  return planImport(parsed, {
    accountId: asAccountId(String(entry.accountId)),
    brokerId: effectiveBrokerId(importer, parsed),
    lookup: lookup(),
    existingHashes: (hashes) => hashes.filter((h) => existing.has(h)),
    instrumentIdFactory: () => asInstrumentId(`new-${++planned}`),
    txnIdFactory: () => asTxnId(`t-${++txns}`),
    ...(v2 ? { dedupV2: { accountGid: accountGid(entry.accountId), instrumentGid } } : {}),
  });
}

const storedOf = (accountId: number, hashOf: (row: TxnRow) => string | undefined) =>
  new Set(
    stored.inv_transactions
      .filter((r) => r.account_id === accountId)
      .flatMap((r) => {
        const h = hashOf(r);
        return h === undefined ? [] : [h];
      }),
  );

describe("re-import identity vectors (S26 review F2 classes)", () => {
  const genesis = genesisSide();

  it("covers the three classes that duplicated rows, and Python re-imports them as duplicates", () => {
    for (const scenario of ["isin_only", "legacy", "two_aliases"]) {
      const f = meta.findings[scenario];
      expect(f?.old_genesis_vs_hint_differ, scenario).toBeGreaterThan(0);
      expect(f?.python_duplicates, scenario).toBe(f?.rows);
      expect(f?.v1_recovered, scenario).toBe(f?.rows);
    }
  });

  it("the TS plan (v1) resolves, hashes and dedups every row as Python does", () => {
    const m = new Mismatches();
    for (const entry of imports) {
      const plan = replan(
        entry,
        storedOf(entry.accountId, (r) => r.dedup_hash),
        false,
      );
      m.check(`${entry.name} broker`, plan.brokerId, entry.reimport.brokerId);
      m.check(`${entry.name} rows`, plan.rows.length, entry.reimport.rows.length);
      plan.rows.forEach((row, i) => {
        const want = entry.reimport.rows[i];
        m.check(
          `${entry.name}#${i}`,
          [row.parsed.rowIndex, row.txn.instrumentId, row.txn.dedupHash, row.isDuplicate],
          [
            want?.rowIndex,
            want?.instrumentId === null || want === undefined ? null : String(want.instrumentId),
            want?.v1Hash,
            want?.isDuplicate,
          ],
        );
      });
    }
    expectAll(m);
  });

  it("genesis' instrument key of every stored row equals the Python reference of gid.md 7.2", () => {
    const m = new Mismatches();
    for (const k of stored.txnKeys)
      m.check(`txn ${k.txnId}`, genesis.keys.get(k.txnId), pythonKey(k.ikey));
    expectAll(m);
  });

  it("a TS re-import (v2) computes the hash genesis derived for the stored row Python matched", () => {
    const m = new Mismatches();
    let fixed = 0;
    for (const entry of imports) {
      const plan = replan(
        entry,
        storedOf(entry.accountId, (r) => genesis.hashes.get(r.id)),
        true,
      );
      plan.rows.forEach((row, i) => {
        const want = entry.reimport.rows[i];
        const txnId = want?.storedTxnId ?? -1;
        m.check(`${entry.name}#${i} hash`, row.txn.dedupHash, genesis.hashes.get(txnId));
        m.check(`${entry.name}#${i} duplicate`, row.isDuplicate, true);
        if (want !== undefined && want.hintKey !== (genesis.keys.get(txnId) ?? "")) fixed++;
      });
    }
    expectAll(m);
    // rows a hint-based key would have imported a second time (the classes above, after the fix)
    expect(fixed).toBeGreaterThan(0);
  });
});
