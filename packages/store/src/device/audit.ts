// Device-local MCP audit commands (D6): declared argument names/types only, never values.
import { z } from "zod";
import { ok, refuse } from "../command.js";
import { vaultId } from "../events/v1/primitives.js";
import { defineDeviceCommand } from "./store.js";

const summary = z
  .record(
    z.string(),
    z.union([
      z.enum(["null", "boolean", "integer", "number", "string", "array", "object", "other"]),
      z.int().nonnegative(),
    ]),
  )
  .refine((value) =>
    Object.entries(value).every(([key, item]) => typeof item !== "number" || key === "_unknown"),
  );
export const startMcpCall = defineDeviceCommand({
  id: "device.startMcpCall",
  input: z.object({
    vault: vaultId,
    tool: z.string().min(1).max(80),
    calledAt: z.iso.datetime(),
    args: summary,
  }),
  run(ctx, input) {
    return ok({ id: ctx.startMcpCall(input) });
  },
});
export const finishMcpCall = defineDeviceCommand({
  id: "device.finishMcpCall",
  input: z.object({
    id: z.int().positive(),
    vault: vaultId,
    privacy: z.enum(["strict", "amounts"]),
    outcome: z.enum(["ok", "error", "refused"]),
    errorKind: z
      .string()
      .regex(/^[a-z_]+$/)
      .nullable()
      .default(null),
    durationMs: z.int().nonnegative(),
  }),
  run(ctx, input) {
    return ctx.finishMcpCall(input) ? ok(null) : refuse("no_call");
  },
});
