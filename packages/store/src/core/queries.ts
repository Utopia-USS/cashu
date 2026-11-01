// Typed reads of the core view tables the commands need (gid in, gid out). A query takes the
// vault's read function (`CommandContext.read`, `Store.read`), so it never spans two vaults.
import { defineQuery } from "../query.js";
import type { SqlValue } from "../sql/driver.js";

export type Read = <R>(sql: string, ...params: SqlValue[]) => R[];

export interface AccountView {
  readonly gid: string;
  readonly bank: string;
  readonly name: string;
  /** The raw IBAN as claimed (events.md 6.4): shown and exported, may fail the checksum. */
  readonly iban: string | null;
  /** The key of the account's identity IBAN (checksum-valid, N2); null when `iban` is raw only. */
  readonly ibanKey: string | null;
  readonly externalId: string | null;
  readonly currency: string;
  readonly type: string;
  readonly removed: boolean;
}

const ACCOUNT_COLUMNS =
  "gid, bank, name, iban, iban_key AS ibanKey, external_id AS externalId, currency, type, removed_at IS NOT NULL AS removed";

type AccountRow = Omit<AccountView, "removed"> & { removed: number };
const toView = (r: AccountRow): AccountView => ({ ...r, removed: r.removed === 1 });

/** The account row whose gid is `gid` (the view shows identity roots). */
export function accountByGid(read: Read, gid: string): AccountView | undefined {
  const r = read<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE gid = ?`, gid)[0];
  return r === undefined ? undefined : toView(r);
}

/**
 * The account row a member gid belongs to: identity resolution may have folded `gid` into another
 * account (events.md 6.4); the view shows the root.
 */
export function accountByMemberGid(read: Read, gid: string): AccountView | undefined {
  const root =
    read<{ root: string }>(
      "SELECT root FROM identity_roots WHERE kind = 'accounts' AND gid = ?",
      gid,
    )[0]?.root ?? gid;
  return accountByGid(read, root);
}

/**
 * The account whose IBAN has key `key` (core/text.py `iban_key`), across banks (gid.md 4.3, R-3):
 * the holder of that identity key, else an account showing only a raw IBAN (failing the checksum)
 * with that key, as Python `get_or_create_account` matches it. Writer-side routing only: the raw
 * match never claims a key or merges accounts (N2). Several: the smallest gid (m12).
 */
export function accountByIbanKey(read: Read, key: string): AccountView | undefined {
  if (!key) return undefined;
  const r =
    read<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE iban_key = ? ORDER BY gid LIMIT 1`,
      key,
    )[0] ??
    read<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE iban_key IS NULL AND iban_match = ?
       ORDER BY gid LIMIT 1`,
      key,
    )[0];
  return r === undefined ? undefined : toView(r);
}

/**
 * The identity IBAN keys of every account of the vault (removed ones included; checksum-valid only,
 * N2). Not the match set of transfers and categories: those use Python's `own_ibans` over the raw
 * `iban` column (lead decision D-08.1, events.md 6.4; `budgetEngineContext`).
 */
export function ownIbanKeys(read: Read): Set<string> {
  return new Set(
    read<{ iban_key: string }>("SELECT iban_key FROM accounts WHERE iban_key IS NOT NULL").map(
      (r) => r.iban_key,
    ),
  );
}

/**
 * The account of `bank` showing external id `externalId` (a parked key never matches); several
 * (name keys held by several live accounts, m12): the smallest gid.
 */
export function accountByExternalKey(
  read: Read,
  bank: string,
  externalId: string,
): AccountView | undefined {
  const r = read<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE bank = ? AND external_id = ? ORDER BY gid LIMIT 1`,
    bank,
    externalId,
  )[0];
  return r === undefined ? undefined : toView(r);
}

/** Live accounts with this exact name, oldest first (Python orders by id: the fold order of the open). */
export function liveAccountsNamed(read: Read, name: string): AccountView[] {
  return read<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE name = ? AND removed_at IS NULL ORDER BY id`,
    name,
  ).map(toView);
}

export interface ProfileView {
  readonly name: string;
  readonly baseCurrency: string;
  readonly mcpPrivacy: string;
}

export function profileOf(read: Read): ProfileView | undefined {
  return read<ProfileView>(
    "SELECT name, base_currency AS baseCurrency, mcp_privacy AS mcpPrivacy FROM profiles",
  )[0];
}

/** The current vault's profile (null before `profile.created` was folded). */
export const profile = defineQuery({
  id: "core.profile",
  run: (read): ProfileView | null => profileOf(read) ?? null,
});

/** Module ids whose register is enabled. */
export function enabledModuleIds(read: Read): Set<string> {
  return new Set(
    read<{ module_id: string }>("SELECT module_id FROM profile_modules WHERE enabled = 1").map(
      (r) => r.module_id,
    ),
  );
}
