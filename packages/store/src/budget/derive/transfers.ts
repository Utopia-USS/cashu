// Deriver budget.transfers (S24 4.3, events.md 9, D-24.1 / D-24.2): `is_internal_transfer` and
// `transfer_group_id` of every transaction row, as a full deterministic recompute over the current
// set with the S08 matcher (`budget.matchTransfers`, Python `reset_transfer_matches` +
// `match_internal_transfers`).
//
// - Rule 5: a pair needs the counterparty IBAN on one leg to be the other leg's account match key
//   (`accounts.iban_match`, Python `iban_key` of the raw IBAN of every account, removed ones too,
//   D-08.1). Names and amounts alone never pair; the matcher's input has no name.
// - Order (D-24.2): rows go to the matcher in anchor order (`fold_txn_keys.anchor_ord`, the fold
//   order of the row's first applied import, which genesis emits in Python id order). A cash mirror
//   leg sorts right after its source row. PARITY: Python's leg id comes from the moment the claim was
//   made; the difference can only matter when a cash pool account carries an IBAN (Python creates
//   pools without one, so a leg and a cash expense never score).
// - Group id (D-24.2): the outflow row's gid, on both legs.
//
// Incremental unit = the amount key (`fold_txn_keys.amount_key`, `budget.transferAmountKey`): greedy
// matching never lets rows of two keys interact. Dirty keys = the keys of the dirty rows now, plus the
// keys of dirty rows that were matched before (`fold_transfer_pairs`: a deleted or re-folded matched
// row frees its partner; an unmatched row never changed anyone's match, so its removal changes
// nothing). Dirty rows include the source partitions whose cash leg the legs deriver changed
// (`takeLegChanges`: an account-only change, e.g. the source account set to cash, drops a leg without a
// dirty transaction partition). A change of the accounts' match keys (signature in
// `fold_transfer_env`), a full re-fold or a bulk dirty set runs `deriveAll`.
//
// The categories deriver reads `is_internal_transfer` (a structural transfer, recurring groups skip
// internal rows): the partitions of the rows whose flag flipped (a cash leg: its source's) are queued
// in `fold_transfer_flips`, which that deriver (registered after this one, with a superset of its
// inputs, so it runs whenever this one did) takes as dirty rows in the same apply and hands on to the
// month aggregates.
import { budget, D } from "@cashu/domain";
import type { DeriveContext, Deriver } from "../../engine/types.js";
import type { TableDef } from "../../sql/ddl.js";
import { CASHEXP, CASHLEG, splitKey, TRANSACTIONS } from "../transactions.js";
import { selectIn } from "./keys.js";
import { takeLegChanges } from "./legs.js";

/** The rows matched by the last derivation: row gid -> its partition (dirty unit) and amount key. */
const pairsTable: TableDef = {
  name: "fold_transfer_pairs",
  primaryKey: ["gid"],
  internal: true,
  withoutRowid: true,
  columns: [
    { name: "gid", type: "TEXT", notNull: true },
    /** The row's partition; a cash leg's is its source row's. */
    { name: "part", type: "TEXT", notNull: true },
    { name: "amount_key", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["part"] }, { columns: ["amount_key"] }],
};

const envTable: TableDef = {
  name: "fold_transfer_env",
  primaryKey: ["k"],
  internal: true,
  withoutRowid: true,
  columns: [
    { name: "k", type: "TEXT", notNull: true },
    { name: "v", type: "TEXT", notNull: true },
  ],
};

/**
 * Partitions of the rows whose `is_internal_transfer` flipped (a cash leg: its source partition), until
 * the categories deriver takes them.
 */
const flipsTable: TableDef = {
  name: "fold_transfer_flips",
  primaryKey: ["row"],
  internal: true,
  withoutRowid: true,
  columns: [{ name: "row", type: "TEXT", notNull: true }],
};

/** Same bulk rule as the categories deriver: a full pass beats per-key work on big dirty sets. */
const FULL_PASS_SHARE = 8;
const FULL_PASS_MIN = 256;

interface Loaded {
  id: number;
  gid: string;
  dedup_hash: string;
  account: string;
  booking_date: string;
  amount: string;
  counterparty_iban: string | null;
  is_internal_transfer: number;
  transfer_group_id: string | null;
}

