import { z } from "zod";
import { profileSlugSchema } from "./messages.js";

const hexId = z.string().regex(/^[0-9a-f]{32}$/);
const isoTime = z.string().datetime({ offset: true });

export const nativeCreationPrepareParamsSchema = z.strictObject({
  name: z.string().trim().min(1).max(40),
  slug: profileSlugSchema,
  baseCurrency: z.enum(["PLN", "EUR", "USD", "CHF", "GBP"]),
  modules: z.array(z.enum(["budget", "assets", "loans", "investments"])).max(4),
  mcpPrivacy: z.enum(["strict", "amounts"]),
  deviceAlias: z.string().trim().min(1).max(40).optional(),
});
export type NativeCreationPrepareParams = z.infer<typeof nativeCreationPrepareParamsSchema>;

export const nativeCreationRefusalCodeSchema = z.enum([
  "invalid_input",
  "setup_unavailable",
  "pending_exists",
  "prepare_expired",
  "prepare_missing",
  "operation_conflict",
  "unsafe_target",
]);
const nativeCreationRefusedSchema = z.strictObject({
  kind: z.literal("refused"),
  code: nativeCreationRefusalCodeSchema,
});

export const nativeCreationPrepareResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("prepared"),
    operationId: hexId,
    phraseSession: hexId,
    words: z
      .string()
      .regex(/^[a-z]+(?: [a-z]+){23}$/)
      .max(512),
    expiresAt: isoTime,
  }),
  nativeCreationRefusedSchema,
]);
export type NativeCreationPrepareResult = z.infer<typeof nativeCreationPrepareResultSchema>;

export const nativeCreationCommitParamsSchema = z.strictObject({
  operationId: hexId,
  phraseSession: hexId,
});
export type NativeCreationCommitParams = z.infer<typeof nativeCreationCommitParamsSchema>;

export const nativeCreationInspectParamsSchema = z.strictObject({ operationId: hexId });
export type NativeCreationInspectParams = z.infer<typeof nativeCreationInspectParamsSchema>;
export const nativeCreationCurrentParamsSchema = z.strictObject({});
export type NativeCreationCurrentParams = z.infer<typeof nativeCreationCurrentParamsSchema>;

export const nativeCreationStageSchema = z.enum([
  "recorded",
  "keys",
  "artifacts",
  "history",
  "admission",
  "publishing",
]);
const pending = z.strictObject({
  kind: z.literal("pending"),
  operationId: hexId,
  stage: nativeCreationStageSchema,
});
const outcomeUnknown = z.strictObject({
  kind: z.literal("outcome_unknown"),
  operationId: hexId,
  stage: nativeCreationStageSchema,
});
const ready = z.strictObject({
  kind: z.literal("ready"),
  operationId: hexId,
  vaultId: hexId,
  profileSlug: profileSlugSchema,
  reconnectRequired: z.literal(true),
});
const notFound = z.strictObject({ kind: z.literal("not_found"), operationId: hexId });
const none = z.strictObject({ kind: z.literal("none") });

export const nativeCreationStatusSchema = z.discriminatedUnion("kind", [
  pending,
  outcomeUnknown,
  ready,
  notFound,
  none,
]);
export type NativeCreationStatus = z.infer<typeof nativeCreationStatusSchema>;
export type NativeCreationReady = z.infer<typeof ready>;
export const nativeCreationCommitResultSchema = z.discriminatedUnion("kind", [
  ready,
  outcomeUnknown,
  nativeCreationRefusedSchema,
]);
export type NativeCreationCommitResult = z.infer<typeof nativeCreationCommitResultSchema>;
export const nativeCreationInspectResultSchema = z.discriminatedUnion("kind", [
  pending,
  outcomeUnknown,
  ready,
  notFound,
]);
export type NativeCreationInspectResult = z.infer<typeof nativeCreationInspectResultSchema>;
export const nativeCreationCurrentResultSchema = z.discriminatedUnion("kind", [
  pending,
  outcomeUnknown,
  ready,
  none,
]);
export type NativeCreationCurrentResult = z.infer<typeof nativeCreationCurrentResultSchema>;
