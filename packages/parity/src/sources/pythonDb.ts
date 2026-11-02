/// <reference types="node" />
/**
 * The one read-only source every TS parity producer reads the Python app's data through.
 *
 * `openPythonDb` copies the dataset's SQLite files (`cashu.db` and its `-wal` / `-shm`) and the
 * `profiles/**` and `imports/**` side files (regular files only, symlinks are not followed) into a
 * fresh `<lab>/parity/ts-run-<stamp>-<dataset>/` and opens the copy with `readOnly: true`. The source
 * dir is never opened: even a read-only connection to a WAL database creates `-wal` / `-shm` files
 * next to it. The source is hashed before the copy and again on `close()`, which throws when one
 * byte changed (as golden.py does) and deletes the copy.
 *
 * Code that takes platform seams instead of typed readers (the genesis exporter) gets them over the
 * copy: `sqlDriver()` (a read-only `SqlDriver`) and `files()` (`GenesisFiles`, side files by
 * data-dir-relative path).
 *
 * Readers are typed per table and profile-scoped: every reader of profile data takes the profile id
 * and filters by it (rule 7: data of one profile never shows up in another). Rows keep SQLite's
 * stored text for decimals (`amount: "12.50"`, Python's `str(Decimal)`), so producers parse them with
 * `@cashu/domain`'s `D()` and nothing is ever a JS float. Enums stored by NAME (`balances.source`) come
 * back as their values (`"csv"`), as Python's ORM gives them. `keys` maps row ids to the goldens'
 * natural keys (`naturalKeys.ts`).
 *
 * Lab rows are real financial data: producers write them only to `<lab>/parity/ts-out/lab/` and
 * never print them. Add a typed reader here (not ad hoc SQL in a producer) when a producer needs
 * another table.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type core, loans } from "@cashu/domain";
import type { SqlDriver } from "@cashu/store";
import { type Dataset, datasetAsOf, datasetDir, labRoot } from "./datasets.ts";
import { bool, int, type Row, text, textOrNull } from "./decode.ts";
import { InvestmentsReader } from "./investments.ts";
import { InvestmentsViewsReader } from "./investmentsViews.ts";
import { LoansAssetsReader } from "./loansAssets.ts";
import { NaturalKeys, type SqlRows, type SqlValue } from "./naturalKeys.ts";
import { openReadOnlyDriver } from "./nodeSqliteDriver.ts";

const DB_FILES = ["cashu.db", "cashu.db-wal", "cashu.db-shm"] as const;
/** Side-file dirs of the data dir the copy takes (genesis reads budget.json, archives, staged files). */
const SIDE_DIRS = ["profiles", "imports"] as const;

/**
 * Side files of a data dir by relative path (`profiles/<slug>/budget.json`, `imports/<slug>/<sha>.csv`).
 * Structural twin of the genesis source's interface in `@cashu/store` (aligned in S26 C8).
 */
export interface GenesisFiles {
  /** The file's bytes; undefined when there is no regular file at `rel`. */
  read(rel: string): Uint8Array | undefined;
  /** Names of the entries (files and dirs) directly in `dir` (`""` = the root), sorted; [] when absent. */
  list(dir: string): readonly string[];
}

export class UnsafePathError extends Error {
  constructor() {
    super("side-file path refused: absolute, empty segment, '.', '..' or backslash");
    this.name = "UnsafePathError";
  }
}

/** `rel` split into its segments, refused unless it stays inside the root. `""` is the root. */
function segments(rel: string, allowRoot: boolean): string[] {
  if (rel === "" && allowRoot) return [];
  if (isAbsolute(rel) || rel.includes("\\") || rel.includes("\0")) throw new UnsafePathError();
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw new UnsafePathError();
  return parts;
}

/** Copy the regular files and dirs under `from` to `to` (symlinks and specials are skipped). */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    if (entry.isDirectory()) copyTree(src, join(to, entry.name));
    else if (entry.isFile()) copyFileSync(src, join(to, entry.name));
  }
}

export class SourceChangedError extends Error {
  constructor(dataset: string) {
    super(`the ${dataset} source dataset changed while it was read`);
    this.name = "SourceChangedError";
  }
}

