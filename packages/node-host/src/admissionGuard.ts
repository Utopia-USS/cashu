import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Whether a data dir may hold native vaults. A dir (or one of the entry's source roots) that holds a
 * Python cashU database is refused: its data comes over only through `cashu migrate`
 * (`apps/host/src/migration/inPlace.ts`), which imports it in place, never by opening or creating
 * vaults beside it. A dir holding an in-place migration's cutover journal is mid-cutover
 * (`migration_incomplete`) until `cashu migrate` finishes it, whatever its root shows meanwhile.
 * The migration's own entries (`python-backup-<time>/`, `.migration-<time>/` without a journal,
 * `migration.json`) and `diagnostics/` are never Python data: only fixed root names are checked.
 */
export type LegacyDataAdmission =
  | "no_legacy_sentinel"
  | "migration_required"
  | "migration_incomplete"
  | "refused";

/** The in-place migration's staging directory inside the data dir: `.migration-<time>/`. */
export const MIGRATION_STAGING_PREFIX = ".migration-";
/** The cutover journal inside a staging directory; present only while a cutover is unfinished. */
export const MIGRATION_JOURNAL = "journal.json";
/** The finished migration's marker in the data dir. */
export const MIGRATION_MARKER = "migration.json";
/** Where the cutover moves the original Python files: `python-backup-<time>/`. */
export const PYTHON_BACKUP_PREFIX = "python-backup-";

function entry(path: string): Stats | null | "unreadable" {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "unreadable";
  }
}

/**
 * A Python database never authorizes native Create, even if the native inventory is empty.
 * This checks only fixed filenames and returns no path or private metadata to the renderer.
 */
export function legacySourceRoots(
  dataDir: string,
  projectRoot: string,
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  explicitDataDir = false,
): readonly string[] {
  const legacyOverride = env.CASHU_LEGACY_DATA_DIR?.trim();
  if (explicitDataDir) {
    return legacyOverride
      ? [dataDir, resolve(legacyOverride.replace(/^~(?=\/|$)/, home))]
      : [dataDir];
  }
  const legacyDefault = legacyOverride
    ? resolve(legacyOverride.replace(/^~(?=\/|$)/, home))
    : platform === "darwin"
      ? join(home, "Library", "Application Support", "finanse")
      : platform === "win32"
        ? join(env.APPDATA || join(home, "AppData", "Roaming"), "finanse")
        : join(env.XDG_DATA_HOME || join(home, ".local", "share"), "finanse");
  return [dataDir, legacyDefault, join(projectRoot, "data")];
}

/**
 * The staging directories of `dataDir` holding a cutover journal (names only), or "unreadable".
 * A staging directory without a journal is a failed attempt's leftover, not a cutover.
 */
export function migrationJournals(dataDir: string): readonly string[] | "unreadable" {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return "unreadable";
  }
  const found: string[] = [];
  for (const name of names) {
    if (!name.startsWith(MIGRATION_STAGING_PREFIX)) continue;
    const journal = entry(join(dataDir, name, MIGRATION_JOURNAL));
    if (journal === "unreadable") return "unreadable";
    if (journal !== null) found.push(name);
  }
  return found.sort();
}

export function legacyDataAdmission(roots: string | readonly string[]): LegacyDataAdmission {
  const databases = ["cashu.db", "finanse.db"] as const;
  const sides = ["-wal", "-shm", "-journal"] as const;
  let found = false;
  let databaseCount = 0;
  const dirs = [
    ...new Set((typeof roots === "string" ? [roots] : roots).map((root) => resolve(root))),
  ];
  // A cutover journal wins: mid-cutover, the root may show a part of the Python files.
  for (const dataDir of dirs) {
    const directory = entry(dataDir);
    if (directory === "unreadable") return "refused";
    if (directory === null || !directory.isDirectory() || directory.isSymbolicLink()) continue;
    const journals = migrationJournals(dataDir);
    if (journals === "unreadable") return "refused";
    if (journals.length > 0) return "migration_incomplete";
  }
  for (const dataDir of dirs) {
    const directory = entry(dataDir);
    if (directory === "unreadable") return "refused";
    if (directory === null) continue;
    if (!directory.isDirectory() || directory.isSymbolicLink()) return "refused";
    for (const name of databases) {
      const database = entry(join(dataDir, name));
      if (database === "unreadable") return "refused";
      if (database !== null) {
        if (!database.isFile() || database.isSymbolicLink() || database.nlink !== 1)
          return "refused";
        found = true;
        databaseCount++;
      }
      for (const suffix of sides) {
        const side = entry(join(dataDir, `${name}${suffix}`));
        if (side === "unreadable") return "refused";
        if (side === null) continue;
        if (!side.isFile() || side.isSymbolicLink() || side.nlink !== 1 || database === null)
          return "refused";
        found = true;
      }
    }
  }
  if (databaseCount > 1) return "refused";
  return found ? "migration_required" : "no_legacy_sentinel";
}
