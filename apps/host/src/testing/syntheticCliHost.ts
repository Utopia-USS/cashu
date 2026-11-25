// Source-only host for the retained CLI delegation tests. Production main.ts never imports this.

import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HostBusyError } from "@cashu/node-host";
import { startLocalHost } from "../host.js";

// The canonical form the host compares: Windows takes the native realpath (on-disk case, long names
// instead of 8.3 short ones), as `resolveReal` in @cashu/node-host does.
const real = (path: string) =>
  process.platform === "win32" ? realpathSync.native(path) : realpathSync(path);

function isTestPath(value: string | undefined): value is string {
  if (value === undefined || !isAbsolute(value) || resolve(value) !== value) return false;
  const temp = real(tmpdir());
  const rel = relative(temp, value);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  const root = join(temp, rel.split(sep)[0] as string);
  if (!basename(root).startsWith("cashu-") || real(root) !== root) return false;
  let path = root;
  for (const component of rel.split(sep).slice(1)) {
    path = join(path, component);
    try {
      if (lstatSync(path).isSymbolicLink()) return false;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        break;
      throw error;
    }
  }
  return true;
}

const [command, flag, dataDir, ...extra] = process.argv.slice(2);
const home = process.env.HOME;
if (
  command !== "run" ||
  flag !== "--data-dir" ||
  dataDir === undefined ||
  extra.length !== 0 ||
  process.env.CASHU_TESTING !== "1" ||
  dataDir !== process.env.CASHU_DATA_DIR ||
  !isTestPath(dataDir) ||
  !isTestPath(home) ||
  real(home) !== home
) {
  console.error("synthetic CLI host: invalid test invocation");
  process.exit(64);
}

try {
  const host = await startLocalHost({
    dataDir,
    home,
    build: process.env.CASHU_BUILD ?? "dev",
    vaultSource: { kind: "synthetic-harness" },
  });
  process.once("SIGTERM", () => void host.stop("signal"));
  process.once("SIGINT", () => void host.stop("signal"));
  process.exit(await host.exit);
} catch (error) {
  if (error instanceof HostBusyError) process.exit(error.exitCode);
  console.error(`synthetic CLI host: failed (${error instanceof Error ? error.name : "error"})`);
  process.exit(70);
}