/** sha256 over `<file sha256>  ./<path>` lines of every file, sorted by path (golden.py `manifest`). */
export function manifest(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(`./${relative(root, full).split("\\").join("/")}`);
    }
  };
  walk(root);
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    const digest = createHash("sha256")
      .update(readFileSync(join(root, rel.slice(2))))
      .digest("hex");
    hash.update(`${digest}  ${rel}\n`);
  }
  return `${files.length}:${hash.digest("hex")}`;
}

// --------------------------------------------------------------------------- row types

export interface ProfileRow {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly baseCurrency: string | null;
  readonly mcpPrivacy: string | null;
}

export interface AccountRow {
  readonly id: number;
  readonly profileId: number;
  readonly bank: string;
  readonly name: string;
  readonly iban: string | null;
  readonly externalId: string | null;
  readonly currency: string;
  readonly type: string;
  readonly active: boolean;
  readonly removedAt: string | null;
}

export interface BalanceRow {
  readonly id: number;
  readonly accountId: number;
  readonly date: string;
  /** Stored decimal text. */
  readonly amount: string;
  readonly currency: string;
  /** `Source` value: open_banking | csv | manual | connector. */
  readonly source: string;
}

export interface TransactionRow {
  readonly id: number;
  readonly accountId: number;
  readonly bookingDate: string;
  readonly valueDate: string | null;
  /** Stored decimal text. */
  readonly amount: string;
  readonly currency: string;
  readonly counterpartyName: string | null;
  readonly counterpartyIban: string | null;
  readonly description: string | null;
  readonly reference: string | null;
  readonly bankTransactionId: string | null;
  readonly source: string;
  readonly dedupHash: string;
  readonly occurrence: number;
  readonly transferGroupId: string | null;
  readonly isInternalTransfer: boolean;
  readonly category: string | null;
  readonly categorySource: string | null;
}

export interface CategoryRuleRow {
  readonly merchantKey: string;
  readonly category: string;
  readonly source: string;
  readonly locked: boolean;
}

// --------------------------------------------------------------------------- value decoding

/** Python `Source` / sa.Enum: stored by member NAME, read as the member value. */
const SOURCE_VALUES: Readonly<Record<string, string>> = Object.freeze({
  OPEN_BANKING: "open_banking",
  CSV: "csv",
  MANUAL: "manual",
  CONNECTOR: "connector",
});

function source(row: Row, col: string): string {
  const name = text(row, col);
  const value = SOURCE_VALUES[name];
  if (value === undefined) throw new Error(`unknown Source member in ${col}`);
  return value;
}

/** Profile-scoped account ids, for `account_id IN (...)` filters. */
const PROFILE_ACCOUNTS = "SELECT id FROM accounts WHERE profile_id = ?";

// --------------------------------------------------------------------------- the source

export interface OpenOptions {
  readonly dataset: Dataset;
  /** Override the dataset's source dir (tests). */
  readonly sourceDir?: string;
  /** Where the run copy goes (default `<lab>/parity`). */
  readonly runRoot?: string;
}

export class PythonDb implements SqlRows {
  readonly dataset: Dataset;
  /** `as_of` of the dataset's goldens (the frozen clock's date). */
  readonly asOf: string;
  readonly keys: NaturalKeys;
  /** Typed readers of the investments module's tables (`investments.ts`). */
  readonly investments: InvestmentsReader;
  readonly investmentsViews: InvestmentsViewsReader;
  /** Typed readers of the loans and assets modules' tables (`loansAssets.ts`). */
  readonly loansAssets: LoansAssetsReader;
  private readonly db: DatabaseSync;
  private readonly sourceDir: string;
  private readonly runDir: string;
  private readonly before: string;
  private readonly drivers: SqlDriver[] = [];
  private closed = false;

  private constructor(opts: OpenOptions) {
    this.dataset = opts.dataset;
    this.asOf = datasetAsOf(opts.dataset);
    this.sourceDir = opts.sourceDir ?? datasetDir(opts.dataset);
    if (!existsSync(join(this.sourceDir, "cashu.db"))) {
      throw new Error(`no ${opts.dataset} dataset (cashu.db) in its source dir`);
    }
    this.before = manifest(this.sourceDir);
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    const root = opts.runRoot ?? join(labRoot(), "parity");
    this.runDir = join(root, `ts-run-${stamp}-${process.pid}-${opts.dataset}`);
    mkdirSync(this.runDir, { recursive: true });
    chmodSync(this.runDir, 0o700);
    for (const f of DB_FILES) {
      const from = join(this.sourceDir, f);
      if (existsSync(from)) copyFileSync(from, join(this.runDir, f));
    }
    for (const d of SIDE_DIRS) {
      const from = join(this.sourceDir, d);
      if (statSync(from, { throwIfNoEntry: false })?.isDirectory())
        copyTree(from, join(this.runDir, d));
    }
    this.db = new DatabaseSync(join(this.runDir, "cashu.db"), { readOnly: true });
    this.keys = new NaturalKeys(this);
    this.investments = new InvestmentsReader(
      (sql, ...params) => this.objects(sql, ...params),
      (profileId) => this.accounts(profileId, { includeRemoved: true }),
    );
    this.investmentsViews = new InvestmentsViewsReader((sql, ...params) =>
      this.objects(sql, ...params),
    );
    this.loansAssets = new LoansAssetsReader((sql, ...params) => this.objects(sql, ...params));
  }

