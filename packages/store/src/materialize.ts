// The store: one vault's decrypted log copy and its materialized view in one SQLite database.
//
// applyWireBatches(batches), in one transaction (each batch in order, its cursor with it):
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
import { assertHmacConformance, type HmacSha256 } from "./crypto/hmac.js";
import { encodePayload } from "./engine/compact.js";
import { StatementCache, TouchedTables, ViewIds, viewSql } from "./engine/context.js";
import {
  type DeriveDeps,
  DirtyCollector,
  deriveContext,
  deriveEverything,
  markContributions,
  runDerivers,
} from "./engine/derive.js";
import { type FoldDeps, LazyRefs, MaterializerRunner } from "./engine/fold.js";
import { conflictsKey, IdentityService } from "./engine/identity.js";
import { deviceOf, EventLog, type LogRow, storedBody } from "./engine/log.js";
import { type StateFlip, type SuppressionRules, updateSuppression } from "./engine/suppression.js";
import type { Deriver, FoldEvent, ViewSql } from "./engine/types.js";
import { type Decoded, decodeEnvelope, envelopeExtra } from "./envelope.js";
import { detPartsOf } from "./events/v1/det-parts.js";
import { fromWire } from "./events/v1/envelope.js";
import { detGidFor, type VaultSalt } from "./gid.js";
import {
  planViewUpgrade,
  type RebuildContext,
  type RebuildListener,
  type RebuildReason,
  type RebuildReport,
  rebuildPartial,
  rebuildView,
  type ViewUpgradePlan,
} from "./rebuild.js";
import {
  type ComponentDef,
  componentKey,
  EventRegistry,
  ModuleRegistry,
  type StoreModule,
  type ViewDefs,
} from "./registry.js";
import { clearTableSql, createTableSql, inSnapshot, type TableDef } from "./sql/ddl.js";
import type { SqlDriver, SqlValue } from "./sql/driver.js";
import { SYSTEM_SCHEMA_VERSION, SYSTEM_TABLES } from "./sql/system.js";
import { isSyncStatement } from "./statements.js";
import { ChangeHub, type TablesListener } from "./subscribe.js";

export interface StoreOptions {
  readonly driver: SqlDriver;
  /** The vault gid (= profile gid, a ULID). Every event must carry it. */
  readonly vault: string;
  /** The vault's gid salt (gid.md 3), from the device keyring. */
  readonly salt: VaultSalt;
  readonly modules: readonly StoreModule[];
  /**
   * Progress of a rebuild (the one `open` runs after an app update, and `rebuild()`), for the UI.
   * Called synchronously inside the rebuild transaction; `done` after the commit.
   */
  readonly onRebuild?: RebuildListener;
  /**
   * HMAC-SHA256 for DET gids (default @noble/hashes). A native implementation injected by the app
   * is checked against RFC 4231 at open and refused when it differs (crypto/hmac.ts).
   */
  readonly hmac?: HmacSha256;
  /**
   * Register the companion derivers (`Deriver.companion`: the month aggregates, recurring payments and
   * the search index) whose tables only the phone's companion queries read. Default off: the desktop
   * host, MCP and the CLI open without them and pay nothing for them. The public view (and its hash)
   * is the same either way; a database opened with the other setting before gains or drops their
   * tables on open (a partial upgrade, never a whole-view rebuild).
   */
  readonly companionReads?: boolean;
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
  /** Sync statements (`device.*`, `lease.*`) skipped: the device layer reads them from the log. */
  readonly statements: number;
}

const META_VAULT = "vault";
/** Park reason of an event whose deterministic gid does not match its payload (gid.md 4). */
const INVALID_GID = "invalid-gid";
const META_SYSTEM = "system_schema";
/** Set while a store is open on the database; a database opened with it still set was not closed. */
const META_SESSION = "open_session";

/**
 * A companion query (month aggregates, recurring payments, search) ran on a store opened without
 * `StoreOptions.companionReads`: its tables are not derived there, so it can only fail, never read
 * stale or empty tables as if they were the data.
 */
export class CompanionReadsOffError extends Error {
  constructor(table: string) {
    super(`${table} is a companion table: open the store with companionReads to read it`);
    this.name = "CompanionReadsOffError";
  }
}

