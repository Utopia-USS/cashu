// Phase 1 of genesis (S26 spec 6.6, 6.1-6.4; gid.md 4, 7, 7.3-7.6): from rows alone, the gid of every
// row one vault exports, before any event is built. Row mappers (C5, and the S31a shipper with a
// resolver over Python's `sync_ids`) read gids only through `GidResolver`. A row that a required
// reference of gid.md 7.6 leaves out gets no gid (counted `(table, dangling_required)` here, once);
// mappers skip a row whose gid the resolver does not know. `ids` lists every exported row under its
// Python `sync_outbox._local_id` (impl notes, change 3). The simple per-row tables: stateIds.ts.
import { type DetGid, detGidFor, type VaultSalt } from "../gid.js";
import { type AccountIdentity, accountIdentities } from "./accountIds.js";
import { instrumentClosure } from "./closure.js";
import { type BudgetHash, budgetHashes, budgetTxnKind, cashLegSource } from "./hashes.js";
import { type InstrumentRef, invHashes } from "./invHashes.js";
import type { GenesisCounters } from "./report.js";
import type { InvInstrumentAliasRow, InvInstrumentRow } from "./rows.js";
import type { ProfileScope } from "./source.js";
import { GidMap, stateIds } from "./stateIds.js";

/** What the caller hands genesis per profile (gid.md 7.5): never minted here. */
export interface VaultKeys {
  /** The vault id (= profile gid), 32 lower-case hex. */
  readonly vault: string;
  readonly salt: VaultSalt;
}

/** Gids by Python table name and Python local id (`sync_outbox._local_id`). */
export interface GidResolver {
  gid(table: string, localId: string): string | undefined;
}

/** One `sync_ids` seed row (impl notes, change 3). */
interface IdEntry {
  readonly table: string;
  readonly localId: string;
  readonly gid: string;
}

export interface InstrumentIdentity extends InstrumentRef {
  readonly row: InvInstrumentRow;
  /** `isin:<value>` of the ISIN alias, else `namespace:value` of the oldest alias; null: none. */
  readonly creationAlias: string | null;
}

/** Instruments and aliases are global in Python (spec 4.6). */
export interface GlobalInstruments {
  readonly instruments: readonly InvInstrumentRow[];
  readonly aliases: readonly InvInstrumentAliasRow[];
}

/** Everything phase 2 needs of one vault. */
export interface VaultIds {
  readonly ordinal: number;
  readonly vault: string;
  readonly det: DetGid;
  readonly resolver: GidResolver;
  readonly accounts: ReadonlyMap<number, AccountIdentity>;
  /** The closure (4.6), ascending local id. */
  readonly instruments: ReadonlyMap<number, InstrumentIdentity>;
  /** Aliases of the closure's instruments, ascending local id. */
  readonly aliases: readonly InvInstrumentAliasRow[];
  /** Exported bank rows: v2 hash and the occurrence after collisions. */
  readonly budgetTxns: ReadonlyMap<number, BudgetHash>;
  /** Exported investment rows: dedupHashV2, or `manual:<gid>` for a manual row. */
  readonly invDedupHashes: ReadonlyMap<number, string>;
  /** Cash legs whose source row is exported: DET(transactions)["cashleg", @source]. No `ids` entry. */
  readonly cashLegClaims: ReadonlyMap<number, string>;
  /** Every exported row, in phase-1 order (table groups, then read order). */
  readonly ids: readonly IdEntry[];
  /** `DET(genesis)[table, id]`: genesis gids, also what a dangling id inside a key becomes (7.6). */
  missingGid(table: string, id: number): string;
}

export function instrumentIdentities(
  closure: readonly number[],
  global: GlobalInstruments,
  det: DetGid,
): ReadonlyMap<number, InstrumentIdentity> {
  const rows = new Map(global.instruments.map((i) => [i.id, i]));
  const aliases = new Map<number, InvInstrumentAliasRow[]>();
  for (const a of [...global.aliases].sort((x, y) => x.id - y.id)) {
    const own = aliases.get(a.instrumentId);
    if (own === undefined) aliases.set(a.instrumentId, [a]);
    else own.push(a);
  }
  const out = new Map<number, InstrumentIdentity>();
  for (const id of closure) {
    const row = rows.get(id);
    if (row === undefined) continue;
    const own = aliases.get(id) ?? [];
    const isin = own.find((a) => a.namespace === "isin");
    const first = own[0];
    let creationAlias: string | null = null;
    if (isin !== undefined) creationAlias = `isin:${isin.value}`;
    else if (first !== undefined) creationAlias = `${first.namespace}:${first.value}`;
    const gid =
      creationAlias === null
        ? det("genesis", ["inv_instruments", String(id)])
        : det("inv_instruments", [creationAlias]);
    out.set(id, { row, gid, isin: row.isin, aliases: own, creationAlias });
  }
  return out;
}

