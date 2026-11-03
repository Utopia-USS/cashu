import { z } from "zod";

export const updateBridgeStatus = z.discriminatedUnion("availability", [
  z.strictObject({ availability: z.literal("unavailable") }),
  z.strictObject({
    availability: z.literal("ready"),
    current: z.string().max(64),
    latest: z.string().max(64).nullable(),
    url: z.null(),
    branchAvailable: z.boolean(),
    manualCheck: z.boolean(),
    app: z
      .strictObject({
        stage: z.enum([
          "available",
          "checking",
          "downloading",
          "installing",
          "up_to_date",
          "error",
        ]),
        version: z.string().max(64).nullable(),
        progress: z.number().finite().min(0).max(100).nullable(),
        error: z.string().max(80).nullable(),
      })
      .nullable(),
  }),
]);
export const updateBridgeOutcome = z.strictObject({
  kind: z.enum(["completed", "refused", "outcome_unknown"]),
  reason: z.string().max(80).optional(),
});
export const updateBridgeAction = z.enum(["check", "install", "skip", "dismiss", "auto"]);
export const updateBridgeDescriptor = z.strictObject({
  schema: z.literal(1),
  socket: z.string().min(1).max(1024),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  session: z.string().uuid(),
  build: z.string().min(1).max(128),
  bundle: z.string().min(1).max(4096),
  pid: z.number().int().positive(),
});
export const updateBridgeClientFrame = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("hello"),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    session: z.string().uuid(),
    build: z.string().max(128),
    bundle: z.string().max(4096),
  }),
  z.strictObject({
    t: z.literal("action"),
    id: z
      .number()
      .int()
      .min(1)
      .max(2 ** 31 - 1),
    action: updateBridgeAction,
    enabled: z.boolean().optional(),
  }),
]);
export const updateBridgeServerFrame = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("ready"),
    session: z.string().uuid(),
    build: z.string().max(128),
    bundle: z.string().max(4096),
    status: updateBridgeStatus,
  }),
  z.strictObject({ t: z.literal("status"), status: updateBridgeStatus }),
  z.strictObject({
    t: z.literal("result"),
    id: z
      .number()
      .int()
      .min(1)
      .max(2 ** 31 - 1),
    outcome: updateBridgeOutcome,
  }),
]);

export type UpdateBridgeDescriptor = z.infer<typeof updateBridgeDescriptor>;
export type UpdateBridgeClientFrame = z.infer<typeof updateBridgeClientFrame>;
export type UpdateBridgeServerFrame = z.infer<typeof updateBridgeServerFrame>;
