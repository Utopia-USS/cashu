// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// Gid resolution of one vault for one plan (S31a spec 4.3): a genesis `GidResolver` layered as
//   1. the gids of this plan (each row's own gid, gids computed earlier in the plan);
//   2. Python's `sync_ids` of the vault's profile (read per plan);
//   3. for an instrument (or alias) the vault does not hold yet: the genesis phase-1 gid over the
//      live Python rows; the instrument then needs its closure snapshot in this vault (4.3 "shared
//      instruments"), which `closureEvents` builds with the genesis instrument mapper.
// An insert NEVER resolves its own gid through `sync_ids` (S30: a captured insert resets the mapping;
// a reused rowid must not inherit an old gid). Shipper-computed tables (accounts, bank / cash
// transactions, investment transactions) take the genesis phase-1 functions over the live rows of the
// vault (`vaultIds`), never a re-implementation; where phase 1 would fall back to a genesis gid (a
// key collision, no natural key) a live row gets a minted ULID instead, so a reused rowid can never
// collide with an old row's gid.

import {
  type GidResolver,
  type GlobalInstruments,
  type VaultIds,
  vaultIds,
} from "../genesis/ids.js";
import type { MapContext, RowEvents } from "../genesis/map/context.js";
import { mapInstruments } from "../genesis/map/investments.js";
import { GenesisCounters, GenesisError } from "../genesis/report.js";
import { Rewriter } from "../genesis/rewrite.js";
import type { GenesisFiles, ProfileScope } from "../genesis/source.js";
import type { DetGid, VaultSalt } from "../gid.js";
import { detGidFor } from "../gid.js";
import { BridgeBlock } from "./map/types.js";

/** The live Python rows of one vault: the inputs of the genesis phase-1 functions. */
export interface CurrentRows {
  readonly scope: ProfileScope;
  readonly global: GlobalInstruments;
}

/** What the bridge reads of one linked vault for a plan (the daemon's Python port fills it). */
export interface VaultInput {
  /** The vault's index (profiles by id). */
  readonly ordinal: number;
  readonly profileId: number;
  readonly vault: string;
  readonly salt: VaultSalt;
  /** Python `sync_ids` of the vault's profile. */
  readonly syncIds: GidResolver;
  /** The live Python rows, read only when a plan needs phase 1 (lazily, once per plan). */
  readonly current: () => CurrentRows;
  /** The Python data dir's side files. */
  readonly files: GenesisFiles;
}

/** Ports of the bridge: randomness and the leader question come from outside (no clock here). */
export interface BridgePorts {
  /** A fresh ULID (event eids, minted gids). */
  ulid(): string;
  /** TRANSITIONAL(S29c-B1): whether this device is the vault's fetch leader. */
  isLeader(vault: string): boolean;
}

/** A gid the bridge computed, returned to Python with the ack (`sync_ids`, source `shipper`). */
export interface AckGid {
  readonly table: string;
  readonly localId: string;
  readonly gid: string;
}

/** Shipper-computed tables: Python leaves their gid NULL unless it minted one (S30). */
const SHIPPER_TABLES: ReadonlySet<string> = new Set([
  "accounts",
  "transactions",
  "inv_transactions",
]);
const INSTRUMENT_TABLES: ReadonlySet<string> = new Set([
  "inv_instruments",
  "inv_instrument_aliases",
]);

const rowKey = (table: string, localId: string) => `${table}\u001f${localId}`;

/** The resolver, phase-1 cache and closure state of one vault in one plan. */
export class VaultMapping {
  readonly input: VaultInput;
  readonly det: DetGid;
  readonly counters = new GenesisCounters();
  /** Gids computed by the bridge in this plan (sent with the ack). */
  readonly computed: AckGid[] = [];
  readonly #ports: BridgePorts;
  readonly #local = new Map<string, string>();
  /** Instruments (local ids) this vault references but does not hold: closure snapshot needed. */
  readonly #missing = new Set<number>();
  readonly #snapshotted = new Set<number>();
  #phase1: VaultIds | undefined;
  #current: CurrentRows | undefined;
  readonly resolver: GidResolver;
  readonly ctx: MapContext;

