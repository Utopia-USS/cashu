/**
 * Gids of one genesis vault -> the goldens' natural keys (S26 spec 8.3 `project.ts`): gid -> the
 * source row genesis exported under it (`ids`: Python table and local id) -> `db.keys.key(table, id)`.
 * Ids inside key strings (signal `dedup_key` / `rule_id`, spec 6.5) map part by part; a dangling id
 * genesis replaced with `DET(genesis)[table, id]` (gid.md 7.6) reads `<prefix>:dangling-<id>` as in
 * store.py, its id found by recomputing that gid.
 */

import type { DetGid } from "../../gid.js";
import { DANGLING } from "./canonical.js";

export interface GidSource {
  readonly table: string;
  readonly localId: string;
}

export interface VaultKeyMap {
  readonly det: DetGid;
  readonly sources: ReadonlyMap<string, GidSource>;
}

/** Natural keys by Python table and row id (`PythonDb.keys`). */
export interface KeyLookup {
  key(table: string, id: number | bigint): string;
  prefix(table: string): string;
}

/** A gid as genesis writes it (keyed UUIDv8 or ULID, events v1 `gid`). */
const GID =
  "[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26}";
const GID_RE = new RegExp(`^(${GID})$`);
/** A whole alert key or rule id (`alert:<gid>`). */
const ALERT_KEY = new RegExp(`^alert:(${GID})$`);
/** A `|` part of a signal key holding an instrument (`i:`) or account (`a:`) gid. */
const KEY_PART = new RegExp(`^(i|a):(${GID})$`);
/** How far past the vault's largest exported id a dangling id is searched. */
const DANGLING_SEARCH = 100_000;

class UnmappedGidError extends Error {
  constructor(what: string) {
    super(`genesis roundtrip: ${what}`);
    this.name = "UnmappedGidError";
  }
}

export class GidKeys {
  readonly #sources: ReadonlyMap<string, GidSource>;
  readonly #keys: KeyLookup;
  readonly #vault: VaultKeyMap;
  readonly #dangling = new Map<string, Map<string, number>>();

  constructor(vault: VaultKeyMap, keys: KeyLookup) {
    this.#vault = vault;
    this.#sources = vault.sources;
    this.#keys = keys;
  }

  /** The source row of a gid, undefined for a gid genesis exported no row under. */
  source(gid: string): GidSource | undefined {
    return this.#sources.get(gid);
  }

  /** The natural key of an exported row's gid, undefined for any other string. */
  keyOf(gid: string): string | undefined {
    const s = this.#sources.get(gid);
    return s === undefined ? undefined : this.#keys.key(s.table, BigInt(s.localId));
  }

  /** A reference column: null stays null; a gid must be an exported row of `table`. */
  ref(table: string, gid: unknown): string | null {
    if (gid === null || gid === undefined) return null;
    const s = typeof gid === "string" ? this.#sources.get(gid) : undefined;
    if (s === undefined || s.table !== table) {
      throw new UnmappedGidError(`a ${table} reference is no exported ${table} row`);
    }
    return this.#keys.key(table, BigInt(s.localId));
  }

  /** An id inside a key string: the row's key, or `<prefix>:dangling-<id>` for a genesis gid. */
  #keyPart(table: string, gid: string): string {
    const s = this.#sources.get(gid);
    if (s !== undefined && s.table === table) return this.#keys.key(table, BigInt(s.localId));
    const id = this.#danglingId(table, gid);
    return `${this.#keys.prefix(table)}:dangling-${id}`;
  }

  #danglingId(table: string, gid: string): number {
    let map = this.#dangling.get(table);
    if (map === undefined) {
      map = new Map();
      let max = 0;
      for (const s of this.#sources.values()) {
        if (s.table === table) max = Math.max(max, Number(s.localId));
      }
      for (let id = 1; id <= max + DANGLING_SEARCH; id++) {
        map.set(this.#vault.det("genesis", [table, String(id)]), id);
      }
      this.#dangling.set(table, map);
    }
    const id = map.get(gid);
    if (id === undefined) throw new UnmappedGidError(`a ${table} key part maps to no id`);
    return id;
  }

  /** Signal `dedup_key` (store.py `rule_key(whole_alert_only=False)`). */
  dedupKey(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const v = String(value);
    const alert = ALERT_KEY.exec(v);
    if (alert !== null) return `alert:${this.#keyPart("alerts", alert[1] as string)}`;
    return v
      .split("|")
      .map((part) => {
        const m = KEY_PART.exec(part);
        if (m === null) return part;
        const table = m[1] === "i" ? "inv_instruments" : "accounts";
        return `${m[1]}:${this.#keyPart(table, m[2] as string)}`;
      })
      .join("|");
  }

  /** Signal `rule_id` (store.py `rule_key(whole_alert_only=True)`). */
  ruleId(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const v = String(value);
    const alert = ALERT_KEY.exec(v);
    return alert === null ? v : `alert:${this.#keyPart("alerts", alert[1] as string)}`;
  }

  /** For JSON walks: a gid string -> its natural key. */
  /**
   * A JSON string: an exported row's gid -> its natural key; a gid of no exported row (a row deleted
   * or merged away after it was referenced, bridge runs) -> `DANGLING`, as store.py's canonical form
   * treats an id whose row is gone; any other string stays.
   */
  readonly mapString = (s: string): string | undefined | typeof DANGLING => {
    const key = this.keyOf(s);
    if (key !== undefined) return key;
    return GID_RE.test(s) ? DANGLING : undefined;
  };
}
