// The Node flags a shim test process runs with (type stripping, the repo's TypeScript resolver and the
// test host interposer), shared by the runner that spawns the shim and the interposer that checks the
// host spawn the shim makes with the same flags (tests only).
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * An absolute module path as an `--import` specifier. POSIX takes the plain path; Windows needs a
 * `file:` URL, because Node reads `D:\...` as a URL with the scheme `d:` and refuses it.
 */
function importSpecifier(path: string): string {
  return process.platform === "win32" ? pathToFileURL(path).href : path;
}

const RESOLVE_TS = join(REPO, "tools/node-ts/resolveTs.ts");
const HOST_INTERPOSER = join(REPO, "apps/cli/src/testing/hostInterposer.ts");

/** The flags before the entry file, in order; the shim hands them on unchanged to the host it starts. */
export const SHIM_SOURCE_FLAGS: readonly string[] = [
  "--no-warnings",
  "--experimental-transform-types",
  "--import",
  importSpecifier(RESOLVE_TS),
  "--import",
  importSpecifier(HOST_INTERPOSER),
];
