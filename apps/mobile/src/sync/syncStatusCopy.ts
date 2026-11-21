// A vault's sync status as the screens show it (pure): the quiet line in Today's banner slot and the
// states that need the owner (removed, sync turned off on the Mac, a profile that does not open).
// Removed vs turned off: both make the relay refuse this phone (members/{uid} deleted); only a removed
// phone is revoked in the vault's own registry (phase `removed`). Never an automatic wipe: a relay
// outage must not look like either.
import type { VaultSyncStatus } from "../services/vaultEngine";

/** Writer frames this phone cannot read yet (`waiting`) or after repeated passes (`failed`). */
interface StuckSummary {
  /** The writing device's registry name; undefined while the registry cannot name it (the line then
   * says "another device", never an id). */
  readonly device?: string;
  readonly failed: boolean;
}

/**
 * The stuck writer the line speaks of: one that failed (`rejected` / `final`: retrying does not help)
 * before one that waits for its key or registry entry, the longest stuck first. A writer the registry
 * cannot name yet counts too (its line names no device).
 */
function stuckSummaryOf(status: VaultSyncStatus): StuckSummary | undefined {
  let pick: (StuckSummary & { readonly since: number }) | undefined;
  for (const writer of status.stuck ?? []) {
    const candidate = {
      ...(writer.name === undefined ? {} : { device: writer.name }),
      failed: writer.kind !== "waiting",
      since: writer.since,
    };
    if (
      pick === undefined ||
      (candidate.failed && !pick.failed) ||
      (candidate.failed === pick.failed && candidate.since < pick.since)
    ) {
      pick = candidate;
    }
  }
  if (pick === undefined) return undefined;
  return pick.device === undefined
    ? { failed: pick.failed }
    : { device: pick.device, failed: pick.failed };
}

export type SyncLine =
  | { readonly kind: "replay"; readonly percent: number }
  | { readonly kind: "stuck"; readonly device?: string; readonly failed: boolean }
  | { readonly kind: "quota" }
  | { readonly kind: "paused"; readonly since: number };

export type VaultNotice =
  | { readonly kind: "removed" }
  | { readonly kind: "syncOff" }
  | { readonly kind: "needsRepair" };

/** How long a full replay runs before its line shows (the designer: "longer than about 1 s"). */
export const REPLAY_LINE_AFTER_MS = 1000;

/** The vault states that ask the owner something; null when sync just works (or merely waits). */
export function vaultNoticeOf(status: VaultSyncStatus | undefined): VaultNotice | null {
  if (status === undefined) return null;
  if (status.phase === "removed") return { kind: "removed" };
  if (
    status.phase === "failed" &&
    status.failure !== undefined &&
    status.failure !== "relay_unreachable"
  ) {
    // Files or keys that do not open: only a re-pairing (or removing the copy) repairs them.
    if (REPAIR_CODES.has(status.failure) || status.failure.startsWith("keystore_")) {
      return { kind: "needsRepair" };
    }
  }
  if (status.relay?.lastError === "forbidden") return { kind: "syncOff" };
  return null;
}

const REPAIR_CODES = new Set(["needs_repair", "keyring_unreadable", "vault_keyring_missing"]);

/**
 * The quiet status line, most specific first: the replay check (only once it ran longer than
 * `REPLAY_LINE_AFTER_MS`, `replayShown`), changes that can't be read (the engine's stuck writers), today's limit, paused. Null when a
 * notice speaks for the vault or nothing is worth a line.
 */
export function syncLineOf(
  status: VaultSyncStatus | undefined,
  options: { readonly replayShown: boolean },
): SyncLine | null {
  if (status === undefined || !status.remote) return null;
  if (vaultNoticeOf(status) !== null) return null;
  const replay = status.replay;
  if (options.replayShown && replay !== undefined && replay.total > 0) {
    return {
      kind: "replay",
      percent: Math.min(100, Math.floor((replay.done / replay.total) * 100)),
    };
  }
  const stuck = stuckSummaryOf(status);
  if (stuck !== undefined) return { kind: "stuck", ...stuck };
  const relay = status.relay;
  if (relay?.lastError === "quota") return { kind: "quota" };
  if (relay?.lastError === "unavailable" || relay?.lastError === "relay-identity-lost") {
    // Paused since the last call that worked; never reached this launch: since the first failure seen.
    const since = relay.lastOk ?? relay.lastErrorAt;
    if (since !== undefined) return { kind: "paused", since };
  }
  return null;
}
