// Path checks for an already provisioned native vault: nothing here creates a vault file. Also the
// one-time removal of the LAN carrier's folder that older builds left in the data dir.
import { lstatSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { StartupFailureError } from "@cashu/host-protocol/startup-failure";

const unavailable = () =>
  new StartupFailureError("native_inventory_unavailable", "native_vault_unavailable");
const invalid = () =>
  new StartupFailureError("native_inventory_unavailable", "native_path_invalid");

/** The canonical, non-symlinked path of an existing file or directory. */
export function existing(path: string, kind: "file" | "directory"): string {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw unavailable();
    throw invalid();
  }
  if (
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (kind === "file" ? !stat.isFile() : !stat.isDirectory())
  )
    throw invalid();
  return path;
}

/** SQLite sidecars of `path` may be absent; a present one must be a plain canonical file. */
export function sidecars(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${path}${suffix}`;
    try {
      lstatSync(sidecar);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw invalid();
    }
    existing(sidecar, "file");
  }
}

/** The folder the LAN carrier kept under the data dir (a copy of each vault's own sealed log). */
const LEGACY_LAN_CARRIER = "lan-carrier";

/**
 * Removes `<dataDir>/lan-carrier`, left by builds that synced over the LAN (nothing reads it since).
 * Only that exact entry of the data dir, only a real directory reached without a symlink (a symlink
 * there, or a data dir path that resolves elsewhere, is left alone), and the recursive removal
 * unlinks symlinks inside it without following them. Run once at host start with the host lock held.
 */
export function removeLegacyLanCarrier(dataDir: string): "removed" | "absent" | "skipped" {
  if (!isAbsolute(dataDir)) return "skipped";
  const target = join(dataDir, LEGACY_LAN_CARRIER);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    return "skipped";
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return "skipped";
  // The canonical folder must be the canonical data dir's own child (no symlinked component).
  if (realpathSync(target) !== join(realpathSync(dataDir), LEGACY_LAN_CARRIER)) return "skipped";
  rmSync(target, { recursive: true, force: false });
  return "removed";
}
