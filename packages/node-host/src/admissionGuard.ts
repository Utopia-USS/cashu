import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Where the old (Python) cashU app keeps its data. The app never opens, moves or changes it: Electron
 * main only checks whether it is there (fixed file names, lstat only) so the recovery screen can say
 * so and hand the user a prompt for their agent. The native host ignores it.
 */
const DATABASES = ["cashu.db", "finanse.db"] as const;
const SIDES = ["", "-wal", "-shm", "-journal"] as const;

/**
 * The roots that may hold the old app's database: the selected data dir alone when it was chosen
 * explicitly (or the flavor does not replace the Python install); otherwise also the pre-rename
 * `finanse` data dir (or CASHU_LEGACY_DATA_DIR) and a source checkout's `data/`.
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

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    // An entry that exists but cannot be inspected still counts as there.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** How many of `roots` hold an old-app database file (or one of its sidecars); 0 = none. */
export function oldAppDataRoots(roots: readonly string[]): number {
  return [...new Set(roots.map((root) => resolve(root)))].filter((root) =>
    DATABASES.some((name) => SIDES.some((side) => present(join(root, `${name}${side}`)))),
  ).length;
}
