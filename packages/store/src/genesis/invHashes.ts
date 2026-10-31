// Investment transaction dedupHashV2 of genesis (S26 spec 4.5 steps 1-5, 6.3; gid.md 4.6, 7, 7.2,
// 7.4). Per non-manual row: the path (reconciliation, else ref when the stripped ref is non-empty,
// else content); the occurrence recovered by recomputing the stored v1 hash with the local ids for
// k = 0..K_MAX (else the rank among rows of one account, batch and v1 occurrence key by
// (created_at, id)); v2 with the account gid and the instrumentKey of 7.2; collisions per 7.4 (a
// reconciliation collision fails the run). Parts come from the domain `dedupKey` module; this file
// hashes them with sha256 (lower hex). Manual rows get the genesis gid instead (ids.ts).
import { D, type Decimal, investments } from "@cashu/domain";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type AccountGids, resolveCollisions } from "./hashes.js";
import { type GenesisCounters, GenesisError } from "./report.js";
import type { InvImportBatchRow, InvInstrumentAliasRow, InvTransactionRow } from "./rows.js";

const { US } = investments;
const utf8 = new TextEncoder();
const sha256Hex = (parts: readonly string[]) => bytesToHex(sha256(utf8.encode(parts.join(US))));

/** gid.md 7: the occurrences tried when recovering a stored v1 hash. */
const K_MAX = 1000;
/** Python `service/transactions.py` MANUAL_BROKER_ID: the broker of a row without a batch. */
const NO_BATCH_BROKER = "manual";
/** Python `contract.py` CASHU_NAMESPACE / LEGACY_NAMESPACE: one namespace under two names. */
// legacy name: Python's equivalent_namespaces treats the pre-rename broker id as `cashu`
const CANONICAL_NAMESPACES: readonly string[] = ["cashu", "finanse"];
const TABLE = "inv_transactions";

/** Python `contract.equivalent_namespaces`: `cashu` and its legacy name `finanse` are one. */
function equivalentNamespaces(namespace: string): readonly string[] {
  return CANONICAL_NAMESPACES.includes(namespace) ? CANONICAL_NAMESPACES : [namespace];
}

/** An instrument of the vault's closure (ids.ts): its gid, ISIN column and aliases by ascending id. */
export interface InstrumentRef {
  readonly gid: string;
  readonly isin: string | null;
  readonly aliases: readonly InvInstrumentAliasRow[];
}

export interface InvHashSource {
  /** The vault's investment transactions, ascending id. */
  readonly rows: readonly InvTransactionRow[];
  readonly accountGid: AccountGids;
  /** The vault's exported import batches by local id. */
  readonly batches: ReadonlyMap<number, InvImportBatchRow>;
  /** The vault's closure by local instrument id. */
  readonly instruments: ReadonlyMap<number, InstrumentRef>;
  /** The gid standing for an instrument that is not in the vault (gid.md 7.6 key rule). */
  readonly missingInstrumentGid: (instrumentId: number) => string;
}

/** gid.md 7.2 for one row: none, broker alias, ISIN alias, ISIN column, else the instrument gid. */
function instrumentKeyV2(
  row: InvTransactionRow,
  batch: InvImportBatchRow | undefined,
  source: InvHashSource,
  tally: (reason: string) => void,
  ambiguous: Set<number>,
): string {
  if (row.instrumentId === null) return "";
  const instrument = source.instruments.get(row.instrumentId);
  if (instrument === undefined) {
    tally("ikey_gid");
    return `gid:${source.missingInstrumentGid(row.instrumentId)}`;
  }
  if (batch !== undefined) {
    const namespaces = equivalentNamespaces(batch.broker);
    const own = instrument.aliases.filter((a) => namespaces.includes(a.namespace));
    if (own.length > 1) ambiguous.add(row.instrumentId);
    const first = own[0];
    if (first !== undefined) {
      tally("ikey_broker");
      return `${batch.broker}:${first.value}`;
    }
  }
  const isinAlias = instrument.aliases.find((a) => a.namespace === "isin");
  if (isinAlias !== undefined) {
    tally("ikey_isin_alias");
    return `isin:${isinAlias.value}`;
  }
  if (instrument.isin !== null && instrument.isin !== "") {
    tally("ikey_isin_col");
    return `isin:${instrument.isin}`;
  }
  tally("ikey_gid");
  return `gid:${instrument.gid}`;
}

const decimal = (text: string | null): Decimal | null => (text === null ? null : D(text));

/** The hash inputs as stored (`DedupInput.from_transaction`: values already `copy_abs`). */
function stored(row: InvTransactionRow, instrumentKey: string): investments.DedupInput {
  return investments.dedupInputFromStored(
    {
      tradeDate: row.tradeDate,
      type: row.type,
      currency: row.currency,
      grossAmount: D(row.grossAmount),
      cashAmount: D(row.cashAmount),
      externalRef: row.externalRef,
      quantity: decimal(row.quantity),
      price: decimal(row.price),
    },
    instrumentKey,
  );
}

/** A stored timestamp as a fixed-width sortable string (fraction padded to 6 digits). */
function sortable(ts: string): string {
  const m = /^(.{19})(?:\.(\d+))?Z$/.exec(ts);
  return m === null ? ts : `${m[1]}.${(m[2] ?? "").padEnd(6, "0")}`;
}