/** A row as matching sees it, with what the view shows now. */
interface Row {
  readonly loaded: Loaded;
  /** The partition: the row key; a leg's source row key. */
  readonly part: string;
  readonly anchor: string;
  readonly amountKey: string;
  readonly isLeg: boolean;
}

const COLUMNS = `t.id, t.gid, t.dedup_hash, v.gid AS account, t.booking_date, t.amount,
  t.counterparty_iban, t.is_internal_transfer, t.transfer_group_id`;
const FROM = "FROM transactions t JOIN view_ids v ON v.id = t.account_id";

/** Every account's match key (accounts without one never match: absent here, `""` in the matcher). */
function matchKeys(ctx: DeriveContext): Map<string, string> {
  return new Map(
    ctx.sql
      .all<{ gid: string; iban_match: string }>(
        "SELECT gid, iban_match FROM accounts WHERE iban_match IS NOT NULL ORDER BY gid",
      )
      .map((a) => [a.gid, a.iban_match]),
  );
}

const signature = (keys: budget.AccountMatchKeys): string => JSON.stringify([...keys]);

function storedSignature(ctx: DeriveContext): string | undefined {
  return ctx.sql.get<{ v: string }>("SELECT v FROM fold_transfer_env WHERE k = 'accounts'")?.v;
}

function saveSignature(ctx: DeriveContext, sig: string): void {
  if (storedSignature(ctx) === sig) return;
  ctx.sql.write(
    envTable.name,
    "INSERT OR REPLACE INTO fold_transfer_env (k, v) VALUES ('accounts', ?)",
    sig,
  );
}

/** The cash legs of these source rows (each sorts right after its source, D-24.2 note above). */
function legsOf(ctx: DeriveContext, sources: readonly Row[]): Row[] {
  const byGid = new Map(sources.map((s) => [CASHLEG + s.loaded.gid, s]));
  if (byGid.size === 0) return [];
  const legGids = selectIn<{ leg_gid: string }>(
    ctx.sql,
    "SELECT leg_gid FROM fold_txn_legs WHERE partition IN (%IN%)",
    sources.map((s) => s.part),
  ).map((r) => r.leg_gid);
  const out: Row[] = [];
  for (const l of selectIn<Loaded>(
    ctx.sql,
    `SELECT ${COLUMNS} ${FROM} WHERE t.gid IN (%IN%)`,
    legGids,
  )) {
    const src = byGid.get(l.dedup_hash);
    if (src === undefined) continue;
    out.push({
      loaded: l,
      part: src.part,
      anchor: `${src.anchor}~`,
      amountKey: src.amountKey,
      isLeg: true,
    });
  }
  return out;
}

/** The rows (and their legs) of these amount keys. */
function rowsOfKeys(ctx: DeriveContext, amountKeys: readonly string[]): Row[] {
  const keyed = selectIn<{ row: string; anchor_ord: string; amount_key: string }>(
    ctx.sql,
    "SELECT row, anchor_ord, amount_key FROM fold_txn_keys WHERE amount_key IN (%IN%)",
    amountKeys,
  );
  const meta = new Map(keyed.map((k) => [k.row, k]));
  const hashesByRoot = new Map<string, string[]>();
  const expenses: string[] = [];
  for (const k of keyed) {
    if (k.row.startsWith(CASHEXP)) {
      expenses.push(k.row.slice(CASHEXP.length));
      continue;
    }
    const [root, hash] = splitKey(k.row);
    hashesByRoot.set(root, [...(hashesByRoot.get(root) ?? []), hash]);
  }
  const loaded: { row: string; l: Loaded }[] = [];
  for (const [root, hashes] of hashesByRoot) {
    const rows = selectIn<Loaded & { occurrence: number }>(
      ctx.sql,
      `SELECT ${COLUMNS}, t.occurrence ${FROM}
       WHERE t.account_id = (SELECT id FROM view_ids WHERE gid = ?) AND t.dedup_hash IN (%IN%)`,
      [...new Set(hashes)],
      [root],
    );
    for (const r of rows) loaded.push({ row: `${root}|${r.dedup_hash}|${r.occurrence}`, l: r });
  }
  for (const r of selectIn<Loaded>(
    ctx.sql,
    `SELECT ${COLUMNS} ${FROM} WHERE t.gid IN (%IN%) AND t.dedup_hash LIKE '${CASHEXP}%'`,
    expenses,
  )) {
    loaded.push({ row: r.dedup_hash, l: r });
  }
  const out: Row[] = [];
  for (const { row, l } of loaded) {
    const m = meta.get(row);
    if (m === undefined) continue; // another occurrence of a hash in the same account
    out.push({ loaded: l, part: row, anchor: m.anchor_ord, amountKey: m.amount_key, isLeg: false });
  }
  return [...out, ...legsOf(ctx, out)];
}

