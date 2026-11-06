import { defineQuery } from "../../query.js";

export interface HostSettingsInfo {
  readonly availability: "ready" | "unavailable";
  readonly version?: string;
  readonly dataDir?: string;
  /** The stable launcher `<data dir>/bin/cashu` that agent commands (`claude mcp add`, CLI lines) run. */
  readonly launcher?: string;
  readonly worker?: {
    readonly state: "off" | "safe-mode" | "idle" | "running" | "stopped" | "error";
    readonly schedule: string;
    readonly nextRunAt: string | null;
    readonly lastTickAt: string | null;
    readonly jobs: readonly {
      readonly job: string;
      readonly vault: string;
      readonly profileName: string;
      readonly status: string;
      readonly startedAt: string;
      readonly finishedAt: string | null;
      readonly code?: string;
    }[];
  };
}

export const hostSettingsInfo = defineQuery({
  id: "device.settings.hostInfo",
  scope: "device",
  run(_read, _args: { readonly poll: number; readonly privacy: boolean }): HostSettingsInfo {
    return { availability: "unavailable" };
  },
});