  static open(opts: OpenOptions): PythonDb {
    return new PythonDb(opts);
  }

  /**
   * The bytes of a file of the dataset's data dir (`relativePath` as the app stores it, e.g. an
   * archived import), copied into the run dir first like the database; null when it is missing or
   * outside the data dir.
   */
  dataFile(relativePath: string): Uint8Array | null {
    const from = resolve(this.sourceDir, relativePath);
    if (!from.startsWith(`${resolve(this.sourceDir)}${sep}`) || !existsSync(from)) return null;
    if (!statSync(from).isFile()) return null;
    const dir = join(this.runDir, "files");
    mkdirSync(dir, { recursive: true });
    const to = join(dir, createHash("sha256").update(relativePath).digest("hex"));
    copyFileSync(from, to);
    return new Uint8Array(readFileSync(to));
  }

  /** Close, delete the copy, and throw `SourceChangedError` if the source changed meanwhile. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const d of this.drivers.splice(0)) d.close();
    this.db.close();
    rmSync(this.runDir, { recursive: true, force: true });
    if (manifest(this.sourceDir) !== this.before) throw new SourceChangedError(this.dataset);
  }

  /** A read-only `SqlDriver` over the copy (its own connection, closed by `close()`). */
  sqlDriver(): SqlDriver {
    if (this.closed) throw new Error("PythonDb is closed");
    const driver = openReadOnlyDriver(join(this.runDir, "cashu.db"));
    this.drivers.push(driver);
    return driver;
  }

  /** The copy's side files (`profiles/**`, `imports/**`) by data-dir-relative path. */
  files(): GenesisFiles {
    const root = this.runDir;
    return {
      read(rel) {
        const full = join(root, ...segments(rel, false));
        if (!statSync(full, { throwIfNoEntry: false })?.isFile()) return undefined;
        return readFileSync(full);
      },
      list(dir) {
        const full = join(root, ...segments(dir, true));
        if (!statSync(full, { throwIfNoEntry: false })?.isDirectory()) return [];
        return readdirSync(full).sort();
      },
    };
  }

  /** Positional rows (natural keys and other generic tooling only; producers use typed readers). */
  rows(sql: string, ...params: (string | number | bigint | null)[]): SqlValue[][] {
    // Object rows in column order (setReturnArrays needs Node 24); callers check the arity, which
    // also catches two result columns sharing a name.
    return this.objects(sql, ...params).map((r) => Object.values(r));
  }

  private objects(sql: string, ...params: (string | number | bigint | null)[]): Row[] {
    const stmt = this.db.prepare(sql);
    stmt.setReadBigInts(true);
    return stmt.all(...params) as unknown as Row[];
  }

  /** Alembic revision of the copy (the lab snapshot may be a revision behind the goldens' copy). */
  schemaVersion(): string {
    const [row] = this.objects("SELECT version_num FROM alembic_version");
    return row === undefined ? "" : text(row, "version_num");
  }

  /** Every profile, ordered by slug (the goldens' `Ctx.profiles` order). */
  profiles(): ProfileRow[] {
    return this.objects(
      "SELECT id, slug, name, base_currency, mcp_privacy FROM profiles ORDER BY slug",
    ).map((r) => ({
      id: int(r, "id"),
      slug: text(r, "slug"),
      name: text(r, "name"),
      baseCurrency: textOrNull(r, "base_currency"),
      mcpPrivacy: textOrNull(r, "mcp_privacy"),
    }));
  }

