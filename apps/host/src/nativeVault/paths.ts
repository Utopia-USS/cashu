// Path checks for an already provisioned native vault: nothing here creates a vault file.
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { StartupFailureError } from "@cashu/host-protocol/startup-failure";

const unavailable = () =>
  new StartupFailureError("native_inventory_unavailable", "native_vault_unavailable");
const invalid = () => new StartupFailureError("native_inventory_unavailable", "native_path_invalid");

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

/** The host-private LAN carrier folder under the data dir, created 0700 when missing. */
export function lanCarrierRoot(dataDir: string): string {
  const root = join(dataDir, "lan-carrier");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error("native_lan_carrier_invalid");
  return root;
}
