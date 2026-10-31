// Id rewriting of genesis (S26 spec 6.4, 6.5; gid.md 6, 7.6): local ids inside typed reference
// columns, key strings and JSON become gids through the phase-1 resolver. Dangling ids follow gid.md
// 7.6 and are always counted: a nullable reference or a JSON scalar id -> null (`dangling_<column>`,
// `dangling_<column>.<key>`), an id in a list -> dropped, an id inside a key -> the genesis gid of
// the missing row (`dangling_key_id`). Table rules first, then a guard walks the whole JSON value
// and fails the run (`unmapped_id_key`) on an id under a vocabulary key no rule rewrote (R5). The
// rules mirror the parity check (parity/python/checks/store.py) with gids in place of natural keys.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ALERT_KEY_RE, idFieldTable, isJsonObject, KEY_PART_RE, rowIdOf } from "./idFields.js";
import type { GidResolver } from "./ids.js";
import { type GenesisCounters, GenesisError } from "./report.js";
import type { GenesisFiles } from "./source.js";

/** What the rewriter needs of phase 1 (`VaultIds`). */
export interface RewriteIds {
  readonly resolver: GidResolver;
  missingGid(table: string, id: number): string;
}

/** A staged proposal file: `<64 hex>[-<suffix>].<ext>` (Python `.proposals/<sha>-<random>.<ext>`). */
const STAGED_NAME = /^([0-9a-f]{64})(?:-[0-9A-Za-z]+)?\.([A-Za-z0-9]{1,10})$/;
const COUNTER_KEY = /^[a-z][a-z0-9_]*$/;

type JsonRule = (r: Rewriter, table: string, column: string, value: unknown) => unknown;

/** Rewrites of the scalar / list keys of a top-level JSON object (others stay). */
function keysRule(
  scalars: readonly (readonly [key: string, target: string])[],
  lists: readonly (readonly [key: string, target: string])[],
): JsonRule {
  return (r, table, column, value) => {
    if (!isJsonObject(value)) return value;
    const out: Record<string, unknown> = { ...value };
    for (const [key, target] of scalars) {
      if (key in out) out[key] = r.jsonScalar(table, `${column}.${key}`, target, out[key]);
    }
    for (const [key, target] of lists) {
      if (Array.isArray(out[key])) out[key] = r.refs(table, `${column}.${key}`, target, out[key]);
    }
    return out;
  };
}

/** Spec 6.5, per (table, column). Every other JSON column goes through the guard only. */
const JSON_RULES: ReadonlyMap<string, JsonRule> = new Map([
  [
    "inv_signals.payload",
    keysRule(
      [
        ["instrument_id", "inv_instruments"],
        ["alert_id", "alerts"],
        ["note_id", "research_notes"],
      ],
      // `accounts` is rewritten only as a list: rule kinds also store an account count there.
      [
        ["note_ids", "research_notes"],
        ["accounts", "accounts"],
      ],
    ),
  ],
  [
    "inv_rule_runs.report",
    keysRule(
      [],
      [
        ["new", "inv_signals"],
        ["escalated", "inv_signals"],
      ],
    ),
  ],
  [
    "research_notes.details",
    keysRule(
      [
        ["watchlist_item_id", "watchlist_items"],
        ["thesis_id", "inv_theses"],
        ["previous_instrument_id", "inv_instruments"],
      ],
      [],
    ),
  ],
  [
    "research_runs.scope",
    keysRule(
      [],
      [
        ["instrument_ids", "inv_instruments"],
        ["covered_instrument_ids", "inv_instruments"],
      ],
    ),
  ],
  ["proposals.payload", (r, table, column, value) => r.proposalPayload(table, column, value)],
]);

/** Rewrites one vault's ids; one instance per vault. */
export class Rewriter {
  readonly #ids: RewriteIds;
  readonly #counters: GenesisCounters;
  readonly #ordinal: number;
  readonly #files: GenesisFiles;

  constructor(ids: RewriteIds, counters: GenesisCounters, ordinal: number, files: GenesisFiles) {
    this.#ids = ids;
    this.#counters = counters;
    this.#ordinal = ordinal;
    this.#files = files;
  }

