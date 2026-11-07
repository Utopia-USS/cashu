import type { UpdateStatus } from "@cashu/store/device";
import { UpdateNoticeView } from "./UpdateNoticeView.js";
import type { UpdateNoticeState } from "./useUpdateNotice.js";

const ready = (
  stage: NonNullable<Extract<UpdateStatus, { availability: "ready" }>["app"]>["stage"],
): UpdateNoticeState => ({
  status: {
    availability: "ready",
    current: "1.0.0",
    latest: "1.1.0",
    url: "https://example.invalid/changes",
    branchAvailable: true,
    manualCheck: true,
    autoCheck: true,
    app: { stage, version: "1.1.0", progress: stage === "downloading" ? 42 : null, error: null },
  },
  busy: false,
  closedVersion: null,
  onBranchClosed() {},
  onAction: async () => true,
});
export default {
  title: "Desktop/Settings/Update notice",
  component: UpdateNoticeView,
  args: { state: ready("available") },
};
export const Available = {};
export const Checking = { args: { state: ready("checking") } };
export const Downloading = { args: { state: ready("downloading") } };
export const Installing = { args: { state: ready("installing") } };
export const UpToDate = { args: { state: ready("up_to_date") } };
export const UpdateError = { args: { state: ready("error") } };
/** Found by the automatic daily check: the same card as a manual find. */
export const AvailableFromAutomaticCheck = {
  args: {
    state: {
      ...ready("available"),
      status: { ...ready("available").status, manualCheck: false },
    } as UpdateNoticeState,
  },
};
export const BranchFallback = {
  args: {
    state: {
      ...ready("available"),
      status: {
        availability: "ready",
        current: "1.0.0",
        latest: "1.1.0",
        url: "https://example.invalid/changes",
        branchAvailable: true,
        manualCheck: false,
        autoCheck: true,
        app: null,
      },
    } as UpdateNoticeState,
  },
};
export const Unbound = {
  args: {
    state: { ...ready("available"), status: { availability: "unavailable" } } as UpdateNoticeState,
  },
};
