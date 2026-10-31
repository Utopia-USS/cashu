/**
 * Producer of `investments.import_plan` (`parity/python/checks/investments.py:import_plan`): per
 * profile with the investments module, a dry-run re-import of every archived import file: the
 * importer rebuilt from what the batch and the account remember, `planImport` over the stored
 * instruments (`DbLookup`, the port of `store/instruments.DbInstrumentLookup`) and stored hashes, and
 * whether the plan's dedup hashes are exactly the batch's stored ones.
 *
 * Domain ids are the app's `str(pk)` (stored instruments) or the preview's `new-<sha12>-<n>` (planned
 * ones); stored ids become natural keys only in the output, as canon.py writes them.
 */

import { formatDateTime, investments as inv, pyStrip, pyUpper, sha256Hex } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import type { InvImportBatchRow } from "../../sources/investments.ts";
import type { OutValue } from "../output.ts";
import { loadInstruments, sid } from "./rows.ts";

const MODULE = "investments";
const imp = inv.importing;

/** `DbInstrumentLookup(session)`: read-only lookups over the stored instruments, shared view. */
class DbLookup implements inv.importing.InstrumentLookup {
  private readonly db: PythonDb;

  constructor(db: PythonDb) {
    this.db = db;
  }

  private one(id: number | null): inv.Instrument | null {
    if (id === null) return null;
    return loadInstruments(this.db, null, [id]).get(inv.asInstrumentId(sid(id))) ?? null;
  }

  byIsin(isin: string): inv.Instrument | null {
    const wanted = pyUpper(pyStrip(isin));
    const byColumn = this.db.investments.instrumentIdByIsin(wanted);
    if (byColumn !== null) return this.one(byColumn);
    return this.one(this.db.investments.instrumentIdByAlias(inv.AliasNamespace.ISIN, wanted));
  }

  byAlias(namespace: string, value: string): inv.Instrument | null {
    if (namespace === inv.AliasNamespace.ISIN) return this.byIsin(value);
    return this.one(this.db.investments.instrumentIdByAlias(namespace, pyStrip(value)));
  }

  bySymbol(symbol: string, mic: string): readonly inv.Instrument[] {
    const ids = this.db.investments.instrumentIdsBySymbol(pyUpper(pyStrip(symbol)), mic);
    const found = loadInstruments(this.db, null, ids);
    return ids.flatMap((id) => {
      const item = found.get(inv.asInstrumentId(sid(id)));
      return item === undefined ? [] : [item];
    });
  }
}

/** `imports.ConnectorDocumentImporter`: a connector's converted document read as canonical JSON. */
class ConnectorDocumentImporter implements inv.importing.BrokerImporter {
  private readonly canonical = new imp.CanonicalImporter();
  readonly brokerId = this.canonical.brokerId;
  readonly displayName: string;
  readonly version = this.canonical.version;

  constructor(importerId: string) {
    this.displayName = importerId;
  }

  private static asJson(file: inv.importing.ImportFile): inv.importing.ImportFile {
    return { name: `${file.name}.json`, content: file.content };
  }

  canParse(file: inv.importing.ImportFile): boolean {
    return this.canonical.canParse(ConnectorDocumentImporter.asJson(file));
  }

  parse(file: inv.importing.ImportFile): inv.importing.ImportParseResult {
    return this.canonical.parse(ConnectorDocumentImporter.asJson(file));
  }
}

const CONNECTOR_PREFIX = "connector:";

/** `_batch_importer`: the importer that parsed the archived file, or why it cannot be rebuilt. */
function batchImporter(
  db: PythonDb,
  batch: InvImportBatchRow,
): { importer: inv.importing.BrokerImporter } | { problem: string } {
  if (imp.canonicalImporterId(batch.importer) === imp.CANONICAL_BROKER_ID) {
    return { importer: new imp.CanonicalImporter() };
  }
  if (
    batch.importer.startsWith(CONNECTOR_PREFIX) &&
    batch.importer.length > CONNECTOR_PREFIX.length
  ) {
    return { importer: new ConnectorDocumentImporter(batch.importer) };
  }
  const yaml = db.investments.mappingYaml(batch.accountId);
  if (!yaml) return { problem: "no_mapping" };
  const parsed = imp.csvMappingFromYaml(yaml);
  if (!parsed.ok) throw new Error("the account's stored mapping does not parse");
  if (parsed.mapping.brokerId !== batch.importer) return { problem: "mapping_of_another_importer" };
  return { importer: new imp.GenericCsvImporter(parsed.mapping) };
}

/** `_plan_id`: a stored instrument's natural key, a planned one's id as is. */
function planId(db: PythonDb, value: string | null): string | null {
  if (value === null) return null;
  return /^[0-9]+$/u.test(value) ? db.keys.key("inv_instruments", Number(value)) : value;
}

function warning(w: inv.importing.ImportWarning): OutValue {
  return {
    message: w.message,
    row: w.row === null ? null : BigInt(w.row),
    blocking: w.blocking,
    kind: w.kind,
  };
}

function alias(a: inv.InstrumentAlias): OutValue {
  return { namespace: a.namespace, value: a.value, guessed: a.guessed };
}