/**
 * The view database is damaged (a torn write after a power loss on storage that ignores flushes, a
 * file copied while it was written). The view is derived: discard the database and open a new one;
 * the carrier replays the encrypted log into it (`Store.openOrRecover`).
 */
export class StoreCorruptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreCorruptError";
  }
}

/** Whether `e` reports a damaged database (SQLite CORRUPT / NOTADB, from any driver). */
export function isCorruption(e: unknown): boolean {
  if (e instanceof StoreCorruptError) return true;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^SQLITE_(CORRUPT|NOTADB)/.test(code)) return true;
  const message = e instanceof Error ? e.message : String(e);
  return /database disk image is malformed|file is not a database/i.test(message);
}
const META_EVENTS = "events_fingerprint";
const META_VIEW = "view_fingerprint";
/** Every view table the database holds (dropped by name when the view is rebuilt). */
const META_VIEW_TABLES = "view_tables";
/** Per view component: version, DDL fingerprint, tables (`ModuleRegistry.viewDefs`). */
const META_VIEW_DEFS = "view_defs";

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
  readonly #suppression: SuppressionRules;
  readonly #internal: ReadonlySet<string>;
  readonly #publicTables: readonly TableDef[];
  /** `tablesRead`: the tables a SQL identifier stands for (a public table, or an internal one's `wakesWith`). */
  readonly #reads: ReadonlyMap<string, readonly string[]>;
  readonly #hub = new ChangeHub();
  readonly deps: FoldDeps;
  readonly #deriveDeps: DeriveDeps;
  readonly #onRebuild: RebuildListener | undefined;
  /** Tables of the companion derivers this store does not run (`CompanionReadsOffError`). */
  readonly #companionOff: ReadonlySet<string>;
  #lastRebuild: RebuildReport | null = null;

  private constructor(opts: StoreOptions, events: EventRegistry, modules: ModuleRegistry) {
    this.vault = opts.vault;
    this.driver = opts.driver;
    this.events = events;
    this.modules = modules;
    this.#suppression = events.suppressionRules();
    this.#onRebuild = opts.onRebuild;
    this.#companionOff = new Set(
      inactiveCompanions(opts).flatMap((d) => (d.tables ?? []).map((t) => t.name)),
    );
    this.#stmts = new StatementCache(opts.driver);
    this.#log = new EventLog(opts.driver);
    this.#ids = new ViewIds(this.#stmts);
    this.#identity = new IdentityService(opts.driver, modules.identityKinds);
    const det = detGidFor(opts.salt, opts.hmac);
    this.deps = {
      vault: opts.vault,
      log: this.#log,
      lazyRefs: new LazyRefs(this.#log, this.#stmts, det, modules.materializers),
      stmts: this.#stmts,
      ids: this.#ids,
      identity: this.#identity,
      det,
    };
    this.#runners = modules.materializers.map((m) => new MaterializerRunner(m, this.deps));
    const inputs = new Set(modules.derivers.flatMap((d) => d.inputs));
    for (const r of this.#runners) r.track = inputs.has(r.mat.id);
    this.#deriveDeps = {
      det,
      ids: this.#ids,
      identity: this.#identity,
      contributions: modules.contributions,
      companionReads: opts.companionReads === true,
    };
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
    this.#reads = readsOf(this.#publicTables, all);
  }

  /**
   * Open (or create) the store of one vault on `driver`. A changed event registry or view definition
   * (an app upgrade) rebuilds the view from the log before the store is returned (events.md 7.9).
   */
  static open(opts: StoreOptions): Store {
    try {
      return Store.#open(opts);
    } catch (e) {
      if (isCorruption(e) && !(e instanceof StoreCorruptError)) {
        throw new StoreCorruptError("the view database is damaged", { cause: e });
      }
      throw e;
    }
  }

  /**
   * Open the vault's store, or, when its database is damaged, discard it and open a new empty one
   * (no cursors: the carrier replays the whole encrypted log into it). `connect` opens the database
   * file, `discard` deletes it (and its WAL files) after the store closed the connection.
   */
  static openOrRecover(
    opts: Omit<StoreOptions, "driver"> & { connect(): SqlDriver; discard(): void },
  ): { readonly store: Store; readonly recovered: boolean } {
    const driver = opts.connect();
    try {
      return { store: Store.open({ ...opts, driver }), recovered: false };
    } catch (e) {
      if (!isCorruption(e)) throw e;
      driver.close();
      opts.discard();
      return { store: Store.open({ ...opts, driver: opts.connect() }), recovered: true };
    }
  }

  static #open(opts: StoreOptions): Store {
    if (opts.hmac !== undefined) assertHmacConformance(opts.hmac);
    const events = EventRegistry.v1();
    for (const m of opts.modules) for (const d of m.events ?? []) events.define(d);
    const modules = new ModuleRegistry(registeredModules(opts));
    const db = opts.driver;
    // The view is derived from the encrypted log, which is the durable copy: WAL with synchronous
    // NORMAL (no flush per commit) may lose the last committed applies on a power loss, never tear
    // the database on honest storage; the cursors roll back with them, so the carrier re-delivers
    // what was lost (data-flow.md "Crash model"). An in-memory database ignores both.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
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
    // Not closed last time (a crash, a power loss, a killed app): check the pages before trusting them.
    if (meta(META_SESSION) !== undefined) {
      const check = db.prepare("PRAGMA quick_check(1)").all<Record<string, string>>();
      const verdict = check.length === 1 ? Object.values(check[0] ?? {})[0] : undefined;
      if (verdict !== "ok") throw new StoreCorruptError(`quick_check: ${String(verdict)}`);
    }
    if (vault === undefined) setMeta(META_VAULT, opts.vault);
    if (system === undefined) setMeta(META_SYSTEM, String(SYSTEM_SCHEMA_VERSION));

    const viewFp = modules.fingerprint();
    const eventsFp = events.fingerprint();
    const viewChanged = meta(META_VIEW) !== viewFp;
    const eventsChanged = meta(META_EVENTS) !== eventsFp;
    if (!viewChanged && !eventsChanged) {
      // The common open: nothing to rebuild. A database from before per-component records gets one.
      if (meta(META_VIEW_DEFS) === undefined) {
        setMeta(META_VIEW_DEFS, canonicalJson(modules.viewDefs()));
      }
      const store = new Store(opts, events, modules);
      setMeta(META_SESSION, "1");
      return store;
    }

    // An app update changed definitions (events.md 7.9, M10). DDL, rebuild and the new record commit
    // together: a crash rolls all of it back and the next open starts again from the old record, so
    // a half-rebuilt view is never served (rebuild.ts "Upgrade rule").
    const storedDefs = meta(META_VIEW_DEFS);
    const knownTables = meta(META_VIEW_TABLES);
    // A database last opened with the companion derivers, now opened without them: they wrote only
    // their own tables, so they leave by dropping those (the planner would rebuild the whole view for
    // a removed deriver whose writes it cannot tell apart).
    const stored = withoutInactiveCompanions(
      storedDefs === undefined ? undefined : (JSON.parse(storedDefs) as ViewDefs),
      inactiveCompanions(opts),
    );
    const planned = planViewUpgrade({
      registry: modules,
      stored: stored.defs,
      previousTables: knownTables === undefined ? [] : (JSON.parse(knownTables) as string[]),
      eventsChanged,
      viewChanged,
    });
    const plan: ViewUpgradePlan = {
      ...planned,
      drop: [...new Set([...planned.drop, ...stored.drop])],
    };
    const byName = new Map(modules.viewTables().map((t) => [t.name, t]));
    const opened = db.transaction(() => {
      for (const name of plan.drop) db.exec(`DROP TABLE IF EXISTS ${name}`);
      db.exec(plan.create.map((name) => createTableSql(byName.get(name) as TableDef)).join("\n"));
      const store = new Store(opts, events, modules);
      // An empty log has an empty view (a new vault, a reset store): nothing to recompute.
      const held = db.prepare("SELECT 1 AS held FROM event_log LIMIT 1").get() !== undefined;
      const report = held ? store.#runUpgrade(plan) : null;
      setMeta(META_VIEW_TABLES, JSON.stringify([...byName.keys()]));
      setMeta(META_VIEW_DEFS, canonicalJson(modules.viewDefs()));
      setMeta(META_VIEW, viewFp);
      setMeta(META_EVENTS, eventsFp);
      return { store, report };
    });
    if (opened.report !== null) opened.store.#finishRebuild(opened.report);
    setMeta(META_SESSION, "1");
    return opened.store;
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
    return this.applyWireBatches([batch])[0] as ApplyResult;
  }

  /**
   * Apply wire-form batches in order in ONE transaction (S29c-B3: one per sync pull), each batch's
   * cursor persisted with it. The outcome of each batch is that of a sequential apply; `touchedTables`
   * of every outcome is the union of the whole call. Subscribers are notified once, after commit.
   */
  applyWireBatches(batches: readonly WireBatch[]): readonly ApplyResult[] {
    const touched = new TouchedTables(this.#internal);
    const results: Omit<ApplyResult, "touchedTables">[] = [];
    this.driver.transaction(() => {
      for (const batch of batches) {
        const view = batch.events.filter((w) => !isSyncStatement(w));
        const raws = view.map((w) => fromWire(w, { vault: this.vault, device: batch.device }));
        const result = this.#applyInTransaction(raws, batch.device, touched);
        if (batch.cursor) this.#saveCursor(batch.device, batch.cursor);
        results.push({ ...result, statements: batch.events.length - view.length });
      }
    });
    this.#hub.notify(touched.set);
    return results.map((r) => ({ ...r, touchedTables: touched.set }));
  }

  /** Apply logical-form envelopes (genesis, tests, the in-process writer). */
  applyEnvelopes(envelopes: readonly unknown[]): ApplyResult {
    const touched = new TouchedTables(this.#internal);
    let result: Omit<ApplyResult, "touchedTables" | "statements"> | undefined;
    this.driver.transaction(() => {
      result = this.#applyInTransaction(envelopes, null, touched);
    });
    this.#hub.notify(touched.set);
    return {
      ...(result as Omit<ApplyResult, "touchedTables" | "statements">),
      touchedTables: touched.set,
      statements: 0,
    };
  }

  #saveCursor(device: string, cursor: SegmentCursor): void {
    this.#stmts
      .get(
        `INSERT INTO sync_cursors (device, seg, offset) VALUES (?, ?, ?)
         ON CONFLICT (device) DO UPDATE SET seg = excluded.seg, offset = excluded.offset`,
      )
      .run(device, cursor.seg, cursor.offset);
  }

  #applyInTransaction(
    raws: readonly unknown[],
    device: string | null,
    touched: TouchedTables,
  ): Omit<ApplyResult, "touchedTables" | "statements"> {
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
        device: deviceOf(row.hlc),
        data: (c.decoded as { data: Record<string, unknown> }).data,
      };
      if (row.cause !== null) e.cause = row.cause;
      if (row.origin !== null) e.origin = row.origin;
      for (const r of this.#runnerByType.get(e.type) ?? []) {
        if (r.mat.refsOnDemand === true) continue; // indexed when first asked (LazyRefs)
        for (const subject of r.mat.refs?.(e, this.deps.det) ?? []) refs.push([subject, e.eid]);
      }
      fresh.push(e);
    }
    this.#log.addRefs(refs);

    const flips = fresh.length > 0 ? updateSuppression(this.#log, fresh, this.#suppression) : [];
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
      data: encodePayload(env.type, decoded.data),
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
    const dirty = new DirtyCollector();
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
        r.refoldAll(sql, dirty);
        continue;
      }
      const mine = byRunner.get(r);
      if (!mine) continue;
      const events = mine.map((f) => f.event);
      if (mine.every((f) => f.from === "new") && r.canAppend(events)) r.append(events, sql, dirty);
      else r.refoldPartitions(events, sql, dirty);
    }
    if (this.modules.derivers.length === 0) return;
    markContributions(dirty, touched.set, this.modules.contributions);
    runDerivers(this.modules.derivers, dirty.partitions, deriveContext(this.#deriveDeps, sql));
  }

  /** Every deriver's full derivation, on `sql` (rebuild). */
  #deriveAll(sql: ViewSql): void {
    deriveEverything(this.modules.derivers, deriveContext(this.#deriveDeps, sql));
  }

  /**
   * Run every deriver's `deriveAll` over the current view (one transaction) and return the tables it
   * changed. The derived oracle of the tests (S24 6): after any apply this must change nothing, i.e.
   * the incremental derivation equals the full one.
   */
  rederive(): { readonly touchedTables: ReadonlySet<string> } {
    const touched = new TouchedTables(this.#internal);
    this.driver.transaction(() => this.#deriveAll(viewSql(this.#stmts, touched)));
    this.#hub.notify(touched.set);
    return { touchedTables: touched.set };
  }

  /**
   * Build the tables snapshots leave out (`inSnapshot`: the virtual tables, FTS5 indexes, and the
   * deriver tables marked `snapshot: false`) again from the view: every deriver that owns one runs its
   * `deriveAll` (one transaction), which rebuilds all of its tables: the companion derivers' tables
   * among them (all `snapshot: false`), so a snapshot taken without `companionReads` imports into a
   * store with it. `importSnapshot` calls this after loading the rest, `except` the derivers the open
   * already rebuilt. A table left out that no deriver owns could never be rebuilt: refused.
   */
  rederiveSnapshotOmitted(options: { readonly except?: ReadonlySet<string> } = {}): void {
    const allOwners = this.modules.derivers.filter((d) => d.tables?.some((t) => !inSnapshot(t)));
    // The orphan check runs against every owner: an excepted deriver (already rebuilt by the open)
    // still owns its tables. `except` only limits which owners run their `deriveAll` here.
    const owned = new Set(allOwners.flatMap((d) => (d.tables ?? []).map((t) => t.name)));
    const orphan = this.viewTables().find((t) => !inSnapshot(t) && !owned.has(t.name));
    if (orphan !== undefined) {
      throw new Error(`table ${orphan.name} is left out of snapshots but no deriver owns it`);
    }
    const owners = allOwners.filter((d) => options.except?.has(d.id) !== true);
    if (owners.length === 0) return;
    const touched = new TouchedTables(this.#internal);
    this.driver.transaction(() =>
      deriveEverything(owners, deriveContext(this.#deriveDeps, viewSql(this.#stmts, touched))),
    );
    this.#hub.notify(touched.set);
  }

  // ------------------------------------------------------------------------------------------- //
  // Rebuild (events.md 7.9): recompute the view from the held log.

  /**
   * Recompute the view from the held log. `redecode` re-validates every stored event (the event
   * registry changed); `reindex` recomputes the event refs (a materializer changed). Progress goes
   * to `StoreOptions.onRebuild`; subscribers of the rewritten tables are notified after the commit.
   */
  rebuild(options: { redecode?: boolean; reindex?: boolean } = {}): RebuildReport {
    let report: RebuildReport | undefined;
    this.driver.transaction(() => {
      report = this.#rebuildFull({ ...options, reason: "manual" });
    });
    return this.#finishRebuild(report as RebuildReport);
  }

  /** The last rebuild of this store (the open-time upgrade, or `rebuild()`), null if none ran. */
  get lastRebuild(): RebuildReport | null {
    return this.#lastRebuild;
  }

  #rebuildContext(touched: TouchedTables): RebuildContext {
    return {
      driver: this.driver,
      vault: this.vault,
      log: this.#log,
      events: this.events,
      identity: this.#identity,
      runners: this.#runners,
      suppression: this.#suppression,
      det: this.deps.det,
      lazyRefs: this.deps.lazyRefs,
      sql: viewSql(this.#stmts, touched),
      logRow: (decoded, original) => this.#logRow(decoded, original),
      derivers: this.modules.derivers,
      deriveContext: (sql) => deriveContext(this.#deriveDeps, sql),
      onProgress: this.#onRebuild,
    };
  }

  /** Inside a transaction. */
  #rebuildFull(options: {
    redecode?: boolean;
    reindex?: boolean;
    reason: RebuildReason;
  }): RebuildReport {
    const touched = new TouchedTables(this.#internal);
    const done = rebuildView(this.#rebuildContext(touched), options);
    return { ...done, touchedTables: touched.set };
  }

  /** Inside the open transaction, after the plan's DDL. */
  #runUpgrade(plan: ViewUpgradePlan): RebuildReport {
    if (plan.scope === "full") {
      return this.#rebuildFull({ redecode: plan.redecode, reindex: true, reason: plan.reason });
    }
    const touched = new TouchedTables(this.#internal);
    const done = rebuildPartial(this.#rebuildContext(touched), plan);
    // Recreated tables changed shape or content even where no row was written.
    for (const name of plan.create) touched.add(name);
    return { ...done, touchedTables: touched.set };
  }

  /** After the commit: remember, notify subscribers, report `done`. */
  #finishRebuild(report: RebuildReport): RebuildReport {
    this.#lastRebuild = report;
    this.#hub.notify(report.touchedTables);
    this.#onRebuild?.({ phase: "done", report });
    return report;
  }

  // ------------------------------------------------------------------------------------------- //
  // Log reads (native creation proof, uncertain-write recovery)

  /** The HLC of each of `eids` held in the log (any state); absent eids are missing from the map. */
  eventHlcs(eids: readonly string[]): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    const stmt = this.#stmts.get("SELECT hlc FROM event_log WHERE eid = ?");
    for (const eid of eids) {
      const row = stmt.get<{ hlc: string }>(eid);
      if (row !== undefined) out.set(eid, row.hlc);
    }
    return out;
  }

  /**
   * Logical envelopes (`fromWire` shape, the vault re-attached) of the log rows after `afterSeq` in
   * insertion order whose writing device is not in `exclude`, at most `limit`; `last` is the
   * `(seq, eid)` of the last row scanned (excluded rows included), so a cursor moves past them too.
   */
  foreignEvents(
    afterSeq: number,
    exclude: ReadonlySet<string>,
    limit: number,
  ): {
    readonly events: readonly Readonly<Record<string, unknown>>[];
    readonly last: { readonly seq: number; readonly eid: string } | undefined;
  } {
    const rows = this.#stmts
      .get("SELECT * FROM event_log WHERE seq > ? ORDER BY seq LIMIT ?")
      .all<LogRow>(afterSeq, Math.max(1, limit));
    const events: Readonly<Record<string, unknown>>[] = [];
    for (const row of rows) {
      if (exclude.has(deviceOf(row.hlc))) continue;
      events.push(JSON.parse(storedBody(row, this.vault)) as Record<string, unknown>);
    }
    const tail = rows.at(-1);
    return { events, last: tail === undefined ? undefined : { seq: tail.seq, eid: tail.eid } };
  }

  // ------------------------------------------------------------------------------------------- //
  // Reading and subscriptions

  /** Run a read-only query on the view. */
  read<R>(sql: string, ...params: SqlValue[]): R[] {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error("read() accepts SELECT / WITH only");
    try {
      return this.#stmts.get(sql).all<R>(...params);
    } catch (e) {
      const missing = /no such table: (?:main\.)?(\w+)/.exec(
        e instanceof Error ? e.message : "",
      )?.[1];
      if (missing !== undefined && this.#companionOff.has(missing)) {
        throw new CompanionReadsOffError(missing);
      }
      throw e;
    }
  }

  /**
   * The public view tables a query reads (for useQuery invalidation): identifiers of the SQL that
   * name a registered public table, and for an internal table a query reads (a deriver's aggregate)
   * the public tables it wakes with (`TableDef.wakesWith`). Table names are a closed set, so this is
   * exact for every query written against the view.
   */
  tablesRead(sql: string): ReadonlySet<string> {
    const out = new Set<string>();
    for (const word of sql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []) {
      for (const t of this.#reads.get(word) ?? []) out.add(t);
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
        viewSql(this.#stmts, touched).write(t.name, clearTableSql(t));
      }
      this.driver.exec(
        "DELETE FROM event_log; DELETE FROM event_refs; DELETE FROM event_rejects; DELETE FROM unknown_events; DELETE FROM materializer_state; DELETE FROM identity_roots; DELETE FROM identity_accepted; DELETE FROM view_ids; DELETE FROM sync_cursors;",
      );
      this.driver.prepare("DELETE FROM store_meta WHERE key LIKE ?").run(conflictsKey("%"));
      touched.add("unknown_events");
    });
    this.#ids.reset();
    this.#identity.load();
    this.deps.lazyRefs.reset();
    this.#hub.notify(touched.set);
  }

  /** This store as the sync engine's `EventSink`. */
  sink(): EventSink {
    return {
      cursors: () => this.cursors(),
      applyBatches: (batches: readonly InboundBatch[]): ApplyOutcome[] =>
        this.applyWireBatches(
          batches.map((b) => ({
            device: b.device,
            events: b.events as readonly SyncWireEvent[],
            cursor: b.cursor,
          })),
        ).map((r) => ({ applied: r.applied, duplicates: r.duplicates, parked: r.parked })),
      reset: () => this.reset(),
      needsUpgrade: () => this.needsUpgrade(),
    };
  }

  /** Record a clean shutdown without closing the connection (the caller owns the handle). */
  detach(): void {
    this.driver.prepare("DELETE FROM store_meta WHERE key = ?").run(META_SESSION);
  }

  close(): void {
    this.detach();
    this.driver.close();
  }
}

/** The companion derivers of `opts.modules` this store does not register (`companionReads` off). */
function inactiveCompanions(opts: StoreOptions): readonly Deriver[] {
  if (opts.companionReads === true) return [];
  return opts.modules.flatMap((m) => (m.derivers ?? []).filter((d) => d.companion === true));
}

/**
 * The modules a store registers: the companion derivers only with `companionReads`. Every companion
 * deriver must come after every other one (the order of `at`: the remaining derivers keep their
 * recorded positions either way, so a toggle never rebuilds them), write only its own tables and keep
 * them out of snapshots.
 */
function registeredModules(opts: StoreOptions): readonly StoreModule[] {
  let companionSeen: string | undefined;
  for (const d of opts.modules.flatMap((m) => m.derivers ?? [])) {
    if (d.companion === true) {
      if (d.writes.length > 0 || d.tables?.some((t) => inSnapshot(t))) {
        throw new RangeError(
          `companion deriver ${d.id} writes outside its own snapshot-less tables`,
        );
      }
      companionSeen ??= d.id;
    } else if (companionSeen !== undefined) {
      throw new RangeError(`deriver ${d.id} comes after the companion deriver ${companionSeen}`);
    }
  }
  if (opts.companionReads === true) return opts.modules;
  return opts.modules.map((m) =>
    m.derivers?.some((d) => d.companion === true)
      ? { ...m, derivers: m.derivers.filter((d) => d.companion !== true) }
      : m,
  );
}

/**
 * The recorded definitions without the components of the companion derivers this store does not run,
 * and their recorded tables to drop.
 */
function withoutInactiveCompanions(
  defs: ViewDefs | undefined,
  inactive: readonly Deriver[],
): { readonly defs: ViewDefs | undefined; readonly drop: readonly string[] } {
  if (defs === undefined || inactive.length === 0) return { defs, drop: [] };
  const keys = new Set(inactive.map((d) => componentKey("deriver", d.id)));
  const kept: Record<string, ComponentDef> = {};
  const drop: string[] = [];
  for (const [key, def] of Object.entries(defs)) {
    if (keys.has(key)) drop.push(...def.tables);
    else kept[key] = def;
  }
  return { defs: kept, drop };
}

function safeJson(raw: unknown): string {
  try {
    return JSON.stringify(raw) ?? "null";
  } catch {
    return '"<unserializable>"';
  }
}

/**
 * What each SQL identifier stands for in `tablesRead`: a public table (and `unknown_events`) itself, an
 * internal table with `wakesWith` those public tables. Throws on a `wakesWith` that is not on an
 * internal table or names a table that is not public (a query over it would never wake).
 */
function readsOf(
  publicTables: readonly TableDef[],
  all: readonly TableDef[],
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>(
    [...publicTables.map((t) => t.name), "unknown_events"].map((n) => [n, [n]]),
  );
  for (const t of all) {
    if (t.wakesWith === undefined) continue;
    const unknown = t.wakesWith.filter((w) => !out.has(w));
    if (!t.internal || unknown.length > 0 || t.wakesWith.length === 0) {
      throw new Error(
        `${t.name}: wakesWith is for an internal table and names public tables (${unknown.join(", ")})`,
      );
    }
    out.set(t.name, t.wakesWith);
  }
  return out;
}
