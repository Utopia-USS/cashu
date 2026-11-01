// The `admin.*` methods (role `admin`): what `cashu host status`, `cashu host stop` and the updater's
// handover call. Fields added after protocol 1.0 are optional (a 1.0 host omits them).
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
  /** Since 1.1: started in safe mode after a crash loop (reads and commands only, no jobs, no network). */
  safeMode: z.boolean().optional(),
  /** Since 1.1: vault stores open. */
  vaults: z.number().int().nonnegative().optional(),
  /** Since 1.1: write tasks queued or running, all stores together. */
  pendingWrites: z.number().int().nonnegative().optional(),
});
export type AdminStatus = z.infer<typeof adminStatusResultSchema>;

export const adminStopParamsSchema = z.object({});
/** The host stops accepting, finishes its current work, releases the lock and exits 0. */
export const adminStopResultSchema = z.object({ stopping: z.literal(true) });

export const adminHandoverParamsSchema = z.object({});
/**
 * Since 1.1 (feature `admin.handover`): the bundle was replaced by an update. The host stops like
 * `admin.stop` but exits 75, so the service manager (or the next client) starts the new bundle.
 */
export const adminHandoverResultSchema = z.object({ handover: z.literal(true) });
