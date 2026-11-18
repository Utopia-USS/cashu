// How the shim reaches the data dir's host: connect, or start one detached and wait (connect-or-start,
// @cashu/node-host). The host runs from the same build as the shim: from source in a dev checkout
// (`node <transform-types flags> apps/host/src/cli.ts`), else the bundle's `host.mjs` next to the shim's
// bundle with the same runtime (the app's binary in Node mode, S47). A host that is still opening its
// stores answers `starting`: the shim waits for it (bounded, connectOrStart) instead of starting
// another. Never a fallback: when no host can be started the caller reports it and stops (exit 69).
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Role } from "@cashu/host-protocol";
import {
  connectHost,
  connectOrStart,
  HostConnectError,
  type HostConnection,
  hostRunPaths,
  readDiscovery,
  type SpawnHostOptions,
  samePath,
  sourceRunFlags,
  spawnDetachedHost,
} from "@cashu/node-host";
import {
  bundlePathFromEntry,
  packagedBuildId,
  packagedLayout,
  packagedVersion,
  readBundleIdentity,
} from "@cashu/node-host/bundle-identity";
import { bundleFlavor, FLAVORS, type Flavor } from "@cashu/node-host/flavor";

/** Where this shim runs from. */
export interface ShimBuild {
  /** The shim's own file (resolved). */
  readonly self: string;
  /** The source checkout (repo root) when the shim runs from source, else undefined. */
  readonly checkout: string | undefined;
  readonly build: string;
  /** The flavor sealed in the shim's bundle (prod from source): picks the default data dir. */
  readonly flavor: Flavor;
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
  if (fromSource)
    return {
      self: real,
      checkout: sourceRoot,
      build: env.CASHU_BUILD ?? "dev",
      flavor: FLAVORS.prod,
    };
  return { self: real, checkout: undefined, ...packagedShimBuild(real, process.execPath, env) };
}

/**
 * The build and flavor of a packaged shim: `self` is the verified bundle's `shim.mjs`, run by the
 * bundle's own executable in Node mode. The bundle is a `.app` on macOS (and any non-Windows
 * platform), the install dir on Windows (`<install>/resources/shim.mjs`, `<install>/cashU.exe`).
 */
export function packagedShimBuild(
  self: string,
  execPath: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): { readonly build: string; readonly flavor: Flavor } {
  const bundle = bundlePathFromEntry(self, platform);
  const identity = bundle ? readBundleIdentity(bundle, platform) : { kind: "invalid" as const };
  if (identity.kind !== "present") throw new Error("packaged_shim_identity_unavailable");
  const layout = packagedLayout(identity.canonicalPath, platform);
  // Windows compares the native realpath (on-disk case, long names) the bundle identity uses.
  const running = (path: string) =>
    platform === "win32" ? realpathSync.native(path) : realpathSync(path);
  if (
    !samePath(self, join(layout.resources, "shim.mjs"), platform) ||
    !samePath(running(execPath), layout.executable, platform) ||
    env.ELECTRON_RUN_AS_NODE !== "1"
  )
    throw new Error("packaged_shim_identity_unavailable");
  return {
    build: packagedBuildId(
      packagedVersion(identity.canonicalPath, platform),
      identity.contentDigest,
    ),
    flavor: bundleFlavor(identity.canonicalPath, platform),
  };
}

/** The command line that runs the host binary for `dataDir`. */
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
  const command = [
    "run",
    "--data-dir",
    dataDir,
    ...(build.checkout === undefined ? ["--bundle", entry] : []),
  ];
  return { command: execPath, args: [...flags, entry, ...command] };
}

function assertPackagedShim(target: HostTarget): void {
  if (target.build.checkout !== undefined) return;
  const current = packagedShimBuild(target.build.self, target.execPath, target.env);
  if (current.build !== target.build.build || current.flavor.id !== target.build.flavor.id)
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

/**
 * How the shim starts the data dir's host: detached, logging to the data dir, and working in the data
 * dir (resolved), never in the caller's directory. A long-lived host would otherwise keep that folder
 * (a Claude Code project, a terminal's cwd) open, which Windows then cannot delete or rename. Nothing
 * in the host depends on the cwd it starts in: its arguments are absolute (`hostCommand`) and each
 * client sends its own cwd per request.
 */
export function hostSpawnOptions(target: HostTarget): SpawnHostOptions {
  const { command, args } = hostCommand(
    target.build,
    target.dataDir,
    target.execPath,
    target.execArgv,
    target.cwd,
  );
  const paths = hostRunPaths(target.dataDir);
  return { command, args, logPath: paths.logPath, env: target.env, cwd: paths.dataDir };
}

/** Reports the wait for a host that is still starting (time since its first `starting` answer). */
export type OnStarting = (elapsedMs: number) => void;

/**
 * Connects with `role`, starting a host when none answers and waiting for one that is starting.
 * Throws HostStartError / HostConnectError.
 */
export async function reachHost(
  target: HostTarget,
  role: Role,
  profile?: string,
  onStarting?: OnStarting,
): Promise<HostConnection> {
  assertPackagedShim(target);
  const spawnOptions = hostSpawnOptions(target);
  const { connection } = await connectOrStart({
    dataDir: target.dataDir,
    role,
    ...(profile === undefined ? {} : { profile }),
    build: target.build.build,
    start: () => {
      spawnDetachedHost(spawnOptions);
    },
    ...(onStarting === undefined ? {} : { onStarting }),
  });
  return connection;
}

/** The data dir's host as `host status` / `host stop` see it (they never start one). */
export type ExistingHost =
  | { readonly kind: "running"; readonly connection: HostConnection }
  | { readonly kind: "starting"; readonly pid: number | undefined }
  | { readonly kind: "absent" };

/**
 * Connects to a running host only. A starting host is reported as such, or waited for (bounded,
 * throws HostStartError) when `onStarting` is given.
 */
export async function existingHost(
  target: HostTarget,
  role: Role,
  onStarting?: OnStarting,
): Promise<ExistingHost> {
  assertPackagedShim(target);
  const options = { dataDir: target.dataDir, role, build: target.build.build };
  try {
    const connection =
      onStarting === undefined
        ? await connectHost(options)
        : (await connectOrStart({ ...options, onStarting })).connection;
    return { kind: "running", connection };
  } catch (error) {
    if (!(error instanceof HostConnectError) || !error.retryable) throw error;
    if (error.kind === "starting")
      return {
        kind: "starting",
        pid: readDiscovery(hostRunPaths(target.dataDir).discoveryPath)?.pid,
      };
    return { kind: "absent" };
  }
}
