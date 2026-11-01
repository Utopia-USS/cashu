// The `admin.*` methods (role `admin`): what `cashu host status`, `cashu host stop` and the updater's
// handover call. Fields added after protocol 1.0 are optional (a 1.0 host omits them).
import { z } from "zod";
import { dataDirIdSchema, ROLES } from "./messages.js";
import { protocolVersionSchema } from "./version.js";

export const adminStatusParamsSchema = z.object({});

/**
 * The sync service's state: `off` (no bridge configured), `refused` (the configuration or the keys
 * were refused), `safe-mode` (not started after a crash loop), `uninitialized` (no linked vault yet),
 * `idle` / `running`, `blocked` (a row the bridge cannot map stops the loop until it is fixed: D4),
 * `error` (the last iteration failed; retried), `stopped`.
 */
export const SYNC_STATES = [
  "off",
  "refused",
  "safe-mode",
  "uninitialized",
  "idle",
  "running",
  "blocked",
  "error",
  "stopped",
] as const;

/** Per vault, by ordinal (never a vault id or a profile slug). */
export const syncVaultStatusSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  /** Whether this device acts as the vault's fetch leader (ships leader-emitted events). */
  leader: z.boolean(),
  /** A shipped plan whose ack is outstanding (recovered at the next iteration). */
  intentOpen: z.boolean(),
  /** How far the other devices' events were piped into Python (log sequence). */
  pipeSeq: z.number().int().nonnegative(),
});

export const syncStatusSchema = z.object({
  state: z.enum(SYNC_STATES),
  /** A short code: the block or refusal reason, the failed step's error class. */
  reason: z.string().max(64).optional(),
  /** Python outbox rows not yet shipped. */
  pending: z.number().int().nonnegative().optional(),
  lastRunAt: z.iso.datetime().optional(),
  vaults: z.array(syncVaultStatusSchema).max(10_000),
});
export type SyncStatus = z.infer<typeof syncStatusSchema>;

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
  /** Feature `sync.status` (S56c): the host's outbox bridge and sync carrier service. */
  sync: syncStatusSchema.optional(),
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
