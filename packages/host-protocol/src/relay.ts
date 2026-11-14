// UI-role RPCs of the sync relay of one vault (M4): status, the owner's switch, removing the vault's
// synced data from the relay, and reconnecting this Mac after its relay identity was replaced. The relay is a transport only: what it carries is sealed own-log frames.
// The relay's error kinds mirror `RelayErrorKind` of @cashu/sync (this package imports domain only).
import { z } from "zod";

const vault = z.string().regex(/^[0-9a-f]{32}$/);
const request = z.strictObject({ vault });

export const NATIVE_RELAY_FEATURE = "native.relay.v1";
export const NATIVE_RELAY_METHODS = [
  "native.relay.status",
  "native.relay.enable",
  "native.relay.disable",
  "native.relay.purge",
  "native.relay.reconnect",
  // G2 override: "Keep fetching on this Mac" while the offline bound pauses this Mac's bank fetch.
  "native.relay.keepFetching",
  // "Try now" of a failing membership removal: a relay pass now.
  "native.relay.syncNow",
] as const;

export function uiRelayAllowed(
  method: string,
  minor: number,
  features: readonly string[],
): boolean {
  return (
    minor >= 8 &&
    features.includes(NATIVE_RELAY_FEATURE) &&
    NATIVE_RELAY_METHODS.some((allowed) => allowed === method)
  );
}

const timestamp = z.number().int().nonnegative();
const deviceId = z.string().regex(/^[0-9a-f]{32}$/);

const count = z.number().int().nonnegative();

/**
 * Writer streams held at a frame (D7), value-free: counts per kind. `since` and `passes` describe the
 * oldest `waiting` / `rejected` record (a `final` one is expected and never an error). `device`: the
 * writer the status line names (the oldest rejected stream, else the oldest waiting one), as a device
 * id the window resolves to a name from its device list (an unknown id reads as "another device").
 */
const relayStuckSchema = z.strictObject({
  waiting: count,
  rejected: count,
  final: count,
  since: timestamp.optional(),
  passes: count,
  device: deviceId.optional(),
});

export const relayStatusParamsSchema = request;
/**
 * What the desktop's Sync row needs and nothing more (value-free: no uid, device id or error text).
 * Optional times are absent when they do not apply.
 */
export const relayStatusResultSchema = z.strictObject({
  /** This host has a relay config (absent: every relay surface is hidden). */
  configured: z.boolean(),
  enabled: z.boolean(),
  /** Devices bound to the vault at the relay, phones included (member documents this Mac wrote). */
  devices: count,
  /** When a pass last reached the relay without an error. */
  lastSyncAt: timestamp.optional(),
  /**
   * D6: sync is paused since this time (the first failed relay pass since the last good one); the
   * Mac keeps working meanwhile. Absent while the relay answers.
   */
  pausedSince: timestamp.optional(),
  /** The relay's daily quota ran out: no pass before this time. */
  quotaUntil: timestamp.optional(),
  /** This Mac's relay identity was replaced: its membership is stale until it reconnects. */
  identityLost: z.boolean(),
  /** `native.relay.reconnect` can re-admit this Mac (identity lost and a recovery secret kept). */
  canReconnect: z.boolean(),
  /** D7: streams held at a frame after the last relay pass; absent when every stream moves. */
  stuck: relayStuckSchema.optional(),
  /**
   * Removed devices whose access to the synced data could not be withdrawn at the relay yet (the
   * removal is retried after every pass), value-free: how many, since when it fails, and their
   * device ids, the longest failing first (the window names them from its device list). Absent when
   * none fails.
   */
  removalsFailing: z
    .strictObject({
      devices: count.min(1),
      since: timestamp,
      ids: z.array(deviceId).min(1).max(64),
    })
    .optional(),
});

export const relayActionParamsSchema = request;
export const relayActionResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("done") }),
  z.strictObject({
    kind: z.literal("refused"),
    /**
     * `retry`: the action stopped part way and running it again finishes it (a purge: the switch is
     * off already; a reconnect: this Mac is admin again, the old identity is not removed yet).
     * `no_recovery_secret`: reconnect without the vault's recovery secret on this Mac (enabled
     * before the secret existed, or the keychain lost it): only turning sync off and on helps.
     */
    reason: z.enum(["no_config", "offline", "not_admin", "busy", "retry", "no_recovery_secret"]),
  }),
]);

export type RelayStatusParams = z.infer<typeof relayStatusParamsSchema>;
export type RelayStatusResult = z.infer<typeof relayStatusResultSchema>;
export type RelayActionParams = z.infer<typeof relayActionParamsSchema>;
export type RelayActionResult = z.infer<typeof relayActionResultSchema>;
export type RelayRefusalReason = Extract<RelayActionResult, { kind: "refused" }>["reason"];