/** Every row of the view (the full recompute's input). */
function allRows(ctx: DeriveContext): Row[] {
  const rows = ctx.sql.all<
    Loaded & { row: string | null; anchor_ord: string | null; amount_key: string | null }
  >(
    `SELECT ${COLUMNS}, k.row, k.anchor_ord, k.amount_key ${FROM}
     LEFT JOIN fold_txn_keys k ON k.row = CASE WHEN t.dedup_hash LIKE '${CASHEXP}%' THEN t.dedup_hash
       ELSE v.gid || '|' || t.dedup_hash || '|' || t.occurrence END`,
  );
  const out: Row[] = [];
  const sources = new Map<string, Row>();
  const legs: Loaded[] = [];
  for (const r of rows) {
    if (r.dedup_hash.startsWith(CASHLEG)) {
      legs.push(r);
      continue;
    }
    if (r.row === null || r.anchor_ord === null || r.amount_key === null) continue;
    const row: Row = {
      loaded: r,
      part: r.row,
      anchor: r.anchor_ord,
      amountKey: r.amount_key,
      isLeg: false,
    };
    out.push(row);
    sources.set(CASHLEG + r.gid, row);
  }
  for (const l of legs) {
    const src = sources.get(l.dedup_hash);
    if (src === undefined) continue;
    out.push({
      loaded: l,
      part: src.part,
      anchor: `${src.anchor}~`,
      amountKey: src.amountKey,
      isLeg: true,
    });
  }
  return out;
}

interface TransferRun {
  gid: string;
  run_ord: string;
  pair_count: number;
}

/** Incomplete remote batches stay invisible; a later complete run supersedes an earlier one. */
function activeRun(ctx: DeriveContext): TransferRun | undefined {
  return ctx.sql.get<TransferRun>(
    `SELECT r.gid, r.run_ord, r.pair_count FROM transfer_runs r
     WHERE (SELECT count(*) FROM transfer_run_pairs p WHERE p.run = r.gid
       AND p.ordinal >= 0 AND p.ordinal < r.pair_count) = r.pair_count
     ORDER BY r.run_ord DESC, r.gid DESC LIMIT 1`,
  );
}

/** Only native imported transaction anchors release an explicit run's unclaimed rows. */
function releaseState(ctx: DeriveContext): {
  run: TransferRun | undefined;
  released: boolean;
  signature: string;
} {
  const run = activeRun(ctx);
  if (run === undefined) return { run, released: true, signature: "none" };
  const newest = ctx.sql.get<{ anchor: string | null }>(
    "SELECT max(anchor_ord) AS anchor FROM fold_txn_keys WHERE row NOT LIKE 'cashexp:%'",
  )?.anchor;
  const released = newest !== null && newest !== undefined && newest > run.run_ord;
  return { run, released, signature: `${run.gid}:${released ? 1 : 0}` };
}

function storedReleaseState(ctx: DeriveContext): string | undefined {
  return ctx.sql.get<{ v: string }>("SELECT v FROM fold_transfer_env WHERE k = 'release'")?.v;
}

function saveReleaseState(ctx: DeriveContext, state: string): void {
  if (storedReleaseState(ctx) === state) return;
  ctx.sql.write(
    envTable.name,
    "INSERT OR REPLACE INTO fold_transfer_env (k, v) VALUES ('release', ?)",
    state,
  );
}

