import { defineQuery } from "../query.js";
import type { UiAction } from "../ui-actions.js";

export type AppUpdateStage =
  | "available"
  | "checking"
  | "downloading"
  | "installing"
  | "up_to_date"
  | "error";
export type UpdateStatus =
  | { readonly availability: "unavailable" }
  | {
      readonly availability: "ready";
      readonly current: string;
      readonly latest: string | null;
      readonly url: string | null;
      readonly branchAvailable: boolean;
      readonly manualCheck: boolean;
      readonly app: null | {
        readonly stage: AppUpdateStage;
        readonly version: string | null;
        readonly progress: number | null;
        readonly error: string | null;
      };
    };

/** Overridden only by a checked host updater provider. */
export const updateStatus = defineQuery({
  id: "device.updateStatus",
  scope: "device",
  run(_read, _args: { readonly poll: number }): UpdateStatus {
    return { availability: "unavailable" };
  },
});

export const updateAction: UiAction<
  {
    readonly action: "check" | "install" | "skip" | "dismiss" | "auto";
    readonly enabled?: boolean;
  },
  { readonly kind: "completed" | "refused" | "outcome_unknown"; readonly reason?: string }
> = { id: "device.updateAction" };
