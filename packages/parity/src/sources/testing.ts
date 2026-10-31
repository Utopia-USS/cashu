/// <reference types="node" />
/**
 * Synthetic datasets for the source and producer tests: a temp dir with a `cashu.db` holding the
 * columns the readers select (the real schema has more). Invented values only.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE alembic_version (version_num VARCHAR NOT NULL);
CREATE TABLE profiles (id INTEGER PRIMARY KEY, slug VARCHAR, name VARCHAR, base_currency VARCHAR,
  mcp_privacy VARCHAR, created_at DATETIME);
CREATE TABLE profile_modules (id INTEGER PRIMARY KEY, profile_id INTEGER, module_id VARCHAR,
  enabled BOOLEAN);
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
`;

export interface SyntheticDataset {
  readonly dir: string;
  readonly runRoot: string;
  /** Run SQL against the source (to seed it, or to change it behind an open source). */
  exec(sql: string): void;
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
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Two profiles sharing an IBAN (isolation), a cash pool, a loan and a removed account. */
export const TWO_PROFILES = `
INSERT INTO profiles VALUES (1, 'test-b', 'Test B', 'PLN', 'strict', '2026-01-01 00:00:00');
INSERT INTO profiles VALUES (2, 'test-a', 'Test A', 'EUR', 'amounts', '2026-01-01 00:00:00');
INSERT INTO profile_modules VALUES (1, 1, 'budget', 1), (2, 1, 'loans', 1), (3, 1, 'assets', 0),
  (4, 2, 'budget', 1);
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
