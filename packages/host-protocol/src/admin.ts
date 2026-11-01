// The `admin.*` methods (role `admin`): what `cashu host status` and `cashu host stop` call.
import { z } from "zod";
import { dataDirIdSchema, ROLES } from "./messages.js";
import { protocolVersionSchema } from "./version.js";

export const adminStatusParamsSchema = z.object({});

export const adminStatusResultSchema = z.object({
  pid: z.number().int().positive(),
  build: z.string().min(1).max(200),
  protocol: protocolVersionSchema,
  startedAt: z.iso.datetime(),
  dataDir: dataDirIdSchema,
  /** Open sessions per role (this one included). */
  sessions: z.record(z.enum(ROLES), z.number().int().nonnegative()),
  stopping: z.boolean(),
});
export type AdminStatus = z.infer<typeof adminStatusResultSchema>;

export const adminStopParamsSchema = z.object({});
/** The host stops accepting, finishes its current work, releases the lock and exits 0. */
export const adminStopResultSchema = z.object({ stopping: z.literal(true) });
