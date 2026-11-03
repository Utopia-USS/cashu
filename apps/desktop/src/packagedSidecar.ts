/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { realResolve } from "./config.js";
import { buildSidecarEnv, type SidecarSpec } from "./sidecar.js";

/** Fixed layout shared with apps/host/src/runtime.ts and the S47 resource builder. */
const PACKAGED_PYTHON_DIR = "python";
const PACKAGED_PYTHON_EXE = "cashu-python";

function loaderOverride(key: string): boolean {
  return (
    key.startsWith("PYTHON") ||
    key.startsWith("_PYI_") ||
    key.startsWith("PYINSTALLER_") ||
    key.startsWith("DYLD_") ||
    key.startsWith("LD_")
  );
}

/** Pass this same scrubbed environment to preflight and Sidecar.start(). */
function packagedSidecarEnv(baseEnv: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {
  const env = buildSidecarEnv(baseEnv, realResolve(dataDir));
  for (const key of Object.keys(env)) {
    if (loaderOverride(key)) delete env[key];
  }
  return env;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Select the bundle's own executable. Caller-controlled paths are forbidden in a packaged app. */
export function packagedSidecarSpec(resourcesPath: string, env: NodeJS.ProcessEnv): SidecarSpec {
  if (env.CASHU_DESKTOP_SIDECAR_BIN || env.CASHU_DESKTOP_SIDECAR_ARGS) {
    throw new Error("Packaged sidecar overrides are unavailable");
  }
  const root = realpathSync.native(resourcesPath);
  const cwd = join(root, PACKAGED_PYTHON_DIR);
  const command = join(cwd, PACKAGED_PYTHON_EXE);
  const actualDir = realpathSync.native(cwd);
  const actualExe = realpathSync.native(command);
  if (!inside(root, actualDir) || !inside(actualDir, actualExe)) {
    throw new Error("Packaged Python escapes Resources");
  }
  const file = lstatSync(command);
  if (!file.isFile() || (file.mode & 0o111) === 0) {
    throw new Error("Packaged Python is not an executable regular file");
  }
  return { command, args: ["serve"], cwd };
}

/** Read-only preflight before constructing Sidecar or importing the Python CLI. */
export function verifyPackagedDataDir(
  spec: SidecarSpec,
  expected: string,
  baseEnv: NodeJS.ProcessEnv,
  run: typeof spawnSync = spawnSync,
): string | null {
  if (!isAbsolute(expected)) return "The packaged data dir must be absolute";
  const env = packagedSidecarEnv(baseEnv, expected);
  const result = run(spec.command, ["--preflight-data-dir"], {
    cwd: spec.cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) return "Could not preflight the packaged Python data dir";
  const lines = String(result.stdout).trim().split(/\r?\n/);
  return lines.length === 1 && realResolve(lines[0] ?? "") === realResolve(expected)
    ? null
    : "Packaged Python resolved a different data dir";
}
