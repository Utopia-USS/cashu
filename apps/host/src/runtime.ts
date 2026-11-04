// Where this host runs from, and the programs it hands out: the `cashu` shim (for the stable launcher)
// and the Python CLI (for delegated commands and MCP sessions, TRANSITIONAL(S49)). From source in a dev
// checkout the host is `node <strip-types flags> apps/host/src/cli.ts`; packaged it is the bundle's
// `host.mjs` run by the app's binary in Node mode, with `shim.mjs` beside it (S47).
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** A program: an absolute executable and the arguments before the caller's own. */
export interface Program {
  readonly command: string;
  readonly args: readonly string[];
  /** Variables the program needs set (the app's binary in Node mode). */
  readonly env?: Readonly<Record<string, string>>;
}

export interface HostRuntime {
  /** The repo root when running from source, undefined when packaged. */
  readonly checkout: string | undefined;
  /** The directory of the running bundle (packaged) or of this source file. */
  readonly dir: string;
  readonly execPath: string;
  readonly execArgv: readonly string[];
  /** The working directory the host started in (relative Node flags resolve against it). */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** A relative `--import` path made absolute (Node resolves it against the cwd of the start). */
const absoluteSpecifier = (spec: string, cwd: string) =>
  spec.startsWith("./") || spec.startsWith("../") ? resolve(cwd, spec) : spec;

/** Node flags that run TypeScript from source; anything else (an inspector, a loader) stays here. */
const SOURCE_FLAG = /^--(experimental-strip-types|no-warnings|disable-warning=.+|import=.+)$/;

function sourceRunFlags(execArgv: readonly string[], cwd: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i] as string;
    if (arg === "--import" && execArgv[i + 1] !== undefined) {
      out.push(arg, absoluteSpecifier(execArgv[i + 1] as string, cwd));
      i++;
    } else if (arg.startsWith("--import=")) {
      out.push(`--import=${absoluteSpecifier(arg.slice("--import=".length), cwd)}`);
    } else if (SOURCE_FLAG.test(arg)) out.push(arg);
  }
  return out;
}

export function currentRuntime(): HostRuntime {
  const self = realpathSync(import.meta.filename);
  const sourceRoot = resolve(dirname(self), "..", "..", "..");
  const source =
    self === join(sourceRoot, "apps", "host", "src", "runtime.ts") &&
    existsSync(join(sourceRoot, "pnpm-workspace.yaml")) &&
    existsSync(join(sourceRoot, "packages", "node-host", "package.json"));
  return {
    // apps/host/src/runtime.ts -> the repo root
    checkout: source ? sourceRoot : undefined,
    dir: dirname(self),
    execPath: process.execPath,
    execArgv: process.execArgv,
    cwd: process.cwd(),
    env: process.env,
  };
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Any inherited loader override makes packaged Python delegation unavailable. */
function packagedLoaderOverride(key: string): boolean {
  return (
    key.startsWith("PYTHON") ||
    key.startsWith("_PYI_") ||
    key.startsWith("PYINSTALLER_") ||
    key.startsWith("DYLD_") ||
    key.startsWith("LD_")
  );
}

function packagedResource(rt: HostRuntime, ...parts: string[]): string | undefined {
  try {
    const root = realpathSync.native(rt.dir);
    const path = join(root, ...parts);
    return inside(root, realpathSync.native(path)) ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Source or fixed packaged skills. */
export function shippedSkillsSource(rt: HostRuntime): string | undefined {
  return rt.checkout === undefined
    ? packagedResource(rt, "python", "_internal", "skills")
    : join(rt.checkout, ".claude", "skills");
}

/** Read-only connector catalog rooted in the verified build, never the caller's cwd. */
export function shippedConnectorsSource(rt: HostRuntime): string | undefined {
  return rt.checkout === undefined
    ? packagedResource(rt, "python", "_internal", "connectors")
    : join(rt.checkout, "connectors");
}

/** The `cashu` shim of this build. */
export function shimProgram(rt: HostRuntime): Program {
  if (rt.checkout !== undefined) {
    return {
      command: rt.execPath,
      args: [
        ...sourceRunFlags(rt.execArgv, rt.cwd),
        join(rt.checkout, "apps", "cli", "src", "index.ts"),
      ],
    };
  }
  return {
    command: rt.execPath,
    args: [join(rt.dir, "shim.mjs")],
    ...(rt.env.ELECTRON_RUN_AS_NODE === undefined ? {} : { env: { ELECTRON_RUN_AS_NODE: "1" } }),
  };
}

/**
 * TRANSITIONAL(S49): delegated Python CLI. Development permits an explicit override; a packaged
 * host uses only its own fixed Resources/python/cashu-python after a read-only data-dir preflight.
 * The packaged entry itself refuses normal CLI/serve until S62 admission is implemented.
 */
export function pythonProgram(rt: HostRuntime): Program | undefined {
  if (rt.checkout === undefined) {
    if (rt.env.CASHU_PYTHON_CLI) return undefined;
    if (Object.keys(rt.env).some(packagedLoaderOverride)) return undefined;
    const dataDir = rt.env.CASHU_DATA_DIR;
    if (!dataDir || !isAbsolute(dataDir)) return undefined;
    let canonicalDataDir: string;
    try {
      canonicalDataDir = realpathSync.native(dataDir);
    } catch {
      return undefined;
    }
    const executable = packagedResource(rt, "python", "cashu-python");
    if (executable === undefined) return undefined;
    try {
      const file = lstatSync(executable);
      if (!file.isFile() || (file.mode & 0o111) === 0) return undefined;
    } catch {
      return undefined;
    }
    const env: NodeJS.ProcessEnv = { ...rt.env, CASHU_DATA_DIR: canonicalDataDir };
    const result = spawnSync(executable, ["--preflight-data-dir"], {
      cwd: join(rt.dir, "python"),
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.status !== 0 || result.stdout.trim().split(/\r?\n/).length !== 1) return undefined;
    if (result.stdout.trim() !== canonicalDataDir) return undefined;
    return { command: executable, args: [], env: { CASHU_DATA_DIR: canonicalDataDir } };
  }
  const override = rt.env.CASHU_PYTHON_CLI;
  if (override !== undefined && override !== "") {
    return isAbsolute(override) && existsSync(override)
      ? { command: override, args: [] }
      : undefined;
  }
  const venv = join(rt.checkout, ".venv", "bin", "cashu");
  return existsSync(venv) ? { command: venv, args: [] } : undefined;
}