  /** Enabled module ids of a profile (unordered; order them by the module registry). */
  enabledModules(profileId: number): string[] {
    return this.objects(
      "SELECT module_id FROM profile_modules WHERE profile_id = ? AND enabled = 1 ORDER BY module_id",
      profileId,
    ).map((r) => text(r, "module_id"));
  }

  /** The profile's accounts in id order; removed ones only with `includeRemoved`. */
  accounts(profileId: number, opts: { includeRemoved?: boolean } = {}): AccountRow[] {
    const removed = opts.includeRemoved ? "" : " AND removed_at IS NULL";
    return this.objects(
      `SELECT id, profile_id, bank, name, iban, external_id, currency, type, active, removed_at
       FROM accounts WHERE profile_id = ?${removed} ORDER BY id`,
      profileId,
    ).map((r) => ({
      id: int(r, "id"),
      profileId: int(r, "profile_id"),
      bank: text(r, "bank"),
      name: text(r, "name"),
      iban: textOrNull(r, "iban"),
      externalId: textOrNull(r, "external_id"),
      currency: text(r, "currency"),
      type: text(r, "type"),
      active: bool(r, "active"),
      removedAt: textOrNull(r, "removed_at"),
    }));
  }

  /** Balance snapshots of the profile's accounts, ordered by account id, then id (insertion). */
  balances(profileId: number): BalanceRow[] {
    return this.objects(
      `SELECT id, account_id, date, amount, currency, source FROM balances
       WHERE account_id IN (${PROFILE_ACCOUNTS}) ORDER BY account_id, id`,
      profileId,
    ).map((r) => ({
      id: int(r, "id"),
      accountId: int(r, "account_id"),
      date: text(r, "date"),
      amount: text(r, "amount"),
      currency: text(r, "currency"),
      source: source(r, "source"),
    }));
  }

  /** Budget transactions of the profile's accounts, ordered by account id, then id. */
  transactions(profileId: number): TransactionRow[] {
    return this.objects(
      `SELECT id, account_id, booking_date, value_date, amount, currency, counterparty_name,
              counterparty_iban, description, reference, bank_transaction_id, source, dedup_hash, occurrence,
              transfer_group_id, is_internal_transfer, category, category_source
       FROM transactions WHERE account_id IN (${PROFILE_ACCOUNTS}) ORDER BY account_id, id`,
      profileId,
    ).map((r) => ({
      id: int(r, "id"),
      accountId: int(r, "account_id"),
      bookingDate: text(r, "booking_date"),
      valueDate: textOrNull(r, "value_date"),
      amount: text(r, "amount"),
      currency: text(r, "currency"),
      counterpartyName: textOrNull(r, "counterparty_name"),
      counterpartyIban: textOrNull(r, "counterparty_iban"),
      description: textOrNull(r, "description"),
      reference: textOrNull(r, "reference"),
      bankTransactionId: textOrNull(r, "bank_transaction_id"),
      source: source(r, "source"),
      dedupHash: text(r, "dedup_hash"),
      occurrence: int(r, "occurrence"),
      transferGroupId: textOrNull(r, "transfer_group_id"),
      isInternalTransfer: bool(r, "is_internal_transfer"),
      category: textOrNull(r, "category"),
      categorySource: textOrNull(r, "category_source"),
    }));
  }

  /** `load_rules`: the profile's merchant rules (`category_rules`), in id order. */
  categoryRules(profileId: number): CategoryRuleRow[] {
    return this.objects(
      "SELECT merchant_key, category, source, locked FROM category_rules WHERE profile_id = ? ORDER BY id",
      profileId,
    ).map((r) => ({
      merchantKey: text(r, "merchant_key"),
      category: text(r, "category"),
      source: text(r, "source"),
      locked: bool(r, "locked"),
    }));
  }

  /**
   * `loans/patterns.py:payment_patterns`: one pattern per loan of the profile's accounts (removed ones
   * too) with a truthy lender IBAN or title phrase; the phrase normalized, empty ones as null.
   */
  loanPaymentPatterns(profileId: number): core.PaymentPattern[] {
    return loans.paymentPatterns(this.loansAssets.loans(profileId));
  }
}

/** Open the dataset, run `fn`, always close (a changed source throws after `fn`). */
export function withPythonDb<T>(opts: OpenOptions, fn: (db: PythonDb) => T): T {
  const db = PythonDb.open(opts);
  let result: T;
  try {
    result = fn(db);
  } catch (e) {
    db.close();
    throw e;
  }
  db.close();
  return result;
}
