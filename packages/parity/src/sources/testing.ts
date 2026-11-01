/// <reference types="node" />
/**
 * Synthetic datasets for the source and producer tests: a temp dir with a `cashu.db` holding the
 * columns the readers select (the real schema has more). Invented values only.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE alembic_version (version_num VARCHAR NOT NULL);
CREATE TABLE profiles (id INTEGER PRIMARY KEY, slug VARCHAR, name VARCHAR, base_currency VARCHAR,
  mcp_privacy VARCHAR, created_at DATETIME);
CREATE TABLE profile_modules (profile_id INTEGER, module_id VARCHAR, enabled BOOLEAN,
  enabled_at DATETIME, PRIMARY KEY (profile_id, module_id));
CREATE TABLE accounts (id INTEGER PRIMARY KEY, bank VARCHAR, name VARCHAR, iban VARCHAR,
  external_id VARCHAR, currency VARCHAR, type VARCHAR, active BOOLEAN, created_at DATETIME,
  profile_id INTEGER, removed_at DATETIME);
CREATE TABLE balances (id INTEGER PRIMARY KEY, account_id INTEGER, date DATE, amount VARCHAR,
  currency VARCHAR, source VARCHAR(12), created_at DATETIME);
CREATE TABLE transactions (id INTEGER PRIMARY KEY, account_id INTEGER, booking_date DATE,
  value_date DATE, amount VARCHAR, currency VARCHAR, counterparty_name VARCHAR,
  counterparty_iban VARCHAR, description VARCHAR, reference VARCHAR, source VARCHAR(12),
  dedup_hash VARCHAR, occurrence INTEGER, transfer_group_id VARCHAR, is_internal_transfer BOOLEAN,
  category VARCHAR, category_source VARCHAR);
CREATE TABLE category_rules (id INTEGER PRIMARY KEY, merchant_key VARCHAR, category VARCHAR,
  source VARCHAR, locked BOOLEAN, created_at DATETIME, profile_id INTEGER);
CREATE TABLE loans (id INTEGER PRIMARY KEY, account_id INTEGER, payment_iban VARCHAR,
  payment_text VARCHAR);
CREATE TABLE inv_transactions (id INTEGER PRIMARY KEY, account_id INTEGER, type VARCHAR,
  trade_date DATE, settle_date DATE, instrument_id INTEGER, quantity VARCHAR, price VARCHAR,
  currency VARCHAR, gross_amount VARCHAR, fee VARCHAR, tax VARCHAR, cash_amount VARCHAR,
  cash_currency VARCHAR, fx_rate VARCHAR, split_ratio VARCHAR, note VARCHAR, source VARCHAR,
  import_batch_id INTEGER, external_ref VARCHAR, dedup_hash VARCHAR, created_at DATETIME);
CREATE TABLE inv_instruments (id INTEGER PRIMARY KEY, name VARCHAR, currency VARCHAR,
  asset_class VARCHAR, symbol VARCHAR, isin VARCHAR, mic VARCHAR, region VARCHAR, sector VARCHAR,
  tags JSON, needs_classification BOOLEAN, valuation_mode VARCHAR, status VARCHAR);
CREATE TABLE inv_instrument_aliases (id INTEGER PRIMARY KEY, instrument_id INTEGER,
  namespace VARCHAR, value VARCHAR, guessed BOOLEAN);
CREATE TABLE inv_profile_instruments (id INTEGER PRIMARY KEY, profile_id INTEGER,
  instrument_id INTEGER, name VARCHAR, asset_class VARCHAR, tags JSON, region VARCHAR,
  sector VARCHAR, valuation_mode VARCHAR, status VARCHAR, needs_classification BOOLEAN,
  "plan" VARCHAR, plan_at DATETIME, plan_reason VARCHAR, segment VARCHAR, segment_by VARCHAR);
CREATE TABLE inv_instrument_renames (id INTEGER PRIMARY KEY, profile_id INTEGER, date DATE,
  old_instrument_id INTEGER, new_instrument_id INTEGER, note VARCHAR);
CREATE TABLE inv_manual_valuations (id INTEGER PRIMARY KEY, profile_id INTEGER,
  instrument_id INTEGER, as_of DATE, unit_value VARCHAR, currency VARCHAR, note VARCHAR);
CREATE TABLE inv_price_bars (id INTEGER PRIMARY KEY, instrument_id INTEGER, date DATE,
  close VARCHAR, open VARCHAR, high VARCHAR, low VARCHAR, volume INTEGER, currency VARCHAR,
  source VARCHAR, fetched_at DATETIME);
CREATE TABLE inv_account_settings (account_id INTEGER PRIMARY KEY, wrapper VARCHAR,
  importer VARCHAR, mapping_yaml VARCHAR, created_at DATETIME, updated_at DATETIME);
CREATE TABLE connector_bindings (id INTEGER PRIMARY KEY, profile_id INTEGER, account_id INTEGER,
  connector_id VARCHAR, params_json JSON, auto_commit BOOLEAN, cursor VARCHAR);
CREATE TABLE inv_fx_rates (id INTEGER PRIMARY KEY, base VARCHAR, quote VARCHAR, date DATE,
  rate VARCHAR, source VARCHAR, fetched_at DATETIME);
CREATE TABLE inv_import_batches (id INTEGER PRIMARY KEY, profile_id INTEGER, account_id INTEGER,
  importer VARCHAR, broker VARCHAR, file_name VARCHAR, file_sha256 VARCHAR, archive_path VARCHAR,
  created_at DATETIME);
`;

export interface SyntheticDataset {
  readonly dir: string;
  readonly runRoot: string;
  /** Run SQL against the source (to seed it, or to change it behind an open source). */
  exec(sql: string): void;
  /** Write a side file (`profiles/...`, `imports/...`) at a data-dir-relative path. */
  writeFile(rel: string, data: string | Uint8Array): void;
  dispose(): void;
}