function txn(db: PythonDb, t: inv.Transaction): OutValue {
  return {
    type: t.type,
    trade_date: t.tradeDate,
    currency: t.currency,
    gross_amount: t.grossAmount,
    cash_amount: t.cashAmount,
    cash_currency: t.cashCurrency,
    instrument_id: planId(db, t.instrumentId),
    settle_date: t.settleDate,
    quantity: t.quantity,
    price: t.price,
    fee: t.fee,
    tax: t.tax,
    fx_rate: t.fxRate,
    split_ratio: t.splitRatio,
    note: t.note,
    source: t.source,
    external_ref: t.externalRef,
    dedup_hash: t.dedupHash,
    created_at: formatDateTime(t.createdAt),
  };
}

function instrument(db: PythonDb, i: inv.Instrument): OutValue {
  return {
    id: planId(db, i.id),
    name: i.name,
    currency: i.currency,
    asset_class: i.assetClass,
    symbol: i.symbol,
    isin: i.isin,
    mic: i.mic,
    needs_classification: i.needsClassification,
    valuation_mode: i.valuationMode,
    status: i.status,
    aliases: i.aliases.map(alias),
  };
}

/** `_replan`: the plan of re-importing one archived file and its dedup summary. */
function replan(db: PythonDb, batch: InvImportBatchRow): OutValue {
  const content = batch.archivePath ? db.dataFile(batch.archivePath) : null;
  if (content === null) return { archive: "missing" };
  const built = batchImporter(db, batch);
  if ("problem" in built) return { archive: "ok", importer: built.problem };
  const { importer } = built;
  const parsed = importer.parse({ name: batch.fileName, content });
  const sha = sha256Hex(content);
  let planned = 0;
  let txnIds = 0;
  const plan = imp.planImport(parsed, {
    accountId: inv.asAccountId(sid(batch.accountId)),
    brokerId: imp.effectiveBrokerId(importer, parsed),
    lookup: new DbLookup(db),
    existingHashes: (hashes) => db.investments.existingHashes(batch.accountId, hashes),
    instrumentIdFactory: () => inv.asInstrumentId(`new-${sha.slice(0, 12)}-${++planned}`),
    txnIdFactory: () => inv.asTxnId(`t-${++txnIds}`),
  });
  const sources = db.investments.batchTransactions(batch.id);
  // the batch's own rows; reconciliation corrections applied with the commit are not file rows
  const stored = new Set(sources.filter((r) => r.source === "import").map((r) => r.dedupHash));
  const hashes = new Set(plan.rows.map((row) => row.txn.dedupHash));
  return {
    archive: "ok",
    sha256_matches: sha === batch.fileSha256,
    importer: batch.importer,
    broker_id: plan.brokerId,
    broker_matches: plan.brokerId === batch.broker,
    account_hint: plan.accountHint,
    rows: plan.rows.map((r) => ({
      row_index: BigInt(r.parsed.rowIndex),
      match: r.match,
      is_duplicate: r.isDuplicate,
      txn: txn(db, r.txn),
    })),
    positions: plan.positions.map((p) => ({
      parsed_index: BigInt(p.parsedIndex),
      match: p.match,
      instrument_id: planId(db, p.position.instrumentId),
      quantity: p.position.quantity,
      currency: p.position.currency,
      as_of: p.position.asOf,
      avg_price: p.position.avgPrice,
      market_value: p.position.marketValue,
    })),
    renames: plan.renames.map((r) => ({
      date: r.rename.date,
      old_instrument_id: planId(db, r.rename.oldInstrumentId),
      new_instrument_id: planId(db, r.rename.newInstrumentId),
      note: r.rename.note,
    })),
    status_changes: plan.statusChanges.map((c) => ({
      instrument_id: planId(db, c.instrumentId),
      status: c.status,
      date: c.parsed.date,
    })),
    new_instruments: plan.newInstruments.map((i) => instrument(db, i)),
    new_aliases: [...plan.newAliases].map(([instrumentId, aliases]) => ({
      instrument_id: planId(db, instrumentId),
      aliases: aliases.map(alias),
    })),
    warnings: plan.warnings.map(warning),
    blocking_errors: plan.blockingErrors.map(warning),
    dedup: {
      rows: BigInt(plan.rows.length),
      distinct_hashes: BigInt(hashes.size),
      stored_for_batch: BigInt(stored.size),
      corrections_for_batch: BigInt(sources.filter((r) => r.source !== "import").length),
      all_rows_stored: plan.rows.every((row) => row.isDuplicate),
      batch_hashes_in_plan: [...stored].every((digest) => hashes.has(digest)),
    },
  };
}

export function produceImportPlan(db: PythonDb): OutValue {
  const out: Record<string, OutValue> = {};
  for (const p of db.profiles()) {
    if (!db.enabledModules(p.id).includes(MODULE)) continue;
    const per: Record<string, OutValue> = {};
    for (const batch of db.investments.importBatches(p.id)) {
      per[db.keys.key("inv_import_batches", batch.id)] = replan(db, batch);
    }
    out[db.keys.key("profiles", p.id)] = per;
  }
  return out;
}