/** Pin only reciprocal, currently valid pairs. Invalid or collapsed claims consume no row. */
function runGroups(
  ctx: DeriveContext,
  rows: readonly Row[],
  accounts: budget.AccountMatchKeys,
  run: TransferRun,
): Map<string, string> {
  const byGid = new Map(rows.map((r) => [r.loaded.gid, r]));
  const used = new Set<string>();
  const groups = new Map<string, string>();
  for (const p of ctx.sql.all<{ out_gid: string; in_gid: string }>(
    "SELECT out_gid, in_gid FROM transfer_run_pairs WHERE run = ? AND ordinal < ? ORDER BY ordinal",
    run.gid,
    run.pair_count,
  )) {
    const out = byGid.get(p.out_gid);
    const inc = byGid.get(p.in_gid);
    if (!out || !inc || used.has(p.out_gid) || used.has(p.in_gid) || p.out_gid === p.in_gid)
      continue;
    if (out.loaded.account === inc.loaded.account) continue;
    const outAmount = D(out.loaded.amount);
    const inAmount = D(inc.loaded.amount);
    if (!outAmount.isSigned() || outAmount.isZero() || inAmount.isSigned() || inAmount.isZero())
      continue;
    if (out.amountKey === "" || out.amountKey !== inc.amountKey) continue;
    if (
      budget.pairScore(
        {
          key: p.out_gid,
          account: out.loaded.account,
          bookingDate: out.loaded.booking_date,
          amount: outAmount,
          counterpartyIban: out.loaded.counterparty_iban,
        },
        {
          key: p.in_gid,
          account: inc.loaded.account,
          bookingDate: inc.loaded.booking_date,
          amount: inAmount,
          counterpartyIban: inc.loaded.counterparty_iban,
        },
        accounts,
      ) === null
    )
      continue;
    used.add(p.out_gid);
    used.add(p.in_gid);
    groups.set(p.out_gid, p.out_gid);
    groups.set(p.in_gid, p.out_gid);
  }
  return groups;
}

/** Match `rows` (whole amount-key groups) and write what changed; returns the matched rows. */
function matchAndWrite(
  ctx: DeriveContext,
  rows: Row[],
  accounts: budget.AccountMatchKeys,
): Map<string, Row> {
  const candidates = rows.filter((r) => r.amountKey !== "");
  const { run, released } = releaseState(ctx);
  const claimed =
    run === undefined ? new Map<string, string>() : runGroups(ctx, rows, accounts, run);
  // anchor order (D-24.2); anchors are unique, so the order is total
  candidates.sort((a, b) => (a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0));
  const pairs = released
    ? budget.matchTransfers(
        candidates
          .filter((r) => !claimed.has(r.loaded.gid))
          .map((r) => ({
            key: r.loaded.gid,
            account: r.loaded.account,
            bookingDate: r.loaded.booking_date,
            amount: D(r.loaded.amount),
            counterpartyIban: r.loaded.counterparty_iban,
          })),
        accounts,
      )
    : [];
  const group = claimed;
  for (const p of pairs) {
    group.set(p.out, p.out);
    group.set(p.in, p.out);
  }
  const matched = new Map<string, Row>();
  for (const r of rows) {
    const g = group.get(r.loaded.gid) ?? null;
    if (g !== null) matched.set(r.loaded.gid, r);
    const flag = g === null ? 0 : 1;
    if (r.loaded.is_internal_transfer === flag && r.loaded.transfer_group_id === g) continue;
    ctx.sql.write(
      TRANSACTIONS,
      "UPDATE transactions SET is_internal_transfer = ?, transfer_group_id = ? WHERE id = ?",
      flag,
      g,
      r.loaded.id,
    );
    if (r.loaded.is_internal_transfer !== flag) {
      ctx.sql.write(
        flipsTable.name,
        "INSERT OR IGNORE INTO fold_transfer_flips (row) VALUES (?)",
        r.part,
      );
    }
  }
  return matched;
}

/** Store the matched rows of the recomputed keys; drop the rows those keys no longer match. */
function savePairs(
  ctx: DeriveContext,
  matched: Map<string, Row>,
  stored: Map<string, { part: string; amount_key: string }>,
) {
  for (const [gid, r] of matched) {
    const s = stored.get(gid);
    stored.delete(gid);
    if (s !== undefined && s.part === r.part && s.amount_key === r.amountKey) continue;
    ctx.sql.write(
      pairsTable.name,
      "INSERT OR REPLACE INTO fold_transfer_pairs (gid, part, amount_key) VALUES (?, ?, ?)",
      gid,
      r.part,
      r.amountKey,
    );
  }
  for (const gid of stored.keys()) {
    ctx.sql.write(pairsTable.name, "DELETE FROM fold_transfer_pairs WHERE gid = ?", gid);
  }
}

