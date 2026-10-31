// Instruments (events.md 6.4, 8.6; S25 spec 4.1).
//
// Identity: `instrument.aliasAdded` claims `namespace:value` for `data.instrument` (a collision folds
// the later claimer into the first holder), `instrument.merged` folds the source's root into the
// target's root.
//
// View: one `inv_instruments` row per identity root that holds at least one applied
// `instrument.created` among its members; the row gid is the root. Field fold (D-S5, lead R-2): the
// root's own first create is the base (else the component's first applied create), `symbol` / `isin`
// / `mic` fill-if-null from the other members' creates in `(hlc, eid)` order, `currency` and
// `asset_class` stay the base's, and `instrument.updated` of any member is LWW-F per field over the
// component. The row is recomputed from per-partition registers on every apply, so the result is a
// function of the set (the base does not depend on which create arrived first).
// Aliases: one `inv_instrument_aliases` row per alias gid (DET(namespace, value)), created by its first
// applied claim; `instrument_id` = the claimer's root (every later claimer joins that root).
import type { FoldContext, IdentityKind, Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { sqlBool, sqlJson } from "../sql/values.js";

export const INSTRUMENTS = "instruments";

export const instrumentIdentity: IdentityKind = {
  id: INSTRUMENTS,
  version: 1,
  handles: ["instrument.aliasAdded", "instrument.merged"],
  claims(e) {
    if (e.type !== "instrument.aliasAdded") return [];
    return [
      {
        gid: String(e.data.instrument),
        key: `${String(e.data.namespace)}:${String(e.data.value)}`,
      },
    ];
  },
  merges(e) {
    if (e.type !== "instrument.merged") return [];
    return [{ source: String(e.data.source), target: String(e.data.target) }];
  },
};

const instruments: TableDef = {
  name: "inv_instruments",
  columns: [
    { name: "name", type: "TEXT", notNull: true },
    { name: "currency", type: "TEXT", notNull: true },
    { name: "asset_class", type: "TEXT", notNull: true },
    { name: "symbol", type: "TEXT" },
    { name: "isin", type: "TEXT" },
    { name: "mic", type: "TEXT" },
    { name: "region", type: "TEXT" },
    { name: "sector", type: "TEXT" },
    { name: "tags", type: "TEXT", notNull: true, json: true },
    { name: "needs_classification", type: "INTEGER", notNull: true },
    { name: "valuation_mode", type: "TEXT", notNull: true },
    { name: "status", type: "TEXT", notNull: true },
    { name: "created_at", type: "TEXT", notNull: true },
    { name: "updated_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["symbol"] }, { columns: ["isin"] }],
};

const aliases: TableDef = {
  name: "inv_instrument_aliases",
  columns: [
    { name: "instrument_id", type: "INTEGER", notNull: true, ref: "inv_instruments" },
    { name: "namespace", type: "TEXT", notNull: true },
    { name: "value", type: "TEXT", notNull: true },
    { name: "guessed", type: "INTEGER", notNull: true },
    { name: "created_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["namespace", "value"], unique: true }, { columns: ["instrument_id"] }],
};

/** The first applied `instrument.created` of each member gid (CREATE once per gid). */
const creates: TableDef = {
  name: "fold_instrument_creates",
  primaryKey: ["gid"],
  internal: true,
  columns: [
    { name: "gid", type: "TEXT", notNull: true },
    { name: "partition", type: "TEXT", notNull: true },
    { name: "ord", type: "TEXT", notNull: true },
    { name: "data", type: "TEXT", notNull: true },
    { name: "created_at", type: "TEXT", notNull: true },
    { name: "at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["partition"] }],
};

/** LWW-F registers of `instrument.updated` over the component: the latest value per field. */
const fields: TableDef = {
  name: "fold_instrument_fields",
  primaryKey: ["partition", "field"],
  internal: true,
  columns: [
    { name: "partition", type: "TEXT", notNull: true },
    { name: "field", type: "TEXT", notNull: true },
    { name: "value", type: "TEXT", notNull: true },
    { name: "ord", type: "TEXT", notNull: true },
    { name: "at", type: "TEXT", notNull: true },
  ],
};

/** Payload field -> view column of the shared instrument fields (events.md 8.6). */
const COLUMNS = {
  name: "name",
  currency: "currency",
  assetClass: "asset_class",
  symbol: "symbol",
  isin: "isin",
  mic: "mic",
  region: "region",
  sector: "sector",
  tags: "tags",
  needsClassification: "needs_classification",
  valuationMode: "valuation_mode",
  status: "status",
} as const;
type Field = keyof typeof COLUMNS;
const FIELDS = Object.keys(COLUMNS) as Field[];
/** Market identity a member's create fills when the base has none (`instrument_merge.py`). */
const FILL_IF_NULL: readonly Field[] = ["symbol", "isin", "mic"];

type Values = Partial<Record<Field, unknown>>;

function pick(data: Readonly<Record<string, unknown>>): Values {
  const out: Values = {};
  for (const f of FIELDS) if (f in data) out[f] = data[f];
  return out;
}

/** Recompute the partition's public row from its registers (no row without a create). */
function project(ctx: FoldContext, root: string): void {
  const made = ctx.sql.all<{
    gid: string;
    ord: string;
    data: string;
    created_at: string;
    at: string;
  }>(
    "SELECT gid, ord, data, created_at, at FROM fold_instrument_creates WHERE partition = ? ORDER BY ord",
    root,
  );
  const base = made.find((c) => c.gid === root) ?? made[0];
  if (base === undefined) return;
  const row = JSON.parse(base.data) as Values;
  for (const c of made) {
    if (c === base) continue;
    const other = JSON.parse(c.data) as Values;
    for (const f of FILL_IF_NULL) {
      if ((row[f] ?? null) === null && (other[f] ?? null) !== null) row[f] = other[f];
    }
  }
  let last = made.reduce((a, c) => (c.ord > a.ord ? c : a), base);
  for (const r of ctx.sql.all<{ field: string; value: string; ord: string; at: string }>(
    "SELECT field, value, ord, at FROM fold_instrument_fields WHERE partition = ?",
    root,
  )) {
    row[r.field as Field] = JSON.parse(r.value) as unknown;
    if (r.ord > last.ord) last = { ...last, ord: r.ord, at: r.at };
  }
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  ctx.sql.write(
    instruments.name,
    `INSERT INTO inv_instruments (id, gid, name, currency, asset_class, symbol, isin, mic, region, sector,
       tags, needs_classification, valuation_mode, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (gid) DO UPDATE SET name = excluded.name, currency = excluded.currency,
       asset_class = excluded.asset_class, symbol = excluded.symbol, isin = excluded.isin,
       mic = excluded.mic, region = excluded.region, sector = excluded.sector, tags = excluded.tags,
       needs_classification = excluded.needs_classification, valuation_mode = excluded.valuation_mode,
       status = excluded.status, created_at = excluded.created_at, updated_at = excluded.updated_at`,
    ctx.id(root),
    root,
    text(row.name) ?? "",
    text(row.currency) ?? "",
    text(row.assetClass) ?? "",
    text(row.symbol),
    text(row.isin),
    text(row.mic),
    text(row.region),
    text(row.sector),
    sqlJson(row.tags ?? []),
    sqlBool(row.needsClassification === true),
    text(row.valuationMode) ?? "",
    text(row.status) ?? "active",
    base.created_at,
    last.at,
  );
}

export const instrumentsMaterializer: Materializer = {
  id: "investments.instruments",
  version: 1,
  tables: [instruments, aliases, creates, fields],
  handles: ["instrument.created", "instrument.updated", "instrument.aliasAdded"],
  identity: [INSTRUMENTS],
  partitions(e, ctx) {
    const subject = e.type === "instrument.aliasAdded" ? String(e.data.instrument) : e.gid;
    return [ctx.resolve(INSTRUMENTS, subject)];
  },
  subjects: (root, ctx) => ctx.identityMembers(INSTRUMENTS, root),
  clear(roots, ctx) {
    for (const r of roots) {
      ctx.sql.write(instruments.name, "DELETE FROM inv_instruments WHERE gid = ?", r);
      ctx.sql.write(
        aliases.name,
        "DELETE FROM inv_instrument_aliases WHERE instrument_id = ?",
        ctx.id(r),
      );
      ctx.sql.write(creates.name, "DELETE FROM fold_instrument_creates WHERE partition = ?", r);
      ctx.sql.write(fields.name, "DELETE FROM fold_instrument_fields WHERE partition = ?", r);
    }
  },
  apply(e, ctx) {
    const d = e.data;
    const ord = e.hlc + e.eid;
    if (e.type === "instrument.aliasAdded") {
      const root = ctx.resolve(INSTRUMENTS, String(d.instrument));
      ctx.members.add(root, e.gid);
      ctx.sql.write(
        aliases.name,
        `INSERT OR IGNORE INTO inv_instrument_aliases (id, gid, instrument_id, namespace, value, guessed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ctx.id(e.gid),
        e.gid,
        ctx.id(root),
        String(d.namespace),
        String(d.value),
        sqlBool(d.guessed === true),
        ctx.time(e, "created_at"),
      );
      return;
    }
    const root = ctx.resolve(INSTRUMENTS, e.gid);
    ctx.members.add(root, e.gid);
    if (e.type === "instrument.created") {
      ctx.sql.write(
        creates.name,
        `INSERT OR IGNORE INTO fold_instrument_creates (gid, partition, ord, data, created_at, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        e.gid,
        root,
        ord,
        sqlJson(pick(d)),
        ctx.time(e, "created_at"),
        ctx.time(e, "updated_at"),
      );
    } else {
      const at = ctx.time(e, "updated_at");
      for (const [f, v] of Object.entries(pick(d))) {
        ctx.sql.write(
          fields.name,
          `INSERT INTO fold_instrument_fields (partition, field, value, ord, at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (partition, field) DO UPDATE SET value = excluded.value, ord = excluded.ord,
             at = excluded.at`,
          root,
          f,
          sqlJson(v ?? null),
          ord,
          at,
        );
      }
    }
    project(ctx, root);
  },
};
