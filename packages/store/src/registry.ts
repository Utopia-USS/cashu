// Registries: event types (current version, schemas per version, upcasters) and the store modules
// (materializers and identity kinds). The v1 catalog (`events/v1`) is the base; a module that evolves
// a type registers the next version with its upcaster (events.md 7.6), and a new type starts at v1.
import type { IsoDate } from "@cashu/domain";
import type { NetWorthContributor, SetupContext, SetupStep } from "@cashu/domain/core";
import type { market } from "@cashu/domain/investments";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { z } from "zod";
import { canonicalJson } from "./canonical.js";
import { membersTable } from "./engine/fold.js";
import type { SuppressionRules } from "./engine/suppression.js";
import {
  CONTRIBUTIONS,
  type Deriver,
  type IdentityKind,
  type Materializer,
  type ModuleContributions,
} from "./engine/types.js";
import {
  type EventMeta,
  type EventType,
  META,
  PAYLOADS,
  type Revocation,
} from "./events/v1/catalog.js";
import type { Read } from "./query.js";
import { createTableSql, type TableDef } from "./sql/ddl.js";
import type { Payload, Upcaster } from "./upcast.js";

export interface EventTypeDef {
  readonly type: string;
  /** The version this reader folds; events of a lower version are upcast to it, higher ones park. */
  readonly current: number;
  readonly schemas: ReadonlyMap<number, z.ZodType>;
  /** Keyed by the version they read (`v -> v + 1`). */
  readonly upcasters: ReadonlyMap<number, Upcaster>;
  readonly meta: EventMeta;
  /** Envelope / payload consistency the schema cannot see (e.g. `instrument.merged`: source = gid). */
  readonly check?: (gid: string, data: Payload) => boolean;
}

/** A version step a module registers: a new type at v1, or `current + 1` of an existing type. */
export interface EventVersionDef {
  readonly type: string;
  readonly v: number;
  readonly schema: z.ZodType;
  /** Required for v > 1: reads `v - 1`, returns `v`. */
  readonly upcastFrom?: Upcaster;
  /** Required for a new type. */
  readonly meta?: EventMeta;
  readonly check?: (gid: string, data: Payload) => boolean;
}

export class EventRegistry {
  readonly #defs = new Map<string, EventTypeDef>();

