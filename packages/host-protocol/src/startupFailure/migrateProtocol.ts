// The `migrate --data-dir <dir> --json` child protocol between Electron main (the parent, "Import my
// data" on the recovery screen) and the host's migration (the child). One JSON object per stdout line:
//   {"event":"progress","stage":"preflight"|"copy"|"import"|"verify"|"cutover"}
//   {"event":"recovery-words","words":"<12-24 lowercase words>"}   the child then reads one stdin
//                                                                 line: "confirm" or "cancel"
//   {"event":"done","status":"migrated"|"already_migrated",...}   last line, exit 0
// `migrate verify --data-dir <dir> --json` prints one final line: done with status "verified" (exit
// 0) or failed (exit 1); it never asks for words.
//   {"event":"failed","code":"<StartupFailureCode>","detail":"..."} last line, exit 1
// Every line is parsed strictly (a trust boundary); anything else, a crash or another exit is an
// `unknown` failure. The words line is the new recovery phrase: it is shown once and never logged.
import { z } from "zod";
import {
  STARTUP_FAILURE_CODES,
  STARTUP_FAILURE_DETAIL_NAMES,
  type StartupFailureDetail,
} from "./codes.js";

/** The stages a migration reports, in order. */
export const MIGRATE_STAGES = ["preflight", "copy", "import", "verify", "cutover"] as const;
export type MigrateStage = (typeof MIGRATE_STAGES)[number];

/** What the parent writes to the child's stdin after a `recovery-words` line. */
export const MIGRATE_CONFIRM = "confirm\n";
export const MIGRATE_CANCEL = "cancel\n";

/** 12 to 24 lowercase words separated by single spaces. */
export const RECOVERY_WORDS = /^[a-z]{1,16}(?: [a-z]{1,16}){11,23}$/;

const count = z.number().int().min(0).max(1_000_000_000);

export const migrateProgressSchema = z.strictObject({
  event: z.literal("progress"),
  stage: z.enum(MIGRATE_STAGES),
});

export const migrateWordsSchema = z.strictObject({
  event: z.literal("recovery-words"),
  words: z.string().regex(RECOVERY_WORDS),
});

export const migrateDoneSchema = z.strictObject({
  event: z.literal("done"),
  status: z.enum(["migrated", "already_migrated", "verified"]),
  profiles: count.optional(),
  financialTables: count.optional(),
  financialRows: count.optional(),
  vaults: count.optional(),
  /** The backup directory's name inside the data dir. */
  backupDir: z
    .string()
    .regex(/^python-backup-[A-Za-z0-9_-]{1,64}$/)
    .optional(),
});

export const migrateFailedSchema = z.strictObject({
  event: z.literal("failed"),
  code: z.enum(STARTUP_FAILURE_CODES),
  detail: z
    .enum(STARTUP_FAILURE_DETAIL_NAMES as [StartupFailureDetail, ...StartupFailureDetail[]])
    .optional(),
});

export const migrateLineSchema = z.discriminatedUnion("event", [
  migrateProgressSchema,
  migrateWordsSchema,
  migrateDoneSchema,
  migrateFailedSchema,
]);
export type MigrateLine = z.infer<typeof migrateLineSchema>;
export type MigrateDone = z.infer<typeof migrateDoneSchema>;
export type MigrateFailed = z.infer<typeof migrateFailedSchema>;

/** One stdout line of the child, or null when it is not exactly one protocol object. */
export function parseMigrateLine(line: string): MigrateLine | null {
  if (line.length > 4096) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = migrateLineSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * What Electron main forwards to the recovery screen while the import runs: a stage, the one-time
 * recovery words (shown until confirmed, never stored), or that the user's cancel took effect. A
 * finished or failed import needs no event: main loads the app or the new recovery screen.
 */
export const recoveryImportEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("progress"), stage: z.enum(MIGRATE_STAGES) }),
  z.strictObject({ kind: z.literal("words"), words: z.string().regex(RECOVERY_WORDS) }),
  z.strictObject({ kind: z.literal("cancelled") }),
]);
export type RecoveryImportEvent = z.infer<typeof recoveryImportEventSchema>;
