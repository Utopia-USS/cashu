import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alive,
  dashboardWindow,
  type ElectronApplication,
  expect,
  hostPid,
  launchDesktop,
  type Page,
  pickProfile,
  setPrivacy,
  stopHost,
  until,
} from "./electron-test.ts";

/**
 * Restore only the generated native test target, at its authenticated inventory path. A synthetic
 * host an earlier spec left behind (a timed-out test never reaches its cleanup) is stopped first:
 * the stores are never replaced under a live host.
 */
export async function restoreNativeBaseline(dataDir: string): Promise<void> {
  const root = process.env.E2E_ROOT;
  const baseline = process.env.E2E_NATIVE_BASELINE_DIR;
  const tempRoot = realpathSync(tmpdir());
  if (
    !root ||
    !baseline ||
    realpathSync(root) !== root ||
    !root.startsWith(`${tempRoot}/cashu-e2e-desktop-`) ||
    baseline !== join(root, "native-baseline") ||
    dataDir !== join(root, "native-data") ||
    realpathSync(baseline) !== baseline ||
    realpathSync(dataDir) !== dataDir
  )
    throw new Error("isolated native baseline paths are absent");
  await stopHost(dataDir);
  const previous = hostPid(dataDir);
  if (previous !== null && alive(previous))
    throw new Error("synthetic native baseline restore refused while a host is live");
  rmSync(dataDir, { recursive: true, force: true });
  cpSync(baseline, dataDir, { recursive: true });
}

export interface NativeDemo {
  readonly repo: string;
  readonly dataDir: string;
  readonly app: ElectronApplication;
  readonly page: Page;
  close(): Promise<void>;
}

export function nativeDemoPaths(): { repo: string; dataDir: string; loader: string } {
  const repo = process.env.E2E_REPO;
  const dataDir = process.env.E2E_NATIVE_DATA_DIR;
  if (!repo || !dataDir || !process.env.E2E_ROOT) throw new Error("isolated native demo absent");
  return { repo, dataDir, loader: join(repo, "tools/node-ts/resolveTs.ts") };
}

export interface NativeDemoOptions {
  /** One spec's synthetic story for the host (CASHU_E2E_*). */
  readonly env?: Record<string, string>;
  /** Runs on the restored data dir before the host starts. */
  readonly prepare?: (dataDir: string) => Promise<void>;
}

/**
 * The synthetic demo (apps/host/src/testing/seedOverviewDemo.ts) on the restored baseline, served by
 * its own host, and the real shell on it with amounts shown and Demo Anna picked.
 */
export async function openNativeDemo({
  env = {},
  prepare,
}: NativeDemoOptions = {}): Promise<NativeDemo> {
  const { repo, dataDir, loader } = nativeDemoPaths();
  await restoreNativeBaseline(dataDir);
  await prepare?.(dataDir);
  const host: ChildProcess = spawn(
    process.execPath,
    ["--import", loader, join(repo, "apps/host/src/testing/seedOverviewDemo.ts"), "serve"],
    { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] },
  );
  let errors = "";
  host.stderr?.on("data", (chunk) => {
    errors += String(chunk);
  });
  let app: ElectronApplication | undefined;
  const close = async () => {
    await app?.close().catch(() => {});
    await stopHost(dataDir).catch(() => {});
    if (host.exitCode === null && host.signalCode === null) {
      host.kill("SIGTERM");
      await until(() => host.exitCode !== null || host.signalCode !== null);
    }
  };
  try {
    const ready = join(dataDir, "overview-ready");
    await until(
      () =>
        (existsSync(ready) && readFileSync(ready, "utf8").trim() === String(host.pid)) ||
        host.exitCode !== null,
    );
    expect(host.exitCode, errors).toBeNull();
    app = await launchDesktop({ dataDir });
    const { page } = await dashboardWindow(app);
    await setPrivacy(page, false);
    await pickProfile(page, "Demo Anna");
    return { repo, dataDir, app, page, close };
  } catch (error) {
    await close();
    throw error;
  }
}