  constructor(input: VaultInput, ports: BridgePorts) {
    this.input = input;
    this.#ports = ports;
    this.det = detGidFor(input.salt);
    this.resolver = { gid: (table, localId) => this.#resolve(table, localId) };
    this.ctx = this.#context(() => this.#phaseOne().instruments);
  }

  /** Records a row's gid for the rest of the plan (`computed`: also returned with the ack). */
  put(table: string, localId: string, gid: string, computed: boolean): void {
    this.#local.set(rowKey(table, localId), gid);
    if (computed) this.computed.push({ table, localId, gid });
  }

  /** The gid of an existing row (update, delete, explicit op), never phase 1. */
  existing(table: string, localId: string): string | undefined {
    return this.#local.get(rowKey(table, localId)) ?? this.input.syncIds.gid(table, localId);
  }

  /**
   * The gid of a row a shipper-computed insert creates (Python left it NULL): phase 1 over the live
   * rows; a genesis-gid fallback becomes a minted ULID.
   */
  shipperGid(table: string, localId: string, accountLocalId?: string): string {
    if (!SHIPPER_TABLES.has(table)) throw new BridgeBlock(`unresolved:${table}`);
    const p1 = this.#phaseOne();
    const gid = p1.resolver.gid(table, localId);
    if (gid === undefined) throw new BridgeBlock(`unresolved:${table}`);
    const fallback = this.det("genesis", [table, localId]);
    if (gid === fallback) return this.#ports.ulid();
    if (table === "accounts" || accountLocalId === undefined) return gid;
    // A transaction's DET parts name its account by the gid the VAULT holds, which differs from
    // phase 1's when the account got a minted ULID (a live collision fallback): the gid is then the
    // genesis rule of ids.ts over the phase-1 hash and the vault's account gid.
    const account = this.existing("accounts", accountLocalId);
    if (account === undefined) throw new BridgeBlock(`unresolved-ref:${table}`);
    const id = Number(localId);
    if (table === "transactions") {
      const hash = p1.budgetTxns.get(id);
      if (hash === undefined) return gid; // a cash expense: Python minted its gid
      return this.det("transactions", [account, hash.dedupHash, String(hash.occurrence)]);
    }
    const hash = p1.invDedupHashes.get(id);
    if (hash === undefined || hash.startsWith("manual:")) return gid;
    return this.det("inv_transactions", [account, hash]);
  }

  /** Whether the vault holds the instrument (its gid is mapped or was shipped in this plan). */
  holdsInstrument(localId: string): boolean {
    return this.existing("inv_instruments", localId) !== undefined;
  }

  /**
   * The closure snapshot (`instrument.created` + `instrument.aliasAdded`) of every instrument the
   * rows mapped so far referenced without the vault holding it, built by the genesis instrument
   * mapper from the live rows; their gids join the plan and the ack. Empty when none is missing.
   */
  closureEvents(): readonly RowEvents[] {
    const ids = [...this.#missing].filter((id) => !this.#snapshotted.has(id));
    this.#missing.clear();
    if (ids.length === 0) return [];
    const all = this.#phaseOne().instruments;
    const wanted = new Map([...all].filter(([id]) => ids.includes(id)));
    for (const id of ids) {
      if (!wanted.has(id)) throw new BridgeBlock("unresolved:inv_instruments");
      this.#snapshotted.add(id);
    }
    const rows = mapInstruments(this.#context(() => wanted));
    for (const r of rows) {
      const gid = r.events[0]?.gid;
      if (r.localId === undefined || gid === undefined) continue;
      if (this.existing(r.table, r.localId) === undefined) this.put(r.table, r.localId, gid, true);
    }
    return rows;
  }

  #resolve(table: string, localId: string): string | undefined {
    const held = this.existing(table, localId);
    if (held !== undefined || !INSTRUMENT_TABLES.has(table)) return held;
    const gid = this.#phaseOne().resolver.gid(table, localId);
    if (gid === undefined) return undefined;
    if (table === "inv_instruments") this.#missing.add(Number(localId));
    return gid;
  }

  #phaseOne(): VaultIds {
    if (this.#phase1 === undefined) {
      this.#current ??= this.input.current();
      const keys = { vault: this.input.vault, salt: this.input.salt };
      this.#phase1 = vaultIds(
        this.#current.scope,
        this.#current.global,
        keys,
        this.input.ordinal,
        this.counters,
      );
    }
    return this.#phase1;
  }

  /** A genesis map context over this vault's resolver (phase-1 maps read lazily). */
  #context(instruments: () => VaultIds["instruments"]): MapContext {
    const phaseOne = () => this.#phaseOne();
    const ordinal = this.input.ordinal;
    const det = this.det;
    const resolver = this.resolver;
    const ids = {
      det,
      resolver,
      get accounts() {
        return phaseOne().accounts;
      },
      get instruments() {
        return instruments();
      },
      get budgetTxns() {
        return phaseOne().budgetTxns;
      },
      get invDedupHashes() {
        return phaseOne().invDedupHashes;
      },
      get cashLegClaims() {
        return phaseOne().cashLegClaims;
      },
    };
    const rewriteIds = {
      resolver,
      missingGid: (table: string, id: number) => det("genesis", [table, String(id)]),
    };
    return {
      ids,
      rw: new Rewriter(rewriteIds, this.counters, ordinal, this.input.files),
      files: this.input.files,
      count: (table, reason, n = 1) => this.counters.addVault(ordinal, table, reason, n),
      attempt(map) {
        try {
          return map();
        } catch (e) {
          if (e instanceof GenesisError && e.code === "unmapped_id_key") {
            throw new BridgeBlock("unmapped-id");
          }
          // Genesis `requiredGid`: a reference phase 1 guarantees in genesis is a missing gid here.
          if (e instanceof Error && e.message.startsWith("genesis invariant:")) {
            throw new BridgeBlock("unresolved-ref");
          }
          throw e;
        }
      },
    };
  }
}
