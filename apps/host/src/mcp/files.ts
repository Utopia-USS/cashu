// Host-only equivalent of Python checked_local_file, sharing the reviewed path/descriptor checks.
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, sep } from "node:path";
import { pyCasefold } from "@cashu/domain";
import { ToolError } from "@cashu/mcp";
import { resolveReal } from "@cashu/node-host";
import { mcpNamedHome } from "./homes.js";

const MAX_BYTES = 20 * 1024 * 1024;
interface FileScope {
  readonly cwd: string;
  readonly home: string | undefined;
  readonly namedHome?: (name: string) => string | undefined;
  readonly dataDir: string;
  readonly legacyDataDir: string;
}
const pathKey = (path: string) => pyCasefold(path.normalize("NFC"));
function inside(path: string, root: string): boolean {
  const p = pathKey(path);
  const r = pathKey(root).replace(/[\\/]+$/, "");
  return p === r || p.startsWith(r + sep);
}
interface FilePolicy {
  readonly extensions: readonly string[];
  readonly maxBytes: number;
  readonly profileOnly: boolean;
  readonly systemLimit?: boolean;
}
function checkedFileReader(scope: FileScope, policy: FilePolicy) {
  const tooLarge = (): never => {
    throw new ToolError(
      policy.profileOnly ? "the mapping file is too large" : "file is too large (max 20 MB)",
      "invalid",
      { system: policy.systemLimit ?? false },
    );
  };
  return (raw: string, profileSlug: string): { name: string; bytes: Uint8Array } => {
    if (!raw || raw.includes("\0")) throw new ToolError("path is required");
    let path: string;
    try {
      let expanded = raw;
      if (raw.startsWith("~")) {
        const suffix = raw.slice(1).search(sep === "\\" ? /[/\\]/ : /\//);
        const end = suffix === -1 ? raw.length : suffix + 1;
        const user = raw.slice(1, end);
        const home =
          user === ""
            ? scope.home
            : (scope.namedHome ?? ((name) => mcpNamedHome(name, { HOME: scope.home })))(user);
        if (home === undefined || home.startsWith("~")) throw new Error("unresolved home");
        expanded = home + raw.slice(end);
      }
      path = realpathSync.native(isAbsolute(expanded) ? expanded : scope.cwd + sep + expanded);
    } catch {
      throw new ToolError("file not found", "not_found");
    }
    if (!statSync(path).isFile()) throw new ToolError("not a regular file");
    const name = basename(path);
    if (!policy.extensions.includes(extname(name).slice(1).toLowerCase()))
      throw new ToolError(`unsupported file type; allowed: ${policy.extensions.join(", ")}`);
    if (
      path
        .split(sep)
        .slice(1)
        .some((part) => part.startsWith("."))
    )
      throw new ToolError("hidden files and files inside hidden directories are not read");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(profileSlug))
      throw new ToolError("invalid profile folder");
    const own = resolveReal(join(scope.dataDir, "profiles", profileSlug));
    if (policy.profileOnly && !inside(path, own))
      throw new ToolError(
        "this file must be in the profile's folder (profiles/<slug>/ in the data dir)",
      );
    if (inside(path, resolveReal(scope.dataDir)) && !inside(path, own))
      throw new ToolError(
        "files inside the cashU data dir are not read (except the profile folder)",
      );
    if (inside(path, resolveReal(scope.legacyDataDir)))
      throw new ToolError("files inside the legacy data folder are not read");
    // Pin the checked file, refuse a final symlink/nonregular replacement, and bound reads even if
    // another process grows the file after the size check. No contents or paths enter diagnostics.
    const fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) throw new ToolError("not a regular file");
      if (info.size > policy.maxBytes) tooLarge();
      const currentPath = realpathSync.native(path);
      const current = statSync(currentPath);
      if (currentPath !== path || current.dev !== info.dev || current.ino !== info.ino)
        throw new ToolError("file changed while being read");
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, policy.maxBytes + 1 - total));
        const count = readSync(fd, chunk, 0, chunk.length, null);
        if (count === 0) break;
        total += count;
        if (total > policy.maxBytes) tooLarge();
        chunks.push(chunk.subarray(0, count));
      }
      return { name, bytes: Buffer.concat(chunks, total) };
    } finally {
      closeSync(fd);
    }
  };
}
export function budgetFileReader(scope: FileScope) {
  return checkedFileReader(scope, {
    extensions: ["json", "csv"],
    maxBytes: MAX_BYTES,
    profileOnly: false,
  });
}
export function investmentFileReader(scope: FileScope) {
  return checkedFileReader(scope, {
    extensions: ["csv", "tsv", "txt", "json", "xlsx"],
    maxBytes: MAX_BYTES,
    profileOnly: false,
    systemLimit: true,
  });
}
export function investmentMappingReader(scope: FileScope) {
  const read = checkedFileReader(scope, {
    extensions: ["yaml", "yml"],
    maxBytes: 256 * 1024,
    profileOnly: true,
  });
  return (raw: string, profileSlug: string): string => {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        read(raw, profileSlug).bytes,
      );
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("the mapping file cannot be read");
    }
  };
}
