// TRANSITIONAL(S49): test helpers of the sync bridge (S31a). Synthetic outbox rows and a vault input
// over in-memory maps; never real data.

import type { GidResolver } from "../../genesis/ids.js";
import type { GenesisFiles } from "../../genesis/source.js";
import { detGidFor, mintUlid, vaultSalt } from "../../gid.js";
import type { OutboxRow } from "../outbox.js";
import type { BridgePorts, CurrentRows, VaultInput } from "../resolve.js";

export const VAULT = "0123456789abcdef0123456789abcdef";
export const SALT = vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => i));
export const DET = detGidFor(SALT);
export const T0 = "2026-03-01 10:00:00.000000";
export const T1 = "2026-03-02 11:30:00.250000";

let nextId = 1;

/** A local outbox row with defaults (profile 1, txn "t1", insert, no prev / key / post). */
export function outboxRow(p: Partial<OutboxRow> & Pick<OutboxRow, "table" | "localId">): OutboxRow {
  return {
    id: p.id ?? nextId++,
    ts: p.ts ?? T1,
    txn: p.txn ?? "t1",
    profileId: p.profileId === undefined ? 1 : p.profileId,
    op: p.op ?? "insert",
    gid: p.gid ?? null,
    fields: p.fields ?? {},
    prev: p.prev ?? null,
    key: p.key ?? null,
    post: p.post ?? null,
    origin: "local",
    table: p.table,
    localId: p.localId,
  };
}

/** A resolver over `table|localId -> gid` entries (Python's `sync_ids` stand-in). */
export function idsOf(entries: Readonly<Record<string, string>>): GidResolver {
  return { gid: (table, localId) => entries[`${table}|${localId}`] };
}

const NO_FILES: GenesisFiles = { read: () => undefined, list: () => [] };

/** A vault input for profile 1 (ordinal 0) with the given `sync_ids` and live rows. */
export function vaultInput(
  syncIds: GidResolver,
  current: () => CurrentRows = () => {
    throw new Error("this test reads no live rows");
  },
  fieldClock: VaultInput["fieldClock"] = () => undefined,
): VaultInput {
  return {
    ordinal: 0,
    profileId: 1,
    vault: VAULT,
    salt: SALT,
    syncIds,
    current,
    files: NO_FILES,
    fieldClock,
  };
}

/** Deterministic ports: ULIDs from a counter, leader unless told otherwise. */
export function testPorts(leader = true): BridgePorts & { readonly minted: string[] } {
  let n = 0;
  const minted: string[] = [];
  return {
    minted,
    ulid() {
      n += 1;
      const id = mintUlid(Date.UTC(2026, 2, 1) + n, (k) => new Uint8Array(k).fill(n % 256));
      minted.push(id);
      return id;
    },
    isLeader: () => leader,
  };
}
