// The store: one vault's decrypted log copy and its materialized view in one SQLite database.
//
// apply(batch), in one transaction:
//   1. decode (zod, upcast) and insert new events into `event_log` (idempotent by eid; an eid seen
//      again with another body is reported as a conflict and the first one kept);
//   2. causal suppression and FWW losers (events.md 6.6) -> state flips;
//   3. identity resolution when identity events are involved (events.md 6.4);
//   4. every materializer folds its share: fast path, partition re-fold or full re-fold;
//   5. after commit: subscribers whose tables were touched are notified.
// The view is a pure function of the held event set (events.md 6.7); `rebuild()` recomputes it.
import type {
  ApplyOutcome,
  EventSink,
  InboundBatch,
  SegmentCursor,
  WireEvent as SyncWireEvent,
} from "@cashu/sync";
import { canonicalJson, jsonEqual } from "./canonical.js";
import { StatementCache, TouchedTables, ViewIds, viewSql } from "./engine/context.js";
import { type FoldDeps, MaterializerRunner } from "./engine/fold.js";
import { conflictsKey, IdentityService } from "./engine/identity.js";
import { EventLog, type LogRow, storedBody } from "./engine/log.js";
import { type StateFlip, updateSuppression } from "./engine/suppression.js";
import type { FoldEvent } from "./engine/types.js";
import { type Decoded, decodeEnvelope, envelopeExtra } from "./envelope.js";
import { detPartsOf } from "./events/v1/det-parts.js";
import { fromWire } from "./events/v1/envelope.js";
import { detGidFor, type VaultSalt } from "./gid.js";
import { rebuildView } from "./rebuild.js";
import { EventRegistry, ModuleRegistry, type StoreModule } from "./registry.js";
import { createTableSql, type TableDef } from "./sql/ddl.js";
import type { SqlDriver, SqlValue } from "./sql/driver.js";
import { SYSTEM_SCHEMA_VERSION, SYSTEM_TABLES } from "./sql/system.js";
import { ChangeHub, type TablesListener } from "./subscribe.js";

export interface StoreOptions {
  readonly driver: SqlDriver;
  /** The vault gid (= profile gid, a ULID). Every event must carry it. */
  readonly vault: string;
  /** The vault's gid salt (gid.md 3), from the device keyring. */
  readonly salt: VaultSalt;
  readonly modules: readonly StoreModule[];
}

export interface WireBatch {
  readonly device: string;
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly cursor?: SegmentCursor;
}

export interface ApplyResult {
  /** New events folded into the view. */
  readonly applied: number;
  /** Events whose eid was already held (re-delivery): no-op. */
  readonly duplicates: number;
  /** New events stored but not folded (unknown type, newer version, invalid payload). */
  readonly parked: number;
  /** New events held but not in effect (their cause is missing, suppressed, or an FWW loss). */
  readonly suppressed: number;
  /** Not valid envelopes (kept in `event_rejects`, never folded). */
  readonly rejected: readonly { readonly eid?: string; readonly error: string }[];
  /** eids already held with a different body: the first stays, the new one is dropped. */
  readonly conflicts: readonly string[];
  /** Public view tables written by this apply (the useQuery invalidation set). */
  readonly touchedTables: ReadonlySet<string>;
  /** This apply parked events: the reader is behind a writer (events.md 7). */
  readonly needsUpgrade: boolean;
}

const META_VAULT = "vault";
/** Park reason of an event whose deterministic gid does not match its payload (gid.md 4). */
const INVALID_GID = "invalid-gid";
const META_SYSTEM = "system_schema";
const META_EVENTS = "events_fingerprint";
const META_VIEW = "view_fingerprint";

export class Store {
  readonly vault: string;
  readonly driver: SqlDriver;
  readonly events: EventRegistry;
  readonly modules: ModuleRegistry;
  readonly #stmts: StatementCache;
  readonly #log: EventLog;
  readonly #ids: ViewIds;
  readonly #identity: IdentityService;
  readonly #runners: readonly MaterializerRunner[];
  readonly #runnerByType = new Map<string, MaterializerRunner[]>();
  readonly #fww: ReadonlySet<string>;
  readonly #internal: ReadonlySet<string>;
  readonly #publicTables: readonly TableDef[];
  readonly #hub = new ChangeHub();
  readonly deps: FoldDeps;

