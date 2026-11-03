/** Authenticated UI RPC for one-use notification click resolution. Tokens are locators only. */
import { z } from "zod";

export const NOTIFICATION_INTENT_FEATURE = "native.notification.intent.v1";
export const NOTIFICATION_INTENT_METHOD = "native.notification.resolve";

export const notificationResolveParamsSchema = z
  .object({
    requestId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    intentToken: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type NotificationResolveParams = z.infer<typeof notificationResolveParamsSchema>;

export const notificationResolveResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable") }).strict(),
  z
    .object({
      kind: z.literal("target"),
      vaultId: z.string().min(1).max(256),
      target: z.enum(["signal", "signalsSummary", "reviewDigest", "generic"]),
      signalId: z.string().min(1).max(256).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if ((value.target === "signal") !== (value.signalId !== undefined))
        ctx.addIssue({ code: "custom", message: "signal target mismatch" });
    }),
]);
export type NotificationResolveResult = z.infer<typeof notificationResolveResultSchema>;
