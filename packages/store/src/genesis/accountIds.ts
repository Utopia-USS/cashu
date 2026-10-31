// Account gids and identity keys of genesis (S26 spec 6.2, 6.3; gid.md 4.3, 7, 7.4). The stored
// `external_id` is un-parked (`<key>~<own id>` -> `<key>`); the gid is DET["iban", ibanKey] for an
// IBAN that passes mod-97, else DET["ext", bank, external_id] for a natural key, else the genesis gid.
// Keys: `iban:<ibanKey>` (valid IBAN only, N2) and `ext:<bank>:<external_id>` (natural key, bank
// shaped as a key). Collisions keep the accounts apart: the lowest id keeps its DET gid and keys, a
// later account whose gid or any key is already taken gets its genesis gid and claims no key.
import { ibanKey } from "@cashu/domain";
import { isValidIban } from "../events/v1/identity.js";
import type { DetGid } from "../gid.js";
import type { GenesisCounters } from "./report.js";
import type { AccountRow } from "./rows.js";

export interface AccountIdentity {
  readonly gid: string;
  /** The identity keys `account.opened` claims; empty for a collision loser. */
  readonly keys: readonly string[];
  /** `external_id` with the own park suffix removed (gid.md 4.3: the view derives the parked form). */
  readonly externalId: string | null;
}

/** Name keys and random keys: not identity (gid.md 4.3). */
const NOT_NATURAL = /^(manual|vehicle|brokerage):/;
const BANK_KEY = /^[a-z0-9_-]+$/;
const PARK_SUFFIX = /~([0-9]+)$/;

/** `external_id` without `~<own id>`; a suffix naming another id is kept (`foreign_park_suffix`). */
function unpark(row: AccountRow, tally: (reason: string) => void): string | null {
  const ext = row.externalId;
  if (ext === null) return null;
  const m = PARK_SUFFIX.exec(ext);
  if (m === null) return ext;
  if (m[1] === String(row.id)) return ext.slice(0, ext.length - m[0].length);
  tally("foreign_park_suffix");
  return ext;
}

/**
 * The identity of every account of one vault, by local id (rows in id order). Counts on `accounts`:
 * `iban_invalid`, `bank_not_key`, `foreign_park_suffix`, `account_key_collision`.
 */
export function accountIdentities(
  rows: readonly AccountRow[],
  det: DetGid,
  counters: GenesisCounters,
  ordinal: number,
): ReadonlyMap<number, AccountIdentity> {
  const tally = (reason: string) => counters.addVault(ordinal, "accounts", reason);
  const claimed = new Set<string>();
  const out = new Map<number, AccountIdentity>();
  for (const row of rows) {
    const externalId = unpark(row, tally);
    const natural = externalId !== null && !NOT_NATURAL.test(externalId);
    const ibanOk = row.iban !== null && isValidIban(row.iban);
    if (row.iban !== null && !ibanOk) tally("iban_invalid");
    const keys: string[] = [];
    if (ibanOk) keys.push(`iban:${ibanKey(row.iban)}`);
    if (natural) {
      if (BANK_KEY.test(row.bank)) keys.push(`ext:${row.bank}:${externalId}`);
      else tally("bank_not_key");
    }
    let gid: string | undefined;
    if (ibanOk) gid = det("accounts", ["iban", ibanKey(row.iban)]);
    else if (natural) gid = det("accounts", ["ext", row.bank, externalId]);
    const taken = (gid !== undefined && claimed.has(gid)) || keys.some((k) => claimed.has(k));
    if (taken) tally("account_key_collision");
    if (gid === undefined || taken) {
      out.set(row.id, {
        gid: det("genesis", ["accounts", String(row.id)]),
        keys: [],
        externalId,
      });
      continue;
    }
    claimed.add(gid);
    for (const k of keys) claimed.add(k);
    out.set(row.id, { gid, keys, externalId });
  }
  return out;
}