/** A fresh dataset dir with the schema and `seed` SQL applied (WAL mode, like the app's database). */
export function syntheticDataset(seed: string): SyntheticDataset {
  const root = mkdtempSync(join(tmpdir(), "cashu-parity-source-"));
  const dir = join(root, "data");
  const runRoot = join(root, "runs");
  mkdirSync(dir);
  const db = new DatabaseSync(join(dir, "cashu.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  db.exec("INSERT INTO alembic_version VALUES ('0026_test')");
  db.exec(seed);
  db.close();
  return {
    dir,
    runRoot,
    exec(sql: string) {
      const w = new DatabaseSync(join(dir, "cashu.db"));
      w.exec(sql);
      w.close();
    },
    writeFile(rel: string, data: string | Uint8Array) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, data);
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Two profiles sharing an IBAN (isolation), a cash pool, a loan and a removed account. */
export const TWO_PROFILES = `
INSERT INTO profiles VALUES (1, 'test-b', 'Test B', 'PLN', 'strict', '2026-01-01 00:00:00');
INSERT INTO profiles VALUES (2, 'test-a', 'Test A', 'EUR', 'amounts', '2026-01-01 00:00:00');
INSERT INTO profile_modules VALUES (1, 'budget', 1, NULL), (1, 'loans', 1, NULL),
  (1, 'assets', 0, NULL), (2, 'budget', 1, NULL);
INSERT INTO accounts VALUES
  (1, 'mbank', 'Konto Test', '99114000000000000000000001', 'csv:99114000000000000000000001', 'PLN',
   'checking', 1, '2026-01-01', 1, NULL),
  (2, 'manual', 'Gotówka', NULL, NULL, 'PLN', 'cash', 1, '2026-01-01', 1, NULL),
  (3, 'manual', 'Kredyt Test', NULL, 'manual:kredyt', 'PLN', 'loan', 1, '2026-01-01', 1, NULL),
  (4, 'manual', 'Stare Test', NULL, 'manual:stare', 'PLN', 'other', 1, '2026-01-01', 1,
   '2026-06-01 10:00:00'),
  (5, 'mbank', 'Konto Test', '99114000000000000000000001', 'csv:99114000000000000000000001', 'EUR',
   'checking', 1, '2026-01-01', 2, NULL);
INSERT INTO balances VALUES
  (1, 1, '2026-09-01', '1000.00', 'PLN', 'CSV', NULL),
  (2, 1, '2026-09-01', '1100.00', 'PLN', 'OPEN_BANKING', NULL),
  (3, 3, '2026-01-01', '9000.00', 'PLN', 'MANUAL', NULL),
  (4, 4, '2026-01-01', '50.00', 'PLN', 'MANUAL', NULL),
  (5, 5, '2026-09-01', '700.00', 'EUR', 'CSV', NULL);
INSERT INTO transactions VALUES
  (1, 2, '2026-08-02', NULL, '200.00', 'PLN', NULL, NULL, 'WYPLATA TEST', NULL, 'MANUAL', 'h1', 1,
   NULL, 0, 'cash', 'manual'),
  (2, 2, '2026-08-01', NULL, '-20.50', 'PLN', NULL, NULL, 'SKLEP TEST', NULL, 'MANUAL', 'h2', 1,
   NULL, 0, 'groceries', 'manual'),
  (3, 1, '2026-08-03', '2026-08-03', '-5.00', 'PLN', 'SKLEP TEST', NULL, 'KARTA TEST', 'r1', 'CSV',
   'h3', 1, NULL, 0, 'other', 'default'),
  (4, 5, '2026-08-03', NULL, '-1.00', 'EUR', NULL, NULL, 'KAWA TEST', NULL, 'CSV', 'h4', 1, NULL, 1,
   NULL, NULL);
`;

/**
 * Two profiles with a brokerage account each (isolation): a PLN ETF with a profile override, a USD
 * stock valued through a USD rate, cash, a sell, a rename and a manual valuation. Invented values.
 */
export const INVESTMENTS = `
INSERT INTO profiles VALUES (1, 'test-b', 'Test B', 'PLN', 'strict', NULL);
INSERT INTO profiles VALUES (2, 'test-a', 'Test A', 'PLN', 'strict', NULL);
INSERT INTO profile_modules VALUES (1, 'investments', 1, NULL), (2, 'investments', 1, NULL);
INSERT INTO accounts VALUES
  (1, 'xtb', 'Makler Test', NULL, 'xtb:1', 'PLN', 'brokerage', 1, NULL, 1, NULL),
  (2, 'mbank', 'Konto Test', NULL, 'csv:2', 'PLN', 'checking', 1, NULL, 1, NULL),
  (3, 'xtb', 'Makler Test', NULL, 'xtb:3', 'PLN', 'brokerage', 1, NULL, 2, NULL);
INSERT INTO inv_instruments VALUES
  (1, 'Test ETF', 'PLN', 'etf', 'TETF', 'PL0000000001', 'XWAR', NULL, NULL, '["equity"]', 0,
   'market', 'active'),
  (2, 'Test Stock', 'USD', 'equity', 'TSTK', NULL, 'XNAS', 'us', NULL, '[]', 0, 'market',
   'active'),
  (3, 'Test Old', 'PLN', 'equity', 'TOLD', NULL, 'XWAR', NULL, NULL, '[]', 0, 'manual',
   'active');
INSERT INTO inv_instrument_aliases VALUES (1, 1, 'stooq', 'tetf', 0), (2, 1, 'isin', 'x', 1),
  (3, 2, 'yahoo', 'TSTK', 1);
INSERT INTO inv_profile_instruments VALUES
  (1, 1, 1, NULL, NULL, '["equity", "core"]', '', NULL, NULL, NULL, NULL, 'hold',
   '2026-09-01 10:00:00.000001', 'Test reason', 'equity_pl', 'owner'),
  (2, 2, 1, 'Other Name', NULL, 'null', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   NULL);
INSERT INTO inv_transactions VALUES
  (1, 1, 'deposit', '2026-01-02', NULL, NULL, NULL, NULL, 'PLN', '5000', '0', '0', '5000', 'PLN',
   NULL, NULL, NULL, 'import', NULL, NULL, 'd1', '2026-01-02 10:00:00.000000'),
  (2, 1, 'buy', '2026-01-05', NULL, 1, '10', '100', 'PLN', '1000', '5', '0', '-1005', 'PLN',
   NULL, NULL, NULL, 'import', NULL, NULL, 'd2', '2026-01-05 10:00:00.000000'),
  (3, 1, 'buy', '2026-02-05', NULL, 2, '2', '50', 'USD', '100', '1', '0', '-404', 'PLN',
   '4.0', NULL, NULL, 'import', NULL, NULL, 'd3', '2026-02-05 10:00:00.000000'),
  (4, 1, 'sell', '2026-03-05', NULL, 1, '4', '110', 'PLN', '440', '2', '0', '438', 'PLN',
   NULL, NULL, NULL, 'import', NULL, NULL, 'd4', '2026-03-05 10:00:00.000000'),
  (5, 1, 'transfer_in', '2026-04-01', NULL, 3, '5', '15', 'PLN', '0', '0', '0', '0', 'PLN',
   NULL, NULL, NULL, 'manual', NULL, NULL, 'd5', '2026-04-01 10:00:00.000000'),
  (6, 3, 'buy', '2026-01-05', NULL, 1, '1', '100', 'PLN', '100', '0', '0', '-100', 'PLN',
   NULL, NULL, NULL, 'import', NULL, NULL, 'd6', '2026-01-05 10:00:00.000000');
INSERT INTO inv_instrument_renames VALUES (1, 2, '2026-06-01', 1, 3, NULL);
INSERT INTO inv_manual_valuations VALUES (1, 1, 3, '2026-09-01', '20', 'PLN', NULL),
  (2, 2, 3, '2026-09-01', '99', 'PLN', NULL);
INSERT INTO inv_price_bars VALUES
  (1, 1, '2026-09-29', '120', NULL, NULL, NULL, NULL, NULL, 'test', NULL),
  (2, 1, '2026-09-30', '121.5', NULL, NULL, NULL, NULL, NULL, 'test', NULL),
  (3, 2, '2026-09-30', '60', NULL, NULL, NULL, 1000, 'USD', 'test', NULL);
INSERT INTO inv_fx_rates VALUES
  (1, 'PLN', 'USD', '2026-02-04', '4.0', 'nbp', NULL),
  (2, 'PLN', 'USD', '2026-09-30', '3.9', 'nbp', NULL),
  (3, 'PLN', 'EUR', '2026-09-30', '4.3', 'nbp', NULL);
`;
