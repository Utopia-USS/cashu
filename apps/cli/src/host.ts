// How the shim reaches the data dir's host: connect, or start one detached and wait (connect-or-start,
// @cashu/node-host). The host runs from the same build as the shim: from source in a dev checkout
// (`node <strip-types flags> apps/host/src/cli.ts`), else the bundle's `host.mjs` next to the shim's
// bundle with the same runtime (the app's binary in Node mode, S47). Never a fallback: when no host can
// be started the caller reports it and stops (exit 69).
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Role } from "@cashu/host-protocol";
import {
  connectHost,
  connectOrStart,
  HostConnectError,
  type HostConnection,
  hostRunPaths,
  spawnDetachedHost,
} from "@cashu/node-host";
import {
  bundlePathFromEntry,
  packagedBuildId,
  readBundleIdentity,
} from "@cashu/node-host/bundle-identity";

/** A relative `--import` path made absolute (Node resolves it against the cwd of the start). */
const absoluteSpecifier = (spec: string, cwd: string) =>
  spec.startsWith("./") || spec.startsWith("../") ? resolve(cwd, spec) : spec;

/** Node flags that run TypeScript from source; anything else (an inspector, a loader) is not passed on. */
const SOURCE_FLAG = /^--(experimental-strip-types|no-warnings|disable-warning=.+|import=.+)$/;

/** The `--import <x>` style flags of `execArgv` that run TypeScript from source, in order. */
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

/** Where this shim runs from. */
export interface ShimBuild {
  /** The shim's own file (resolved). */
  readonly self: string;
  /** The source checkout (repo root) when the shim runs from source, else undefined. */
  readonly checkout: string | undefined;
  readonly build: string;
}

export function shimBuild(
  self: string,
  env: Readonly<Record<string, string | undefined>>,
): ShimBuild {
  const real = realpathSync(self);
  const sourceRoot = resolve(dirname(real), "..", "..", "..");
  const fromSource =
    real === join(sourceRoot, "apps", "cli", "src", "index.ts") &&
    existsSync(join(sourceRoot, "pnpm-workspace.yaml")) &&
    existsSync(join(sourceRoot, "packages", "node-host", "package.json"));
  return {
    self: real,
    checkout: fromSource ? sourceRoot : undefined,
    build: fromSource ? (env.CASHU_BUILD ?? "dev") : packagedShimBuild(real, process.execPath, env),
  };
}

function packagedShimBuild(
  self: string,
  execPath: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const bundle = bundlePathFromEntry(self);
  const identity = bundle ? readBundleIdentity(bundle) : { kind: "invalid" as const };
  if (
    identity.kind !== "present" ||
    self !== join(identity.canonicalPath, "Contents", "Resources", "shim.mjs") ||
    realpathSync(execPath) !== join(identity.canonicalPath, "Contents", "MacOS", "cashU") ||
    env.ELECTRON_RUN_AS_NODE !== "1"
  )
    throw new Error("packaged_shim_identity_unavailable");
  const version = execFileSync(
    "/usr/bin/plutil",
    [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      join(identity.canonicalPath, "Contents", "Info.plist"),
    ],
    { encoding: "utf8", timeout: 5_000 },
  ).trim();
  return packagedBuildId(version, identity.contentDigest);
}

/** The command line that runs the host of `dataDir`. */
export function hostCommand(
  build: ShimBuild,
  dataDir: string,
  execPath: string,
  execArgv: readonly string[],
  cwd: string,
): { command: string; args: string[] } {
  const entry =
    build.checkout === undefined
      ? join(dirname(build.self), "host.mjs")
      : join(build.checkout, "apps", "host", "src", "cli.ts");
  const flags = build.checkout === undefined ? [] : sourceRunFlags(execArgv, cwd);
  return {
    command: execPath,
    args: [
      ...flags,
      entry,
      "run",
      "--data-dir",
      dataDir,
      ...(build.checkout === undefined ? ["--bundle", entry] : []),
    ],
  };
}

function assertPackagedShim(target: HostTarget): void {
  if (target.build.checkout !== undefined) return;
  if (packagedShimBuild(target.build.self, target.execPath, target.env) !== target.build.build)
    throw new Error("packaged_shim_build_mismatch");
}

export interface HostTarget {
  readonly dataDir: string;
  readonly build: ShimBuild;
  /** The host's environment when the shim starts it (the shim's own, plus what `.env.dev` adds). */
  readonly env: NodeJS.ProcessEnv;
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly cwd: string;
}

/** The host's log, named in the shim's error text. */
export const hostLogPath = (dataDir: string) => hostRunPaths(dataDir).logPath;

/** Connects with `role`, starting a host when none answers. Throws HostStartError / HostConnectError. */
export async function reachHost(
  target: HostTarget,
  role: Role,
  profile?: string,
): Promise<HostConnection> {
  assertPackagedShim(target);
  const { command, args } = hostCommand(
    target.build,
    target.dataDir,
    target.execPath,
    target.execArgv,
    target.cwd,
  );
  const paths = hostRunPaths(target.dataDir);
  const { connection } = await connectOrStart({
    dataDir: target.dataDir,
    role,
    ...(profile === undefined ? {} : { profile }),
    build: target.build.build,
    start: () => {
      spawnDetachedHost({ command, args, logPath: paths.logPath, env: target.env });
    },
  });
  return connection;
}

/** Connects to a running host only (status / stop never start one); undefined when none answers. */
export async function existingHost(
  target: HostTarget,
  role: Role,
): Promise<HostConnection | undefined> {
  assertPackagedShim(target);
  try {
    return await connectHost({ dataDir: target.dataDir, role, build: target.build.build });
  } catch (error) {
    if (error instanceof HostConnectError && error.retryable) return undefined;
    throw error;
  }
}
