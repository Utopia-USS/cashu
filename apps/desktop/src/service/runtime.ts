import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { homedir, release } from "node:os";
import {
  type HostService,
  type ServiceStatus,
  SYSTEMD_LAUNCHER,
  SystemdHostService,
  type SystemdRunner,
} from "@cashu/node-host";
import { defaultDataDir, realResolve } from "../config.js";
import { currentMacRuntime, MacHostService, type MainProcessAgentBridge } from "./mac.js";
import { nativeMacAgentBridge } from "./native.js";

const unavailable: ServiceStatus = { state: "unavailable", reason: "service_not_bound" };

class UnavailableHostService implements HostService {
  async status(): Promise<ServiceStatus> {
    return unavailable;
  }
  async enable(): Promise<ServiceStatus> {
    return unavailable;
  }
  async disable(): Promise<ServiceStatus> {
    return unavailable;
  }
  async start() {
    return { kind: "unavailable" as const };
  }
}

/** Only the fixed systemctl executable and adapter-owned arguments reach the process. */
const systemctlRunner: SystemdRunner = {
  run(args) {
    return new Promise((resolve) => {
      execFile(
        "/usr/bin/systemctl",
        [...args],
        { timeout: 5_000, maxBuffer: 4_096 },
        (error, stdout) => {
          resolve({ code: error ? 1 : 0, stdout: stdout.slice(0, 4_096) });
        },
      );
    });
  },
};

export interface DesktopServiceInput {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly dataDir: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly bridge?: MainProcessAgentBridge;
  readonly runner?: SystemdRunner;
  readonly launcherReady?: boolean;
  readonly osRelease?: string;
}

/** Registration is unavailable until the installed, fixed launcher or native bridge is real. */
export function createDesktopHostService(input: DesktopServiceInput): HostService {
  if (!input.packaged) return new UnavailableHostService();
  if (input.platform === "darwin") {
    if (!input.bridge) return new UnavailableHostService();
    return new MacHostService({
      ...currentMacRuntime(
        { isPackaged: true },
        input.dataDir,
        input.bridge,
        input.osRelease ?? release(),
      ),
      platform: input.platform,
      home: input.home,
    });
  }
  if (input.platform !== "linux") return new UnavailableHostService();
  const expected = defaultDataDir("linux", input.home, input.env);
  if (realResolve(input.dataDir) !== realResolve(expected)) return new UnavailableHostService();
  if (input.launcherReady !== true) return new UnavailableHostService();
  return new SystemdHostService({
    home: input.home,
    dataDir: realResolve(input.dataDir),
    ...(input.env.XDG_CONFIG_HOME ? { xdgConfigHome: input.env.XDG_CONFIG_HOME } : {}),
    ...(input.env.XDG_DATA_HOME ? { xdgDataHome: input.env.XDG_DATA_HOME } : {}),
    runner: input.runner ?? systemctlRunner,
  });
}

function fixedLauncherReady(): boolean {
  try {
    const stat = lstatSync(SYSTEMD_LAUNCHER);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      realpathSync.native(SYSTEMD_LAUNCHER) === SYSTEMD_LAUNCHER &&
      stat.uid === 0 &&
      (stat.mode & 0o022) === 0 &&
      (stat.mode & 0o111) !== 0
    );
  } catch {
    return false;
  }
}

export function desktopHostService(
  dataDir: string,
  packaged: boolean,
  resourcesPath = process.resourcesPath,
): HostService {
  return createDesktopHostService({
    platform: process.platform,
    packaged,
    dataDir,
    home: homedir(),
    env: process.env,
    bridge: packaged ? nativeMacAgentBridge(resourcesPath) : undefined,
    launcherReady: packaged && process.platform === "linux" && fixedLauncherReady(),
  });
}

/** The fixed calendar plan is informational and never evidence that a worker ran. */
export function nextDailyWake(now: Date = new Date()): string {
  const next = new Date(now);
  next.setHours(7, 30, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}
