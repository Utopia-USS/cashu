// The profile's agent workspace settings. Python kept them in `profiles/<slug>/workspace.json`
// (`{"path", "routine_permissions"}`, core/workspace/service.py: an unreadable file or a missing
// path means the default folder; only `true` opts the routine in). The native app keeps them per
// vault in `<D>/workspace/v1/<vaultId>.json` (`{format, vaultId, path, routinePermissions}`,
// workspace/production.ts and adapter.ts). The import converts one into the other; a Python value
// the native file cannot hold refuses the import instead of being dropped.
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { GenesisFiles } from "@cashu/store/genesis";
import { MigrationError } from "../contract.js";

/** A configured workspace: the folder and the routine-permissions opt-in. */
export interface WorkspaceClaim {
  readonly path: string;
  readonly routinePermissions: boolean;
}

const MAX_PATH = 4096;
const VAULT = /^[0-9a-f]{32}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Python's reading of `profiles/<slug>/workspace.json`; null when Python uses the defaults. */
export function workspaceClaim(files: GenesisFiles, slug: string): WorkspaceClaim | null {
  const bytes = files.read(`profiles/${slug}/workspace.json`);
  if (bytes === undefined) return null;
  let raw: unknown;
  try {
    // `read_text(encoding="utf-8")` keeps a BOM, which `json.loads` then refuses: defaults.
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  const path = typeof raw.path === "string" && raw.path !== "" ? raw.path : null;
  const routinePermissions = raw.routine_permissions === true;
  // Python itself never writes the opt-in without the folder, nor a relative folder.
  if (path === null) {
    if (routinePermissions) throw new MigrationError("semantic_difference");
    return null;
  }
  if (path.length > MAX_PATH || path.includes("\0") || !isAbsolute(path) || resolve(path) !== path)
    throw new MigrationError("semantic_difference");
  return { path, routinePermissions };
}

const configPath = (dataDir: string, vaultId: string) =>
  join(dataDir, "workspace", "v1", `${vaultId}.json`);

/** The native file, byte for byte as the native workspace writer would write it. */
function configBytes(vaultId: string, claim: WorkspaceClaim): Buffer {
  const config = {
    format: 1,
    vaultId,
    path: claim.path,
    routinePermissions: claim.routinePermissions,
  };
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function privateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700)
    throw new MigrationError("identity_invalid");
  fsyncDirectory(dirname(path));
}

/** Writes the native config of every vault with a claim into the fresh target (nothing if none). */
export function writeWorkspaceClaims(
  dataDir: string,
  claims: readonly { readonly vaultId: string; readonly claim: WorkspaceClaim | null }[],
): void {
  const present = claims.filter((item) => item.claim !== null);
  if (present.length === 0) return;
  privateDirectory(join(dataDir, "workspace"));
  privateDirectory(join(dataDir, "workspace", "v1"));
  for (const { vaultId, claim } of present) {
    if (!VAULT.test(vaultId) || claim === null) throw new MigrationError("identity_invalid");
    const bytes = configBytes(vaultId, claim);
    const fd = openSync(
      configPath(dataDir, vaultId),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      for (let offset = 0; offset < bytes.length; ) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new MigrationError("identity_invalid");
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  fsyncDirectory(join(dataDir, "workspace", "v1"));
  assertWorkspaceClaims(dataDir, claims);
}

/** `<D>/workspace/v1/` holds exactly the converted configs, each with the expected bytes. */
export function assertWorkspaceClaims(
  dataDir: string,
  claims: readonly { readonly vaultId: string; readonly claim: WorkspaceClaim | null }[],
): void {
  try {
    const expected = claims
      .filter((item) => item.claim !== null)
      .map((item) => `${item.vaultId}.json`)
      .sort();
    let names: string[];
    try {
      names = readdirSync(join(dataDir, "workspace", "v1")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      names = [];
    }
    if (JSON.stringify(names) !== JSON.stringify(expected))
      throw new MigrationError("replay_mismatch");
    for (const { vaultId, claim } of claims) {
      if (claim === null) continue;
      const path = configPath(dataDir, vaultId);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
        throw new MigrationError("replay_mismatch");
      if (!readFileSync(path).equals(configBytes(vaultId, claim)))
        throw new MigrationError("replay_mismatch");
    }
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError("replay_mismatch");
  }
}
