import { z } from "zod";

const id = z.string().regex(/^[0-9a-f]{32}$/);
const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const cursor = z.strictObject({ seg: z.number().int().min(1), offset: z.number().int().min(0) });
const deviceIds = z
  .array(id)
  .min(1)
  .max(1024)
  .refine((ids) => ids.every((value, index) => index === 0 || (ids[index - 1] ?? "") < value));

export const NATIVE_DEVICES_FEATURE = "native.devices.v1";
export const NATIVE_DEVICES_METHODS = [
  "native.devices.list",
  "native.devices.revokePreview",
  "native.devices.revokeCommit",
  "native.devices.revokeInspect",
  "native.devices.revokeCancel",
] as const;

export function uiDevicesAllowed(
  method: string,
  minor: number,
  features: readonly string[],
): boolean {
  return (
    minor >= 6 &&
    features.includes(NATIVE_DEVICES_FEATURE) &&
    NATIVE_DEVICES_METHODS.some((allowed) => allowed === method)
  );
}

export const deviceRefusalSchema = z.strictObject({
  kind: z.literal("refused"),
  code: z.enum([
    "invalid_input",
    "unavailable",
    "unknown_vault",
    "unsafe_target",
    "retirement_unavailable",
    "integrity_failure",
    "authority_required",
    "recovery_invalid",
    "preview_missing",
    "preview_expired",
    "preview_stale",
    "confirmation_required",
    "recertify_capacity",
    "operation_conflict",
    "outcome_unknown",
  ]),
});

export const deviceListParamsSchema = z.strictObject({ vault: id });
export const deviceListResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ready"),
    vault: id,
    ownDevice: id,
    operations: z
      .array(z.strictObject({ operationId: ulid, phase: z.enum(["may_append", "completed"]) }))
      .max(16),
    evidence: z.strictObject({
      historyPending: z.boolean(),
      overflow: z.boolean(),
      authorityUncertain: z.boolean(),
      writeAdmission: z.enum([
        "ready",
        "own-tail-uncertain",
        "authority-unresolved",
        "rolled-back",
      ]),
    }),
    devices: z
      .array(
        z.strictObject({
          id,
          name: z.string().max(80),
          trusted: z.boolean(),
          revoked: z.boolean(),
          behind: z.boolean(),
          forked: z.boolean(),
        }),
      )
      .max(1024),
  }),
  deviceRefusalSchema,
]);

export const revokePreviewParamsSchema = z.strictObject({
  vault: id,
  targets: deviceIds,
  recertify: z.array(id).max(1024),
});
const revokeTargetSchema = z.strictObject({
  device: id,
  cut: cursor,
  head: z.enum(["trusted", "local_start"]),
});
export const revokePreviewResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("prepared"),
    vault: id,
    token: id,
    operationId: ulid,
    expiresAt: z.number().int().nonnegative(),
    targets: z.array(revokeTargetSchema).min(1).max(1024),
    affected: z
      .array(z.strictObject({ device: id, name: z.string().max(80), selected: z.boolean() }))
      .max(1024),
    warning: z.literal("unseen_writes_possible"),
    localStartConfirmationRequired: z.boolean(),
  }),
  deviceRefusalSchema,
]);

export const revokeCommitParamsSchema = z.strictObject({
  vault: id,
  token: id,
  warningAcknowledgement: z.literal("revoke_risk_acknowledged"),
  localStartAcknowledgement: z.literal("local_target_stream_never_seen").optional(),
  recoveryPhrase: z.string().min(40).max(512),
});
export const revokeCommitResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("completed"), operationId: ulid }),
  z.strictObject({ kind: z.literal("outcome_unknown"), operationId: ulid }),
  deviceRefusalSchema,
]);
export const revokeInspectParamsSchema = z.strictObject({ vault: id, operationId: ulid });
export const revokeInspectResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("completed"), operationId: ulid }),
  z.strictObject({ kind: z.literal("outcome_unknown"), operationId: ulid }),
  z.strictObject({ kind: z.literal("not_started"), operationId: ulid }),
  z.strictObject({ kind: z.literal("not_found"), operationId: ulid }),
  deviceRefusalSchema,
]);
export const revokeCancelParamsSchema = z.strictObject({ vault: id, token: id });
export const revokeCancelResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cancelled") }),
  deviceRefusalSchema,
]);

export type RevokePreviewParams = z.infer<typeof revokePreviewParamsSchema>;
export type RevokePreviewResult = z.infer<typeof revokePreviewResultSchema>;
export type RevokeCommitParams = z.infer<typeof revokeCommitParamsSchema>;
export type RevokeCommitResult = z.infer<typeof revokeCommitResultSchema>;
export type RevokeInspectParams = z.infer<typeof revokeInspectParamsSchema>;
export type RevokeInspectResult = z.infer<typeof revokeInspectResultSchema>;
export type RevokeCancelParams = z.infer<typeof revokeCancelParamsSchema>;
export type RevokeCancelResult = z.infer<typeof revokeCancelResultSchema>;
export type DeviceListParams = z.infer<typeof deviceListParamsSchema>;
export type DeviceListResult = z.infer<typeof deviceListResultSchema>;
