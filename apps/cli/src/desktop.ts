// The native desktop launch target for `cashu app`. A packaged shim runs from a verified bundle (a
// `.app` on macOS, the install dir on Windows) and opens that bundle's own executable; a source shim
// uses the checkout's local Electron binary and built desktop entry.
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { samePath } from "@cashu/node-host";
import {
  bundlePathFromEntry,
  packagedLayout,
  readBundleIdentity,
} from "@cashu/node-host/bundle-identity";
import type { ShimBuild } from "./host.js";

export interface DesktopLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}
export type DesktopResult =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "signal"; readonly signal: NodeJS.Signals }
  | { readonly kind: "failed" };

/**
 * The Electron binary of a source checkout's desktop app on Windows, where `node_modules/.bin/electron`
 * is a shell script (and `.cmd` shims cannot be spawned without a shell): the path that the desktop
 * app's own `electron` package exports. It is loaded by its directory, so no other installation (a
 * parent folder, NODE_PATH) can stand in. Null when the package or its downloaded binary is missing.
 */
export function sourceElectronBinary(desktopApp: string): string | null {
  try {
    const binary: unknown = createRequire(join(desktopApp, "package.json"))(
      join(desktopApp, "node_modules", "electron"),
    );
    return typeof binary === "string" && existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

export interface DesktopLaunchPlatform {
  readonly platform: NodeJS.Platform;
  /** `sourceElectronBinary`, injected by tests. */
  readonly electronBinary: (desktopApp: string) => string | null;
}

export function desktopLaunch(
  build: ShimBuild,
  execPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  dataDir: string,
  debug: boolean,
  { platform, electronBinary }: DesktopLaunchPlatform = {
    platform: process.platform,
    electronBinary: sourceElectronBinary,
  },
): DesktopLaunch | null {
  const childEnv: NodeJS.ProcessEnv = { ...env, CASHU_DATA_DIR: dataDir };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (debug) childEnv.CASHU_DESKTOP_DEBUG = "1";
  if (build.checkout !== undefined) {
    const app = join(build.checkout, "apps", "desktop");
    if (!existsSync(join(app, "dist", "main.js"))) return null;
    const electron =
      platform === "win32" ? electronBinary(app) : join(app, "node_modules", ".bin", "electron");
    if (electron === null || !existsSync(electron)) return null;
    return { command: electron, args: [app], cwd, env: childEnv };
  }
  const bundle = bundlePathFromEntry(build.self, platform);
  const identity = bundle ? readBundleIdentity(bundle, platform) : { kind: "invalid" as const };
  if (identity.kind !== "present") return null;
  const layout = packagedLayout(identity.canonicalPath, platform);
  // Windows compares the native realpath (on-disk case, long names) the bundle identity uses.
  const real = (path: string) => {
    try {
      return platform === "win32" ? realpathSync.native(path) : realpathSync(path);
    } catch {
      return null;
    }
  };
  const self = real(build.self);
  const executable = real(execPath);
  if (
    self === null ||
    executable === null ||
    !samePath(self, join(layout.resources, "shim.mjs"), platform) ||
    !samePath(executable, layout.executable, platform)
  )
    return null;
  // The bundle's parent as the working directory: never inside the bundle or install folder.
  return { command: execPath, args: [], cwd: dirname(identity.canonicalPath), env: childEnv };
}

export function runDesktopApp(
  target: DesktopLaunch,
  launch: (target: DesktopLaunch) => Promise<DesktopResult> = spawnDesktop,
): Promise<DesktopResult> {
  return launch(target);
}

function spawnDesktop(target: DesktopLaunch): Promise<DesktopResult> {
  return new Promise((resolve) => {
    const child = spawn(target.command, [...target.args], {
      cwd: target.cwd,
      env: target.env,
      stdio: "inherit",
    });
    const forward = () => child.kill("SIGTERM");
    process.on("SIGTERM", forward);
    const finish = (result: DesktopResult) => {
      process.off("SIGTERM", forward);
      resolve(result);
    };
    child.once("error", () => finish({ kind: "failed" }));
    child.once("exit", (code, signal) =>
      finish(signal ? { kind: "signal", signal } : { kind: "exit", code: code ?? 1 }),
    );
  });
}
