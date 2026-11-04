// Test-only preload. The real CLI shim still runs as the entry point; its one expected detached
// source host spawn is routed to an explicit synthetic-harness host. The one foreground spawn it
// lets through unchanged is `cashu migrate`: the real host entry's `migrate` for the same temp data
// dir (tests drive it only to paths that end before any key store access). This file is never
// imported by the production launcher.
import childProcess, { type SpawnOptions } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const SHIM = join(REPO, "apps/cli/src/index.ts");
const HOST_CLI = join(REPO, "apps/host/src/cli.ts");
const SYNTHETIC_HOST = join(REPO, "apps/host/src/testing/syntheticCliHost.ts");
const RESOLVE_TS = join(REPO, "tools/node-ts/resolveTs.ts");
const INTERPOSER = fileURLToPath(import.meta.url);
const TEMP = realpathSync(tmpdir());

function testPath(value: string | undefined, label: string): string {
  if (value === undefined || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`CLI test interposer: invalid ${label}`);
  }
  const rel = relative(TEMP, value);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`CLI test interposer: ${label} is outside the temporary directory`);
  }
  const root = join(TEMP, rel.split(sep)[0] as string);
  if (!basename(root).startsWith("cashu-") || realpathSync(root) !== root) {
    throw new Error(`CLI test interposer: ${label} has no fresh cashU test root`);
  }
  // Reject a symlink at any existing component. A failure test intentionally has a regular file
  // in the data path; the host must still receive that path and report its normal start failure.
  let current = root;
  for (const component of rel.split(sep).slice(1)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`CLI test interposer: symlink in ${label}`);
      }
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
  return value;
}

if (process.env.CASHU_TESTING !== "1") {
  throw new Error("CLI test interposer requires CASHU_TESTING=1");
}
const entry = process.argv[1];
const migrateChild = entry === HOST_CLI && process.argv[2] === "migrate";
if (entry !== SHIM && entry !== SYNTHETIC_HOST && !migrateChild) {
  throw new Error("CLI test interposer requires an exact test process entry");
}
const dataDir = testPath(process.env.CASHU_DATA_DIR, "data dir");
const home = testPath(process.env.HOME, "HOME");
if (realpathSync(home) !== home || !lstatSync(home).isDirectory()) {
  throw new Error("CLI test interposer requires an existing canonical HOME");
}

const expected = [
  "--no-warnings",
  "--experimental-transform-types",
  "--import",
  RESOLVE_TS,
  "--import",
  INTERPOSER,
  HOST_CLI,
  "run",
  "--data-dir",
  dataDir,
];
const originalSpawn = childProcess.spawn;
childProcess.spawn = ((...input: unknown[]) => {
  const [command, args, options] = input;
  const argv = Array.isArray(args) ? args : [];
  const spawnOptions = (Array.isArray(args) ? options : args) as SpawnOptions | undefined;
  const hostEntry = argv.includes(HOST_CLI) || argv.includes(SYNTHETIC_HOST);
  if (!hostEntry && spawnOptions?.detached !== true) {
    return Reflect.apply(originalSpawn, childProcess, input);
  }
  const actual = [...argv];
  if (
    spawnOptions?.detached !== true &&
    entry === SHIM &&
    command === process.execPath &&
    actual.length >= expected.length &&
    expected.slice(0, 7).every((arg, index) => actual[index] === arg) &&
    actual[7] === "migrate" &&
    actual.at(-2) === "--data-dir" &&
    actual.at(-1) === dataDir &&
    spawnOptions?.env?.CASHU_TESTING === "1" &&
    spawnOptions.env.HOME === home
  )
    return Reflect.apply(originalSpawn, childProcess, input);
  if (
    spawnOptions?.detached !== true ||
    entry !== SHIM ||
    command !== process.execPath ||
    actual.length !== expected.length ||
    actual.some((arg, index) => arg !== expected[index]) ||
    spawnOptions.env?.CASHU_TESTING !== "1" ||
    spawnOptions.env?.CASHU_DATA_DIR !== dataDir ||
    spawnOptions.env?.HOME !== home
  ) {
    throw new Error("CLI test interposer refused an unexpected host spawn");
  }
  actual[6] = SYNTHETIC_HOST;
  return Reflect.apply(originalSpawn, childProcess, [command, actual, spawnOptions]);
}) as typeof childProcess.spawn;
syncBuiltinESMExports();
