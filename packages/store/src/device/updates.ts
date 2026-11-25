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
      /** False while the current stage comes from an automatic check (no checking / result card). */
      readonly manualCheck: boolean;
      /** "Sprawdzaj codziennie": the automatic daily check (notify only) is on. */
      readonly autoCheck: boolean;
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
  run(): UpdateStatus {
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