/** Budget transactions (spec 4.2): bank rows DET, cash expenses genesis gids, legs claims only. */
function budgetIds(
  map: GidMap,
  scope: ProfileScope,
  acc: (id: number) => string | undefined,
  budgetTxns: ReadonlyMap<number, BudgetHash>,
): ReadonlyMap<number, string> {
  for (const t of scope.transactions) {
    const kind = budgetTxnKind(t);
    if (kind === "cashLeg") continue;
    const account = acc(t.accountId);
    const hash = budgetTxns.get(t.id);
    if (account === undefined) map.leftOut("transactions");
    else if (kind === "cashExpense")
      map.put("transactions", t.id, map.genesis("transactions", t.id));
    else if (hash !== undefined) {
      map.put(
        "transactions",
        t.id,
        map.det("transactions", [account, hash.dedupHash, String(hash.occurrence)]),
      );
    }
  }
  const claims = new Map<number, string>();
  for (const t of scope.transactions) {
    if (budgetTxnKind(t) !== "cashLeg") continue;
    const source = cashLegSource(t);
    const anchor = source === undefined ? undefined : map.gid("transactions", String(source));
    if (anchor !== undefined) claims.set(t.id, map.det("transactions", ["cashleg", anchor]));
    else if (t.categorySource === "manual_txn") map.leftOut("transactions");
  }
  return claims;
}

/**
 * Phase 1 for one vault: the gid of every exported row of `scope` and of its instrument closure.
 * `ordinal` is the vault's index (profiles by id). Counters: accountIds.ts, closure.ts, hashes.ts,
 * invHashes.ts, plus `(table, dangling_required)` per row a required reference leaves out (7.6).
 */
export function vaultIds(
  scope: ProfileScope,
  global: GlobalInstruments,
  keys: VaultKeys,
  ordinal: number,
  counters: GenesisCounters,
): VaultIds {
  const det = detGidFor(keys.salt);
  const map = new GidMap(det, counters, ordinal);
  map.put("profiles", scope.profile.id, keys.vault);
  for (const m of scope.profileModules) {
    map.put(
      "profile_modules",
      `${m.profileId}|${m.moduleId}`,
      det("profile_modules", [m.moduleId]),
    );
  }
  const accounts = accountIdentities(scope.accounts, det, counters, ordinal);
  for (const [id, a] of accounts) map.put("accounts", id, a.gid);
  const acc = (id: number) => accounts.get(id)?.gid;

  const closure = instrumentClosure(scope, global.instruments, counters, ordinal);
  const instruments = instrumentIdentities(closure, global, det);
  const aliases = [...instruments.values()].flatMap((i) => i.aliases).sort((a, b) => a.id - b.id);
  for (const [id, i] of instruments) map.put("inv_instruments", id, i.gid);
  for (const a of aliases) {
    map.put("inv_instrument_aliases", a.id, det("inv_instrument_aliases", [a.namespace, a.value]));
  }

  const budgetTxns = budgetHashes(scope.transactions, acc, counters, ordinal);
  const cashLegClaims = budgetIds(map, scope, acc, budgetTxns);
  const invBatches = stateIds(map, scope, acc, (id) => instruments.get(id)?.gid);

  const invHash = invHashes(
    {
      rows: scope.invTransactions,
      accountGid: acc,
      batches: invBatches,
      instruments,
      missingInstrumentGid: (id) => map.genesis("inv_instruments", id),
    },
    counters,
    ordinal,
  );
  const invDedupHashes = new Map<number, string>();
  for (const t of scope.invTransactions) {
    const account = acc(t.accountId);
    const hash = invHash.get(t.id);
    if (account === undefined) {
      map.leftOut("inv_transactions");
    } else if (t.source === "manual") {
      const gid = map.genesis("inv_transactions", t.id);
      map.put("inv_transactions", t.id, gid);
      invDedupHashes.set(t.id, `manual:${gid}`);
    } else if (hash !== undefined) {
      map.put("inv_transactions", t.id, det("inv_transactions", [account, hash]));
      invDedupHashes.set(t.id, hash);
    }
  }

  return {
    ordinal,
    vault: keys.vault,
    det,
    resolver: map,
    accounts,
    instruments,
    aliases,
    budgetTxns,
    invDedupHashes,
    cashLegClaims,
    ids: map.ids,
    missingGid: (table, id) => map.genesis(table, id),
  };
}
