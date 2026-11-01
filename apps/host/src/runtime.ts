// Where this host runs from, and the programs it hands out: the `cashu` shim (for the stable launcher)
// and the Python CLI (for delegated commands and MCP sessions, TRANSITIONAL(S49)). From source in a dev
// checkout the host is `node <strip-types flags> apps/host/src/cli.ts`; packaged it is the bundle's
// `host.mjs` run by the app's binary in Node mode, with `shim.mjs` beside it (S47).
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

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
  return {
    // apps/host/src/runtime.ts -> the repo root
    checkout: self.endsWith(".ts") ? resolve(dirname(self), "..", "..", "..") : undefined,
    dir: dirname(self),
    execPath: process.execPath,
    execArgv: process.execArgv,
    cwd: process.cwd(),
    env: process.env,
  };
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
 * TRANSITIONAL(S49): the Python CLI (`cashu` of the Python app) that runs what the host has not
 * ported. `CASHU_PYTHON_CLI` (an absolute path) wins; a dev checkout uses its `.venv/bin/cashu`. The
 * packaged location comes with the bundled Python (S47); until then a packaged host has none and says so.
 */
export function pythonProgram(rt: HostRuntime): Program | undefined {
  const override = rt.env.CASHU_PYTHON_CLI;
  if (override !== undefined && override !== "") {
    return isAbsolute(override) && existsSync(override)
      ? { command: override, args: [] }
      : undefined;
  }
  if (rt.checkout === undefined) return undefined;
  const venv = join(rt.checkout, ".venv", "bin", "cashu");
  return existsSync(venv) ? { command: venv, args: [] } : undefined;
}
