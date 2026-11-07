// What `cashu migrate` does once a cutover has finished (status `migrated`, and again on every later
// run that finds the folder `already_migrated`, so a crash between the cutover and this step or a
// failed bootout is retried; the terminal and the app's "Import my data" both reach it through cli.ts):
// retire the Python app's launchd worker
// agents (pythonAgents.ts) and read the imported profile slugs for the MCP reconnect lines (the old
// `cashu-<slug>` registrations point at the replaced Python binary). Neither may undo or fail the
// import: every error becomes a reported outcome.
import { join } from "node:path";
import {
  MIGRATE_MCP_PROFILES_MAX,
  MIGRATE_PROFILE_SLUG,
  PYTHON_AGENT_LABELS,
  type PythonAgentRetirement,
} from "@cashu/host-protocol/startup-failure";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { databaseName } from "./oneShot.js";
import { type LaunchctlRunner, type RetireRuntime, retirePythonAgents } from "./pythonAgents.js";

export interface AfterImportInput {
  readonly dataDir: string;
  /** The backup directory's name inside the data dir (the migration marker's `backupDir`). */
  readonly backupDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly uid: number;
  /** The real launchctl runner (production wiring only); null never boots anything out. */
  readonly launchctl: LaunchctlRunner | null;
  /** A sealed test build: never launchctl, only an explicit CASHU_LAUNCH_AGENTS_DIR (pythonAgents.ts). */
  readonly testBuild?: boolean;
  /** The running app (host main.ts); absent, the real default agents dir is never touched. */
  readonly runtime?: RetireRuntime;
  /** Tests: the account home (default: the user database's). */
  readonly accountHome?: string;
}

export interface AfterImport {
  readonly agents: PythonAgentRetirement;
  /** The imported profile slugs in profile order, or null when they could not be read. */
  readonly slugs: readonly string[] | null;
}

/** The profile slugs of the Python database in the backup, in profile order (read only). */
function backupProfileSlugs(dataDir: string, backupDir: string): string[] {
  const backup = join(dataDir, backupDir);
  const db = openNodeSqlite(join(backup, databaseName(backup)), { readOnly: true });
  try {
    return db
      .prepare("SELECT slug FROM profiles ORDER BY id")
      .all<{ slug: string }>()
      .map((row) => row.slug);
  } finally {
    db.close();
  }
}

/** The slugs the app's protocol carries (`mcpProfiles`): valid ones, at most the protocol's limit. */
export function protocolSlugs(slugs: readonly string[]): string[] {
  return slugs.filter((slug) => MIGRATE_PROFILE_SLUG.test(slug)).slice(0, MIGRATE_MCP_PROFILES_MAX);
}

export function afterImport(input: AfterImportInput): AfterImport {
  let agents: PythonAgentRetirement;
  try {
    agents = retirePythonAgents(input);
  } catch {
    agents = {
      bootout: "skipped",
      agents: PYTHON_AGENT_LABELS.map((label) => ({ label, state: "failed" })),
    };
  }
  let slugs: string[] | null;
  try {
    slugs = backupProfileSlugs(input.dataDir, input.backupDir);
  } catch {
    slugs = null;
  }
  return { agents, slugs };
}