  /** The normative v1 catalog. */
  static v1(): EventRegistry {
    const r = new EventRegistry();
    for (const type of Object.keys(PAYLOADS) as EventType[]) {
      r.#defs.set(type, {
        type,
        current: 1,
        schemas: new Map([[1, PAYLOADS[type]]]),
        upcasters: new Map(),
        meta: META[type],
        ...(type === "instrument.merged"
          ? { check: (gid: string, data: Payload) => data.source === gid }
          : {}),
      });
    }
    return r;
  }

  define(def: EventVersionDef): this {
    const prev = this.#defs.get(def.type);
    if (!prev) {
      if (def.v !== 1) throw new RangeError(`${def.type}: a new type starts at v1`);
      if (!def.meta) throw new RangeError(`${def.type}: a new type needs its meta`);
      this.#defs.set(def.type, {
        type: def.type,
        current: 1,
        schemas: new Map([[1, def.schema]]),
        upcasters: new Map(),
        meta: def.meta,
        ...(def.check ? { check: def.check } : {}),
      });
      return this;
    }
    if (def.v !== prev.current + 1) {
      throw new RangeError(`${def.type}: next version must be v${prev.current + 1}`);
    }
    if (!def.upcastFrom) throw new RangeError(`${def.type} v${def.v}: missing upcaster`);
    const check = def.check ?? prev.check;
    this.#defs.set(def.type, {
      type: def.type,
      current: def.v,
      schemas: new Map([...prev.schemas, [def.v, def.schema]]),
      upcasters: new Map([...prev.upcasters, [prev.current, def.upcastFrom]]),
      meta: def.meta ?? prev.meta,
      ...(check ? { check } : {}),
    });
    return this;
  }

  get(type: string): EventTypeDef | undefined {
    return this.#defs.get(type);
  }

  types(): readonly string[] {
    return [...this.#defs.keys()].sort();
  }

  /** Types whose terminal transitions are first-writer-wins (events.md 6.2 FWW, 6.6). */
  fwwTypes(): ReadonlySet<string> {
    return new Set(
      [...this.#defs.values()].filter((d) => d.meta.rule === "FWW").map((d) => d.type),
    );
  }

  /** FWW types and causal revokers (events.md 6.6): the suppression stage's inputs. */
  suppressionRules(): SuppressionRules {
    const revokers = new Map<string, Revocation>();
    for (const d of this.#defs.values()) {
      if (d.meta.revokes !== undefined) revokers.set(d.type, d.meta.revokes);
    }
    return { fww: this.fwwTypes(), revokers };
  }

  /**
   * Changes whenever a type's current version or the causal suppression rules change (FWW types,
   * revokers: they decide which held events are in effect): the stored log is then re-decoded and
   * the whole view rebuilt.
   */
  fingerprint(): string {
    const rules = this.suppressionRules();
    return canonicalJson({
      versions: Object.fromEntries(this.types().map((t) => [t, this.get(t)?.current])),
      fww: [...rules.fww].sort(),
      revokers: Object.fromEntries([...rules.revokers].sort(([a], [b]) => (a < b ? -1 : 1))),
    });
  }
}

/** A store module (core, budget, assets, loans, investments): what it folds and how. */
export interface StoreModule {
  readonly id: string;
  readonly materializers: readonly Materializer[];
  readonly identityKinds?: readonly IdentityKind[];
  readonly events?: readonly EventVersionDef[];
  /** Post-fold steps over several materializers' output (S24 4.1), run in registry order. */
  readonly derivers?: readonly Deriver[];
  /** What this module offers other modules' derivers without being imported (S24 4.2). */
  readonly contributions?: ModuleContributions;
  /**
   * How this module values the accounts it owns for net worth (Python `ModuleSpec.networth`), read
   * from the vault's view (and the device's price cache): the read models compose it, core never
   * imports the module.
   */
  readonly netWorth?: NetWorthSource;
  /** The module's blank-page steps (Python `ModuleSpec.setup_status`) from the vault's view. */
  readonly setup?: SetupSource;
}

/** What a net-worth source reads besides the view: "now" and the device's price cache. */
export interface NetWorthEnv {
  /** Today's local date ("now" for computed valuations; domain has no clock). */
  readonly today: IsoDate;
  /** The device's price cache (prices are device-local caches, never view tables, events.md 10). */
  readonly prices: market.PriceCache | null;
  readonly marketData?: market.CachedMarketData;
}

/** A module's net-worth contributor over the vault's view. */
export type NetWorthSource = (read: Read, env: NetWorthEnv) => NetWorthContributor;

/** A module's blank-page steps over the vault's view. */
export type SetupSource = (read: Read, ctx: SetupContext) => SetupStep[];

/** The resolved set of modules of one store: lookup by event type, conflicts rejected. */
export class ModuleRegistry {
  readonly modules: readonly StoreModule[];
  readonly materializers: readonly Materializer[];
  readonly identityKinds: readonly IdentityKind[];
  readonly derivers: readonly Deriver[];
  readonly contributions: readonly ModuleContributions[];
  readonly #byType = new Map<string, Materializer[]>();

  constructor(modules: readonly StoreModule[]) {
    this.modules = modules;
    const ids = new Set<string>();
    const tables = new Set<string>();
    this.materializers = modules.flatMap((m) => m.materializers);
    this.identityKinds = modules.flatMap((m) => m.identityKinds ?? []);
    for (const mat of this.materializers) {
      if (ids.has(mat.id)) throw new RangeError(`duplicate materializer ${mat.id}`);
      ids.add(mat.id);
      for (const t of mat.tables) {
        if (tables.has(t.name)) throw new RangeError(`table ${t.name} owned twice`);
        tables.add(t.name);
      }
      for (const type of mat.handles) {
        const list = this.#byType.get(type) ?? [];
        list.push(mat);
        this.#byType.set(type, list);
      }
    }
    for (const k of this.identityKinds) {
      for (const t of k.tables ?? []) {
        if (tables.has(t.name)) throw new RangeError(`table ${t.name} owned twice`);
        tables.add(t.name);
      }
    }
    this.derivers = modules.flatMap((m) => m.derivers ?? []);
    this.contributions = modules.flatMap((m) => (m.contributions ? [m.contributions] : []));
    checkDerivers(this.derivers, ids, tables);
  }

  materializersFor(type: string): readonly Materializer[] {
    return this.#byType.get(type) ?? [];
  }

  handledTypes(): ReadonlySet<string> {
    return new Set(this.#byType.keys());
  }

  /** Every view table: materializer tables, their partition indexes, identity and deriver tables. */
  viewTables(): readonly TableDef[] {
    return [
      ...this.materializers.flatMap((m) => [...m.tables, membersTable(m)]),
      ...this.identityKinds.flatMap((k) => k.tables ?? []),
      ...this.derivers.flatMap((d) => d.tables ?? []),
    ];
  }

  /**
   * What each view component (materializer, identity kind, deriver) was built with: its version, a
   * fingerprint of its tables' exact DDL, the tables it owns and the facts the upgrade rule needs.
   * Recorded in the view database, compared on open: a difference selects what is rebuilt
   * (`planViewUpgrade`).
   */
  viewDefs(): ViewDefs {
    const out: Record<string, ComponentDef> = {};
    const tables = (ts: readonly TableDef[]) => ({
      ddl: ddlFingerprint(ts),
      tables: ts.map((t) => t.name),
    });
    for (const m of this.materializers) {
      const refs = m.refs === undefined ? undefined : m.refsOnDemand === true ? "lazy" : "eager";
      out[componentKey("materializer", m.id)] = {
        version: m.version,
        ...tables([...m.tables, membersTable(m)]),
        ...(refs ? { refs } : {}),
      };
    }
    for (const k of this.identityKinds) {
      out[componentKey("identity", k.id)] = { version: k.version, ...tables(k.tables ?? []) };
    }
    for (const [at, d] of this.derivers.entries()) {
      out[componentKey("deriver", d.id)] = { version: d.version, ...tables(d.tables ?? []), at };
    }
    return out;
  }

  /** Changes whenever a materializer's version or a table's DDL changes: the view must be rebuilt. */
  fingerprint(): string {
    return canonicalJson({
      materializers: this.materializers.map((m) => [m.id, m.version]),
      identity: this.identityKinds.map((k) => [k.id, k.version]),
      derivers: this.derivers.map((d) => [d.id, d.version]),
      ddl: this.viewTables().map(createTableSql),
    });
  }
}

export type ComponentKind = "materializer" | "identity" | "deriver";

/** The `ViewDefs` key of one component: `<kind>:<id>`. */
export function componentKey(kind: ComponentKind, id: string): string {
  return `${kind}:${id}`;
}

/** One view component's recorded definition (see `ModuleRegistry.viewDefs`). */
export interface ComponentDef {
  readonly version: number;
  /** sha256 (hex, 16 chars) of the component's `CREATE TABLE` / `CREATE INDEX` statements. */
  readonly ddl: string;
  /** Every table it owns, internal ones (a materializer's members table) included. */
  readonly tables: readonly string[];
  /** A materializer that indexes event refs (they feed every fold's `referrers`, events.md 6.1). */
  readonly refs?: "eager" | "lazy";
  /** A deriver's position in the registry order (each deriver sees the previous ones' writes). */
  readonly at?: number;
}

export type ViewDefs = Readonly<Record<string, ComponentDef>>;

function ddlFingerprint(tables: readonly TableDef[]): string {
  return bytesToHex(sha256(utf8ToBytes(tables.map(createTableSql).join("\n")))).slice(0, 16);
}

/**
 * Deriver registry rules (S24 4.1): unique ids, own tables owned once, inputs that name a registered
 * materializer (or `CONTRIBUTIONS`), every derived column written by exactly one deriver, and at most
 * one row predicate per table. A row predicate is disjoint from the owning materializer's rows by
 * construction (the deriver's rows carry its own key prefix, e.g. `dedup_hash LIKE 'cashleg:%'`).
 */
function checkDerivers(
  derivers: readonly Deriver[],
  materializerIds: ReadonlySet<string>,
  tables: Set<string>,
): void {
  const ids = new Set<string>();
  const columns = new Set<string>();
  const rowTables = new Set<string>();
  for (const d of derivers) {
    if (ids.has(d.id) || materializerIds.has(d.id)) throw new RangeError(`duplicate id ${d.id}`);
    ids.add(d.id);
    if (d.inputs.length === 0) throw new RangeError(`deriver ${d.id} has no inputs`);
    for (const input of d.inputs) {
      if (input !== CONTRIBUTIONS && !materializerIds.has(input)) {
        throw new RangeError(`deriver ${d.id}: unknown input ${input}`);
      }
    }
    for (const t of d.tables ?? []) {
      if (tables.has(t.name)) throw new RangeError(`table ${t.name} owned twice`);
      tables.add(t.name);
    }
    for (const w of d.writes) {
      if ("rows" in w) {
        if (rowTables.has(w.table)) throw new RangeError(`rows of ${w.table} derived twice`);
        rowTables.add(w.table);
        continue;
      }
      for (const c of w.columns) {
        const key = `${w.table}.${c}`;
        if (columns.has(key)) throw new RangeError(`column ${key} derived twice`);
        columns.add(key);
      }
    }
  }
}