type StoredPair = { gid: string; part: string; amount_key: string };
const byGid = (rows: StoredPair[]) =>
  new Map(rows.map((r) => [r.gid, { part: r.part, amount_key: r.amount_key }]));

function deriveAll(ctx: DeriveContext): void {
  takeLegChanges(ctx); // every row is re-matched below
  const accounts = matchKeys(ctx);
  const matched = matchAndWrite(ctx, allRows(ctx), accounts);
  savePairs(
    ctx,
    matched,
    byGid(ctx.sql.all<StoredPair>("SELECT gid, part, amount_key FROM fold_transfer_pairs")),
  );
  saveSignature(ctx, signature(accounts));
  saveReleaseState(ctx, releaseState(ctx).signature);
}

function deriveParts(ctx: DeriveContext, parts: readonly string[]): void {
  const amountKeys = new Set<string>();
  for (const r of selectIn<{ amount_key: string }>(
    ctx.sql,
    "SELECT amount_key FROM fold_txn_keys WHERE row IN (%IN%)",
    parts,
  )) {
    amountKeys.add(r.amount_key);
  }
  for (const r of selectIn<{ amount_key: string }>(
    ctx.sql,
    "SELECT amount_key FROM fold_transfer_pairs WHERE part IN (%IN%)",
    parts,
  )) {
    amountKeys.add(r.amount_key);
  }
  amountKeys.delete(""); // a zero amount never matches
  if (amountKeys.size === 0) return;
  const keys = [...amountKeys];
  const matched = matchAndWrite(ctx, rowsOfKeys(ctx, keys), matchKeys(ctx));
  savePairs(
    ctx,
    matched,
    byGid(
      selectIn<StoredPair>(
        ctx.sql,
        "SELECT gid, part, amount_key FROM fold_transfer_pairs WHERE amount_key IN (%IN%)",
        keys,
      ),
    ),
  );
}

/**
 * The row partitions whose `is_internal_transfer` flipped since the last call, emptied (the
 * categories deriver re-derives them, S24c).
 */
export function takeTransferFlips(ctx: DeriveContext): string[] {
  const rows = ctx.sql
    .all<{ row: string }>("SELECT row FROM fold_transfer_flips")
    .map((r) => r.row);
  if (rows.length > 0) ctx.sql.write(flipsTable.name, "DELETE FROM fold_transfer_flips");
  return rows;
}

export const transfersDeriver: Deriver = {
  id: "budget.transfers",
  version: 2,
  tables: [pairsTable, envTable, flipsTable],
  writes: [{ table: TRANSACTIONS, columns: ["is_internal_transfer", "transfer_group_id"] }],
  inputs: ["budget.transactions", "budget.transfer_runs", "core.accounts"],
  derive(dirty, ctx) {
    if (dirty.has("budget.transfer_runs")) {
      deriveAll(ctx);
      return;
    }
    if (releaseState(ctx).signature !== storedReleaseState(ctx)) {
      deriveAll(ctx);
      return;
    }
    if (dirty.has("core.accounts") && signature(matchKeys(ctx)) !== storedSignature(ctx)) {
      deriveAll(ctx);
      return;
    }
    const txns = dirty.get("budget.transactions");
    if (txns === "all") {
      deriveAll(ctx);
      return;
    }
    // the source partitions whose cash leg changed (also through an account-only change)
    const parts = [...new Set([...(txns ?? []), ...takeLegChanges(ctx)])];
    if (parts.length === 0) return;
    if (parts.length >= FULL_PASS_MIN) {
      const total = ctx.sql.get<{ n: number }>("SELECT count(*) AS n FROM fold_txn_keys")?.n ?? 0;
      if (parts.length * FULL_PASS_SHARE > total) {
        deriveAll(ctx);
        return;
      }
    }
    deriveParts(ctx, parts);
  },
  deriveAll,
};