interface PathRow {
  readonly id: number;
  readonly row: InvTransactionRow;
  readonly accountGid: string;
  readonly v2Input: investments.DedupInput;
  readonly broker: string;
  /** The recovered v1 occurrence; undefined until the rank fallback assigns one. */
  occurrence: number | undefined;
  readonly fallbackGroup: string;
}

/**
 * dedupHashV2 of every non-manual row of one vault, by local id. A reconciliation row without a
 * quantity has no hash (counted `bad_reconciliation`, not exported). Counts on `inv_transactions`:
 * `occ_v1_match`, `occ_fallback`, `recon_match`, `recon_mismatch`, `inv_v2_collision`,
 * `ikey_broker`, `ikey_isin_alias`, `ikey_isin_col`, `ikey_gid`, `ikey_ambiguous` (instruments).
 * Throws `GenesisError("recon_collision")` when two reconciliation rows share a v2 hash.
 */
export function invHashes(
  source: InvHashSource,
  counters: GenesisCounters,
  ordinal: number,
): ReadonlyMap<number, string> {
  const tally = (reason: string, n = 1) => counters.addVault(ordinal, TABLE, reason, n);
  const ambiguous = new Set<number>();
  const out = new Map<number, string>();
  const reconClaims = new Set<string>();
  const paths: PathRow[] = [];
  for (const row of source.rows) {
    const accountGid = source.accountGid(row.accountId);
    if (row.source === "manual" || accountGid === undefined) continue;
    const batch = row.importBatchId === null ? undefined : source.batches.get(row.importBatchId);
    const account = String(row.accountId);
    const localInstrument = row.instrumentId === null ? "" : String(row.instrumentId);
    if (row.source === "reconciliation") {
      if (row.quantity === null) {
        tally("bad_reconciliation");
        continue;
      }
      const quantity = D(row.quantity);
      const path = (instrumentKey: string): investments.InvHashPath => ({
        kind: "reconciliation",
        instrumentKey,
        asOf: row.tradeDate,
        type: row.type,
        quantity,
      });
      const v1 = sha256Hex(investments.hashPartsV1(path(localInstrument), account));
      tally(v1 === row.dedupHash ? "recon_match" : "recon_mismatch");
      const key =
        row.instrumentId === null
          ? ""
          : `gid:${source.instruments.get(row.instrumentId)?.gid ?? source.missingInstrumentGid(row.instrumentId)}`;
      const hash = sha256Hex(investments.hashPartsV2(path(key), accountGid));
      const claim = `${accountGid}|${hash}`;
      if (reconClaims.has(claim)) {
        throw new GenesisError("recon_collision", "two reconciliation rows share one v2 hash");
      }
      reconClaims.add(claim);
      out.set(row.id, hash);
      continue;
    }
    const broker = batch?.broker ?? NO_BATCH_BROKER;
    const v1Input = stored(row, localInstrument);
    let occurrence: number | undefined;
    for (let k = 0; k <= K_MAX && occurrence === undefined; k++) {
      const path = investments.hashPathOf(v1Input, broker, k);
      if (sha256Hex(investments.hashPartsV1(path, account)) === row.dedupHash) occurrence = k;
    }
    tally(occurrence === undefined ? "occ_fallback" : "occ_v1_match");
    const v2Input = stored(row, instrumentKeyV2(row, batch, source, tally, ambiguous));
    paths.push({
      id: row.id,
      row,
      accountGid,
      v2Input,
      broker,
      occurrence,
      fallbackGroup: [account, row.importBatchId ?? "", investments.occurrenceKeyOf(v1Input)].join(
        US,
      ),
    });
  }
  tally("ikey_ambiguous", ambiguous.size);
  assignFallbackRanks(paths);
  const hashAt = (p: PathRow, k: number) =>
    sha256Hex(
      investments.hashPartsV2(investments.hashPathOf(p.v2Input, p.broker, k), p.accountGid),
    );
  const { occurrences, collisions } = resolveCollisions(
    paths,
    (p, k) => `${p.accountGid}|${hashAt(p, k)}`,
    (p) => p.occurrence ?? 0,
  );
  tally("inv_v2_collision", collisions);
  for (const p of paths) out.set(p.id, hashAt(p, occurrences.get(p.id) ?? 0));
  return new Map([...out].sort((a, b) => a[0] - b[0]));
}

/**
 * The rank fallback (spec 4.5 step 3): a row whose stored hash no k reproduces gets its rank among
 * the rows of its account, batch and v1 occurrence key, ordered by (created_at, id).
 */
function assignFallbackRanks(paths: readonly PathRow[]): void {
  const groups = new Map<string, PathRow[]>();
  for (const p of paths) {
    const group = groups.get(p.fallbackGroup);
    if (group === undefined) groups.set(p.fallbackGroup, [p]);
    else group.push(p);
  }
  for (const group of groups.values()) {
    const ranked = [...group].sort((a, b) => {
      const ta = sortable(a.row.createdAt);
      const tb = sortable(b.row.createdAt);
      return ta < tb ? -1 : ta > tb ? 1 : a.id - b.id;
    });
    ranked.forEach((p, rank) => {
      if (p.occurrence === undefined) p.occurrence = rank;
    });
  }
}
