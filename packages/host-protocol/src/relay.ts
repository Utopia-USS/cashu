// UI-role RPCs of the sync relay of one vault (M4): status, the owner's switch, and removing the vault's
// synced data from the relay. The relay is a transport only: what it carries is sealed own-log frames.
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

/** Why the relay last failed, value-free; undefined once a later call succeeded. */
export const relayErrorKindSchema = z.enum([
  "unavailable",
  "quota",
  "forbidden",
  "relay-identity-lost",
]);

export const relayStatusSchema = z.strictObject({
  lastOk: timestamp.optional(),
  lastError: relayErrorKindSchema.optional(),
  lastErrorAt: timestamp.optional(),
});

const count = z.number().int().nonnegative();

/**
 * Writer streams held at a frame (D7), value-free: counts per kind. `since` and `passes` describe the
 * oldest `waiting` / `rejected` record (a `final` one is expected and never an error).
 */
const relayStuckSchema = z.strictObject({
  waiting: count,
  rejected: count,
  final: count,
  since: timestamp.optional(),
  passes: count,
});

export const relayStatusParamsSchema = request;
export const relayStatusResultSchema = z.strictObject({
  /** This host has a relay config (absent: every relay surface is hidden). */
  configured: z.boolean(),
  enabled: z.boolean(),
  status: relayStatusSchema,
  /** Devices bound to the vault at the relay (member documents this Mac wrote). */
  devices: z.number().int().nonnegative(),
  /** When a pass last reached the relay without an error. */
  lastSyncAt: timestamp.optional(),
  /**
   * D6: sync is paused since this time (the first failed relay pass since the last good one); the
   * Mac keeps working meanwhile. Absent while the relay answers.
   */
  pausedSince: timestamp.optional(),
  /** D7: streams held at a frame after the last relay pass; absent when every stream moves. */
  stuck: relayStuckSchema.optional(),
});

export const relayActionParamsSchema = request;
export const relayActionResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("done") }),
  z.strictObject({
    kind: z.literal("refused"),
    /** `retry`: a purge stopped part way (the switch is off already; running it again finishes it). */
    reason: z.enum(["no_config", "offline", "not_admin", "busy", "retry"]),
  }),
]);

export type RelayErrorKindValue = z.infer<typeof relayErrorKindSchema>;
export type RelayStatusValue = z.infer<typeof relayStatusSchema>;
export type RelayStatusParams = z.infer<typeof relayStatusParamsSchema>;
export type RelayStatusResult = z.infer<typeof relayStatusResultSchema>;
export type RelayActionParams = z.infer<typeof relayActionParamsSchema>;
export type RelayActionResult = z.infer<typeof relayActionResultSchema>;
export type RelayRefusalReason = Extract<RelayActionResult, { kind: "refused" }>["reason"];
