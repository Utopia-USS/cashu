// A synthetic Python data dir for the CLI tests (S26 spec 10 `apps/cli/src/genesis/*.test.ts`):
// `cashu.db` at schema 0025 built from the committed Alembic DDL of the store's genesis tests, two
// profiles with a few rows each, side files the run copies and a file it does not. Synthetic only.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { CliEnv } from "../command.ts";

// The schema-only DDL of Alembic revision 0025, committed with the store's genesis test helpers
// (read as a file: the store does not export its test code).
const DDL_0025 = new URL(
  "../../../../../packages/store/src/genesis/testing/python-schema/0025.sql",
  import.meta.url,
);

const TS = "2026-01-02 03:04:05.000000";

/** Slugs and names of the synthetic profiles: stdout must never carry them. */
export const SECRETS = ["ala", "olek", "Ala Syntetyczna", "Olek Syntetyczny", "Konto testowe"];

/** Writes the synthetic data dir into `dir` (created). */
export function writePythonDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "cashu.db"));
  try {
    db.exec(readFileSync(DDL_0025, "utf8"));
    db.prepare("INSERT INTO alembic_version (version_num) VALUES (?)").run(
      "0025_topic_view_sources",
    );
    const profile = db.prepare(
      "INSERT INTO profiles (id, slug, name, base_currency, mcp_privacy, created_at) VALUES (?, ?, ?, 'PLN', 'strict', ?)",
    );
    profile.run(1, "ala", "Ala Syntetyczna", TS);
    profile.run(2, "olek", "Olek Syntetyczny", TS);
    const module = db.prepare(
      "INSERT INTO profile_modules (profile_id, module_id, enabled, enabled_at) VALUES (?, ?, 1, ?)",
    );
    module.run(1, "budget", TS);
    module.run(2, "budget", TS);
    const account = db.prepare(
      `INSERT INTO accounts (id, bank, name, iban, external_id, currency, type, active, created_at, profile_id)
       VALUES (?, ?, 'Konto testowe', NULL, ?, 'PLN', 'checking', 1, ?, ?)`,
    );
    account.run(1, "mbank", "csv:SYNTH1", TS, 1);
    account.run(2, "pekao", "eb:SYNTH2", TS, 2);
    db.prepare(
      `INSERT INTO balances (account_id, date, amount, currency, source, created_at)
       VALUES (1, '2026-01-02', '1500.50', 'PLN', 'CSV', ?)`,
    ).run(TS);
    db.prepare(
      `INSERT INTO category_rules (merchant_key, category, source, locked, created_at, profile_id)
       VALUES ('sklep testowy', 'jedzenie', 'manual', 0, ?, 1)`,
    ).run(TS);
  } finally {
    db.close();
  }
  mkdirSync(join(dir, "profiles", "ala"), { recursive: true });
  writeFileSync(join(dir, "profiles", "ala", "budget.json"), '{"cushion": {"enabled": false}}\n');
  mkdirSync(join(dir, "imports", "ala"), { recursive: true });
  writeFileSync(join(dir, "imports", "ala", "notes.txt"), "synthetic\n");
  mkdirSync(join(dir, "backups"), { recursive: true });
  writeFileSync(join(dir, "backups", "old.db"), "not copied\n");
}

/** A fresh temp dir. */
export const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), `cashu-cli-${prefix}-`));

/** A `CliEnv` with a fake home and its own temp dir; stdout and stderr lines are collected. */
export function testEnv(home: string): CliEnv & {
  readonly out: string[];
  readonly err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    home,
    tmpDir: tempDir("tmp"),
    pid: 4242,
    now: () => Date.UTC(2026, 9, 31),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    out,
    err,
  };
}
