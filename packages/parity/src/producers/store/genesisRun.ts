/// <reference types="node" />
/**
 * The genesis roundtrip of a parity dataset (S26 spec 8.3 `genesisRun.ts`): the `PythonDb` copy ->
 * `genesis.genesis(...)` (strict) with fixed parity keys per vault -> one in-memory `Store` per vault
 * with the vault's log applied in `GENESIS_CHUNK` chunks. The spec 8.4 invariants are asserted here
 * (the producer fails otherwise). Memoized per `PythonDb`, so every `store.table.*` producer of a run
 * shares one genesis and one fold.
 *
 * Parity keys (spec 6.1, impl notes change 1): `salt = sha256("cashu-parity-gid-salt-v1" US slug)`,
 * `vault = hex(first 16 bytes of sha256("cashu-parity-vault-v1" US slug))`. Never random; gids never
 * reach parity output (natural keys only), so fixed salts leak nothing. Errors name vault ordinals
 * and counts only, never slugs or values.
 */

import { createHash } from "node:crypto";
import {
  betterSqlite3Driver,
  builtinModules,
  type DetGid,
  detGidFor,
  Store,
  vaultSalt,
} from "@cashu/store";
import * as genesis from "@cashu/store/genesis";
import Database from "better-sqlite3";
import { DATASET_CLOCKS, type PythonDb } from "../../sources/index.ts";

const US = "\x1f";
/**
 * Allowance of the clock-skew guard over the dataset clock. A parity run has no wall clock of its
 * own: the dataset clock is the goldens' "as of", but a dataset's rows can be written after it (the
 * demo dataset carries its build time), so the guard gets a fixed year past the clock. Deterministic;
 * the log bytes never depend on `now` (only the guard reads it).
 */
const SKEW_ALLOWANCE_MS = 366 * 24 * 60 * 60 * 1000;

/** Where a gid came from: the Python table and its `sync_outbox._local_id`. */
export interface GidSource {
  readonly table: string;
  readonly localId: string;
}

export interface VaultRun {
  readonly ordinal: number;
  readonly profileId: number;
  /** The folded view of the vault's log. */
  readonly store: Store;
  /** Every exported row's gid -> its source row (genesis `ids`). */
  readonly sources: ReadonlyMap<string, GidSource>;
  /** The vault's DET gids (resolves the genesis gid of a dangling id inside a key, gid.md 7.6). */
  readonly det: DetGid;
}

export interface GenesisRun {
  /** By source profile id. */
  readonly vaults: ReadonlyMap<number, VaultRun>;
}

const sha256 = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

/** The fixed parity keys of a profile (spec 6.1, impl notes change 1). */
export function parityKeys(slug: string): genesis.VaultKeys {
  return {
    vault: sha256(`cashu-parity-vault-v1${US}${slug}`).subarray(0, 16).toString("hex"),
    salt: vaultSalt(sha256(`cashu-parity-gid-salt-v1${US}${slug}`)),
  };
}

/** The caller clock genesis gets: the dataset clock (as UTC) plus the skew allowance. */
export function parityNow(db: Pick<PythonDb, "dataset">): number {
  return Date.parse(`${DATASET_CLOCKS[db.dataset]}Z`) + SKEW_ALLOWANCE_MS;
}

class GenesisInvariantError extends Error {
  constructor(ordinal: number, what: string) {
    super(`genesis vault ${ordinal}: spec 8.4 invariant failed: ${what}`);
    this.name = "GenesisInvariantError";
  }
}

const count = (store: Store, table: string): number =>
  store.read<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? 0;

/** Applies a vault's log to a fresh in-memory store and asserts spec 8.4 on every chunk. */
function fold(v: genesis.GenesisVault, keys: genesis.VaultKeys): Store {
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");
  const store = Store.open({
    driver: betterSqlite3Driver(db),
    vault: v.vault,
    salt: keys.salt,
    modules: builtinModules(),
  });
  const fail = (what: string) => new GenesisInvariantError(v.ordinal, what);
  for (let i = 0; i < v.events.length; i += genesis.GENESIS_CHUNK) {
    const r = store.applyWire({
      device: v.device,
      events: v.events.slice(i, i + genesis.GENESIS_CHUNK),
    });
    if (r.parked !== 0) throw fail(`parked ${r.parked}`);
    if (r.suppressed !== 0) throw fail(`suppressed ${r.suppressed}`);
    if (r.rejected.length !== 0) throw fail(`rejected ${r.rejected.length}`);
    if (r.conflicts.length !== 0) throw fail(`conflicts ${r.conflicts.length}`);
    if (r.needsUpgrade) throw fail("needsUpgrade after an apply");
  }
  if (store.needsUpgrade()) throw fail("needsUpgrade");
  // unknown_events also holds the `invalid-gid` parks (P1), which needsUpgrade() leaves out.
  const unknown = count(store, "unknown_events");
  if (unknown !== 0) throw fail(`unknown_events ${unknown}`);
  const conflicts = count(store, "account_conflicts");
  if (conflicts !== 0) throw fail(`account_conflicts ${conflicts}`);
  return store;
}

function runGenesis(db: PythonDb): GenesisRun {
  const keys = new Map(db.profiles().map((p) => [p.slug, parityKeys(p.slug)]));
  const result = genesis.genesis({ driver: db.sqlDriver(), files: db.files() }, keys, {
    strict: true,
    now: parityNow(db),
  });
  const vaults = new Map<number, VaultRun>();
  for (const v of result.vaults) {
    const k = keys.get(v.slug);
    if (k === undefined) throw new GenesisInvariantError(v.ordinal, "no parity keys");
    const sources = new Map<string, GidSource>();
    for (const e of v.ids) sources.set(e.gid, { table: e.table, localId: e.localId });
    vaults.set(v.profileId, {
      ordinal: v.ordinal,
      profileId: v.profileId,
      store: fold(v, k),
      sources,
      det: detGidFor(k.salt),
    });
  }
  return { vaults };
}

const runs = new WeakMap<PythonDb, GenesisRun>();

/** The genesis roundtrip of `db`, run once per `PythonDb` and shared by every `store.table.*` producer. */
export function genesisRun(db: PythonDb): GenesisRun {
  let run = runs.get(db);
  if (run === undefined) {
    run = runGenesis(db);
    runs.set(db, run);
  }
  return run;
}