  #count(table: string, reason: string): void {
    this.#counters.addVault(this.#ordinal, table, reason);
  }

  #gid(target: string, id: number): string | undefined {
    return this.#ids.resolver.gid(target, String(id));
  }

  /**
   * A nullable typed reference column (gid.md 7.6 "null" rows): the target's gid, or null when the
   * id is null or the target is not exported (counted `(table, dangling_<column>)`).
   */
  ref(table: string, column: string, target: string, id: number | null): string | null {
    if (id === null) return null;
    const gid = this.#gid(target, id);
    if (gid === undefined) this.#count(table, `dangling_${column}`);
    return gid ?? null;
  }

  /** An id list (7.6): gids in order, dangling ids dropped (counted `dangling_<key>`), non-ids kept. */
  refs(table: string, key: string, target: string, values: readonly unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const value of values) {
      const id = rowIdOf(value);
      if (id === undefined) {
        out.push(value);
        continue;
      }
      const gid = this.#gid(target, id);
      if (gid === undefined) this.#count(table, `dangling_${key}`);
      else out.push(gid);
    }
    return out;
  }

  /** A scalar id inside JSON (7.6): its gid, null when dangling (counted); a non-id value stays. */
  jsonScalar(table: string, key: string, target: string, value: unknown): unknown {
    const id = rowIdOf(value);
    if (id === undefined) return value;
    const gid = this.#gid(target, id);
    if (gid === undefined) this.#count(table, `dangling_${key}`);
    return gid ?? null;
  }

  #keyPart(table: string, target: string, id: number): string {
    const gid = this.#gid(target, id);
    if (gid !== undefined) return gid;
    this.#count(table, "dangling_key_id");
    return this.#ids.missingGid(target, id);
  }

  /** A signal / plan / research dedup key (6.5): `i:` / `a:` parts and a whole `alert:<id>` key. */
  key(table: string, value: string): string {
    const alert = ALERT_KEY_RE.exec(value);
    if (alert !== null) return `alert:${this.#keyPart(table, "alerts", Number(alert[1]))}`;
    return value
      .split("|")
      .map((part) => {
        const m = KEY_PART_RE.exec(part);
        if (m === null) return part;
        const target = m[1] === "i" ? "inv_instruments" : "accounts";
        return `${m[1]}:${this.#keyPart(table, target, Number(m[2]))}`;
      })
      .join("|");
  }

  /** A signal rule id (6.5): only a whole `alert:<id>` holds an id. */
  ruleId(table: string, value: string): string {
    const alert = ALERT_KEY_RE.exec(value);
    return alert === null ? value : `alert:${this.#keyPart(table, "alerts", Number(alert[1]))}`;
  }

  /**
   * A JSON column of an exported row: the table rule of 6.5 (if any), then the guard. Throws
   * `GenesisError("unmapped_id_key")` after counting `(table, unmapped_id_key.<column>.<key>)` for
   * every id left under a vocabulary key.
   */
  json(table: string, column: string, value: unknown): unknown {
    const rule = JSON_RULES.get(`${table}.${column}`);
    const out = rule === undefined ? value : rule(this, table, column, value);
    let unmapped = 0;
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const item of v) walk(item);
        return;
      }
      if (!isJsonObject(v)) return;
      for (const [k, child] of Object.entries(v)) {
        const items = Array.isArray(child) ? child : [child];
        if (idFieldTable(k) !== undefined && items.some((i) => rowIdOf(i) !== undefined)) {
          unmapped++;
          this.#count(
            table,
            COUNTER_KEY.test(k) ? `unmapped_id_key.${column}.${k}` : "unmapped_id_key",
          );
        }
        walk(child);
      }
    };
    walk(out);
    if (unmapped > 0) {
      throw new GenesisError("unmapped_id_key", "a JSON value holds a local id no rule rewrote");
    }
    return out;
  }

  /** `proposals.payload` (6.5): `account_id` -> `account`, `staged` -> `blob {sha256, ext}`. */
  proposalPayload(table: string, column: string, value: unknown): unknown {
    if (!isJsonObject(value)) return value;
    if ("binding_id" in value) {
      // A connector proposal's local binding id (and its device-local `run_id`) has no 6.5 rule yet
      // (open lead decision): fail closed instead of letting a local id into the log.
      this.#count(table, `unmapped_id_key.${column}.binding_id`);
      throw new GenesisError("unmapped_id_key", "a connector proposal holds a local binding id");
    }
    const { account_id: accountId, staged, ...rest } = value;
    const out: Record<string, unknown> = { ...rest };
    if ("account_id" in value) {
      out.account = this.jsonScalar(table, `${column}.account_id`, "accounts", accountId);
    }
    if ("staged" in value) out.blob = this.#stagedBlob(table, staged);
    return out;
  }

  /**
   * The blob of a staged file, from its name; the bytes are hashed when the file is in the copy
   * (`staged_missing`, `staged_hash_mismatch`). A name that is not `<sha256>[-x].<ext>` -> null
   * (`staged_invalid`).
   */
  #stagedBlob(table: string, staged: unknown): { sha256: string; ext: string } | null {
    if (staged === null) return null;
    const name = typeof staged === "string" ? (staged.split("/").pop() ?? "") : "";
    const m = STAGED_NAME.exec(name);
    if (typeof staged !== "string" || m === null) {
      this.#count(table, "staged_invalid");
      return null;
    }
    const blob = { sha256: m[1] ?? "", ext: (m[2] ?? "").toLowerCase() };
    const safe = !staged.startsWith("/") && !staged.split("/").includes("..");
    const bytes = safe ? this.#files.read(staged) : undefined;
    if (bytes === undefined) this.#count(table, "staged_missing");
    else if (bytesToHex(sha256(bytes)) !== blob.sha256) this.#count(table, "staged_hash_mismatch");
    return blob;
  }
}
