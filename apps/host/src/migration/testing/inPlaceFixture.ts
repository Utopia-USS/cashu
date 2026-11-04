// Synthetic Python data dirs for the in-place migration tests (tests only): a schema-0025 cashu.db
// with one profile, one account, a staged import file, FX and macro rows, plus the device-local side
// state the import moves but never reads, and the native shell's own entries. A test key store over
// an in-memory keyring in the exact `cashu-next-test.*` namespace; nothing touches the OS keychain.
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { createProductionKeyStore } from "@cashu/node-host/keyring";
import {
  createTestKeyStore,
  createTestMigrationKek,
  type OsKeyringDeletePort,
} from "@cashu/node-host/testing";
import type { InPlaceKeychain } from "../inPlace.js";

const SCHEMA = new URL(
  "../../../../../packages/store/src/genesis/testing/python-schema/0025.sql",
  import.meta.url,
);

/** The Python top-level entries the fixture writes (the cutover moves exactly these). */
export const PYTHON_NAMES = [
  "backups",
  "cashu.db",
  "connectors",
  "imports",
  "logs",
  "settings.json",
] as const;

export interface PythonFixture {
  /** `<tmp>/t44-test-*` (outside D: recovery files go here). */
  readonly base: string;
  /** D: `<base>/data`, the Python data dir migrated in place. */
  readonly dataDir: string;
  readonly keychain: InPlaceKeychain;
  readonly service: string;
  readonly items: Map<string, Uint8Array>;
  readonly makeKeyStore: typeof createProductionKeyStore;
  remove(): void;
}

export function pythonFixture(): PythonFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "t44-test-")));
  const dataDir = join(base, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, "cashu.db"));
  const timestamp = "2026-01-02 03:04:05.000000";
  const stagedBytes = new TextEncoder().encode("synthetic import bytes\n");
  const stagedSha = createHash("sha256").update(stagedBytes).digest("hex");
  const stagedPath = `imports/synthetic/.proposals/${stagedSha}-0123456789ab.csv`;
  try {
    db.exec(readFileSync(SCHEMA, "utf8"));
    db.prepare("INSERT INTO alembic_version(version_num) VALUES (?)").run(
      "0025_topic_view_sources",
    );
    db.prepare(
      "INSERT INTO profiles(id,slug,name,base_currency,mcp_privacy,created_at) VALUES (?,?,?,?,?,?)",
    ).run(1, "synthetic", "Synthetic", "PLN", "strict", timestamp);
    db.prepare(
      "INSERT INTO accounts(id,bank,name,currency,type,active,created_at,profile_id) VALUES (?,?,?,?,?,?,?,?)",
    ).run(1, "manual", "Synthetic account", "PLN", "checking", 1, timestamp, 1);
    db.prepare(
      "INSERT INTO proposals(id,profile_id,kind,status,summary,payload,result,source,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      1,
      1,
      "import",
      "pending",
      "Synthetic staged import",
      JSON.stringify({ account_id: 1, staged: stagedPath }),
      "{}",
      "user",
      timestamp,
    );
    db.prepare(
      "INSERT INTO inv_fx_rates(id,base,quote,date,rate,source,fetched_at) VALUES (?,?,?,?,?,?,?)",
    ).run(1, "EUR", "USD", "2026-01-02", "1.07", "nbp", null);
    db.prepare(
      "INSERT INTO inv_macro_bars(id,series,date,close,source,fetched_at) VALUES (?,?,?,?,?,?)",
    ).run(1, "growth", "2026-01-02", "101.2", "manual", null);
  } finally {
    db.close();
  }
  const dir = (path: string) => mkdirSync(join(dataDir, path), { recursive: true, mode: 0o700 });
  const file = (path: string, bytes: string | Uint8Array) =>
    writeFileSync(join(dataDir, path), bytes, { mode: 0o600 });
  dir("imports/synthetic/.proposals");
  file(stagedPath, stagedBytes);
  // Device-local Python state: moved into the backup, never read by the import.
  file("settings.json", JSON.stringify({ language: "en" }));
  dir("logs");
  file("logs/cashu.log", "synthetic python log line\n");
  dir("backups");
  file("backups/cashu-20260101.db", randomBytes(4096));
  dir("connectors/sample");
  file("connectors/sample/connector.py", "print('synthetic')\n");
  // The native shell's own entries, present before an import from the recovery screen.
  file("logs/electron.log", "synthetic shell log line\n");
  dir("desktop-electron/Local Storage");
  file("desktop-electron/Local Storage/state", "synthetic");
  dir("diagnostics");
  file(".DS_Store", "synthetic");

  const items = new Map<string, Uint8Array>();
  const service = `cashu-next-test.${randomBytes(16).toString("hex")}`;
  const keyring: OsKeyringDeletePort = {
    async get(s, account) {
      return items.get(`${s}/${account}`)?.slice() ?? null;
    },
    async set(s, account, value) {
      items.set(`${s}/${account}`, value.slice());
    },
    async delete(s, account) {
      items.delete(`${s}/${account}`);
    },
  };
  const makeKeyStore: typeof createProductionKeyStore = (input) =>
    createTestKeyStore({ ...input, service, keyring });
  return {
    base,
    dataDir,
    service,
    items,
    makeKeyStore,
    keychain: { makeKeyStore, kek: createTestMigrationKek({ dataDir, service, keyring }) },
    remove: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** Every file (sha256), directory and symlink under `names` of `root`, keyed by relative path. */
export function treeHashes(root: string, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (relative: string) => {
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) out[relative] = `link:${readlinkSync(path)}`;
    else if (stat.isDirectory()) {
      out[relative] = "dir";
      for (const child of readdirSync(path)) visit(`${relative}/${child}`);
    } else out[relative] = createHash("sha256").update(readFileSync(path)).digest("hex");
  };
  for (const name of names) visit(name);
  return out;
}

/** Every file under `root` (relative paths), for byte scans. */
export function allFiles(
  root: string,
  skip: (relative: string) => boolean = () => false,
): string[] {
  const out: string[] = [];
  const visit = (relative: string) => {
    if (skip(relative)) return;
    const path = relative === "" ? root : join(root, relative);
    const stat = lstatSync(path);
    if (stat.isDirectory())
      for (const child of readdirSync(path))
        visit(relative === "" ? child : `${relative}/${child}`);
    else if (stat.isFile()) out.push(relative);
  };
  visit("");
  return out;
}
