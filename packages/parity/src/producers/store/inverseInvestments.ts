/**
 * TRANSITIONAL(S25): inverse mode (see `inverse.ts`) of the investments rows that have no
 * materializer yet: instruments and aliases, account settings, imports, transactions, position
 * snapshots and renames. Deleted table by table as S25 lands their folds.
 */

import { json, text } from "./canonical.ts";
import type { GenesisEvent } from "./genesisRun.ts";
import { fields, first, type InverseSpec, last, perGid, time } from "./inverse.ts";

const firstOf = (events: readonly GenesisEvent[]) => events[0] as GenesisEvent;

const accountSettings: InverseSpec = {
  types: ["invAccount.settingsSet"],
  rows: perGid((events, keys) => {
    const e = last(events);
    const f = fields(e, keys);
    return {
      account_id: f.ref("accounts", "account"),
      wrapper: f.text("wrapper"),
      importer: f.text("importer"),
      mapping_yaml: f.text("mappingYaml"),
      created_at: time(firstOf(events), "created_at"),
      updated_at: time(e, "updated_at"),
    };
  }),
};

/** `archive` is the blob ref `{sha256, ext}` genesis exports only for a verified archive (spec 4.4). */
const imports: InverseSpec = {
  types: ["invImport.recorded"],
  rows: perGid((events, keys) => {
    const e = first("inv_import_batches", events, "invImport.recorded");
    const f = fields(e, keys);
    const archive = e.data.archive as { sha256?: unknown; ext?: unknown } | undefined;
    return {
      account_id: f.ref("accounts", "account"),
      importer: f.text("importer"),
      broker: f.text("broker"),
      file_name: f.text("fileName"),
      file_sha256: f.text("fileSha256"),
      archive_path:
        archive === undefined ? null : { sha256: text(archive.sha256), ext: text(archive.ext) },
      txn_count: f.int("txnCount"),
      duplicate_count: f.int("duplicateCount"),
      position_count: f.int("positionCount"),
      rename_count: f.int("renameCount"),
      status_change_count: f.int("statusChangeCount"),
      instrument_count: f.int("instrumentCount"),
      correction_count: f.int("correctionCount"),
      warnings: f.json("warnings"),
      created_at: time(e, "created_at"),
    };
  }),
};

const transactions: InverseSpec = {
  types: ["invTxn.imported"],
  rows: perGid((events, keys) => {
    const e = first("inv_transactions", events, "invTxn.imported");
    const f = fields(e, keys);
    return {
      account_id: f.ref("accounts", "account"),
      type: f.text("type"),
      trade_date: f.text("tradeDate"),
      settle_date: f.text("settleDate"),
      instrument_id: f.ref("inv_instruments", "instrument"),
      quantity: f.text("quantity"),
      price: f.text("price"),
      currency: f.text("currency"),
      gross_amount: f.text("grossAmount"),
      fee: f.text("fee"),
      tax: f.text("tax"),
      cash_amount: f.text("cashAmount"),
      cash_currency: f.text("cashCurrency"),
      fx_rate: f.text("fxRate"),
      split_ratio: f.text("splitRatio"),
      note: f.text("note"),
      source: f.text("source"),
      import_batch_id: f.ref("inv_import_batches", "batch"),
      external_ref: f.text("externalRef"),
      created_at: time(e, "created_at", e.data.createdAt),
    };
  }),
};

const positions: InverseSpec = {
  types: ["position.snapshotImported"],
  rows: perGid((events, keys) => {
    const e = first("inv_position_snapshots", events, "position.snapshotImported");
    const f = fields(e, keys);
    return {
      account_id: f.ref("accounts", "account"),
      instrument_id: f.ref("inv_instruments", "instrument"),
      as_of: f.text("asOf"),
      quantity: f.text("quantity"),
      currency: f.text("currency"),
      avg_price: f.text("avgPrice"),
      market_value: f.text("marketValue"),
      import_batch_id: f.ref("inv_import_batches", "batch"),
      created_at: time(e, "created_at"),
    };
  }),
};

const renames: InverseSpec = {
  types: ["instrumentRename.recorded"],
  rows: perGid((events, keys) => {
    const e = first("inv_instrument_renames", events, "instrumentRename.recorded");
    const f = fields(e, keys);
    return {
      date: f.text("date"),
      old_instrument_id: f.ref("inv_instruments", "old"),
      new_instrument_id: f.ref("inv_instruments", "new"),
      note: f.text("note"),
      import_batch_id: f.ref("inv_import_batches", "batch"),
      created_at: time(e, "created_at"),
    };
  }),
};

const instruments: InverseSpec = {
  types: ["instrument.created"],
  rows: perGid((events, keys) => {
    const e = first("inv_instruments", events, "instrument.created");
    const f = fields(e, keys);
    return {
      name: f.text("name"),
      currency: f.text("currency"),
      asset_class: f.text("assetClass"),
      symbol: f.text("symbol"),
      isin: f.text("isin"),
      mic: f.text("mic"),
      region: f.text("region"),
      sector: f.text("sector"),
      tags: json(e.data.tags, keys.mapString),
      needs_classification: f.bool("needsClassification"),
      valuation_mode: f.text("valuationMode"),
      status: f.text("status"),
      created_at: time(e, "created_at"),
      updated_at: time(e, "updated_at"),
    };
  }),
};

const aliases: InverseSpec = {
  types: ["instrument.aliasAdded"],
  rows: perGid((events, keys) => {
    const e = first("inv_instrument_aliases", events, "instrument.aliasAdded");
    const f = fields(e, keys);
    return {
      instrument_id: f.ref("inv_instruments", "instrument"),
      namespace: f.text("namespace"),
      value: f.text("value"),
      guessed: f.bool("guessed"),
      created_at: time(e, "created_at"),
    };
  }),
};

/** Inverse builders of the investments row tables. */
export const INVESTMENTS_INVERSE: Readonly<Record<string, InverseSpec>> = {
  inv_account_settings: accountSettings,
  inv_import_batches: imports,
  inv_transactions: transactions,
  inv_position_snapshots: positions,
  inv_instrument_renames: renames,
  inv_instruments: instruments,
  inv_instrument_aliases: aliases,
};
