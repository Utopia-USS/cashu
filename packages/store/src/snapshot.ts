// View hashes and store snapshots.
//
// - `viewHash`: a deterministic content hash of the public view (ids excluded, references hashed as
//   the referenced row's gid, JSON canonical). Two stores holding the same event set have the same
//   hash, whatever the delivery order (events.md 6.7); parity checks (S24-S26, S48) compare it.
// - `exportSnapshot` / `importSnapshot`: the whole store (log copy, view, fold indexes) as a portable
//   value, to start a device without replaying (and decrypting) the log. The snapshot is PLAINTEXT:
//   it must only leave the device through the carrier's encryption (S32 builds compaction on it).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalJson } from "./canonical.js";
import { Store, type StoreOptions } from "./materialize.js";
import { allColumns, type TableDef } from "./sql/ddl.js";
import type { SqlValue } from "./sql/driver.js";
import { SYSTEM_TABLES } from "./sql/system.js";

export interface ViewHash {
  readonly hash: string;
  readonly tables: Readonly<Record<string, { readonly rows: number; readonly hash: string }>>;
}

const hex = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));

export function viewHash(store: Store): ViewHash {
  const gidById = new Map(
    store.driver
      .prepare("SELECT id, gid FROM view_ids")
      .all<{ id: number; gid: string }>()
      .map((r) => [r.id, r.gid]),
  );
  const tables: Record<string, { rows: number; hash: string }> = {};
  const defs = [...store.publicTables()].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const t of defs) {
    const cols = allColumns(t).filter((c) => !(t.primaryKey === undefined && c.name === "id"));
    const rows = store.driver
      .prepare(`SELECT ${cols.map((c) => c.name).join(", ")} FROM ${t.name}`)
      .all<Record<string, SqlValue>>()
      .map((r) =>
        canonicalJson(
          cols.map((c) => {
            const v = r[c.name] ?? null;
            if (v === null) return null;
            if (c.ref) return `ref:${gidById.get(Number(v)) ?? `?${String(v)}`}`;
            if (c.json) return JSON.parse(String(v)) as unknown;
            return typeof v === "bigint" ? Number(v) : v;
          }),
        ),
      )
      .sort();
    tables[t.name] = { rows: rows.length, hash: hex(rows.join("\n")) };
  }
  return { hash: hex(canonicalJson(tables)), tables };
}

export interface StoreSnapshot {
  readonly format: "cashu.store.snapshot/1";
  readonly vault: string;
  readonly viewHash: string;
  readonly tables: Readonly<
    Record<string, { readonly columns: readonly string[]; readonly rows: readonly SqlValue[][] }>
  >;
}

function storeTables(store: Store): readonly TableDef[] {
  return [...SYSTEM_TABLES, ...store.viewTables()];
}

export function exportSnapshot(store: Store): StoreSnapshot {
  const tables: Record<string, { columns: string[]; rows: SqlValue[][] }> = {};
  for (const t of storeTables(store)) {
    const columns = allColumns(t).map((c) => c.name);
    const rows = store.driver
      .prepare(`SELECT ${columns.join(", ")} FROM ${t.name}`)
      .all<Record<string, SqlValue>>()
      .map((r) => columns.map((c) => r[c] ?? null));
    tables[t.name] = { columns, rows };
  }
  return {
    format: "cashu.store.snapshot/1",
    vault: store.vault,
    viewHash: viewHash(store).hash,
    tables,
  };
}

/**
 * Load a snapshot into an empty database and open the store on it. When the snapshot was taken by
 * a reader with other definitions (another app version), the store rebuilds from the imported log
 * on open; otherwise the imported view must hash to the snapshot's hash, or the import fails.
 */
export function importSnapshot(opts: StoreOptions, snapshot: StoreSnapshot): Store {
  if (snapshot.format !== "cashu.store.snapshot/1") throw new Error("unknown snapshot format");
  if (snapshot.vault !== opts.vault) throw new Error("snapshot of another vault");
  const empty = Store.open(opts);
  const count = empty.driver.prepare("SELECT COUNT(*) AS n FROM event_log").get<{ n: number }>();
  if ((count?.n ?? 0) > 0) throw new Error("importSnapshot needs an empty store");
  const names = new Set(storeTables(empty).map((t) => t.name));
  const metaOf = (driverMeta: readonly SqlValue[][]) =>
    canonicalJson(
      driverMeta.filter((r) => r[0] === "view_fingerprint" || r[0] === "events_fingerprint").sort(),
    );
  const currentMeta = empty.driver
    .prepare("SELECT key, value FROM store_meta")
    .all<{ key: string; value: string }>()
    .map((r) => [r.key, r.value]);
  const sameDefinitions = metaOf(snapshot.tables.store_meta?.rows ?? []) === metaOf(currentMeta);
  opts.driver.transaction(() => {
    for (const [name, { columns, rows }] of Object.entries(snapshot.tables)) {
      if (!names.has(name)) continue;
      opts.driver.exec(`DELETE FROM ${name}`);
      const insert = opts.driver.prepare(
        `INSERT INTO ${name} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      for (const row of rows) insert.run(...row);
    }
  });
  // Different definitions: open() sees the snapshot's fingerprints and rebuilds from the log.
  const store = Store.open(opts);
  if (sameDefinitions && viewHash(store).hash !== snapshot.viewHash) {
    throw new Error("the imported view does not match the snapshot hash");
  }
  return store;
}
