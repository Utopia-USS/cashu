import { lstatSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";

/** Temporary read-only refusal until T54 supplies authenticated migration admission. */
export type LegacyDataAdmission = "no_legacy_sentinel" | "migration_required" | "refused";

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
 * T54 will replace it with an exact source/journal classifier before migration is offered.
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

export function legacyDataAdmission(roots: string | readonly string[]): LegacyDataAdmission {
  const databases = ["cashu.db", "finanse.db"] as const;
  const sides = ["-wal", "-shm", "-journal"] as const;
  let found = false;
  let databaseCount = 0;
  for (const dataDir of new Set(
    (typeof roots === "string" ? [roots] : roots).map((root) => resolve(root)),
  )) {
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
