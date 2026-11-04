// The native desktop launch target for `cashu app`. A packaged shim runs from a verified bundle;
// a source shim uses the checkout's local Electron binary and built desktop entry.
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { bundlePathFromEntry, readBundleIdentity } from "@cashu/node-host/bundle-identity";
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

export function desktopLaunch(
  build: ShimBuild,
  execPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  dataDir: string,
  debug: boolean,
): DesktopLaunch | null {
  const childEnv: NodeJS.ProcessEnv = { ...env, CASHU_DATA_DIR: dataDir };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (debug) childEnv.CASHU_DESKTOP_DEBUG = "1";
  if (build.checkout !== undefined) {
    const app = join(build.checkout, "apps", "desktop");
    const electron = join(app, "node_modules", ".bin", "electron");
    if (!existsSync(electron) || !existsSync(join(app, "dist", "main.js"))) return null;
    return { command: electron, args: [app], cwd, env: childEnv };
  }
  const bundle = bundlePathFromEntry(build.self);
  const identity = bundle ? readBundleIdentity(bundle) : { kind: "invalid" as const };
  if (
    identity.kind !== "present" ||
    realpathSync(build.self) !==
      join(identity.canonicalPath, "Contents", "Resources", "shim.mjs") ||
    realpathSync(execPath) !== join(identity.canonicalPath, "Contents", "MacOS", "cashU")
  )
    return null;
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
