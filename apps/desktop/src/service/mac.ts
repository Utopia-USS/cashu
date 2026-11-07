import { homedir } from "node:os";
import { join } from "node:path";
import type { HostService, ServiceStatus, StartOutcome } from "@cashu/node-host";
import { realResolve } from "../config.js";

/** This identity is reserved for the new app; S47 must sign and package it exactly. */
export const MAC_APP_BUNDLE_ID = "io.utopiasoft.cashu";

export type NativeAgentStatus = "notRegistered" | "enabled" | "requiresApproval" | "notFound";

/** S47 must bind this to ServiceManagement in the trusted Electron main process. */
export interface MainProcessAgentBridge {
  /** Read from Bundle.main by the in-process bridge, never renderer supplied. */
  identity(): Promise<{ readonly bundleId: string; readonly bundlePath: string }>;
  status(): Promise<NativeAgentStatus>;
  register(): Promise<void>;
  unregister(): Promise<void>;
  /** Bounded activation of the exact bundled agent. */
  activate(): Promise<boolean>;
}

export interface MacRuntime {
  readonly platform: NodeJS.Platform;
  readonly osReleaseMajor: number;
  readonly isPackaged: boolean;
  readonly dataDir: string;
  readonly home: string;
  readonly bridge: MainProcessAgentBridge;
}

export function currentMacRuntime(
  app: { isPackaged: boolean },
  dataDir: string,
  bridge: MainProcessAgentBridge,
  release: string,
): MacRuntime {
  return {
    platform: process.platform,
    osReleaseMajor: Number.parseInt(release.split(".")[0] ?? "0", 10),
    isPackaged: app.isPackaged,
    dataDir,
    home: homedir(),
    bridge,
  };
}

async function eligible(runtime: MacRuntime): Promise<boolean> {
  if (runtime.platform !== "darwin" || runtime.osReleaseMajor < 22) return false; // macOS 13+
  if (!runtime.isPackaged) return false;
  const identity = await runtime.bridge.identity();
  if (identity.bundleId !== MAC_APP_BUNDLE_ID || !identity.bundlePath.endsWith(".app"))
    return false;
  const expected = realResolve(join(runtime.home, "Library", "Application Support", "cashU"));
  return realResolve(runtime.dataDir) === expected;
}

export function mapNativeAgentStatus(status: NativeAgentStatus): ServiceStatus {
  switch (status) {
    case "notRegistered":
      return { state: "off" };
    case "enabled":
      return { state: "enabled" };
    case "requiresApproval":
      return { state: "requires_approval" };
    case "notFound":
      return { state: "error", reason: "agent_not_found" };
  }
}

export class MacHostService implements HostService {
  readonly #runtime: MacRuntime;

  constructor(runtime: MacRuntime) {
    const bridge = runtime.bridge;
    this.#runtime = Object.freeze({
      platform: runtime.platform,
      osReleaseMajor: runtime.osReleaseMajor,
      isPackaged: runtime.isPackaged,
      dataDir: runtime.dataDir,
      home: runtime.home,
      bridge: Object.freeze({
        identity: bridge.identity.bind(bridge),
        status: bridge.status.bind(bridge),
        register: bridge.register.bind(bridge),
        unregister: bridge.unregister.bind(bridge),
        activate: bridge.activate.bind(bridge),
      }),
    });
  }

  async status(): Promise<ServiceStatus> {
    try {
      if (!(await eligible(this.#runtime))) {
        return { state: "unavailable", reason: "ineligible_runtime" };
      }
      return mapNativeAgentStatus(await this.#runtime.bridge.status());
    } catch {
      return { state: "error", reason: "native_status_failed" };
    }
  }

  async enable(): Promise<ServiceStatus> {
    const current = await this.status();
    if (current.state === "unavailable" || current.state === "error") return current;
    if (current.state !== "off") return current;
    try {
      await this.#runtime.bridge.register();
      return this.status();
    } catch {
      return { state: "error", reason: "native_register_failed" };
    }
  }

  async disable(): Promise<ServiceStatus> {
    const current = await this.status();
    if (current.state === "unavailable" || current.state === "error" || current.state === "off") {
      return current;
    }
    try {
      await this.#runtime.bridge.unregister();
      return this.status();
    } catch {
      return { state: "error", reason: "native_unregister_failed" };
    }
  }

  async start(): Promise<StartOutcome> {
    if ((await this.status()).state !== "enabled") return { kind: "unavailable" };
    try {
      return (await this.#runtime.bridge.activate())
        ? { kind: "started" }
        : { kind: "failed", reason: "native_activate_failed" };
    } catch {
      return { kind: "failed", reason: "native_activate_failed" };
    }
  }
}
