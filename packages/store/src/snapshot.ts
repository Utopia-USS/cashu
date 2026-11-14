// View hashes and store snapshots.
//
// - `viewHash`: a deterministic content hash of the public view (ids excluded, references hashed as
//   the referenced row's gid, JSON canonical). Two stores holding the same event set have the same
//   hash, whatever the delivery order (events.md 6.7); parity checks (S24-S26, S48) compare it.
// - `exportSnapshot` / `importSnapshot`: the whole store (log copy, view, fold indexes) as a portable
//   value, to start a device without replaying (and decrypting) the log. Virtual tables (FTS5
//   indexes) and the deriver tables marked `snapshot: false` (an index's memory) are left out and
//   derived again on import, by their derivers' `deriveAll`. The snapshot is PLAINTEXT:
//   it must only leave the device through the carrier's encryption (S32 builds compaction on it).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalJson } from "./canonical.js";
import { Store, type StoreOptions } from "./materialize.js";
import { componentKey, type ViewDefs } from "./registry.js";
import { allColumns, inSnapshot, type TableDef } from "./sql/ddl.js";
import type { SqlValue } from "./sql/driver.js";
import { SYSTEM_TABLES } from "./sql/system.js";

export interface ViewHash {
  readonly hash: string;
  readonly tables: Readonly<Record<string, { readonly rows: number; readonly hash: string }>>;
}

const hex = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));

export function viewHash(store: Store): ViewHash {
  const gidById = new Map(
    store
      .read<{ id: number; gid: string }>("SELECT id, gid FROM view_ids")
      .map((r) => [r.id, r.gid]),
  );
  const tables: Record<string, { rows: number; hash: string }> = {};
  // A virtual table is internal (never public); the filter states it: its columns read as NULL.
  const defs = [...store.publicTables()]
    .filter((t) => t.virtual === undefined)
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const t of defs) {
    const cols = allColumns(t).filter((c) => !(t.primaryKey === undefined && c.name === "id"));
    const rows = store
      .read<Record<string, SqlValue>>(`SELECT ${cols.map((c) => c.name).join(", ")} FROM ${t.name}`)
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

/** The `store_meta` keys that record the view definitions (materialize.ts). */
const VIEW_META: ReadonlySet<string> = new Set(["view_fingerprint", "view_defs", "view_tables"]);

/** The `ViewDefs` keys of every companion deriver of `opts.modules` (registered or not). */
function companionKeys(opts: StoreOptions): ReadonlySet<string> {
  return new Set(
    opts.modules.flatMap((m) =>
      (m.derivers ?? [])
        .filter((d) => d.companion === true)
        .map((d) => componentKey("deriver", d.id)),
    ),
  );
}

/**
 * What decides whether a snapshot's view can be taken as is: the event registry's fingerprint and the
 * recorded view definitions without the companion derivers (their tables are never in a snapshot, so
 * a snapshot of a store with or without them carries the same view). A record without per-component
 * definitions falls back to the whole-view fingerprint.
 */
function definitionsOf(
  meta: { readonly columns: readonly string[]; readonly rows: readonly SqlValue[][] } | undefined,
  companion: ReadonlySet<string>,
): string {
  const k = meta?.columns.indexOf("key") ?? -1;
  const v = meta?.columns.indexOf("value") ?? -1;
  const value = (key: string) => meta?.rows.find((r) => r[k] === key)?.[v] ?? null;
  const defs = value("view_defs");
  if (typeof defs !== "string") {
    return canonicalJson({ events: value("events_fingerprint"), view: value("view_fingerprint") });
  }
  const parsed = JSON.parse(defs) as ViewDefs;
  return canonicalJson({
    events: value("events_fingerprint"),
    defs: Object.fromEntries(Object.entries(parsed).filter(([key]) => !companion.has(key))),
  });
}

export interface StoreSnapshot {
  readonly format: "cashu.store.snapshot/1";
  readonly vault: string;
  readonly viewHash: string;
  readonly tables: Readonly<
    Record<string, { readonly columns: readonly string[]; readonly rows: readonly SqlValue[][] }>
  >;
}

/** The tables a snapshot carries: every table but those its derivers rebuild (`inSnapshot`). */
function storeTables(store: Store): readonly TableDef[] {
  return [...SYSTEM_TABLES, ...store.viewTables()].filter(inSnapshot);
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
  const currentMeta = empty.driver
    .prepare("SELECT key, value FROM store_meta")
    .all<{ key: string; value: string }>()
    .map((r) => [r.key, r.value] as SqlValue[]);
  const sameDefinitions =
    definitionsOf(snapshot.tables.store_meta, companionKeys(opts)) ===
    definitionsOf({ columns: ["key", "value"], rows: currentMeta }, companionKeys(opts));
  opts.driver.transaction(() => {
    for (const [name, { columns, rows }] of Object.entries(snapshot.tables)) {
      if (!names.has(name)) continue;
      // Same definitions but for the companion derivers (a snapshot taken with or without
      // `companionReads`): this store keeps the record of its own, so open() rebuilds nothing.
      const kept =
        name === "store_meta" && sameDefinitions
          ? rows.filter((r) => !VIEW_META.has(String(r[columns.indexOf("key")])))
          : rows;
      if (name === "store_meta" && sameDefinitions) {
        opts.driver
          .prepare(
            `DELETE FROM store_meta WHERE key NOT IN (${[...VIEW_META].map(() => "?").join(", ")})`,
          )
          .run(...VIEW_META);
      } else opts.driver.exec(`DELETE FROM ${name}`);
      const insert = opts.driver.prepare(
        `INSERT INTO ${name} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      for (const row of kept) insert.run(...row);
    }
  });
  // Different definitions: open() sees the snapshot's record and upgrades the view from the log.
  const store = Store.open(opts);
  // The tables left out of the snapshot (FTS, every companion deriver's) are built by their derivers,
  // but for those the upgrade already rebuilt (on a partial one; a whole-view rebuild built them all).
  const upgrade = store.lastRebuild;
  if (upgrade === null) store.rederiveSnapshotOmitted();
  else if (upgrade.scope === "partial") {
    store.rederiveSnapshotOmitted({ except: new Set(upgrade.derivers) });
  }
  if (sameDefinitions && viewHash(store).hash !== snapshot.viewHash) {
    throw new Error("the imported view does not match the snapshot hash");
  }
  return store;
}
