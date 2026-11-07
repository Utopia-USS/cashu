// The `migrate --data-dir <dir> --json` child protocol between Electron main (the parent, "Import my
// data" on the recovery screen) and the host's migration (the child). One JSON object per stdout line:
//   {"event":"progress","stage":"preflight"|"copy"|"import"|"verify"|"cutover"}
//   {"event":"recovery-words","words":"<12-24 lowercase words>"}   the child then reads one stdin
//                                                                 line: "confirm" or "cancel"
//   {"event":"done","status":"migrated"|"already_migrated",...}   last line, exit 0
//     (migrated / verified also carry `unpriced`: the imported instruments the app cannot value yet,
//     public tickers / ISINs / instrument names only; absent when that check could not run.
//     `migrated` and `already_migrated` also carry `mcpProfiles`, the imported profile slugs the
//     parent builds the `claude mcp remove` / `add` lines from, and `agents`, what became of the
//     retired Python app's launchd worker agents: an already imported folder retries that step)
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

/** Most unpriced instruments one `done` line names (the child sends at most this many). */
export const MIGRATE_UNPRICED_MAX = 200;
/** Longest instrument label on the protocol (the child shortens longer names). */
export const MIGRATE_UNPRICED_LABEL_MAX = 64;
/** Longest protocol line (in UTF-16 code units, as the parent reads it). */
const MIGRATE_LINE_MAX = 32_768;
/** Most profile slugs one `done` line names (`mcpProfiles`). */
export const MIGRATE_MCP_PROFILES_MAX = 64;
/**
 * Room a `done` line keeps for its fields other than `unpriced` (status, counts, backupDir, at most
 * MIGRATE_MCP_PROFILES_MAX slugs of 64 characters, the agents result).
 */
const MIGRATE_DONE_FIELDS_MAX = 6_144;

/**
 * A profile slug as the MCP lines use it (`cashu-<slug>`, `--profile <slug>`): the Python app's
 * slugify output (`[a-z0-9-]`, at most 40) and the conservative superset a configured slug may use.
 */
export const MIGRATE_PROFILE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The launchd worker agents the retired Python app installed (`io.utopiasoft.cashu.worker`, and the
 * pre-rename `io.github.synszakala.finanse.worker`), plists at `<agents dir>/<label>.plist`. After the
 * import they are booted out and their plists removed; nothing else (never the native host agent
 * `io.utopiasoft.cashu.host`) is ever touched.
 */
export const PYTHON_AGENT_LABELS = [
  "io.utopiasoft.cashu.worker",
  "io.github.synszakala.finanse.worker",
] as const;
export type PythonAgentLabel = (typeof PYTHON_AGENT_LABELS)[number];

/**
 * What became of each Python agent: `retired` (booted out when allowed, plist removed), `absent` (no
 * plist), `failed` (finish by hand), `skipped` (the real agents dir was not ours to touch: a test or
 * source run, a test build, or an import into another data dir than the account's default one).
 * `bootout` is `ran` when launchctl booted out every present agent (the real agents dir, a packaged
 * app outside tests) and `skipped` when it was not used (a custom agents dir: plists removed only).
 */
export const pythonAgentRetirementSchema = z.strictObject({
  bootout: z.enum(["ran", "skipped"]),
  agents: z
    .array(
      z.strictObject({
        label: z.enum(PYTHON_AGENT_LABELS),
        state: z.enum(["retired", "absent", "failed", "skipped"]),
      }),
    )
    .max(PYTHON_AGENT_LABELS.length),
});
export type PythonAgentRetirement = z.infer<typeof pythonAgentRetirementSchema>;

/** The commands that retire one Python agent by hand (docs/migration-runbook.md step 4.2). */
export function retirePythonAgentCommands(label: PythonAgentLabel): readonly string[] {
  return [`launchctl bootout gui/$(id -u)/${label}`, `rm -f ~/Library/LaunchAgents/${label}.plist`];
}

/** Every manual command for the agents whose retirement failed (empty when none did). */
export function failedAgentCommands(retirement: PythonAgentRetirement | null): string[] {
  if (retirement === null) return [];
  return retirement.agents
    .filter((agent) => agent.state === "failed")
    .flatMap((agent) => retirePythonAgentCommands(agent.label));
}

/**
 * An imported instrument the app cannot value: its ticker, else ISIN, else name (public market
 * identifiers), its currency, and why (`no_prices`: no readable price history; `no_fx`: prices but
 * no PLN rate of its currency).
 */
export const unpricedInstrumentSchema = z.strictObject({
  label: z.string().min(1).max(MIGRATE_UNPRICED_LABEL_MAX),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reason: z.enum(["no_prices", "no_fx"]),
});
export type UnpricedInstrument = z.infer<typeof unpricedInstrumentSchema>;

/**
 * The longest prefix of `items` (at most MIGRATE_UNPRICED_MAX) whose encoded list keeps a `done`
 * line within the line limit. Measured on the JSON encoding, so a label of quotes or control
 * characters counts at its escaped size and the done line always parses.
 */
export function fitUnpriced(items: readonly UnpricedInstrument[]): UnpricedInstrument[] {
  const budget = MIGRATE_LINE_MAX - MIGRATE_DONE_FIELDS_MAX;
  const fitted: UnpricedInstrument[] = [];
  let size = 2;
  for (const item of items.slice(0, MIGRATE_UNPRICED_MAX)) {
    const next = JSON.stringify(item).length + (fitted.length === 0 ? 0 : 1);
    if (size + next > budget) break;
    fitted.push(item);
    size += next;
  }
  return fitted;
}

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
  unpriced: z.array(unpricedInstrumentSchema).max(MIGRATE_UNPRICED_MAX).optional(),
  /** The imported profile slugs (`migrated` / `already_migrated`), for the MCP reconnect lines. */
  mcpProfiles: z
    .array(z.string().regex(MIGRATE_PROFILE_SLUG))
    .max(MIGRATE_MCP_PROFILES_MAX)
    .optional(),
  /** What became of the Python app's launchd worker agents (`migrated` / `already_migrated`). */
  agents: pythonAgentRetirementSchema.optional(),
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
  if (line.length > MIGRATE_LINE_MAX) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = migrateLineSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Longest MCP command line main forwards (a long data dir path, shell-quoted). */
export const RECOVERY_MCP_COMMAND_MAX = 4_096;

/**
 * What Electron main forwards to the recovery screen while the import runs: a stage, the one-time
 * recovery words (shown until confirmed, never stored), that the user's cancel took effect, or a
 * finished import with something to say before the app opens: the instruments the app cannot value,
 * the `claude mcp remove` / `add` lines per imported profile (built by main from the slugs with the
 * setup screen's builder) and what became of the Python worker agents. A finished import with none
 * of these, and a failed one, need no event: main loads the app or the new recovery screen.
 */
export const recoveryImportEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("progress"), stage: z.enum(MIGRATE_STAGES) }),
  z.strictObject({ kind: z.literal("words"), words: z.string().regex(RECOVERY_WORDS) }),
  z.strictObject({ kind: z.literal("cancelled") }),
  z.strictObject({
    kind: z.literal("done"),
    unpriced: z.array(unpricedInstrumentSchema).max(MIGRATE_UNPRICED_MAX),
    mcpCommands: z
      .array(z.string().min(1).max(RECOVERY_MCP_COMMAND_MAX))
      .max(2 * MIGRATE_MCP_PROFILES_MAX),
    agents: pythonAgentRetirementSchema.nullable(),
  }),
]);
export type RecoveryImportEvent = z.infer<typeof recoveryImportEventSchema>;