  private constructor(opts: StoreOptions, events: EventRegistry, modules: ModuleRegistry) {
    this.vault = opts.vault;
    this.driver = opts.driver;
    this.events = events;
    this.modules = modules;
    this.#fww = events.fwwTypes();
    this.#stmts = new StatementCache(opts.driver);
    this.#log = new EventLog(opts.driver);
    this.#ids = new ViewIds(this.#stmts);
    this.#identity = new IdentityService(opts.driver, modules.identityKinds);
    this.deps = {
      vault: opts.vault,
      log: this.#log,
      stmts: this.#stmts,
      ids: this.#ids,
      identity: this.#identity,
      det: detGidFor(opts.salt),
    };
    this.#runners = modules.materializers.map((m) => new MaterializerRunner(m, this.deps));
    for (const r of this.#runners) {
      for (const t of r.mat.handles) {
        const list = this.#runnerByType.get(t) ?? [];
        list.push(r);
        this.#runnerByType.set(t, list);
      }
    }
    const all = this.viewTables();
    this.#internal = new Set(
      [...SYSTEM_TABLES, ...all].filter((t) => t.internal).map((t) => t.name),
    );
    this.#publicTables = all.filter((t) => !t.internal);
  }

  /**
   * Open (or create) the store of one vault on `driver`. A changed event registry or view definition
   * (an app upgrade) rebuilds the view from the log before the store is returned (events.md 7.9).
   */
  static open(opts: StoreOptions): Store {
    const events = EventRegistry.v1();
    for (const m of opts.modules) for (const d of m.events ?? []) events.define(d);
    const modules = new ModuleRegistry(opts.modules);
    const db = opts.driver;
    const hasMeta =
      db
        .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'store_meta'")
        .get() !== undefined;
    const meta = (key: string) =>
      db.prepare("SELECT value FROM store_meta WHERE key = ?").get<{ value: string }>(key)?.value;
    const setMeta = (key: string, value: string) =>
      db
        .prepare(
          "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run(key, value);
    // The system schema is created once (a new database); a changed one bumps its version.
    const system = hasMeta ? meta(META_SYSTEM) : undefined;
    if (system === undefined) db.exec(SYSTEM_TABLES.map(createTableSql).join("\n"));
    else if (Number(system) !== SYSTEM_SCHEMA_VERSION) {
      throw new Error(`unsupported store schema ${system}`);
    }
    const vault = meta(META_VAULT);
    if (vault !== undefined && vault !== opts.vault) {
      throw new Error("this database belongs to another vault");
    }
    if (vault === undefined) setMeta(META_VAULT, opts.vault);
    if (system === undefined) setMeta(META_SYSTEM, String(SYSTEM_SCHEMA_VERSION));

    const viewFp = modules.fingerprint();
    const eventsFp = events.fingerprint();
    const viewChanged = meta(META_VIEW) !== viewFp;
    const eventsChanged = meta(META_EVENTS) !== eventsFp;
    if (viewChanged) {
      // View tables are derived: an upgraded definition drops and recreates them. The view
      // fingerprint covers their exact DDL, so an unchanged one means they exist as defined.
      const allTables = modules.viewTables();
      const known = meta("view_tables");
      for (const name of known ? (JSON.parse(known) as string[]) : []) {
        db.exec(`DROP TABLE IF EXISTS ${name}`);
      }
      db.exec(allTables.map(createTableSql).join("\n"));
      setMeta("view_tables", JSON.stringify(allTables.map((t) => t.name)));
    }

    const store = new Store(opts, events, modules);
    if (viewChanged || eventsChanged) {
      // An empty log has an empty view (a new vault, a reset store): nothing to recompute.
      const held = db.prepare("SELECT 1 AS held FROM event_log LIMIT 1").get();
      if (held !== undefined) store.rebuild({ redecode: eventsChanged, reindex: true });
      setMeta(META_VIEW, viewFp);
      setMeta(META_EVENTS, eventsFp);
    }
    return store;
  }

  /** Every view table of the registered modules (public and internal). */
  viewTables(): readonly TableDef[] {
    return this.modules.viewTables();
  }

  /** Public tables (queryable, hashed, reported as touched). */
  publicTables(): readonly TableDef[] {
    return this.#publicTables;
  }

  // ------------------------------------------------------------------------------------------- //
  // Apply

  /** Apply one wire-form batch read from a device's segments (S28a `InboundBatch`). */
  applyWire(batch: WireBatch): ApplyResult {
    const raws = batch.events.map((w) => fromWire(w, { vault: this.vault, device: batch.device }));
    return this.#apply(raws, batch.device, batch.cursor);
  }

  /** Apply logical-form envelopes (genesis, tests, the in-process writer). */
  applyEnvelopes(envelopes: readonly unknown[]): ApplyResult {
    return this.#apply(envelopes, null, undefined);
  }

  #apply(raws: readonly unknown[], device: string | null, cursor?: SegmentCursor): ApplyResult {
    const touched = new TouchedTables(this.#internal);
    let result: Omit<ApplyResult, "touchedTables"> | undefined;
    this.driver.transaction(() => {
      result = this.#applyInTransaction(raws, device, touched);
      if (device !== null && cursor) {
        this.#stmts
          .get(
            `INSERT INTO sync_cursors (device, seg, offset) VALUES (?, ?, ?)
             ON CONFLICT (device) DO UPDATE SET seg = excluded.seg, offset = excluded.offset`,
          )
          .run(device, cursor.seg, cursor.offset);
      }
    });
    const out = { ...(result as Omit<ApplyResult, "touchedTables">), touchedTables: touched.set };
    this.#hub.notify(touched.set);
    return out;
  }

  #applyInTransaction(
    raws: readonly unknown[],
    device: string | null,
    touched: TouchedTables,
  ): Omit<ApplyResult, "touchedTables"> {
    const rejected: { eid?: string; error: string }[] = [];
    const conflicts: string[] = [];
    const fresh: FoldEvent[] = [];
    let duplicates = 0;
    let parked = 0;
    let upgrade = false;

    // 1. Decode; reject what is not a valid envelope of this vault.
    const candidates: { decoded: Exclude<Decoded, { status: "rejected" }>; original: unknown }[] =
      [];
    for (const raw of raws) {
      const decoded = decodeEnvelope(raw, this.events);
      if (decoded.status === "rejected") {
        const eid = (raw as { eid?: unknown } | null)?.eid;
        rejected.push({ ...(typeof eid === "string" ? { eid } : {}), error: decoded.error });
        this.#stmts
          .get("INSERT INTO event_rejects (device, error, raw) VALUES (?, ?, ?)")
          .run(device, decoded.error, safeJson(raw));
        continue;
      }
      if (decoded.envelope.vault !== this.vault) {
        rejected.push({ eid: decoded.envelope.eid, error: "event of another vault" });
        continue;
      }
      candidates.push({ decoded, original: (raw as { data: unknown }).data });
    }

    // 2. Split held from new (one query per chunk); a held eid or a repeat within the batch is a
    //    duplicate when its body is the same, else a conflict (the first stays).
    const held = this.#log.held(candidates.map((c) => c.decoded.envelope.eid));
    const body = (c: (typeof candidates)[number]) =>
      canonicalJson({ ...c.decoded.envelope, data: c.original });
    const accepted = new Map<string, (typeof candidates)[number]>(); // new eids of this batch
    const rows: Omit<LogRow, "seq">[] = [];
    const kept: { c: (typeof candidates)[number]; row: Omit<LogRow, "seq"> }[] = [];
    for (const c of candidates) {
      const eid = c.decoded.envelope.eid;
      const first = accepted.get(eid);
      if (held.has(eid) || first !== undefined) {
        const prior =
          first !== undefined ? body(first) : storedBody(this.#log.get(eid) as LogRow, this.vault);
        if (prior === body(c)) duplicates += 1;
        else conflicts.push(eid);
        continue;
      }
      accepted.set(eid, c);
      const row = this.#logRow(c.decoded, c.original);
      rows.push(row);
      kept.push({ c, row });
    }

    // 3. Store the new events (multi-row inserts), count the parked ones, fold the rest.
    this.#log.insertMany(rows);
    const refs: [string, string][] = [];
    for (const { c, row } of kept) {
      if (row.state === "parked") {
        parked += 1;
        if (row.reason !== INVALID_GID) upgrade = true;
        this.#countUnknown(row.type, row.v, row.reason ?? "", touched);
        continue;
      }
      const e: { -readonly [K in keyof FoldEvent]: FoldEvent[K] } = {
        eid: row.eid,
        hlc: row.hlc,
        at: row.at,
        type: row.type,
        v: row.v,
        gid: row.gid,
        device: row.device,
        data: (c.decoded as { data: Record<string, unknown> }).data,
      };
      if (row.cause !== null) e.cause = row.cause;
      if (row.origin !== null) e.origin = row.origin;
      for (const r of this.#runnerByType.get(e.type) ?? []) {
        for (const subject of r.mat.refs?.(e, this.deps.det) ?? []) refs.push([subject, e.eid]);
      }
      fresh.push(e);
    }
    this.#log.addRefs(refs);

    const flips = fresh.length > 0 ? updateSuppression(this.#log, fresh, this.#fww) : [];
    const applied = flips.filter((f) => f.from === "new" && f.to === "applied").length;
    const suppressed = flips.filter((f) => f.from === "new" && f.to === "suppressed").length;
    this.#fold(flips, touched);
    return {
      applied,
      duplicates,
      parked,
      suppressed,
      rejected,
      conflicts,
      needsUpgrade: upgrade,
    };
  }

  #logRow(
    decoded: Exclude<Decoded, { status: "rejected" }>,
    original: unknown,
  ): Omit<LogRow, "seq"> {
    const env = decoded.envelope;
    const base = {
      eid: env.eid,
      hlc: env.hlc,
      at: env.at,
      type: env.type,
      v: env.v,
      gid: env.gid,
      device: env.device,
      cause: env.cause ?? null,
      origin: env.origin ?? null,
      extra: envelopeExtra(env),
    };
    if (decoded.status === "parked") {
      return {
        ...base,
        state: "parked",
        reason: decoded.reason,
        raw_data: JSON.stringify(original),
        data: null,
      };
    }
    if (!this.#gidMatches(base.type, base.gid, decoded.data)) {
      // A deterministic gid that does not match its payload (a writer bug): kept, never folded, so
      // one gid can never stand for two row keys. Not an upgrade signal.
      const raw = JSON.stringify(original);
      return { ...base, state: "parked", reason: INVALID_GID, raw_data: raw, data: null };
    }
    return {
      ...base,
      state: "applied",
      reason: null,
      // the original payload is kept only when the reader's view of it differs (upcast, stripped)
      raw_data: jsonEqual(original, decoded.data) ? null : JSON.stringify(original),
      data: JSON.stringify(decoded.data),
    };
  }

  /** events.md 7.10: a payload-derived DET gid must equal `DET(table)[parts]` of its payload. */
  #gidMatches(type: string, gid: string, data: Record<string, unknown>): boolean {
    const p = detPartsOf(type, data);
    return p === undefined || this.deps.det(p.table, p.parts) === gid;
  }

  #countUnknown(type: string, v: number, reason: string, touched: TouchedTables): void {
    this.#stmts
      .get(
        `INSERT INTO unknown_events (type, v, reason, count) VALUES (?, ?, ?, 1)
         ON CONFLICT (type, v, reason) DO UPDATE SET count = count + 1`,
      )
      .run(type, v, reason);
    touched.add("unknown_events");
  }

  /** Steps 3 and 4: identity, then every materializer's share of the flips. */
  #fold(flips: readonly StateFlip[], touched: TouchedTables): void {
    if (flips.length === 0) return;
    const identityInvolved = flips.some(
      (f) =>
        this.#identity.isIdentityType(f.event.type) &&
        (f.from === "new" ? f.to === "applied" : true),
    );
    const change = identityInvolved
      ? this.#identity.recompute(this.#log, viewSql(this.#stmts, touched))
      : undefined;
    for (const t of change?.tables ?? []) touched.add(t);

    const sql = viewSql(this.#stmts, touched);
    const byRunner = new Map<MaterializerRunner, StateFlip[]>();
    for (const f of flips) {
      if (f.from === "new" && f.to !== "applied") continue; // never folded, nothing to undo
      for (const r of this.#runnerByType.get(f.event.type) ?? []) {
        const list = byRunner.get(r) ?? [];
        list.push(f);
        byRunner.set(r, list);
      }
    }
    for (const r of this.#runners) {
      const full =
        change !== undefined &&
        ((r.mat.identity ?? []).some((k) => change.roots.has(k)) ||
          (r.mat.accepted ?? []).some((k) => change.accepted.has(k)));
      if (full) {
        r.refoldAll(sql);
        continue;
      }
      const mine = byRunner.get(r);
      if (!mine) continue;
      const events = mine.map((f) => f.event);
      if (mine.every((f) => f.from === "new") && r.canAppend(events)) r.append(events, sql);
      else r.refoldPartitions(events, sql);
    }
  }

  // ------------------------------------------------------------------------------------------- //
  // Rebuild (events.md 7.9): recompute the view from the held log.

  /**
   * Recompute the view from the held log. `redecode` re-validates every stored event (the event
   * registry changed); `reindex` recomputes the event refs (a materializer changed). Opening a store
   * after an upgrade does both.
   */
  rebuild(options: { redecode?: boolean; reindex?: boolean } = {}): {
    readonly touchedTables: ReadonlySet<string>;
  } {
    const touched = new TouchedTables(this.#internal);
    this.driver.transaction(() => {
      rebuildView(
        {
          driver: this.driver,
          vault: this.vault,
          log: this.#log,
          events: this.events,
          identity: this.#identity,
          runners: this.#runners,
          fww: this.#fww,
          det: this.deps.det,
          sql: viewSql(this.#stmts, touched),
          logRow: (decoded, original) => this.#logRow(decoded, original),
        },
        options,
      );
    });
    this.#hub.notify(touched.set);
    return { touchedTables: touched.set };
  }

  // ------------------------------------------------------------------------------------------- //
  // Reading and subscriptions

  /** Run a read-only query on the view. */
  read<R>(sql: string, ...params: SqlValue[]): R[] {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error("read() accepts SELECT / WITH only");
    return this.#stmts.get(sql).all<R>(...params);
  }

  /**
   * The public view tables a query reads (for useQuery invalidation): identifiers of the SQL that
   * name a registered public table. Table names are a closed set, so this is exact for every query
   * written against the view.
   */
  tablesRead(sql: string): ReadonlySet<string> {
    const names = new Set([...this.#publicTables.map((t) => t.name), "unknown_events"]);
    const out = new Set<string>();
    for (const word of sql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []) {
      if (names.has(word)) out.add(word);
    }
    return out;
  }

  /** Listen for applies that touched any of `tables`. Returns the unsubscribe function. */
  subscribe(tables: Iterable<string>, listener: TablesListener): () => void {
    return this.#hub.subscribe(tables, listener);
  }

  /** A value that changes whenever one of `tables` was touched (useSyncExternalStore snapshots). */
  version(tables: Iterable<string>): number {
    return this.#hub.version(tables);
  }

  /** Whether the log holds events this reader cannot fold yet. */
  needsUpgrade(): boolean {
    return (
      (this.driver
        .prepare("SELECT COUNT(*) AS n FROM unknown_events WHERE reason != ?")
        .get<{ n: number }>(INVALID_GID)?.n ?? 0) > 0
    );
  }

  /** Known event types no registered materializer folds (shrinks to empty as S24 / S25 land). */
  unfoldedTypes(): readonly string[] {
    const handled = this.modules.handledTypes();
    const identity = new Set(this.modules.identityKinds.flatMap((k) => k.handles));
    return this.events.types().filter((t) => !handled.has(t) && !identity.has(t));
  }

  // ------------------------------------------------------------------------------------------- //
  // Carrier side (S28a EventSink)

  cursors(): ReadonlyMap<string, SegmentCursor> {
    return new Map(
      this.driver
        .prepare("SELECT device, seg, offset FROM sync_cursors")
        .all<{ device: string; seg: number; offset: number }>()
        .map((r) => [r.device, { seg: r.seg, offset: r.offset }]),
    );
  }

  /** Drop the view, the log copy and the cursors (the carrier then replays its whole log). */
  reset(): void {
    const touched = new TouchedTables(this.#internal);
    this.driver.transaction(() => {
      for (const t of this.viewTables()) {
        viewSql(this.#stmts, touched).write(t.name, `DELETE FROM ${t.name}`);
      }
      this.driver.exec(
        "DELETE FROM event_log; DELETE FROM event_refs; DELETE FROM event_rejects; DELETE FROM unknown_events; DELETE FROM materializer_state; DELETE FROM identity_roots; DELETE FROM identity_accepted; DELETE FROM view_ids; DELETE FROM sync_cursors;",
      );
      this.driver.prepare("DELETE FROM store_meta WHERE key LIKE ?").run(conflictsKey("%"));
      touched.add("unknown_events");
    });
    this.#ids.reset();
    this.#identity.load();
    this.#hub.notify(touched.set);
  }

  /** This store as the sync engine's `EventSink`. */
  sink(): EventSink {
    return {
      cursors: () => this.cursors(),
      apply: (batch: InboundBatch): ApplyOutcome => {
        const r = this.applyWire({
          device: batch.device,
          events: batch.events as readonly SyncWireEvent[],
          cursor: batch.cursor,
        });
        return { applied: r.applied, duplicates: r.duplicates, parked: r.parked };
      },
      reset: () => this.reset(),
    };
  }

  close(): void {
    this.driver.close();
  }
}

function safeJson(raw: unknown): string {
  try {
    return JSON.stringify(raw) ?? "null";
  } catch {
    return '"<unserializable>"';
  }
}
