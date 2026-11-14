import { z } from "zod";

const vault = z.string().regex(/^[0-9a-f]{32}$/);
const operationId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const request = z.strictObject({ vault });
const operation = request.extend({ operationId });
const refusal = z.strictObject({
  kind: z.literal("refused"),
  code: z.enum([
    "unavailable",
    "not_trusted",
    "capacity",
    "expired",
    "invalid",
    "busy",
    "outcome_unknown",
    // The vault's sync is switched off on this Mac / this build has no sync config (invite only).
    "relay_off",
    "no_config",
  ]),
});

export const NATIVE_PAIRING_FEATURE = "native.pairing.v1";
export const NATIVE_PAIRING_METHODS = [
  "native.pairing.invite",
  "native.pairing.confirm",
  "native.pairing.inspect",
  "native.pairing.cancel",
] as const;

export function uiPairingAllowed(
  method: string,
  minor: number,
  features: readonly string[],
): boolean {
  return (
    minor >= 7 &&
    features.includes(NATIVE_PAIRING_FEATURE) &&
    NATIVE_PAIRING_METHODS.some((allowed) => allowed === method)
  );
}

export const pairingInviteParamsSchema = request;
export const pairingInviteResultSchema = z.union([
  z.strictObject({
    kind: z.literal("ready"),
    operationId,
    qr: z.string().min(1).max(2_048),
    expiresAt: z.number().int().nonnegative(),
  }),
  refusal,
]);
export const pairingConfirmParamsSchema = operation.extend({
  code: z.string().regex(/^[0-9]{6}$/),
});
export const pairingConfirmResultSchema = z.union([
  z.strictObject({
    kind: z.literal("completed"),
    operationId,
    device: z.string().regex(/^[0-9a-f]{32}$/),
  }),
  /**
   * The phone is admitted (member of the vault, device.added in the log) but its first sync has not
   * reached this Mac yet: the desktop says so and polls `inspect` until `completed`.
   */
  z.strictObject({
    kind: z.literal("waiting_for_phone"),
    operationId,
    device: z.string().regex(/^[0-9a-f]{32}$/),
  }),
  z.strictObject({ kind: z.literal("outcome_unknown"), operationId }),
  refusal,
]);
export const pairingInspectParamsSchema = operation;
export const pairingInspectResultSchema = z.union([
  z.strictObject({
    kind: z.enum(["pending", "waiting_for_phone", "completed", "outcome_unknown", "not_started"]),
    operationId,
  }),
  refusal,
]);
export const pairingCancelParamsSchema = operation;
export const pairingCancelResultSchema = z.strictObject({ kind: z.enum(["cancelled", "refused"]) });

export type PairingInviteParams = z.infer<typeof pairingInviteParamsSchema>;
export type PairingInviteResult = z.infer<typeof pairingInviteResultSchema>;
export type PairingConfirmParams = z.infer<typeof pairingConfirmParamsSchema>;
export type PairingConfirmResult = z.infer<typeof pairingConfirmResultSchema>;
export type PairingInspectParams = z.infer<typeof pairingInspectParamsSchema>;
export type PairingInspectResult = z.infer<typeof pairingInspectResultSchema>;
export type PairingCancelParams = z.infer<typeof pairingCancelParamsSchema>;
export type PairingCancelResult = z.infer<typeof pairingCancelResultSchema>;
