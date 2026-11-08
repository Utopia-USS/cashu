/// <reference types="node" />
// Isolated Electron Create harness. Only a supervised fake-KeyStore host can serve this data dir.

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type ElectronApplication } from "@playwright/test";
import { appDir, electronBinary, launchEnv, until } from "./electron-test.ts";

export interface TestHost {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  stop(): Promise<void>;
}

export interface NativeCreationHarness {
  readonly root: string;
  readonly dataDir: string;
  readonly service: string;
  startHost(): Promise<TestHost>;
  launchDesktop(): Promise<ElectronApplication>;
  cleanup(): Promise<void>;
}

export function nativeCreationHarness(): NativeCreationHarness {
  const repo = process.env.E2E_REPO;
  if (!repo) throw new Error("synthetic_creation_e2e_setup_missing");
  const repoPath: string = repo;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "t44-test-")));
  const dataDir = join(root, "data");
  const appPath = join(root, "app");
  const home = join(root, "home");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(appPath, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  const isolation = {
    HOME: home,
    CASHU_TESTING: "1",
    CASHU_DATA_DIR: dataDir,
    CASHU_LEGACY_DATA_DIR: join(root, "legacy"),
    CASHU_WORKSPACES_DIR: join(root, "workspaces"),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
  const service = `cashu-next-test.${randomBytes(16).toString("hex")}`;
  writeFileSync(
    join(appPath, "package.json"),
    JSON.stringify({ name: "cashu-native-create-e2e", private: true, main: "bootstrap.cjs" }),
    { mode: 0o600 },
  );
  // The bootstrap is source-only, has no production environment switch, and runs before main.
  writeFileSync(
    join(appPath, "bootstrap.cjs"),
    readFileSync(join(appDir(), "e2e", "native-creation-guard.cjs")),
    { mode: 0o600 },
  );
  const hosts: TestHost[] = [];
  const apps: ElectronApplication[] = [];
  let cleaned = false;

  async function startHost(): Promise<TestHost> {
    if (cleaned) throw new Error("synthetic_creation_harness_closed");
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "--import",
        join(repoPath, "tools", "node-ts", "resolveTs.ts"),
        join(repoPath, "apps", "host", "src", "testing", "nativeCreationHost.ts"),
        dataDir,
        service,
      ],
      {
        env: {
          ...process.env,
          ...isolation,
          CASHU_DESKTOP_ALLOWED_DATA_ROOT: root,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", () => resolve(null));
    });
    let stopping: Promise<void> | undefined;
    const host: TestHost = {
      child,
      exited,
      stop() {
        stopping ??= (async () => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          const force = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }, 5_000);
          try {
            await exited;
          } finally {
            clearTimeout(force);
          }
        })();
        return stopping;
      },
    };
    hosts.push(host);
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes("ready\n")) resolve();
        });
        void exited.then(() => reject(new Error("synthetic_creation_host_exited_before_ready")));
      });
      return host;
    } catch (error) {
      await host.stop();
      throw error;
    }
  }

  async function launchDesktop(): Promise<ElectronApplication> {
    if (cleaned) throw new Error("synthetic_creation_harness_closed");
    const marker = join(dataDir, "test-guard-ready");
    const previous = existsSync(marker)
      ? readFileSync(marker, "utf8").trim().split("\n").length
      : 0;
    const app = await _electron.launch({
      executablePath: electronBinary(),
      args: [appPath, "--lang=pl-PL"],
      env: launchEnv(dataDir, {
        ...isolation,
        CASHU_DESKTOP_ALLOWED_DATA_ROOT: root,
        CASHU_DESKTOP_NO_TRAY: "1",
        E2E_NATIVE_CREATE_DATA_DIR: dataDir,
        E2E_NATIVE_CREATE_MAIN: join(appDir(), "dist", "main.js"),
      }),
      timeout: 90_000,
    });
    apps.push(app);
    const pid = app.process().pid;
    if (pid === undefined) throw new Error("synthetic_creation_electron_pid_missing");
    await until(() => {
      if (!existsSync(marker)) return false;
      const lines = readFileSync(marker, "utf8").trim().split("\n");
      return lines.length > previous && lines.at(-1) === String(pid);
    }, 10_000);
    return app;
  }

  return {
    root,
    dataDir,
    service,
    startHost,
    launchDesktop,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      for (const app of apps.reverse()) await app.close().catch(() => {});
      for (const host of hosts.reverse()) await host.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
